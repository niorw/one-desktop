





use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use serde::{Deserialize, Serialize};


#[derive(Debug, Clone, Serialize)]
pub struct RunRecord {
    pub id: String,
    pub session_id: String,
    pub group_id: Option<String>,
    
    pub seat_id: Option<String>,
    
    pub kind: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    
    pub status: String,
    pub model: Option<String>,
    pub prompt_tokens: i64,
    pub output_tokens: i64,
    pub iterations: i64,
}

impl RunRecord {
    
    pub fn duration_ms(&self) -> Option<i64> {
        self.ended_at.map(|e| (e - self.started_at).max(0))
    }

    pub fn is_success(&self) -> bool {
        self.status == "ok"
    }
}


#[derive(Debug, Clone, Serialize)]
pub struct StepRecord {
    pub seq: i64,
    
    pub kind: String,
    pub name: Option<String>,
    pub origin: Option<String>,
    
    pub outcome: String,
    pub duration_ms: Option<i64>,
    pub started_at: i64,
    
    pub args_digest: Option<String>,
}


#[derive(Debug, Clone, Serialize)]
pub struct RunWithSteps {
    pub run: RunRecord,
    pub steps: Vec<StepRecord>,
}


#[derive(Debug, Clone, Serialize, Default)]
pub struct GroupRunSummary {
    pub run_count: i64,
    pub prompt_tokens: i64,
    pub output_tokens: i64,
    
    pub total_duration_ms: i64,
    
    pub est_cost_yuan: f64,
}


#[derive(Debug, Clone, Serialize)]
pub struct GroupInsight {
    pub summary: GroupRunSummary,
    pub runs: Vec<RunWithSteps>,
}


#[derive(Debug, Clone, Serialize, Default)]
pub struct SeatRunSummary {
    pub total_runs: i64,
    pub success_runs: i64,
    pub total_tokens: i64,
    pub total_duration_ms: i64,
    pub est_cost_yuan: f64,
}

impl SeatRunSummary {
    pub fn success_rate(&self) -> f64 {
        if self.total_runs == 0 {
            0.0
        } else {
            self.success_runs as f64 / self.total_runs as f64
        }
    }
}


#[derive(Debug, Clone, Serialize)]
pub struct SeatInsight {
    pub summary: SeatRunSummary,
    
    pub recent_runs: Vec<RunRecord>,
}


pub struct InsightQueries<'a> {
    db: &'a DbConnection,
}

