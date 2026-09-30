use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use crate::models::session::{
    SessionInfo, SessionSearchIndexDocument, SessionSearchIndexRefresh, SessionSearchIndexSource,
    SessionSearchResults,
};
use crate::models::tool::ToolKey;

const MAX_SEARCH_RESULTS: usize = 2_000;
const MAX_INDEX_TEXT_CHARS: usize = 8_000;

pub fn remove_directory(connection: &Connection, directory_id: i64) -> Result<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "delete from session_search_documents where directory_id = ?1",
        [directory_id],
    )?;
    transaction.execute(
        "delete from session_search_sources where directory_id = ?1",
        [directory_id],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn refresh(
    connection: &Connection,
    directory_id: i64,
    sources: &[SessionSearchIndexSource],
) -> Result<SessionSearchIndexRefresh> {
    let transaction = connection.unchecked_transaction()?;
    let mut incomplete_tools = Vec::new();
    let mut indexed_sessions = 0;

    for source in sources {
        let Some(documents) = source.documents.as_ref() else {
            upsert_source_status(&transaction, directory_id, source.tool_key, true)?;
            incomplete_tools.push(source.tool_key);
            continue;
        };

        if !source.incomplete {
            transaction.execute(
                "delete from session_search_documents where directory_id = ?1 and tool_key = ?2",
                params![directory_id, source.tool_key.as_str()],
            )?;
        }

        for document in documents {
            if document.tool_key != source.tool_key {
                continue;
            }
            upsert_document(&transaction, directory_id, document)?;
            indexed_sessions += 1;
        }

        upsert_source_status(
            &transaction,
            directory_id,
            source.tool_key,
            source.incomplete,
        )?;
        if source.incomplete {
            incomplete_tools.push(source.tool_key);
        }
    }

    transaction.commit()?;
    Ok(SessionSearchIndexRefresh {
        incomplete_tools,
        indexed_sessions,
    })
}

pub fn search(
    connection: &Connection,
    directory_id: i64,
    query: &str,
    aliases: &HashMap<ToolKey, HashMap<String, String>>,
) -> Result<SessionSearchResults> {
    let query = query.trim().to_lowercase();
    let mut matches: HashMap<(ToolKey, String), SessionInfo> = HashMap::new();

    if query.chars().count() < 3 {
        let mut statement = connection.prepare(
            "select tool_key, session_id, title, last_active_ms
             from session_search_documents
             where directory_id = ?1 and instr(search_text, ?2) > 0
             order by last_active_ms desc, tool_key asc, session_id asc
             limit ?3",
        )?;
        let rows = statement.query_map(
            params![directory_id, query, (MAX_SEARCH_RESULTS + 1) as i64],
            read_session,
        )?;
        collect_sessions(rows, &mut matches)?;
    } else {
        let expression = fts_phrase(&query);
        let mut statement = connection.prepare(
            "select d.tool_key, d.session_id, d.title, d.last_active_ms
             from session_search_fts f
             join session_search_documents d on d.rowid = f.rowid
             where d.directory_id = ?1 and session_search_fts match ?2
             order by d.last_active_ms desc, d.tool_key asc, d.session_id asc
             limit ?3",
        )?;
        let rows = statement.query_map(
            params![directory_id, expression, (MAX_SEARCH_RESULTS + 1) as i64],
            read_session,
        )?;
        collect_sessions(rows, &mut matches)?;
    }

    // Aliases remain authoritative in the business database and are merged only for matches.
    for (tool_key, tool_aliases) in aliases {
        for (session_id, alias) in tool_aliases {
            if let Some(session) = matches.get_mut(&(*tool_key, session_id.clone())) {
                session.alias = Some(alias.clone());
                continue;
            }
            if !alias.to_lowercase().contains(&query) {
                continue;
            }
            let document = connection
                .query_row(
                    "select title, last_active_ms from session_search_documents
                     where directory_id = ?1 and tool_key = ?2 and session_id = ?3",
                    params![directory_id, tool_key.as_str(), session_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
                )
                .optional()?;
            if let Some((title, last_active_ms)) = document {
                matches.insert(
                    (*tool_key, session_id.clone()),
                    SessionInfo {
                        tool_key: *tool_key,
                        session_id: session_id.clone(),
                        title,
                        alias: Some(alias.clone()),
                        last_active_ms,
                    },
                );
            }
        }
    }

    let mut incomplete_tools = Vec::new();
    let mut statement = connection.prepare(
        "select tool_key from session_search_sources
         where directory_id = ?1 and incomplete = 1",
    )?;
    let rows = statement.query_map([directory_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        if let Some(tool_key) = ToolKey::from_key(&row?) {
            incomplete_tools.push(tool_key);
        }
    }

    let mut items: Vec<_> = matches.into_values().collect();
    items.sort_by(|left, right| {
        right
            .last_active_ms
            .cmp(&left.last_active_ms)
            .then_with(|| left.tool_key.as_str().cmp(right.tool_key.as_str()))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    if items.len() > MAX_SEARCH_RESULTS {
        for item in items.iter().skip(MAX_SEARCH_RESULTS) {
            if !incomplete_tools.contains(&item.tool_key) {
                incomplete_tools.push(item.tool_key);
            }
        }
        items.truncate(MAX_SEARCH_RESULTS);
    }

    Ok(SessionSearchResults {
        items,
        incomplete_tools,
    })
}

fn upsert_document(
    connection: &Connection,
    directory_id: i64,
    document: &SessionSearchIndexDocument,
) -> Result<()> {
    let mut fields = Vec::with_capacity(document.fields.len() + 1);
    fields.push(document.title.clone());
    fields.extend(document.fields.iter().cloned());
    let search_text = bounded_search_text(fields);

    connection.execute(
        "insert into session_search_documents
           (directory_id, tool_key, session_id, title, search_text, last_active_ms)
         values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(directory_id, tool_key, session_id) do update set
           title = excluded.title,
           search_text = excluded.search_text,
           last_active_ms = excluded.last_active_ms",
        params![
            directory_id,
            document.tool_key.as_str(),
            document.session_id,
            document.title,
            search_text,
            document.last_active_ms,
        ],
    )?;
    Ok(())
}

fn bounded_search_text(fields: Vec<String>) -> String {
    let mut result = String::new();
    for field in fields {
        let field = field.trim().to_lowercase();
        if field.is_empty() || result.chars().count() >= MAX_INDEX_TEXT_CHARS {
            continue;
        }
        if !result.is_empty() {
            result.push('\n');
        }
        let remaining = MAX_INDEX_TEXT_CHARS.saturating_sub(result.chars().count());
        result.extend(field.chars().take(remaining));
    }
    result
}

fn upsert_source_status(
    connection: &Connection,
    directory_id: i64,
    tool_key: ToolKey,
    incomplete: bool,
) -> Result<()> {
    connection.execute(
        "insert into session_search_sources (directory_id, tool_key, incomplete, refreshed_at_ms)
         values (?1, ?2, ?3, ?4)
         on conflict(directory_id, tool_key) do update set
           incomplete = excluded.incomplete,
           refreshed_at_ms = excluded.refreshed_at_ms",
        params![
            directory_id,
            tool_key.as_str(),
            incomplete,
            crate::services::execution_service::now_ms(),
        ],
    )?;
    Ok(())
}

fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

fn read_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionInfo> {
    let tool_key: String = row.get(0)?;
    let tool_key = ToolKey::from_key(&tool_key).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(0, "tool_key".into(), rusqlite::types::Type::Text)
    })?;
    Ok(SessionInfo {
        tool_key,
        session_id: row.get(1)?,
        title: row.get(2)?,
        alias: None,
        last_active_ms: row.get(3)?,
    })
}

fn collect_sessions<F>(
    rows: rusqlite::MappedRows<'_, F>,
    matches: &mut HashMap<(ToolKey, String), SessionInfo>,
) -> Result<()>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<SessionInfo>,
{
    for row in rows {
        let session = row?;
        matches.insert((session.tool_key, session.session_id.clone()), session);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::cache_connection::init_ephemeral_cache;

    fn document(
        tool_key: ToolKey,
        session_id: &str,
        title: &str,
        fields: &[&str],
    ) -> SessionSearchIndexDocument {
        SessionSearchIndexDocument {
            tool_key,
            session_id: session_id.to_string(),
            title: title.to_string(),
            last_active_ms: Some(10),
            fields: fields.iter().map(|value| value.to_string()).collect(),
        }
    }

    #[test]
    fn fts_search_supports_case_insensitive_substrings_and_cjk_fallbacks() {
        let connection = init_ephemeral_cache().unwrap();
        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Claude,
                documents: Some(vec![document(
                    ToolKey::Claude,
                    "one",
                    "Visible Title",
                    &["搜索索引中文内容"],
                )]),
                incomplete: false,
            }],
        )
        .unwrap();

        let aliases = HashMap::new();
        assert_eq!(
            search(&connection, 1, "VISIBLE", &aliases)
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(
            search(&connection, 1, "搜索", &aliases)
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(
            search(&connection, 1, "索引中文", &aliases)
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(search(&connection, 2, "Visible", &aliases)
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn refresh_prunes_stale_rows_but_preserves_a_failed_source() {
        let connection = init_ephemeral_cache().unwrap();
        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Codex,
                documents: Some(vec![
                    document(ToolKey::Codex, "old", "old title", &[]),
                    document(ToolKey::Codex, "keep", "keep title", &[]),
                ]),
                incomplete: false,
            }],
        )
        .unwrap();
        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Codex,
                documents: Some(vec![document(ToolKey::Codex, "keep", "updated title", &[])]),
                incomplete: false,
            }],
        )
        .unwrap();

        let aliases = HashMap::new();
        assert!(search(&connection, 1, "old", &aliases)
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            search(&connection, 1, "updated", &aliases)
                .unwrap()
                .items
                .len(),
            1
        );

        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Codex,
                documents: None,
                incomplete: true,
            }],
        )
        .unwrap();
        assert_eq!(
            search(&connection, 1, "updated", &aliases)
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(
            search(&connection, 1, "updated", &aliases)
                .unwrap()
                .incomplete_tools,
            vec![ToolKey::Codex]
        );
    }

    #[test]
    fn aliases_match_only_indexed_sessions_and_include_the_alias() {
        let connection = init_ephemeral_cache().unwrap();
        refresh(
            &connection,
            4,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Grok,
                documents: Some(vec![document(ToolKey::Grok, "present", "original", &[])]),
                incomplete: false,
            }],
        )
        .unwrap();
        let aliases = HashMap::from([(
            ToolKey::Grok,
            HashMap::from([
                ("present".into(), "My Alias".into()),
                ("orphan".into(), "orphan alias".into()),
            ]),
        )]);

        let result = search(&connection, 4, "my alias", &aliases).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].alias.as_deref(), Some("My Alias"));

        let title_match = search(&connection, 4, "original", &aliases).unwrap();
        assert_eq!(title_match.items.len(), 1);
        assert_eq!(title_match.items[0].alias.as_deref(), Some("My Alias"));
    }

    #[test]
    fn fts_query_treats_search_text_as_a_literal_phrase() {
        let connection = init_ephemeral_cache().unwrap();
        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Codex,
                documents: Some(vec![document(
                    ToolKey::Codex,
                    "special",
                    "Design OR \"quoted phrase\" [draft]",
                    &[],
                )]),
                incomplete: false,
            }],
        )
        .unwrap();

        let result = search(&connection, 1, "or \"quoted phrase\"", &HashMap::new()).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].session_id, "special");
    }

    #[test]
    fn indexed_search_text_has_a_per_session_storage_limit() {
        let connection = init_ephemeral_cache().unwrap();
        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Claude,
                documents: Some(vec![document(
                    ToolKey::Claude,
                    "long",
                    &format!("{}tail-marker", "a".repeat(MAX_INDEX_TEXT_CHARS)),
                    &[],
                )]),
                incomplete: false,
            }],
        )
        .unwrap();

        assert_eq!(
            search(&connection, 1, "aaa", &HashMap::new())
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(search(&connection, 1, "tail-marker", &HashMap::new())
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn search_is_bounded_at_two_thousand_results_and_marks_the_source_incomplete() {
        let connection = init_ephemeral_cache().unwrap();
        let documents = (0..2_005)
            .map(|index| {
                document(
                    ToolKey::Claude,
                    &format!("session-{index}"),
                    &format!("shared query {index}"),
                    &[],
                )
            })
            .collect();
        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Claude,
                documents: Some(documents),
                incomplete: false,
            }],
        )
        .unwrap();

        let result = search(&connection, 1, "shared", &HashMap::new()).unwrap();
        assert_eq!(result.items.len(), MAX_SEARCH_RESULTS);
        assert_eq!(result.incomplete_tools, vec![ToolKey::Claude]);
    }

    #[test]
    fn cache_clear_removes_search_documents_and_fts_rows() {
        let connection = init_ephemeral_cache().unwrap();
        refresh(
            &connection,
            1,
            &[SessionSearchIndexSource {
                tool_key: ToolKey::Grok,
                documents: Some(vec![document(ToolKey::Grok, "one", "grok searchable", &[])]),
                incomplete: false,
            }],
        )
        .unwrap();

        crate::services::cache_service::clear(&connection).unwrap();

        assert!(search(&connection, 1, "searchable", &HashMap::new())
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn removing_a_project_deletes_only_its_index() {
        let connection = init_ephemeral_cache().unwrap();
        for directory_id in [1, 2] {
            refresh(
                &connection,
                directory_id,
                &[SessionSearchIndexSource {
                    tool_key: ToolKey::Claude,
                    documents: Some(vec![document(
                        ToolKey::Claude,
                        &format!("session-{directory_id}"),
                        &format!("project-{directory_id} title"),
                        &[],
                    )]),
                    incomplete: false,
                }],
            )
            .unwrap();
        }

        remove_directory(&connection, 1).unwrap();

        assert!(search(&connection, 1, "title", &HashMap::new())
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            search(&connection, 2, "title", &HashMap::new())
                .unwrap()
                .items
                .len(),
            1
        );
    }
}
