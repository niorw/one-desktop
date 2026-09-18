





use crate::agent::ports::{HeartbeatError, TaskHeartbeat};
use crate::group::task_board_repo::TaskBoardRepository;
use crate::storage::connection::DbConnection;
use std::sync::Arc;


pub struct SqliteTaskHeartbeat {
    db: Arc<DbConnection>,
}

impl SqliteTaskHeartbeat {
    pub fn new(db: Arc<DbConnection>) -> Self {
        Self { db }
    }
}

impl TaskHeartbeat for SqliteTaskHeartbeat {
    fn beat(&self, task_id: &str) -> Result<(), HeartbeatError> {
        TaskBoardRepository::new(&self.db)
            .beat(task_id)
            .map_err(|e| HeartbeatError::Store(e.to_string()))
    }
}
