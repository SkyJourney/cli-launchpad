use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::models::workspace_layout::WorkspaceLayoutPresetSummary;

#[derive(Debug, Clone)]
pub struct WorkspaceLayoutRow {
    pub schema_version: i64,
    pub revision: i64,
    pub payload_json: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveCurrentOutcome {
    Saved { revision: i64 },
    Stale { current_revision: i64 },
    Incompatible { stored_schema_version: i64 },
}

#[derive(Debug, Clone)]
pub struct WorkspaceLayoutPresetRow {
    pub summary: WorkspaceLayoutPresetSummary,
    pub payload_json: String,
}

pub fn get_current(connection: &Connection) -> rusqlite::Result<Option<WorkspaceLayoutRow>> {
    connection
        .query_row(
            "select schema_version, revision, payload_json, updated_at_ms from workspace_state where id = 1",
            [],
            |row| {
                Ok(WorkspaceLayoutRow {
                    schema_version: row.get(0)?,
                    revision: row.get(1)?,
                    payload_json: row.get(2)?,
                    updated_at_ms: row.get(3)?,
                })
            },
        )
        .optional()
}

/// Persist only a newer client revision. A delayed autosave cannot replace a
/// layout that was already written by a later UI update.
///
/// CAS 只比较 revision：列 `schema_version` 是 payload 版本的只读镜像，成功保存时
/// 与 payload 一起写成当前版本，所以 0.3.0 升级用户（列值 1~4）的第一次保存也会成功。
/// 存储版本高于当前支持（或小于 1）时返回 `Incompatible`，且不修改该行。
pub fn save_current(
    connection: &mut Connection,
    schema_version: i64,
    revision: i64,
    payload_json: &str,
    updated_at_ms: i64,
) -> rusqlite::Result<SaveCurrentOutcome> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: Option<(i64, i64)> = transaction
        .query_row(
            "select schema_version, revision from workspace_state where id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    if let Some((stored_schema, stored_revision)) = current {
        if stored_schema < 1 || stored_schema > schema_version {
            transaction.commit()?;
            return Ok(SaveCurrentOutcome::Incompatible {
                stored_schema_version: stored_schema,
            });
        }
        if revision <= stored_revision {
            transaction.commit()?;
            return Ok(SaveCurrentOutcome::Stale {
                current_revision: stored_revision,
            });
        }
        transaction.execute(
            "update workspace_state set schema_version = ?1, revision = ?2, payload_json = ?3, updated_at_ms = ?4 where id = 1 and revision < ?2",
            params![schema_version, revision, payload_json, updated_at_ms],
        )?;
    } else {
        if revision <= 0 {
            transaction.commit()?;
            return Ok(SaveCurrentOutcome::Stale {
                current_revision: 0,
            });
        }
        transaction.execute(
            "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, ?1, ?2, ?3, ?4)",
            params![schema_version, revision, payload_json, updated_at_ms],
        )?;
    }

    transaction.commit()?;
    Ok(SaveCurrentOutcome::Saved { revision })
}

/// Explicit user reset is the only operation allowed to replace a current
/// layout whose stored schema or payload cannot be read by this application.
pub fn reset_current(
    connection: &mut Connection,
    schema_version: i64,
    payload_json: &str,
    updated_at_ms: i64,
) -> rusqlite::Result<i64> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current_revision: Option<i64> = transaction
        .query_row(
            "select revision from workspace_state where id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let revision = current_revision
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(rusqlite::Error::IntegralValueOutOfRange(0, i64::MAX))?;

    transaction.execute(
        "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, ?1, ?2, ?3, ?4) on conflict(id) do update set schema_version = excluded.schema_version, revision = excluded.revision, payload_json = excluded.payload_json, updated_at_ms = excluded.updated_at_ms",
        params![schema_version, revision, payload_json, updated_at_ms],
    )?;
    transaction.commit()?;
    Ok(revision)
}

