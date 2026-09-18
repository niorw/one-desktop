

use crate::group::worker::{CreateWorkerPayload, Worker, WorkerStatus};
use crate::group::SeatType;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use rusqlite::{params, Result as SqliteResult};

pub struct WorkerRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> WorkerRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    pub fn update_status(&self, id: &str, status: WorkerStatus) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE workers SET status = ?1 WHERE id = ?2",
                params![serde_json::to_string(&status).unwrap(), id],
            )?;
            Ok(())
        })
    }

    
    pub fn release(&self, id: &str) -> SqliteResult<()> {
        self.update_status(id, WorkerStatus::Idle)
    }

    
    pub fn update_agent(
        &self,
        id: &str,
        agent_ref: &str,
        capabilities: &[String],
    ) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE workers SET agent_ref = ?1, capabilities = ?2 WHERE id = ?3",
                params![
                    agent_ref,
                    serde_json::to_string(capabilities).unwrap_or_else(|_| "[]".into()),
                    id
                ],
            )?;
            Ok(())
        })
    }

    
    pub fn update_current_task(&self, id: &str, task_id: Option<String>) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE workers SET current_task_id = ?1 WHERE id = ?2",
                params![task_id, id],
            )?;
            Ok(())
        })
    }

    pub fn list_by_group(&self, group_id: &str) -> SqliteResult<Vec<Worker>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat \
                 FROM workers WHERE group_id = ?1",
            )?;
            let items = stmt
                .query_map(params![group_id], map_row)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }
}

fn map_row(row: &rusqlite::Row) -> SqliteResult<Worker> {
    Ok(Worker {
        id: row.get(0)?,
        group_id: row.get(1)?,
        agent_ref: row.get(2)?,
        seat_type: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or(SeatType::Static),
        status: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or(WorkerStatus::Idle),
        max_concurrency: row.get(5)?,
        capabilities: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
        current_task_id: row.get(7)?,
        last_heartbeat: row.get(8)?,
    })
}

impl<'a> Repository<Worker, CreateWorkerPayload, ()> for WorkerRepository<'a> {
    fn create(&self, p: CreateWorkerPayload) -> SqliteResult<Worker> {
        let id = format!("wk_{}", uuid::Uuid::new_v4().simple());
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO workers (id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    id,
                    p.group_id,
                    p.agent_ref,
                    serde_json::to_string(&p.seat_type).unwrap_or_else(|_| "\"Static\"".into()),
                    serde_json::to_string(&WorkerStatus::Idle).unwrap(),
                    p.max_concurrency,
                    serde_json::to_string(&p.capabilities).unwrap_or_else(|_| "[]".into()),
                    Option::<String>::None,
                    Option::<i64>::None,
                ],
            )
        })?;
        self.find_by_id(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<Worker>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat \
                 FROM workers WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], map_row)?;
            match rows.next() {
                Some(Ok(w)) => Ok(Some(w)),
                _ => Ok(None),
            }
        })
    }

    fn find_all(&self, _query: ()) -> SqliteResult<Vec<Worker>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat \
                 FROM workers",
            )?;
            let items = stmt.query_map([], map_row)?.filter_map(|r| r.ok()).collect();
            Ok(items)
        })
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute("DELETE FROM workers WHERE id = ?1", params![id])?;
            Ok(())
        })
    }
}
