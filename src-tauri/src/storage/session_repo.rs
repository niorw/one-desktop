

use crate::session::model::{CreateSessionPayload, Session, SessionQuery};
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use rusqlite::{params, Result as SqliteResult};

pub struct SessionRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> SessionRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }
}

impl<'a> Repository<Session, CreateSessionPayload, SessionQuery> for SessionRepository<'a> {
    fn create(&self, payload: CreateSessionPayload) -> SqliteResult<Session> {
        let now = chrono::Utc::now().to_rfc3339();
        let session = Session {
            id: payload.id,
            title: payload.title,
            model: payload.model,
            preamble: payload.preamble,
            created_at: now.clone(),
            updated_at: now,
            mode: payload.mode,
            group_id: payload.group_id,
            workspace_id: payload.workspace_id,
        };

        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, title, model, preamble, created_at, updated_at, mode, group_id, workspace_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    session.id,
                    session.title,
                    session.model,
                    session.preamble,
                    session.created_at,
                    session.updated_at,
                    session.mode,
                    session.group_id,
                    session.workspace_id,
                ],
            )?;
            Ok(())
        })?;

        tracing::info!(
            target: "onedesktop.storage",
            session_id = %session.id,
            title = %session.title,
            "Session created"
        );
        Ok(session)
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<Session>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, model, preamble, created_at, updated_at, mode, group_id, workspace_id
                 FROM sessions WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], |row| {
                Ok(Session {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    model: row.get(2)?,
                    preamble: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    mode: row.get(6)?,
                    group_id: row.get(7)?,
                    workspace_id: row.get(8)?,
                })
            })?;
            match rows.next() {
                Some(Ok(session)) => Ok(Some(session)),
                _ => Ok(None),
            }
        })
    }

    fn find_all(&self, _query: SessionQuery) -> SqliteResult<Vec<Session>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, model, preamble, created_at, updated_at, mode, group_id, workspace_id
                 FROM sessions ORDER BY updated_at DESC",
            )?;
            let sessions = stmt
                .query_map([], |row| {
                    Ok(Session {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        model: row.get(2)?,
                        preamble: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        mode: row.get(6)?,
                        group_id: row.get(7)?,
                        workspace_id: row.get(8)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(sessions)
        })
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute("DELETE FROM messages WHERE session_id = ?1", params![id])?;
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
            Ok(())
        })?;
        tracing::info!(target: "onedesktop.storage", session_id = %id, "Session deleted");
        Ok(())
    }
}
