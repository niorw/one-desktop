

use crate::group::task_board::{CreateTaskPayload, Task, TaskStatus};
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use rusqlite::{params, Result as SqliteResult};

pub struct TaskBoardRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> TaskBoardRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    pub fn update_status(&self, id: &str, status: TaskStatus) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE tasks SET status = ?1 WHERE id = ?2",
                params![serde_json::to_string(&status).unwrap(), id],
            )?;
            Ok(())
        })
    }

    
    
    
    pub fn update_fields(
        &self,
        id: &str,
        description: Option<&str>,
        reasoning: Option<&str>,
    ) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            if let Some(d) = description {
                conn.execute("UPDATE tasks SET description = ?1 WHERE id = ?2", params![d, id])?;
            }
            if let Some(r) = reasoning {
                conn.execute("UPDATE tasks SET reasoning = ?1 WHERE id = ?2", params![r, id])?;
            }
            Ok(())
        })
    }

    pub fn mark_completed(&self, id: &str) -> SqliteResult<()> {
        self.update_status(id, TaskStatus::Completed)
    }

    
    
    pub fn mark_failed(&self, id: &str, error: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE tasks SET status = ?1, last_error = ?2 WHERE id = ?3",
                params![TaskStatus::Failed.as_db_str(), error, id],
            )?;
            Ok(())
        })
    }

    
    
    pub fn find_in_progress(&self) -> SqliteResult<Vec<Task>> {
        let status = TaskStatus::InProgress.as_db_str();
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks \
                 WHERE status = ?1 \
                   AND group_id IS NOT NULL \
                   AND group_id != '' \
                   AND group_id != 'personal'",
            )?;
            let items = stmt
                .query_map(params![status], map_row)?
                .filter_map(|r| r.ok())
                .collect::<Vec<Task>>();
            Ok(items)
        })
    }

    
    
    pub fn append_outputs(&self, id: &str, paths: &[String]) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            let existing: String = conn
                .query_row(
                    "SELECT COALESCE(outputs, '[]') FROM tasks WHERE id = ?1",
                    params![id],
                    |r| r.get::<_, String>(0),
                )
                .unwrap_or_else(|_| "[]".to_string());
            let mut merged: Vec<String> =
                serde_json::from_str(&existing).unwrap_or_default();
            for p in paths {
                let p = p.trim();
                if p.is_empty() || merged.contains(&p.to_string()) {
                    continue;
                }
                merged.push(p.to_string());
            }
            conn.execute(
                "UPDATE tasks SET outputs = ?1 WHERE id = ?2",
                params![serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into()), id],
            )?;
            Ok(())
        })
    }

    
    pub fn find_by_batch(&self, group_id: &str, batch_id: &str) -> SqliteResult<Vec<Task>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks WHERE group_id = ?1 AND batch_id = ?2",
            )?;
            let items = stmt
                .query_map(params![group_id, batch_id], map_row)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    
    
    
    
    
    
    pub fn find_by_group(&self, group_id: &str) -> SqliteResult<Vec<Task>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks WHERE group_id = ?1 ORDER BY rowid ASC",
            )?;
            let items = stmt
                .query_map(params![group_id], map_row)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    pub fn list_all(&self) -> SqliteResult<Vec<Task>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks ORDER BY group_id, batch_id, id",
            )?;
            let items = stmt
                .query_map([], map_row)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    
    
    
    
    pub fn list_personal(&self) -> SqliteResult<Vec<Task>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks \
                 WHERE (group_id IS NULL OR group_id = '' OR group_id = 'personal') \
                   AND batch_id IS NULL \
                 ORDER BY order_idx ASC, id",
            )?;
            let items = stmt
                .query_map([], map_row)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    pub fn find_pending(&self, group_id: &str) -> SqliteResult<Vec<Task>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks WHERE group_id = ?1 AND status = ?2",
            )?;
            let items = stmt
                .query_map(params![group_id, TaskStatus::Pending.as_db_str()], map_row)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    pub fn beat(&self, task_id: &str) -> SqliteResult<()> {
        let now = chrono::Utc::now().timestamp();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE tasks SET last_heartbeat = ?1 WHERE id = ?2",
                params![now, task_id],
            )
            .map(|_| ())
        })
    }

    
    
    
    
    
    
    
    pub fn find_stale(&self, timeout_secs: i64) -> SqliteResult<Vec<Task>> {
        let cutoff = chrono::Utc::now().timestamp() - timeout_secs;
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks WHERE status = ?1 \
                 AND batch_id IS NOT NULL \
                 AND (last_heartbeat IS NULL OR last_heartbeat < ?2)",
            )?;
            let items = stmt
                .query_map(
                    params![TaskStatus::InProgress.as_db_str(), cutoff],
                    map_row,
                )?
                .filter_map(|r| r.ok())
                .collect();
            Ok(items)
        })
    }

    
    pub fn retry_task(&self, id: &str) -> SqliteResult<Task> {
        let pending = TaskStatus::Pending.as_db_str();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE tasks SET status = ?1, retry_count = retry_count + 1, last_heartbeat = NULL WHERE id = ?2",
                params![pending, id],
            )?;
            Ok(())
        })?;
        self.find_by_id(id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    
    pub fn reassign_task(&self, id: &str, worker_id: Option<String>) -> SqliteResult<Task> {
        let pending = TaskStatus::Pending.as_db_str();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE tasks SET worker_id = ?1, status = ?2, last_heartbeat = NULL WHERE id = ?3",
                params![worker_id, pending, id],
            )?;
            Ok(())
        })?;
        self.find_by_id(id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    
    pub fn skip_dependencies(&self, id: &str) -> SqliteResult<Task> {
        let pending = TaskStatus::Pending.as_db_str();
        self.db.with_conn_mut(|conn| {
            conn.execute(
                "UPDATE tasks SET depends_on = '[]', status = ?1, last_heartbeat = NULL WHERE id = ?2",
                params![pending, id],
            )?;
            Ok(())
        })?;
        self.find_by_id(id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    
    
    
    pub fn approve_batch(&self, group_id: &str, batch_id: &str) -> SqliteResult<usize> {
        let awaiting = TaskStatus::AwaitingApproval.as_db_str();
        let pending = TaskStatus::Pending.as_db_str();
        self.db.with_conn_mut(|conn| {
            let n = conn.execute(
                "UPDATE tasks SET status = ?1 WHERE group_id = ?2 AND batch_id = ?3 AND status = ?4",
                params![pending, group_id, batch_id, awaiting],
            )?;
            Ok(n)
        })
    }

    
    
    pub fn reorder(&self, task_id: &str, before_id: Option<&str>) -> SqliteResult<()> {
        let task = self
            .find_by_id(task_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let status = task.status.clone();
        let mut siblings = self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks WHERE status = ?1 ORDER BY order_idx ASC, id ASC",
            )?;
            let items = stmt
                .query_map(params![serde_json::to_string(&status).unwrap()], map_row)?
                .filter_map(|r| r.ok())
                .collect::<Vec<Task>>();
            Ok(items)
        })?;
        let dragged = match siblings.iter().position(|t| t.id == task_id) {
            Some(i) => siblings.remove(i),
            None => return Ok(()),
        };
        let insert_at = match before_id {
            Some(b) if b != task_id => siblings.iter().position(|t| t.id == b).unwrap_or(siblings.len()),
            _ => siblings.len(),
        };
        siblings.insert(insert_at, dragged);
        self.db.with_conn_mut(|conn| {
            for (i, t) in siblings.iter().enumerate() {
                conn.execute(
                    "UPDATE tasks SET order_idx = ?1 WHERE id = ?2",
                    params![i as i64, t.id],
                )?;
            }
            Ok(())
        })
    }
}









