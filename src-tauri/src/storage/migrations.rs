














use rusqlite::{Connection, Result as SqliteResult};


pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub up: &'static str,
}


pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        up: include_str!("../../migrations/0001_init.sql"),
    },
    
    
    Migration {
        version: 2,
        name: "run_artifacts",
        up: include_str!("../../migrations/0002_run_artifacts.sql"),
    },
    
    
    Migration {
        version: 3,
        name: "agent_plugins",
        up: include_str!("../../migrations/0003_add_agent_plugins.sql"),
    },
    
    
    Migration {
        version: 4,
        name: "task_last_error",
        up: include_str!("../../migrations/0004_add_task_last_error.sql"),
    },
    
    Migration {
        version: 5,
        name: "session_events",
        up: include_str!("../../migrations/0005_session_events.sql"),
    },
];





#[cfg(debug_assertions)]
fn assert_no_absolute_path(sql: &str, name: &str) {
    let stripped: String = sql
        .lines()
        .map(|l| match l.find("--") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    const FORBIDDEN: &[&str] = &["/Users/", "/home/", "C:\\", "/Volumes/", "/private/"];
    for f in FORBIDDEN {
        assert!(
            !stripped.contains(f),
            "迁移 `{name}` 含绝对路径字面量 `{f}`，违反 PORTABILITY INVARIANT（schema 不得写死本地路径）"
        );
    }
}




pub fn run_migrations(conn: &mut Connection) -> SqliteResult<()> {
    #[cfg(debug_assertions)]
    for m in MIGRATIONS {
        assert_no_absolute_path(m.up, m.name);
    }

    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for m in MIGRATIONS {
        if m.version > current {
            conn.execute_batch(m.up)?;
            conn.execute_batch(&format!("PRAGMA user_version = {}", m.version))?;
            tracing::info!(
                target: "onedesktop.storage",
                version = m.version,
                name = m.name,
                "applied migration"
            );
        }
    }

    apply_backfills(conn)
}






fn apply_backfills(conn: &mut Connection) -> SqliteResult<()> {
    
    
    

    
    if !table_has_column(conn, "calendar_events", "title")? {
        conn.execute_batch(
            "ALTER TABLE calendar_events ADD COLUMN title TEXT NOT NULL DEFAULT '';
             ALTER TABLE calendar_events ADD COLUMN time_start TEXT;
             ALTER TABLE calendar_events ADD COLUMN time_end TEXT;
             ALTER TABLE calendar_events ADD COLUMN color TEXT NOT NULL DEFAULT '#0a84ff';",
        )?;
        conn.execute(
            "UPDATE calendar_events SET title = content WHERE title = '' AND content != ''",
            [],
        )?;
    }
    
    if !table_has_column(conn, "calendar_events", "kind")? {
        conn.execute_batch(
            "ALTER TABLE calendar_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'schedule';",
        )?;
    }
    
    if !table_has_column(conn, "calendar_events", "notified_at")? {
        conn.execute_batch("ALTER TABLE calendar_events ADD COLUMN notified_at INTEGER;")?;
    }

    
    if !table_has_column(conn, "scheduled_tasks", "session_id")? {
        conn.execute_batch(
            "ALTER TABLE scheduled_tasks ADD COLUMN session_id TEXT;
             ALTER TABLE scheduled_tasks ADD COLUMN last_run_id TEXT;
             ALTER TABLE scheduled_tasks ADD COLUMN progress REAL NOT NULL DEFAULT 0;
             ALTER TABLE scheduled_tasks ADD COLUMN current_step INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE scheduled_tasks ADD COLUMN total_steps INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE scheduled_tasks ADD COLUMN checkpoint_json TEXT;
             ALTER TABLE scheduled_tasks ADD COLUMN total_tokens_used INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE scheduled_tasks ADD COLUMN started_at TEXT;
             ALTER TABLE scheduled_tasks ADD COLUMN finished_at TEXT;",
        )?;
    }

    
    if !table_has_column(conn, "runs", "checkpoint_json")? {
        conn.execute_batch(
            "ALTER TABLE runs ADD COLUMN job_id TEXT;
             ALTER TABLE runs ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE runs ADD COLUMN progress REAL NOT NULL DEFAULT 0;
             ALTER TABLE runs ADD COLUMN current_step INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE runs ADD COLUMN total_steps INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE runs ADD COLUMN checkpoint_json TEXT;",
        )?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_runs_status_kind ON runs(status, kind);")?;
    }
    if !table_has_column(conn, "runs", "dismissed_at")? {
        conn.execute_batch("ALTER TABLE runs ADD COLUMN dismissed_at INTEGER;")?;
    }
    if !table_has_column(conn, "runs", "reasoning_tokens")? {
        conn.execute_batch("ALTER TABLE runs ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;")?;
    }

    
    if !table_has_column(conn, "changeset", "after_content")? {
        conn.execute_batch(
            "ALTER TABLE changeset ADD COLUMN after_content TEXT; \
             ALTER TABLE changeset ADD COLUMN snapshot_type TEXT NOT NULL DEFAULT 'normal';",
        )?;
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_changeset_run_file ON changeset(run_id, file);")?;

    
    if !table_has_column(conn, "sessions", "workspace_id")? {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
             CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at);",
        )?;
    }

    
    if !table_has_column(conn, "workspaces", "path")? {
        conn.execute("ALTER TABLE workspaces ADD COLUMN path TEXT", [])?;
    }

    
    
    
    
    
    if !table_has_column(conn, "tasks", "order_idx")? {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN order_idx INTEGER NOT NULL DEFAULT 0;")?;
    }
    if !table_has_column(conn, "sessions", "mode")? {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN mode TEXT; \
             ALTER TABLE sessions ADD COLUMN group_id TEXT;",
        )?;
    }
    if !table_has_column(conn, "roundtable_messages", "worker_id")? {
        conn.execute_batch(
            "ALTER TABLE roundtable_messages ADD COLUMN worker_id TEXT NOT NULL DEFAULT '';",
        )?;
    }
    
    
    
    
    if !table_has_column(conn, "roundtable_messages", "session_id")? {
        conn.execute_batch(
            "ALTER TABLE roundtable_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT '';",
        )?;
    }

    
    
    
    
    
    if !table_has_column(conn, "session_events", "call_id")? {
        conn.execute_batch(
            "ALTER TABLE session_events ADD COLUMN call_id TEXT;
             CREATE INDEX IF NOT EXISTS idx_sevt_session_call ON session_events(session_id, kind, call_id);",
        )?;
    }

    Ok(())
}


