






use rusqlite::{Connection, Result as SqliteResult};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;



pub struct DbConnection {
    
    
    pool: Vec<Mutex<Connection>>,
    
    rr: AtomicUsize,
}

impl DbConnection {
    
    pub fn open(app_data_dir: &PathBuf) -> SqliteResult<Self> {
        std::fs::create_dir_all(app_data_dir).ok();
        let db_path = app_data_dir.join("onedesktop.db");
        tracing::info!(
            target: "onedesktop.storage",
            path = %db_path.display(),
            "Opening database"
        );

        
        
        let bootstrap = Connection::open(&db_path)?;
        bootstrap.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let mut instance = Self {
            pool: vec![Mutex::new(bootstrap)],
            rr: AtomicUsize::new(0),
        };
        instance.run_migrations()?;

        
        const POOL_SIZE: usize = 4;
        for _ in 1..POOL_SIZE {
            let c = Connection::open(&db_path)?;
            c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
            instance.pool.push(Mutex::new(c));
        }
        Ok(instance)
    }

    
    
    fn pick(&self) -> usize {
        let n = self.pool.len();
        if n <= 1 {
            0
        } else {
            self.rr.fetch_add(1, Ordering::Relaxed) % n
        }
    }

    
    pub fn with_conn<F, T>(&self, f: F) -> SqliteResult<T>
    where
        F: FnOnce(&Connection) -> SqliteResult<T>,
    {
        let conn = self.pool[self.pick()].lock().expect("DB mutex poisoned");
        f(&conn)
    }

    
    
    
    
    pub fn with_conn_mut<F, T>(&self, f: F) -> SqliteResult<T>
    where
        F: FnOnce(&mut Connection) -> SqliteResult<T>,
    {
        let mut conn = self.pool[self.pick()].lock().expect("DB mutex poisoned");
        f(&mut conn)
    }

    
    fn run_migrations(&self) -> SqliteResult<()> {
        self.with_conn_mut(|conn| {
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        })?;
        self.with_conn_mut(|conn| crate::storage::migrations::run_migrations(conn))?;
        tracing::info!(target: "onedesktop.storage", "Database migrations complete");
        Ok(())
    }
}

#[cfg(test)]
mod workspace_migration_tests {
    
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("od_wsmig_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn workspace_migration_is_idempotent_across_restarts() {
        let dir = tmp_dir("idem");

        
        {
            let db = DbConnection::open(&dir).unwrap();
            db.with_conn(|conn| {
                let n: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
                assert_eq!(n, 1, "默认工作区应恰好一行");
                let cols: Vec<String> = conn
                    .prepare("PRAGMA table_info(sessions)")?
                    .query_map([], |r| r.get::<_, String>(1))?
                    .collect::<Result<Vec<_>, _>>()?;
                assert!(cols.contains(&"workspace_id".to_string()), "sessions 应已加 workspace_id");
                
                conn.execute(
                    "INSERT INTO inspirations (id, workspace_id, content, tags, created_at)
                     VALUES ('i1', NULL, 'hello', '[\"t\"]', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        }

        
        let db = DbConnection::open(&dir).unwrap();
        db.with_conn(|conn| {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
            assert_eq!(n, 1, "默认工作区不应被重复插入");
            let insp: i64 = conn.query_row("SELECT COUNT(*) FROM inspirations", [], |r| r.get(0))?;
            assert_eq!(insp, 1, "已有灵感不应被迁移抹掉");
            let dup: i64 = conn
                .prepare("PRAGMA table_info(sessions)")?
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<Result<Vec<String>, _>>()?
                .iter()
                .filter(|c| c.as_str() == "workspace_id")
                .count() as i64;
            assert_eq!(dup, 1, "workspace_id 列不应被重复 ALTER");
            Ok(())
        })
        .unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    
    
    #[test]
    fn fresh_db_has_all_backfilled_columns() {
        let dir = tmp_dir("cols");
        let db = DbConnection::open(&dir).unwrap();

        db.with_conn(|conn| {
            
            let runs_cols: Vec<String> = cols_of(conn, "runs");
            for c in ["job_id", "attempt_no", "progress", "current_step", "total_steps", "checkpoint_json", "dismissed_at", "reasoning_tokens"] {
                assert!(runs_cols.iter().any(|x| x == c), "runs 缺列 {c}");
            }
            let st_cols: Vec<String> = cols_of(conn, "scheduled_tasks");
            for c in ["session_id", "last_run_id", "checkpoint_json", "total_tokens_used", "started_at", "finished_at"] {
                assert!(st_cols.iter().any(|x| x == c), "scheduled_tasks 缺列 {c}");
            }
            let cal_cols: Vec<String> = cols_of(conn, "calendar_events");
            for c in ["title", "time_start", "time_end", "color", "kind", "notified_at"] {
                assert!(cal_cols.iter().any(|x| x == c), "calendar_events 缺列 {c}");
            }
            let ch_cols: Vec<String> = cols_of(conn, "changeset");
            for c in ["after_content", "snapshot_type"] {
                assert!(ch_cols.iter().any(|x| x == c), "changeset 缺列 {c}");
            }
            let ws_cols: Vec<String> = cols_of(conn, "workspaces");
            assert!(ws_cols.iter().any(|x| x == "path"), "workspaces 缺列 path");

            
            let uv: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(uv, crate::storage::migrations::MIGRATIONS.last().unwrap().version, "user_version 未推进");

            Ok(())
        })
        .unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn cols_of(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }
}
