








use crate::agent::ledger::*;
use crate::storage::connection::DbConnection;
use rusqlite::params;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const FLUSH_INTERVAL_MS: u64 = 200;
const FLUSH_BATCH: usize = 32;

enum LedgerMsg {
    Step { run_id: String, step: RunStep },
    Flush(Sender<()>),
}



pub struct SqliteRunLedger {
    db: Arc<DbConnection>,
    tx: Sender<LedgerMsg>,
}

impl SqliteRunLedger {
    pub fn new(db: Arc<DbConnection>) -> Self {
        let (tx, rx) = mpsc::channel::<LedgerMsg>();
        let worker_db = db.clone();
        thread::spawn(move || Self::worker(worker_db, rx));
        Self { db, tx }
    }

    fn worker(db: Arc<DbConnection>, rx: Receiver<LedgerMsg>) {
        let mut buf: Vec<(String, RunStep)> = Vec::with_capacity(FLUSH_BATCH);
        let mut next_seq: HashMap<String, u64> = HashMap::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(FLUSH_INTERVAL_MS)) {
                Ok(LedgerMsg::Step { run_id, step }) => {
                    buf.push((run_id, step));
                    if buf.len() >= FLUSH_BATCH {
                        Self::flush(&db, &mut buf, &mut next_seq);
                    }
                }
                Ok(LedgerMsg::Flush(ack)) => {
                    Self::flush(&db, &mut buf, &mut next_seq);
                    let _ = ack.send(());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !buf.is_empty() {
                        Self::flush(&db, &mut buf, &mut next_seq);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !buf.is_empty() {
                        Self::flush(&db, &mut buf, &mut next_seq);
                    }
                    break;
                }
            }
        }
    }

    fn flush(
        db: &Arc<DbConnection>,
        buf: &mut Vec<(String, RunStep)>,
        next_seq: &mut HashMap<String, u64>,
    ) {
        if buf.is_empty() {
            return;
        }
        
        
        let rows: Vec<(
            String,
            u64,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            i64,
        )> = buf
            .iter()
            .map(|(run_id, s)| {
                let seq = next_seq.entry(run_id.clone()).or_insert(0);
                *seq += 1;
                (
                    run_id.clone(),
                    *seq,
                    s.kind.as_str().to_string(),
                    s.name.clone(),
                    s.origin.clone(),
                    s.args_digest.clone(),
                    s.outcome.as_str().to_string(),
                    s.unavailable_reason.map(|u| u.as_str().to_string()),
                    s.approval_source.map(|a| a.as_str().to_string()),
                    s.approval_decision.map(|d| d.as_str().to_string()),
                    s.duration_ms.map(|d| d as i64),
                    s.started_at,
                )
            })
            .collect();

        let _ = db.with_conn_mut(|conn| {
            let tx = conn.transaction()?;
            for r in &rows {
                tx.execute(
                    "INSERT INTO run_steps \
                     (run_id, seq, kind, name, origin, args_digest, outcome, \
                      unavailable_reason, approval_source, approval_decision, duration_ms, started_at) \
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    params![
                        &r.0, r.1, &r.2, &r.3, &r.4, &r.5, &r.6, &r.7, &r.8, &r.9, &r.10, r.11
                    ],
                )?;
            }
            tx.commit()?;
            Ok::<(), rusqlite::Error>(())
        });
        buf.clear();
    }
}

impl RunLedger for SqliteRunLedger {
    fn begin(&self, r: RunBegin) -> RunId {
        let started_at = now_unix_ms();
        let _ = self.db.with_conn_mut(|conn| {
            conn.execute(
                "INSERT INTO runs (id, session_id, group_id, seat_id, kind, started_at, status, model, job_id, attempt_no) \
                 VALUES (?,?,?,?,?,?,'running',?,?,?)",
                params![
                    r.run_id,
                    r.session_id,
                    r.group_id,
                    r.seat_id,
                    r.kind.as_str(),
                    started_at,
                    r.model,
                    r.job_id,
                    r.attempt_no as i64
                ],
            )
        });
        r.run_id.clone()
    }

    fn step(&self, id: &str, s: RunStep) {
        
        let _ = self.tx.send(LedgerMsg::Step {
            run_id: id.to_string(),
            step: s,
        });
    }

    
    
    
    
    
    
    
    fn checkpoint(&self, id: &str, cp: Checkpoint) {
        let json = serde_json::to_string(&cp).unwrap_or_default();
        let _ = self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE runs SET checkpoint_json=?1, current_step=?2 WHERE id=?3",
                params![json, cp.iteration as i64, id],
            )
        });
    }

    fn finish(&self, id: &str, f: RunFinish) {
        
        let (ack_tx, ack_rx) = mpsc::channel::<()>();
        let _ = self.tx.send(LedgerMsg::Flush(ack_tx));
        let _ = ack_rx.recv(); 

        let _ = self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE runs SET ended_at=?, status=?, model=?, prompt_tokens=?, \
                 output_tokens=?, reasoning_tokens=?, iterations=?, error_kind=? WHERE id=?",
                params![
                    f.ended_at,
                    f.status.as_str(),
                    f.model,
                    f.prompt_tokens as i64,
                    f.output_tokens as i64,
                    f.reasoning_tokens as i64,
                    f.iterations as i64,
                    f.error_kind,
                    id
                ],
            )
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ledger::{RunBegin, RunKind};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_db() -> Arc<DbConnection> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = PathBuf::from(std::env::temp_dir())
            .join(format!("onedesktop_ledger_test_{}_{}", std::process::id(), n));
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    
    
    #[test]
    fn begin_uses_provided_run_id() {
        let db = tmp_db();
        let ledger = SqliteRunLedger::new(db);
        let provided = "fixed-run-id-001";
        let returned = ledger.begin(RunBegin {
            run_id: provided.to_string(),
            session_id: "s".into(),
            group_id: None,
            seat_id: None,
            kind: RunKind::Chat,
            model: None,
            job_id: None,
            attempt_no: 1,
        });
        assert_eq!(returned, provided, "begin 必须原样返回调用方传入的 run_id");
    }
}
