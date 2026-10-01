use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::models::workspace_layout::WorkspaceLayoutPresetSummary;

#[derive(Debug, Clone)]
pub struct WorkspaceLayoutRow {
    pub schema_version: i64,
    pub revision: i64,
    pub payload_json: String,
    pub updated_at_ms: i64,
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
pub fn save_current(
    connection: &mut Connection,
    schema_version: i64,
    revision: i64,
    payload_json: &str,
    updated_at_ms: i64,
) -> rusqlite::Result<(bool, i64)> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: Option<(i64, i64)> = transaction
        .query_row(
            "select schema_version, revision from workspace_state where id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    if let Some((stored_schema, stored_revision)) = current {
        if stored_schema != schema_version || revision <= stored_revision {
            transaction.commit()?;
            return Ok((false, stored_revision));
        }
        transaction.execute(
            "update workspace_state set schema_version = ?1, revision = ?2, payload_json = ?3, updated_at_ms = ?4 where id = 1 and schema_version = ?1 and revision < ?2",
            params![schema_version, revision, payload_json, updated_at_ms],
        )?;
    } else {
        if revision <= 0 {
            transaction.commit()?;
            return Ok((false, 0));
        }
        transaction.execute(
            "insert into workspace_state (id, schema_version, revision, payload_json, updated_at_ms) values (1, ?1, ?2, ?3, ?4)",
            params![schema_version, revision, payload_json, updated_at_ms],
        )?;
    }

    transaction.commit()?;
    Ok((true, revision))
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
    use crate::models::workspace_layout::{WorkspaceLayoutDocument, WorkspaceLayoutNode};
    use uuid::Uuid;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection::apply_migrations(&connection).unwrap();
        connection
    }

    fn layout_json() -> String {
        WorkspaceLayoutDocument {
            schema_version: 1,
            tree: WorkspaceLayoutNode::Pane {
                id: "root".to_string(),
                pane_number: 1,
                session_ids: Vec::new(),
                active_session_id: None,
            },
            focused_pane_id: "root".to_string(),
            slots: Vec::new(),
            detached_slot_ids: Vec::new(),
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
            (true, 1)
        );
        assert_eq!(
            save_current(&mut connection, 1, 3, &json, 30).unwrap(),
            (true, 3)
        );
        assert_eq!(
            save_current(&mut connection, 1, 2, &json, 20).unwrap(),
            (false, 3)
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
}
