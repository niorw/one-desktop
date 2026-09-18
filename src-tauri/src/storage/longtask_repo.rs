






















use crate::agent::ledger::Checkpoint;
use crate::storage::connection::DbConnection;
use rusqlite::{params, Result as SqliteResult};
use serde::{Deserialize, Serialize};





const RESUMABLE_KINDS: [&str; 2] = ["chat", "scheduled"];


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumableRun {
    pub run_id: String,
    pub session_id: String,
    
    pub session_title: String,
    
    pub job_id: Option<String>,
    
    pub kind: String,
    
    pub status: String,
    pub attempt_no: u32,
    
    pub iteration: u32,
    
    pub tokens_used: u64,
    pub model: Option<String>,
    pub started_at: i64,
}

pub struct LongTaskRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> LongTaskRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    
    
    
    
    
    
    pub fn mark_orphans_interrupted(&self) -> SqliteResult<usize> {
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE runs SET status='interrupted', ended_at=COALESCE(ended_at, ?1) \
                 WHERE status='running' AND kind IN ('chat','scheduled')",
                params![crate::agent::ledger::now_unix_ms()],
            )
        })
    }

    
    
    
    
    
    pub fn list_resumable(&self, limit: u32) -> SqliteResult<Vec<ResumableRun>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT r.id, r.session_id, COALESCE(s.title, r.session_id), r.job_id, r.kind, \
                        r.status, COALESCE(r.attempt_no,1), COALESCE(r.checkpoint_json,''), \
                        r.model, r.started_at \
                 FROM runs r LEFT JOIN sessions s ON s.id = r.session_id \
                 WHERE r.status IN ('paused','interrupted') AND r.kind IN ('chat','scheduled') \
                   AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = r.job_id) \
                 ORDER BY r.started_at DESC LIMIT ?1",
            )?;
            let list = stmt
                .query_map(params![limit as i64], row_to_resumable)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(list)
        })
    }

    
    pub fn get_run(&self, run_id: &str) -> SqliteResult<Option<ResumableRun>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT r.id, r.session_id, COALESCE(s.title, r.session_id), r.job_id, r.kind, \
                        r.status, COALESCE(r.attempt_no,1), COALESCE(r.checkpoint_json,''), \
                        r.model, r.started_at \
                 FROM runs r LEFT JOIN sessions s ON s.id = r.session_id \
                 WHERE r.id = ?1",
            )?;
            let mut rows = stmt.query_map(params![run_id], row_to_resumable)?;
            match rows.next() {
                Some(Ok(v)) => Ok(Some(v)),
                _ => Ok(None),
            }
        })
    }

    
    pub fn latest_run_of_job(&self, job_id: &str) -> SqliteResult<Option<ResumableRun>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT r.id, r.session_id, COALESCE(s.title, r.session_id), r.job_id, r.kind, \
                        r.status, COALESCE(r.attempt_no,1), COALESCE(r.checkpoint_json,''), \
                        r.model, r.started_at \
                 FROM runs r LEFT JOIN sessions s ON s.id = r.session_id \
                 WHERE r.job_id = ?1 ORDER BY r.started_at DESC LIMIT 1",
            )?;
            let mut rows = stmt.query_map(params![job_id], row_to_resumable)?;
            match rows.next() {
                Some(Ok(v)) => Ok(Some(v)),
                _ => Ok(None),
            }
        })
    }

    
    
    
    
    
    pub fn latest_resumable_run_of_job(&self, job_id: &str) -> SqliteResult<Option<ResumableRun>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT r.id, r.session_id, COALESCE(s.title, r.session_id), r.job_id, r.kind, \
                        r.status, COALESCE(r.attempt_no,1), COALESCE(r.checkpoint_json,''), \
                        r.model, r.started_at \
                 FROM runs r LEFT JOIN sessions s ON s.id = r.session_id \
                 WHERE r.job_id = ?1 AND r.status IN ('paused','interrupted') \
                 ORDER BY r.started_at DESC LIMIT 1",
            )?;
            let mut rows = stmt.query_map(params![job_id], row_to_resumable)?;
            match rows.next() {
                Some(Ok(v)) => Ok(Some(v)),
                _ => Ok(None),
            }
        })
    }

    
    
    pub fn mark_superseded_by_job(&self, job_id: &str) -> SqliteResult<usize> {
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE runs SET status='superseded' WHERE job_id=?1 AND status IN ('paused','interrupted')",
                params![job_id],
            )
        })
    }

    
    
    
    
    pub fn latest_run_of_session(&self, session_id: &str) -> SqliteResult<Option<ResumableRun>> {        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT r.id, r.session_id, COALESCE(s.title, r.session_id), r.job_id, r.kind, \
                        r.status, COALESCE(r.attempt_no,1), COALESCE(r.checkpoint_json,''), \
                        r.model, r.started_at \
                 FROM runs r LEFT JOIN sessions s ON s.id = r.session_id \
                 WHERE r.session_id = ?1 ORDER BY r.started_at DESC LIMIT 1",
            )?;
            let mut rows = stmt.query_map(params![session_id], row_to_resumable)?;
            match rows.next() {
                Some(Ok(v)) => Ok(Some(v)),
                _ => Ok(None),
            }
        })
    }

    
    
    
    pub fn mark_superseded(&self, run_id: &str) -> SqliteResult<()> {
        self.db
            .with_conn_mut(|c| {
                c.execute(
                    "UPDATE runs SET status='superseded' WHERE id=?1 AND status IN ('paused','interrupted')",
                    params![run_id],
                )
            })
            .map(|_| ())
    }

    
    
    
    
    
    
    
    pub fn stamp_job_started(&self, task_id: &str, session_id: &str) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db
            .with_conn_mut(|c| {
                c.execute(
                    "UPDATE scheduled_tasks SET session_id=?1, started_at=?2, finished_at=NULL, \
                     updated_at=?2 WHERE id=?3",
                    params![session_id, now, task_id],
                )
            })
            .map(|_| ())
    }

    
    pub fn stamp_job_finished(&self, task_id: &str, run_id: &str) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db
            .with_conn_mut(|c| {
                c.execute(
                    "UPDATE scheduled_tasks SET last_run_id=?1, finished_at=?2, updated_at=?2 \
                     WHERE id=?3",
                    params![run_id, now, task_id],
                )
            })
            .map(|_| ())
    }

    
    pub fn is_resumable_kind(kind: &str) -> bool {
        RESUMABLE_KINDS.contains(&kind)
    }

    
    
    
    
    
    
    pub fn list_recoverable(&self, cutoff_ms: i64, limit: u32) -> SqliteResult<Vec<ResumableRun>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT r.id, r.session_id, COALESCE(s.title, r.session_id), r.job_id, r.kind, \
                        r.status, COALESCE(r.attempt_no,1), COALESCE(r.checkpoint_json,''), \
                        r.model, r.started_at \
                 FROM runs r LEFT JOIN sessions s ON s.id = r.session_id \
                 WHERE r.dismissed_at IS NULL \
                   AND r.kind IN ('chat','scheduled') \
                   AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = r.job_id) \
                   AND (r.status = 'paused' \
                        OR (r.status = 'interrupted' AND r.started_at >= ?1)) \
                 ORDER BY r.started_at DESC LIMIT ?2",
            )?;
            let list = stmt
                .query_map(params![cutoff_ms, limit as i64], row_to_resumable)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(list)
        })
    }

    
    
    pub fn dismiss_interruption(&self, run_id: &str) -> SqliteResult<usize> {
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE runs SET dismissed_at = ?1 WHERE id = ?2 AND status = 'interrupted'",
                params![crate::agent::ledger::now_unix_ms(), run_id],
            )
        })
    }

    
    pub fn dismiss_all_interruptions(&self) -> SqliteResult<usize> {
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE runs SET dismissed_at = ?1 \
                 WHERE status = 'interrupted' AND dismissed_at IS NULL",
                params![crate::agent::ledger::now_unix_ms()],
            )
        })
    }

    
    
    pub fn sweep_expired_interruptions(&self, cutoff_ms: i64) -> SqliteResult<usize> {
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE runs SET dismissed_at = ?1 \
                 WHERE status = 'interrupted' AND dismissed_at IS NULL AND started_at < ?2",
                params![crate::agent::ledger::now_unix_ms(), cutoff_ms],
            )
        })
    }
}


