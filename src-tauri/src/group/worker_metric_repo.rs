







use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerMetric {
    pub worker_id: String,
    pub group_id: String,
    
    pub total_tokens: i64,
    
    pub total_duration_ms: i64,
    
    pub runs: i64,
    
    pub last_msg_count: i64,
    
    pub last_context_tokens: i64,
    
    pub last_total_tokens: i64,
    pub updated_at: i64,
    
    #[serde(default)]
    pub trace_id: Option<String>,
}

pub struct WorkerMetricRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> WorkerMetricRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    
    
    pub fn record(
        &self,
        worker_id: &str,
        group_id: &str,
        total_tokens: u64,
        duration_ms: u64,
        msg_count: i64,
        context_tokens: i64,
        trace_id: Option<&str>,
    ) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO worker_metrics \
                 (worker_id, group_id, total_tokens, total_duration_ms, runs, last_msg_count, last_context_tokens, last_total_tokens, updated_at, trace_id) \
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?3, ?7, ?8) \
                 ON CONFLICT(worker_id) DO UPDATE SET \
                    total_tokens = total_tokens + excluded.total_tokens, \
                    total_duration_ms = total_duration_ms + excluded.total_duration_ms, \
                    runs = runs + 1, \
                    last_msg_count = excluded.last_msg_count, \
                    last_context_tokens = excluded.last_context_tokens, \
                    last_total_tokens = excluded.last_total_tokens, \
                    updated_at = excluded.updated_at, \
                    trace_id = excluded.trace_id",
                params![
                    worker_id,
                    group_id,
                    total_tokens as i64,
                    duration_ms as i64,
                    msg_count,
                    context_tokens,
                    now_ms(),
                    trace_id,
                ],
            )?;
            Ok(())
        })
    }

    
    pub fn list_by_group(&self, group_id: &str) -> SqliteResult<Vec<WorkerMetric>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT worker_id, group_id, total_tokens, total_duration_ms, runs, \
                        last_msg_count, last_context_tokens, last_total_tokens, updated_at, trace_id \
                 FROM worker_metrics WHERE group_id = ?1",
            )?;
            let items = stmt
                .query_map(params![group_id], |row| {
                    Ok(WorkerMetric {
                        worker_id: row.get(0)?,
                        group_id: row.get(1)?,
                        total_tokens: row.get(2)?,
                        total_duration_ms: row.get(3)?,
                        runs: row.get(4)?,
                        last_msg_count: row.get(5)?,
                        last_context_tokens: row.get(6)?,
                        last_total_tokens: row.get(7)?,
                        updated_at: row.get(8)?,
                        trace_id: row.get(9)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
