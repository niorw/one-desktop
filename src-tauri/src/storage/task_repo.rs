

use crate::scheduler::model::*;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use rusqlite::{params, Result as SqliteResult};

pub struct TaskRepository<'a> {
    db: &'a DbConnection,
}

impl<'a> TaskRepository<'a> {
    pub fn new(db: &'a DbConnection) -> Self {
        Self { db }
    }

    
    pub fn find_active(&self) -> SqliteResult<Vec<ScheduledTask>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id,title,description,type,schedule,action_type,action_payload,source,status,\
                 last_run_at,next_run_at,run_count,created_at,updated_at \
                 FROM scheduled_tasks WHERE status='active' ORDER BY created_at DESC",
            )?;
            let list = stmt
                .query_map([], row_to_task)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(list)
        })
    }

    pub fn update_next_run(&self, id: &str, next: Option<&str>) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE scheduled_tasks SET next_run_at=?1, updated_at=?2 WHERE id=?3",
                params![next, now, id],
            )
            .map(|_| ())
        })
    }

    pub fn record_run(
        &self,
        id: &str,
        last_run: &str,
        run_count: i64,
        status: &str,
        next: Option<&str>,
    ) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE scheduled_tasks SET last_run_at=?1, run_count=?2, status=?3, next_run_at=?4, updated_at=?5 WHERE id=?6",
                params![last_run, run_count, status, next, now, id],
            )
            .map(|_| ())
        })
    }

    pub fn set_status(&self, id: &str, status: TaskStatus) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE scheduled_tasks SET status=?1, updated_at=?2 WHERE id=?3",
                params![status.as_str(), now, id],
            )
            .map(|_| ())
        })
    }

    
    
    pub fn update(
        &self,
        id: &str,
        title: &str,
        description: Option<&str>,
        type_: &str,
        schedule_expr: &str,
        source: &str,
        action_type: &str,
        action_payload: &str,
        next_run_at: Option<&str>,
    ) -> SqliteResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.db.with_conn_mut(|c| {
            c.execute(
                "UPDATE scheduled_tasks \
                 SET title=?1, description=?2, type=?3, schedule=?4, source=?5, \
                     action_type=?6, action_payload=?7, next_run_at=?8, updated_at=?9 \
                 WHERE id=?10",
                params![
                    title,
                    description,
                    type_,
                    schedule_expr,
                    source,
                    action_type,
                    action_payload,
                    next_run_at,
                    now,
                    id
                ],
            )
            .map(|_| ())
        })
    }
}

impl<'a> Repository<ScheduledTask, CreateTaskPayload, ()> for TaskRepository<'a> {
    fn create(&self, p: CreateTaskPayload) -> SqliteResult<ScheduledTask> {
        let now = chrono::Utc::now().to_rfc3339();
        let task = ScheduledTask {
            id: p.id,
            title: p.title,
            description: p.description,
            type_: p.type_,
            schedule_expr: p.schedule_expr,
            action_type: p.action_type,
            action_payload: p.action_payload,
            source: p.source,
            status: TaskStatus::Active,
            last_run_at: None,
            next_run_at: p.next_run_at,
            run_count: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        self.db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO scheduled_tasks \
                 (id,title,description,type,schedule,action_type,action_payload,source,status,last_run_at,next_run_at,run_count,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10,0,?11,?12)",
                params![
                    task.id,
                    task.title,
                    task.description,
                    task.type_.as_str(),
                    task.schedule_expr,
                    task.action_type.as_str(),
                    task.action_payload,
                    task.source.as_str(),
                    task.status.as_str(),
                    task.next_run_at,
                    task.created_at,
                    task.updated_at,
                ],
            )
            .map(|_| ())
        })?;
        Ok(task)
    }

    fn find_by_id(&self, id: &str) -> SqliteResult<Option<ScheduledTask>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id,title,description,type,schedule,action_type,action_payload,source,status,\
                 last_run_at,next_run_at,run_count,created_at,updated_at \
                 FROM scheduled_tasks WHERE id=?1",
            )?;
            let mut rows = stmt.query_map(params![id], row_to_task)?;
            match rows.next() {
                Some(Ok(t)) => Ok(Some(t)),
                _ => Ok(None),
            }
        })
    }

    fn find_all(&self, _q: ()) -> SqliteResult<Vec<ScheduledTask>> {
        self.db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id,title,description,type,schedule,action_type,action_payload,source,status,\
                 last_run_at,next_run_at,run_count,created_at,updated_at \
                 FROM scheduled_tasks ORDER BY created_at DESC",
            )?;
            let list = stmt
                .query_map([], row_to_task)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(list)
        })
    }

    fn delete(&self, id: &str) -> SqliteResult<()> {
        self.db.with_conn_mut(|c| {
            c.execute("DELETE FROM scheduled_tasks WHERE id=?1", params![id])
                .map(|_| ())
        })
    }
}

fn row_to_task(row: &rusqlite::Row) -> rusqlite::Result<ScheduledTask> {
    Ok(ScheduledTask {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        type_: TaskType::from_str(&row.get::<_, String>(3)?),
        schedule_expr: row.get(4)?,
        action_type: ActionType::from_str(&row.get::<_, String>(5)?),
        action_payload: row.get(6)?,
        source: TaskSource::from_str(&row.get::<_, String>(7)?),
        status: TaskStatus::from_str(&row.get::<_, String>(8)?),
        last_run_at: row.get(9)?,
        next_run_at: row.get(10)?,
        run_count: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}