pub fn read_retention_days(db: &DbConnection) -> i64 {
    db.with_conn(|c| {
        let v = c
            .query_row(
                "SELECT value FROM settings WHERE key = 'interrupted_retention_days'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(14);
        Ok(v)
    })
    .unwrap_or(14)
}


pub fn read_auto_clean(db: &DbConnection) -> bool {
    db.with_conn(|c| {
        let v = c
            .query_row(
                "SELECT value FROM settings WHERE key = 'interrupted_auto_clean'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .map(|s| s != "0" && s != "off")
            .unwrap_or(true);
        Ok(v)
    })
    .unwrap_or(true)
}








pub fn recover_in_flight_tasks(db: &DbConnection) -> usize {
    let repo = LongTaskRepository::new(db);
    let orphans = match repo.mark_orphans_interrupted() {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(
                target: "onedesktop.longtask",
                error = %e,
                "启动恢复失败：孤儿 run 改判未完成（不影响启动）"
            );
            return 0;
        }
    };
    
    
    if read_auto_clean(db) {
        let retention_days = read_retention_days(db).max(0);
        if retention_days > 0 {
            let cutoff = crate::agent::ledger::now_unix_ms() - retention_days * 86_400_000;
            if let Ok(n) = repo.sweep_expired_interruptions(cutoff) {
                if n > 0 {
                    tracing::info!(
                        target: "onedesktop.longtask",
                        swept = n,
                        retention_days = retention_days,
                        "启动过期清理：已隐藏过期崩溃中断"
                    );
                }
            }
        }
    }
    let resumable = repo.list_resumable(50).map(|v| v.len()).unwrap_or(0);
    if orphans > 0 || resumable > 0 {
        tracing::info!(
            target: "onedesktop.longtask",
            orphans_marked = orphans,
            resumable_total = resumable,
            "启动恢复完成（等待用户在恢复面板确认续跑）"
        );
    }
    orphans
}

fn row_to_resumable(row: &rusqlite::Row) -> rusqlite::Result<ResumableRun> {
    let cp_json: String = row.get(7)?;
    
    
    let cp: Checkpoint = serde_json::from_str(&cp_json).unwrap_or(Checkpoint {
        iteration: 0,
        tokens_used: 0,
        ts: 0,
    });
    Ok(ResumableRun {
        run_id: row.get(0)?,
        session_id: row.get(1)?,
        session_title: row.get(2)?,
        job_id: row.get(3)?,
        kind: row.get(4)?,
        status: row.get(5)?,
        attempt_no: row.get::<_, i64>(6)? as u32,
        iteration: cp.iteration,
        tokens_used: cp.tokens_used,
        model: row.get(8)?,
        started_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db() -> DbConnection {
        let dir = std::env::temp_dir().join(format!("od_longtask_{}", uuid::Uuid::new_v4().simple()));
        DbConnection::open(&dir).expect("open test db")
    }

    
    fn seed_run(
        db: &DbConnection,
        id: &str,
        session_id: &str,
        kind: &str,
        status: &str,
        job_id: Option<&str>,
        started_at: i64,
        cp: Option<(u32, u64)>,
    ) {
        let cp_json = cp.map(|(it, tk)| {
            serde_json::to_string(&Checkpoint {
                iteration: it,
                tokens_used: tk,
                ts: started_at,
            })
            .unwrap()
        });
        db.with_conn_mut(|c| {
            c.execute(
                "INSERT OR IGNORE INTO sessions (id, title, model, preamble, created_at, updated_at) \
                 VALUES (?1, ?2, 'm', '', '', '')",
                params![session_id, format!("会话 {}", session_id)],
            )?;
            c.execute(
                &format!(
                    "INSERT INTO runs (id, session_id, kind, started_at, status, model, job_id, attempt_no, checkpoint_json) \
                     VALUES (?1,?2,?3,?4,?5,'{}',?6,2,?7)",
                    crate::defaults::DEFAULT_MODEL
                ),
                params![id, session_id, kind, started_at, status, job_id, cp_json],
            )
        })
        .expect("seed run");
    }

    #[test]
    fn resumable_kinds_exclude_group_layer() {
        
        assert!(LongTaskRepository::is_resumable_kind("chat"));
        assert!(LongTaskRepository::is_resumable_kind("scheduled"));
        assert!(!LongTaskRepository::is_resumable_kind("worker"));
        assert!(!LongTaskRepository::is_resumable_kind("roundtable"));
    }

    #[test]
    fn recovery_marks_only_job_layer_orphans() {
        let db = tmp_db();
        seed_run(&db, "r1", "s1", "chat", "running", None, 100, Some((3, 900)));
        seed_run(&db, "r2", "s2", "scheduled", "running", Some("job1"), 200, Some((5, 1500)));
        
        seed_run(&db, "r3", "s3", "worker", "running", None, 300, None);
        seed_run(&db, "r4", "s4", "roundtable", "running", None, 400, None);
        
        seed_run(&db, "r5", "s5", "chat", "ok", None, 500, Some((2, 400)));

        let marked = recover_in_flight_tasks(&db);
        assert_eq!(marked, 2, "只有 chat/scheduled 的 running 行被改判");

        let repo = LongTaskRepository::new(&db);
        assert_eq!(repo.get_run("r1").unwrap().unwrap().status, "interrupted");
        assert_eq!(repo.get_run("r2").unwrap().unwrap().status, "interrupted");
        assert_eq!(repo.get_run("r3").unwrap().unwrap().status, "running");
        assert_eq!(repo.get_run("r4").unwrap().unwrap().status, "running");
        assert_eq!(repo.get_run("r5").unwrap().unwrap().status, "ok");

        
        assert_eq!(recover_in_flight_tasks(&db), 0);
    }

    #[test]
    fn list_resumable_orders_and_filters() {
        let db = tmp_db();
        seed_run(&db, "r1", "s1", "chat", "paused", None, 100, Some((3, 900)));
        seed_run(&db, "r2", "s2", "scheduled", "interrupted", Some("job1"), 300, Some((5, 1500)));
        seed_run(&db, "r3", "s3", "worker", "interrupted", None, 400, Some((1, 10)));
        seed_run(&db, "r4", "s4", "chat", "ok", None, 500, Some((9, 99)));

        let list = LongTaskRepository::new(&db).list_resumable(50).unwrap();
        let ids: Vec<&str> = list.iter().map(|r| r.run_id.as_str()).collect();
        assert_eq!(ids, vec!["r2", "r1"], "最近的在前，且排除 worker / 终态");

        let r2 = &list[0];
        assert_eq!(r2.iteration, 5);
        assert_eq!(r2.tokens_used, 1500);
        assert_eq!(r2.attempt_no, 2);
        assert_eq!(r2.job_id.as_deref(), Some("job1"));
        assert_eq!(r2.session_title, "会话 s2");
    }

    #[test]
    fn corrupt_checkpoint_degrades_instead_of_dropping_row() {
        
        let db = tmp_db();
        seed_run(&db, "r1", "s1", "chat", "interrupted", None, 100, None);
        db.with_conn_mut(|c| {
            c.execute(
                "UPDATE runs SET checkpoint_json='{not json' WHERE id='r1'",
                [],
            )
        })
        .unwrap();

        let list = LongTaskRepository::new(&db).list_resumable(50).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].iteration, 0, "降级为从 0 开始，由前端禁用「继续」");
    }

    #[test]
    fn latest_run_lookups_pick_newest() {
        let db = tmp_db();
        seed_run(&db, "old", "s1", "scheduled", "ok", Some("job1"), 100, Some((2, 200)));
        seed_run(&db, "new", "s1", "scheduled", "paused", Some("job1"), 900, Some((7, 700)));

        let repo = LongTaskRepository::new(&db);
        assert_eq!(repo.latest_run_of_job("job1").unwrap().unwrap().run_id, "new");
        assert_eq!(
            repo.latest_run_of_session("s1").unwrap().unwrap().run_id,
            "new"
        );
        assert!(repo.latest_run_of_job("nope").unwrap().is_none());
    }

    #[test]
    fn superseded_run_leaves_the_recovery_panel() {
        let db = tmp_db();
        seed_run(&db, "r1", "s1", "chat", "paused", None, 100, Some((3, 900)));
        let repo = LongTaskRepository::new(&db);

        repo.mark_superseded("r1").unwrap();
        assert!(repo.list_resumable(50).unwrap().is_empty());
        
        assert_eq!(repo.get_run("r1").unwrap().unwrap().status, "superseded");

        
        repo.mark_superseded("r1").unwrap();
        assert_eq!(repo.get_run("r1").unwrap().unwrap().status, "superseded");
    }

    #[test]
    fn dismiss_and_sweep_hide_interrupted_only() {
        
        let db = tmp_db();
        
        seed_run(&db, "old1", "s1", "chat", "interrupted", None, 100, Some((3, 900)));
        seed_run(&db, "old2", "s2", "scheduled", "interrupted", Some("job1"), 200, Some((5, 1500)));
        seed_run(&db, "new1", "s3", "chat", "interrupted", None, 9_999_999_999_000, Some((1, 10)));
        seed_run(&db, "p1", "s4", "chat", "paused", None, 300, Some((2, 200)));

        let repo = LongTaskRepository::new(&db);
        
        let cutoff = crate::agent::ledger::now_unix_ms() - 7 * 86_400_000;
        let swept = repo.sweep_expired_interruptions(cutoff).unwrap();
        assert_eq!(swept, 2, "仅两条旧 interrupted 被过期隐藏");

        
        let dismissed = repo.dismiss_all_interruptions().unwrap();
        assert_eq!(dismissed, 1, "仅剩的 new1 被忽略");

        
        let list = repo.list_recoverable(0, 50).unwrap();
        assert_eq!(list.len(), 1, "paused 永不被隐藏");
        assert_eq!(list[0].run_id, "p1");

        
        let touched = repo.dismiss_interruption("p1").unwrap();
        assert_eq!(touched, 0, "paused 不可被「忽略」");
        assert_eq!(repo.list_recoverable(0, 50).unwrap().len(), 1);
    }

    #[test]
    fn job_stamps_write_anchor_then_result() {
        let db = tmp_db();
        db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO scheduled_tasks (id, title, created_at, updated_at) \
                 VALUES ('job1','每日简报','','')",
                [],
            )
        })
        .unwrap();

        let repo = LongTaskRepository::new(&db);
        repo.stamp_job_started("job1", "sess-1").unwrap();
        let (sid, last, fin): (Option<String>, Option<String>, Option<String>) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT session_id, last_run_id, finished_at FROM scheduled_tasks WHERE id='job1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!(sid.as_deref(), Some("sess-1"), "锚点必须开跑就落盘");
        assert!(last.is_none(), "run_id 此刻还不存在");
        assert!(fin.is_none());

        repo.stamp_job_finished("job1", "run-9").unwrap();
        let (last, fin): (Option<String>, Option<String>) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT last_run_id, finished_at FROM scheduled_tasks WHERE id='job1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(last.as_deref(), Some("run-9"));
        assert!(fin.is_some());
    }
}