pub fn list_presets(
    connection: &Connection,
) -> rusqlite::Result<Vec<WorkspaceLayoutPresetSummary>> {
    let mut statement = connection.prepare(
        "select id, name, schema_version, created_at_ms, updated_at_ms from workspace_layout_presets order by name collate nocase asc, id asc",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(WorkspaceLayoutPresetSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            schema_version: row.get(2)?,
            created_at_ms: row.get(3)?,
            updated_at_ms: row.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn get_preset(
    connection: &Connection,
    id: &str,
) -> rusqlite::Result<Option<WorkspaceLayoutPresetRow>> {
    connection
        .query_row(
            "select id, name, schema_version, payload_json, created_at_ms, updated_at_ms from workspace_layout_presets where id = ?1",
            params![id],
            |row| {
                Ok(WorkspaceLayoutPresetRow {
                    summary: WorkspaceLayoutPresetSummary {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        schema_version: row.get(2)?,
                        created_at_ms: row.get(4)?,
                        updated_at_ms: row.get(5)?,
                    },
                    payload_json: row.get(3)?,
                })
            },
        )
        .optional()
}

pub fn create_preset(
    connection: &mut Connection,
    id: &str,
    name: &str,
    schema_version: i64,
    payload_json: &str,
    now_ms: i64,
    max_presets: usize,
) -> rusqlite::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let count: i64 =
        transaction.query_row("select count(*) from workspace_layout_presets", [], |row| {
            row.get(0)
        })?;
    if count >= max_presets as i64 {
        return Err(rusqlite::Error::InvalidParameterName(
            "workspace layout preset limit reached".to_string(),
        ));
    }
    transaction.execute(
        "insert into workspace_layout_presets (id, name, schema_version, payload_json, created_at_ms, updated_at_ms) values (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, name, schema_version, payload_json, now_ms],
    )?;
    transaction.commit()
}

pub fn update_preset(
    connection: &Connection,
    id: &str,
    schema_version: i64,
    payload_json: &str,
    updated_at_ms: i64,
) -> rusqlite::Result<bool> {
    Ok(connection.execute(
        "update workspace_layout_presets set schema_version = ?2, payload_json = ?3, updated_at_ms = ?4 where id = ?1",
        params![id, schema_version, payload_json, updated_at_ms],
    )? > 0)
}

pub fn rename_preset(
    connection: &Connection,
    id: &str,
    name: &str,
    updated_at_ms: i64,
) -> rusqlite::Result<bool> {
    Ok(connection.execute(
        "update workspace_layout_presets set name = ?2, updated_at_ms = ?3 where id = ?1",
        params![id, name, updated_at_ms],
    )? > 0)
}

pub fn delete_preset(connection: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(connection.execute(
        "delete from workspace_layout_presets where id = ?1",
        params![id],
    )? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection;
    use crate::models::workspace_layout::{
        WorkspaceLayoutDocument, WorkspaceLayoutNode, WORKSPACE_LAYOUT_SCHEMA_VERSION,
    };
    use uuid::Uuid;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        connection
    }

    fn layout_json() -> String {
        WorkspaceLayoutDocument {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            tree: WorkspaceLayoutNode::Pane {
                id: "root".to_string(),
                pane_number: 1,
                contents: Vec::new(),
                active_content: None,
            },
            focused_pane_id: "root".to_string(),
            slots: Vec::new(),
            documents: Vec::new(),
            detached_contents: Vec::new(),
        }
        .to_json()
        .unwrap()
    }

    #[test]
    fn current_state_uses_revision_order_and_reset_increments_revision() {
        let mut connection = database();
        let json = layout_json();
        assert_eq!(
            save_current(&mut connection, 1, 1, &json, 10).unwrap(),
            SaveCurrentOutcome::Saved { revision: 1 }
        );
        assert_eq!(
            save_current(&mut connection, 1, 3, &json, 30).unwrap(),
            SaveCurrentOutcome::Saved { revision: 3 }
        );
        assert_eq!(
            save_current(&mut connection, 1, 2, &json, 20).unwrap(),
            SaveCurrentOutcome::Stale {
                current_revision: 3
            }
        );
        assert_eq!(get_current(&connection).unwrap().unwrap().revision, 3);
        assert_eq!(reset_current(&mut connection, 1, &json, 40).unwrap(), 4);
    }

    #[test]
    fn preset_crud_is_transactional_and_preset_count_is_bounded() {
        let mut connection = database();
        let json = layout_json();
        let id = Uuid::new_v4().to_string();
        create_preset(&mut connection, &id, "布局 A", 1, &json, 10, 1).unwrap();
        assert_eq!(list_presets(&connection).unwrap().len(), 1);
        assert!(create_preset(
            &mut connection,
            &Uuid::new_v4().to_string(),
            "布局 B",
            1,
            &json,
            11,
            1,
        )
        .is_err());
        assert_eq!(list_presets(&connection).unwrap().len(), 1);
        assert_eq!(
            get_preset(&connection, &id).unwrap().unwrap().payload_json,
            json
        );
        assert!(rename_preset(&connection, &id, "新布局", 20).unwrap());
        assert!(update_preset(&connection, &id, 1, &json, 30).unwrap());
        assert!(delete_preset(&connection, &id).unwrap());
        assert!(!delete_preset(&connection, &id).unwrap());
    }

    fn insert_row(connection: &Connection, schema_version: i64, revision: i64, payload: &str) {
        connection
            .execute(
                "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, ?1, ?2, ?3, 0)",
                params![schema_version, revision, payload],
            )
            .unwrap();
    }

    fn stored_row(connection: &Connection) -> (i64, i64, String) {
        let row = get_current(connection).unwrap().unwrap();
        (row.schema_version, row.revision, row.payload_json)
    }

    #[test]
    fn save_current_distinguishes_stale_from_incompatible_schema() {
        let json = layout_json();

        // 1) 0.3.0 升级用户：列值 1 的行，保存 revision 4 必须成功并把列同步写成 5。
        let mut connection = database();
        insert_row(&connection, 1, 3, "{\"legacy\":true}");
        assert_eq!(
            save_current(&mut connection, 5, 4, &json, 0).unwrap(),
            SaveCurrentOutcome::Saved { revision: 4 }
        );
        assert_eq!(stored_row(&connection), (5, 4, json.clone()));

        // 2) revision 落后或相等：Stale，行不变。
        let mut connection = database();
        insert_row(&connection, 5, 4, &json);
        for revision in [4, 2] {
            assert_eq!(
                save_current(&mut connection, 5, revision, &json, 0).unwrap(),
                SaveCurrentOutcome::Stale {
                    current_revision: 4
                }
            );
        }
        assert_eq!(stored_row(&connection), (5, 4, json.clone()));

        // 3) 存储版本高于当前支持：Incompatible，且绝不覆盖未来版本数据。
        let mut connection = database();
        insert_row(&connection, 99, 3, "{\"future\":true}");
        assert_eq!(
            save_current(&mut connection, 5, 4, &json, 0).unwrap(),
            SaveCurrentOutcome::Incompatible {
                stored_schema_version: 99
            }
        );
        assert_eq!(
            stored_row(&connection),
            (99, 3, "{\"future\":true}".to_string())
        );

        // 4) 没有行：revision <= 0 为 Stale{0}，revision 1 为 Saved。
        let mut connection = database();
        for revision in [0, -1] {
            assert_eq!(
                save_current(&mut connection, 5, revision, &json, 0).unwrap(),
                SaveCurrentOutcome::Stale {
                    current_revision: 0
                }
            );
        }
        assert!(get_current(&connection).unwrap().is_none());
        assert_eq!(
            save_current(&mut connection, 5, 1, &json, 0).unwrap(),
            SaveCurrentOutcome::Saved { revision: 1 }
        );

        // 5) 列值小于 1 的行：Incompatible。表上有 check (schema_version > 0)，
        //    所以用 ignore_check_constraints 构造这个防御分支的输入。
        let mut connection = database();
        connection
            .pragma_update(None, "ignore_check_constraints", "ON")
            .unwrap();
        insert_row(&connection, 0, 7, "{\"broken\":true}");
        connection
            .pragma_update(None, "ignore_check_constraints", "OFF")
            .unwrap();
        assert_eq!(
            save_current(&mut connection, 5, 9, &json, 0).unwrap(),
            SaveCurrentOutcome::Incompatible {
                stored_schema_version: 0
            }
        );
        assert_eq!(
            stored_row(&connection),
            (0, 7, "{\"broken\":true}".to_string())
        );
    }
}