fn parse_task_status(raw: &str) -> TaskStatus {
    serde_json::from_str(raw)
        .or_else(|_| serde_json::from_str(&format!("\"{}\"", raw)))
        .unwrap_or(TaskStatus::Pending)
}

fn map_row(row: &rusqlite::Row) -> SqliteResult<Task> {
    Ok(Task {
        id: row.get(0)?,
        group_id: row.get(1)?,
        batch_id: row.get(2)?,
        worker_id: row.get(3)?,
        description: row.get(4)?,
        depends_on: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
        input_refs: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
        output_spec: row.get(7)?,
        status: parse_task_status(&row.get::<_, String>(8)?),
        retry_count: row.get(9)?,
        assigned_worker: row.get(10)?,
        outputs: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
        reasoning: row.get(12)?,
        capability: row.get(13)?,
        last_heartbeat: row.get(14)?,
        order_idx: row.get(15)?,
        last_error: row.get(16)?,
    })
}

impl<'a> Repository<Task, CreateTaskPayload, ()> for TaskBoardRepository<'a> {
    fn create(&self, p: CreateTaskPayload) -> SqliteResult<Task> {
        let status = p.status.clone().unwrap_or(TaskStatus::Pending);
        self.db.with_conn_mut(|conn| {
            
            let next_idx: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(order_idx), -1) + 1 FROM tasks WHERE status = ?1",
                    params![serde_json::to_string(&status).unwrap()],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            conn.execute(
                "INSERT INTO tasks (id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,order_idx)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![
                    p.id,
                    p.group_id,
                    p.batch_id,
                    p.worker_id,
                    p.description,
                    serde_json::to_string(&p.depends_on).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&p.input_refs).unwrap_or_else(|_| "[]".into()),
                    p.output_spec,
                    serde_json::to_string(&status).unwrap(),
                    0i32,
                    Option::<String>::None,
                    "[]",
                    p.reasoning,
                    p.capability,
                    next_idx,
                ],
            )
        })?;
        self.find_by_id(&p.id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<Task>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(params![id], map_row)?;
            match rows.next() {
                Some(Ok(t)) => Ok(Some(t)),
                _ => Ok(None),
            }
        })
    }

    fn find_all(&self, _query: ()) -> SqliteResult<Vec<Task>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat,order_idx,last_error \
                 FROM tasks ORDER BY id",
            )?;
            let items = stmt.query_map([], map_row)?.filter_map(|r| r.ok()).collect();
            Ok(items)
        })
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|conn| {
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;
    use std::sync::Arc;
    use uuid::Uuid;

    fn temp_db() -> Arc<DbConnection> {
        let dir = PathBuf::from(std::env::temp_dir()).join(format!("onedesktop_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    
    
    #[test]
    fn parse_task_status_accepts_quoted_and_bare_values() {
        assert_eq!(parse_task_status("\"Completed\""), TaskStatus::Completed);
        assert_eq!(parse_task_status("Completed"), TaskStatus::Completed);
        assert_eq!(
            parse_task_status("AwaitingApproval"),
            TaskStatus::AwaitingApproval
        );
        assert_eq!(parse_task_status("\"Failed\""), TaskStatus::Failed);
        
        assert_eq!(parse_task_status("Nonsense"), TaskStatus::Pending);
    }

    
    fn seed_inprogress(repo: &TaskBoardRepository, id: &str) -> Task {
        let p = CreateTaskPayload {
            id: id.to_string(),
            group_id: "g1".to_string(),
            batch_id: Some("b1".to_string()),
            worker_id: None,
            description: "task".to_string(),
            depends_on: vec![],
            input_refs: vec![],
            output_spec: None,
            status: None,
            capability: None,
            reasoning: None,
        };
        let t = repo.create(p).unwrap();
        repo.update_status(&t.id, TaskStatus::InProgress).unwrap();
        repo.find_by_id(&t.id).unwrap().unwrap()
    }

    #[test]
    fn beat_writes_last_heartbeat() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        let t = seed_inprogress(&repo, "t-beat");
        assert!(t.last_heartbeat.is_none(), "fresh dispatched task has no heartbeat yet");
        repo.beat(&t.id).unwrap();
        let after = repo.find_by_id(&t.id).unwrap().unwrap();
        assert!(after.last_heartbeat.is_some(), "beat must set last_heartbeat");
    }

    #[test]
    fn find_stale_catches_expired_and_null() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        
        let fresh = seed_inprogress(&repo, "t-fresh");
        repo.beat(&fresh.id).unwrap();
        
        let _never = seed_inprogress(&repo, "t-never");
        
        let old = seed_inprogress(&repo, "t-old");
        repo.beat(&old.id).unwrap();
        db.with_conn_mut(|c| {
            c.execute(
                "UPDATE tasks SET last_heartbeat = ?1 WHERE id = ?2",
                params![chrono::Utc::now().timestamp() - 100, old.id],
            )
            .map(|_| ())
        })
        .unwrap();

        let stale = repo.find_stale(60).unwrap();
        let ids: Vec<&str> = stale.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"t-never"), "null heartbeat must be flagged stale");
        assert!(ids.contains(&"t-old"), "expired heartbeat must be flagged stale");
        assert!(!ids.contains(&"t-fresh"), "recently beaten task must NOT be stale");
    }

    #[test]
    fn sweep_marks_stale_failed() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        let never = seed_inprogress(&repo, "t-sweep");
        let stale = repo.find_stale(60).unwrap();
        assert_eq!(stale.len(), 1, "one stale task seeded");
        
        for t in &stale {
            repo.update_status(&t.id, TaskStatus::Failed).unwrap();
        }
        let after = repo.find_by_id(&never.id).unwrap().unwrap();
        assert_eq!(after.status, TaskStatus::Failed, "stale task reclaimed as Failed");
        let empty = repo.find_stale(60).unwrap();
        assert!(empty.is_empty(), "after reclaim, no stale task remains");
    }

    #[test]
    fn retry_task_increments_count_and_resets() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        let t = seed_inprogress(&repo, "t-retry");
        repo.update_status(&t.id, TaskStatus::Failed).unwrap();
        repo.beat(&t.id).unwrap(); 
        let before = repo.find_by_id(&t.id).unwrap().unwrap();
        assert_eq!(before.retry_count, 0);

        let after = repo.retry_task(&t.id).unwrap();
        assert_eq!(after.status, TaskStatus::Pending, "retry returns to Pending");
        assert_eq!(after.retry_count, 1, "retry_count incremented");
        assert!(after.last_heartbeat.is_none(), "heartbeat cleared to retrigger dispatch");
    }

    #[test]
    fn reassign_task_sets_worker_and_pending() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        let t = seed_inprogress(&repo, "t-reassign");
        repo.update_status(&t.id, TaskStatus::Failed).unwrap();

        let after = repo.reassign_task(&t.id, Some("worker-new".to_string())).unwrap();
        assert_eq!(after.status, TaskStatus::Pending, "reassign returns to Pending");
        assert_eq!(after.worker_id.as_deref(), Some("worker-new"), "worker overwritten");
        assert!(after.last_heartbeat.is_none(), "heartbeat cleared");
    }

    #[test]
    fn skip_dependencies_clears_deps_and_pending() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        let p = CreateTaskPayload {
            id: "t-skip".to_string(),
            group_id: "g1".to_string(),
            batch_id: Some("b1".to_string()),
            worker_id: None,
            description: "task".to_string(),
            depends_on: vec!["dep-a".to_string(), "dep-b".to_string()],
            input_refs: vec![],
            output_spec: None,
            status: None,
            capability: None,
            reasoning: None,
        };
        let t = repo.create(p).unwrap();
        repo.update_status(&t.id, TaskStatus::InProgress).unwrap();

        let after = repo.skip_dependencies(&t.id).unwrap();
        assert_eq!(after.status, TaskStatus::Pending, "skip returns to Pending");
        assert!(after.depends_on.is_empty(), "depends_on cleared");
        assert!(after.last_heartbeat.is_none(), "heartbeat cleared");
    }

    #[test]
    fn append_outputs_merges_dedup_and_preserves_existing() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        let p = CreateTaskPayload {
            id: "t-out".to_string(),
            group_id: "g1".to_string(),
            batch_id: Some("b1".to_string()),
            worker_id: None,
            description: "task".to_string(),
            depends_on: vec![],
            input_refs: vec![],
            output_spec: None,
            status: Some(TaskStatus::Pending),
            capability: None,
            reasoning: None,
        };
        let t = repo.create(p).unwrap();

        
        repo.append_outputs(&t.id, &["/ws/a.html".to_string(), "/ws/b.css".to_string()])
            .unwrap();
        let after = repo.find_by_id(&t.id).unwrap().unwrap();
        assert_eq!(after.outputs, vec!["/ws/a.html", "/ws/b.css"]);

        
        repo.append_outputs(&t.id, &["/ws/a.html".to_string(), "/ws/c.js".to_string()])
            .unwrap();
        let after = repo.find_by_id(&t.id).unwrap().unwrap();
        assert_eq!(after.outputs, vec!["/ws/a.html", "/ws/b.css", "/ws/c.js"]);
    }
}