impl<'a> InsightQueries<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    
    fn cost_table(&self) -> CostTable {
        self.db
            .with_conn(|conn| {
                let raw: Option<String> = conn
                    .query_row("SELECT value FROM settings WHERE key = ?1", ["cost_table"], |r| {
                        r.get(0)
                    })
                    .ok();
                match raw.and_then(|s| serde_json::from_str::<CostTable>(&s).ok()) {
                    Some(t) if !t.entries.is_empty() => Ok(t),
                    _ => Ok(CostTable::builtin_default()),
                }
            })
            .unwrap_or_else(|_| CostTable::builtin_default())
    }

    
    pub fn group_summary(&self, group_id: &str) -> SqliteResult<GroupRunSummary> {
        
        
        let cost_table = self.cost_table();
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(output_tokens),0),
                        COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN ended_at - started_at ELSE 0 END),0)
                 FROM runs WHERE group_id = ?1",
            )?;
            let (run_count, prompt_tokens, output_tokens, total_duration_ms): (i64, i64, i64, i64) =
                stmt.query_row(params![group_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?;
            
            let mut est_cost_yuan = 0.0_f64;
            let runs = self.runs_raw(&conn, group_id)?;
            for r in &runs {
                est_cost_yuan += cost_yuan(
                    &cost_table,
                    r.model.as_deref(),
                    r.prompt_tokens,
                    r.output_tokens,
                );
            }
            Ok(GroupRunSummary {
                run_count,
                prompt_tokens,
                output_tokens,
                total_duration_ms,
                est_cost_yuan,
            })
        })
    }

    
    pub fn group_runs(&self, group_id: &str) -> SqliteResult<Vec<RunWithSteps>> {
        self.db.with_conn(|conn| {
            let runs = self.runs_raw(&conn, group_id)?;
            
            let mut steps_by_run: std::collections::HashMap<String, Vec<StepRecord>> =
                std::collections::HashMap::new();
            let mut stmt = conn.prepare(
                "SELECT s.run_id, s.seq, s.kind, s.name, s.origin, s.outcome, s.duration_ms, s.started_at, s.args_digest \
                 FROM run_steps s JOIN runs r ON s.run_id = r.id \
                 WHERE r.group_id = ?1 ORDER BY s.run_id, s.seq",
            )?;
            let rows = stmt.query_map(params![group_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    StepRecord {
                        seq: row.get(1)?,
                        kind: row.get(2)?,
                        name: row.get(3)?,
                        origin: row.get(4)?,
                        outcome: row.get(5)?,
                        duration_ms: row.get(6)?,
                        started_at: row.get(7)?,
                        args_digest: row.get(8)?,
                    },
                ))
            })?;
            for row in rows.flatten() {
                steps_by_run.entry(row.0).or_default().push(row.1);
            }
            Ok(runs
                .into_iter()
                .map(|run| RunWithSteps {
                    steps: steps_by_run.remove(&run.id).unwrap_or_default(),
                    run,
                })
                .collect())
        })
    }

    
    pub fn seat_summary(&self, seat_id: &str) -> SqliteResult<SeatRunSummary> {
        
        let cost_table = self.cost_table();
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END),0),
                        COALESCE(SUM(prompt_tokens + output_tokens),0),
                        COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN ended_at - started_at ELSE 0 END),0)
                 FROM runs WHERE seat_id = ?1",
            )?;
            let (total_runs, success_runs, total_tokens, total_duration_ms): (i64, i64, i64, i64) =
                stmt.query_row(params![seat_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?;
            
            let mut est_cost_yuan = 0.0_f64;
            for r in self.seat_runs_conn(&conn, seat_id, i64::MAX)? {
                est_cost_yuan += cost_yuan(
                    &cost_table,
                    r.model.as_deref(),
                    r.prompt_tokens,
                    r.output_tokens,
                );
            }
            Ok(SeatRunSummary {
                total_runs,
                success_runs,
                total_tokens,
                total_duration_ms,
                est_cost_yuan,
            })
        })
    }

    
    pub fn seat_runs(&self, seat_id: &str, limit: i64) -> SqliteResult<Vec<RunRecord>> {
        self.db
            .with_conn(|conn| self.seat_runs_conn(&conn, seat_id, limit))
    }

    fn runs_raw(&self, conn: &rusqlite::Connection, group_id: &str) -> SqliteResult<Vec<RunRecord>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, group_id, seat_id, kind, started_at, ended_at, status, model,
                    prompt_tokens, output_tokens, iterations
             FROM runs WHERE group_id = ?1 ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![group_id], |row| {
            Ok(RunRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                group_id: row.get(2)?,
                seat_id: row.get(3)?,
                kind: row.get(4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
                status: row.get(7)?,
                model: row.get(8)?,
                prompt_tokens: row.get(9)?,
                output_tokens: row.get(10)?,
                iterations: row.get(11)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    fn seat_runs_conn(
        &self,
        conn: &rusqlite::Connection,
        seat_id: &str,
        limit: i64,
    ) -> SqliteResult<Vec<RunRecord>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, group_id, seat_id, kind, started_at, ended_at, status, model,
                    prompt_tokens, output_tokens, iterations
             FROM runs WHERE seat_id = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![seat_id, limit], |row| {
            Ok(RunRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                group_id: row.get(2)?,
                seat_id: row.get(3)?,
                kind: row.get(4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
                status: row.get(7)?,
                model: row.get(8)?,
                prompt_tokens: row.get(9)?,
                output_tokens: row.get(10)?,
                iterations: row.get(11)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}




#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CostTable {
    
    pub entries: Vec<CostEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostEntry {
    pub pattern: String,
    pub in_price: f64,
    pub out_price: f64,
}

impl CostTable {
    
    pub fn builtin_default() -> Self {
        CostTable {
            entries: vec![
                CostEntry { pattern: "deepseek".into(), in_price: 2.0, out_price: 8.0 },
                CostEntry { pattern: "gpt-4".into(), in_price: 10.0, out_price: 30.0 },
                CostEntry { pattern: "*".into(), in_price: 2.0, out_price: 8.0 },
            ],
        }
    }

    
    pub fn lookup(&self, model: Option<&str>) -> (f64, f64) {
        let m = model.unwrap_or("").to_lowercase();
        for e in &self.entries {
            if e.pattern == "*" || m.contains(&e.pattern.to_lowercase()) {
                return (e.in_price, e.out_price);
            }
        }
        (2.0, 8.0)
    }
}


fn cost_yuan(table: &CostTable, model: Option<&str>, prompt_tokens: i64, output_tokens: i64) -> f64 {
    let (p_in, p_out) = table.lookup(model);
    (prompt_tokens as f64 / 1_000_000.0) * p_in + (output_tokens as f64 / 1_000_000.0) * p_out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_uses_deepseek_default() {
        let t = CostTable::builtin_default();
        assert!((cost_yuan(&t, Some("deepseek-chat"), 1_000_000, 0) - 2.0).abs() < 1e-9);
        assert!((cost_yuan(&t, Some("deepseek-chat"), 0, 1_000_000) - 8.0).abs() < 1e-9);
        
        assert!((cost_yuan(&t, None, 1_000_000, 1_000_000) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn cost_custom_table_overrides_builtin() {
        let t = CostTable {
            entries: vec![
                CostEntry { pattern: "kimi".into(), in_price: 1.0, out_price: 4.0 },
                CostEntry { pattern: "*".into(), in_price: 3.0, out_price: 12.0 },
            ],
        };
        
        assert!((cost_yuan(&t, Some("moonshot-kimi"), 1_000_000, 1_000_000) - 5.0).abs() < 1e-9);
        
        assert!((cost_yuan(&t, Some("deepseek-chat"), 1_000_000, 1_000_000) - 15.0).abs() < 1e-9);
    }
}

#[cfg(test)]
mod deadlock_tests {
    
    
    

    use super::*;
    use crate::storage::connection::DbConnection;

    fn tmp_db(tag: &str) -> std::sync::Arc<DbConnection> {
        let dir = std::env::temp_dir().join(format!("od_deadlock_{}_{}", std::process::id(), tag));
        std::fs::create_dir_all(&dir).unwrap();
        std::sync::Arc::new(DbConnection::open(&dir).unwrap())
    }

    
    
    
    
    struct Watchdog {
        done: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl Watchdog {
        fn new(name: &'static str) -> Self {
            use std::sync::atomic::Ordering;
            let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag = done.clone();
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while std::time::Instant::now() < deadline {
                    if flag.load(Ordering::Relaxed) {
                        return; 
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                if !flag.load(Ordering::Relaxed) {
                    eprintln!("[deadlock] {} 超时未返回——疑似 with_conn 嵌套自锁!", name);
                    std::process::exit(99);
                }
            });
            Self { done }
        }
    }

    impl Drop for Watchdog {
        fn drop(&mut self) {
            self.done.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    #[test]
    fn group_summary_with_runs_does_not_deadlock() {
        let _wd = Watchdog::new("group_summary");
        let db = tmp_db("gs");
        
        let ledger = crate::agent::ledger_sqlite::SqliteRunLedger::new(db.clone());
        use crate::agent::ledger::*;
        let r = ledger.begin(RunBegin {
            run_id: uuid::Uuid::new_v4().to_string(),
            session_id: "rt:g:w".into(),
            group_id: Some("g".into()),
            seat_id: Some("w".into()),
            kind: RunKind::Worker,
            model: Some("deepseek-chat".into()),
            job_id: None,
            attempt_no: 1,
        });
        ledger.finish(&r, RunFinish {
            status: RunStatus::Ok,
            ended_at: crate::agent::ledger::now_unix_ms() + 100,
            model: Some("deepseek-chat".into()),
            prompt_tokens: 1000,
            output_tokens: 500,
            reasoning_tokens: 0,
            iterations: 1,
            error_kind: None,
        });

        let q = InsightQueries::new(db.as_ref());
        let s = q.group_summary("g").expect("group_summary");
        assert_eq!(s.run_count, 1);
        assert!(s.est_cost_yuan > 0.0, "cost should be computed");
    }

    #[test]
    fn seat_summary_with_runs_does_not_deadlock() {
        let _wd = Watchdog::new("seat_summary");
        let db = tmp_db("ss");
        let ledger = crate::agent::ledger_sqlite::SqliteRunLedger::new(db.clone());
        use crate::agent::ledger::*;
        let r = ledger.begin(RunBegin {
            run_id: uuid::Uuid::new_v4().to_string(),
            session_id: "rt:g:w".into(),
            group_id: Some("g".into()),
            seat_id: Some("w".into()),
            kind: RunKind::Worker,
            model: Some("deepseek-chat".into()),
            job_id: None,
            attempt_no: 1,
        });
        ledger.finish(&r, RunFinish {
            status: RunStatus::Ok,
            ended_at: crate::agent::ledger::now_unix_ms() + 100,
            model: Some("deepseek-chat".into()),
            prompt_tokens: 1000,
            output_tokens: 500,
            reasoning_tokens: 0,
            iterations: 1,
            error_kind: None,
        });

        let q = InsightQueries::new(db.as_ref());
        let s = q.seat_summary("w").expect("seat_summary");
        assert_eq!(s.total_runs, 1);
        assert!(s.est_cost_yuan > 0.0, "cost should be computed");
    }
}