fn table_has_column(conn: &Connection, table: &str, column: &str) -> SqliteResult<bool> {
    let existing: Vec<String> = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(existing.iter().any(|c| c == column))
}

#[cfg(test)]
mod tests {
    use super::*;

    
    
    
    
    
    
    #[test]
    fn backfill_adds_call_id_to_session_events() {
        let mut conn = Connection::open_in_memory().unwrap();
        
        for m in &MIGRATIONS[..4] {
            conn.execute_batch(m.up).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE session_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                run_id      TEXT,
                seq         INTEGER NOT NULL,
                kind        TEXT NOT NULL,
                payload     TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX idx_sevt_session_seq ON session_events(session_id, seq);
            CREATE INDEX idx_sevt_run ON session_events(run_id);
            PRAGMA user_version = 5;",
        )
        .unwrap();

        run_migrations(&mut conn).unwrap();

        
        assert!(table_has_column(&conn, "session_events", "call_id").unwrap());
        
        conn.execute(
            "INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_events (session_id, run_id, seq, kind, call_id, payload, created_at) \
             VALUES ('s1', NULL, 1, 'tool_call', 'call_1', '{}', 1)",
            [],
        )
        .unwrap();
        
        let idx: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sevt_session_call'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert!(idx.is_some(), "idx_sevt_session_call 索引未创建");
    }
}
