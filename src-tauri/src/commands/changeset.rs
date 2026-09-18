







use crate::commands::group::GroupState;
use crate::error::AgentError;
use crate::storage::changeset_sqlite::{ChangesetRow, SqliteChangesetRecorder};
use tauri::{AppHandle, Manager, Runtime};


#[tauri::command]
pub async fn group_changesets<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
    limit: Option<i64>,
) -> Result<Vec<ChangesetRow>, AgentError> {
    let gdb = app.state::<GroupState>();
    SqliteChangesetRecorder::new(gdb.db.clone())
        .list_for_group(&group_id, limit.unwrap_or(100))
        .map_err(|e| AgentError::Storage {
            message: e.to_string(),
        })
}


#[tauri::command]
pub async fn run_changesets<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    limit: Option<i64>,
) -> Result<Vec<ChangesetRow>, AgentError> {
    let gdb = app.state::<GroupState>();
    SqliteChangesetRecorder::new(gdb.db.clone())
        .run_changesets(&run_id, limit.unwrap_or(200))
        .map_err(|e| AgentError::Storage {
            message: e.to_string(),
        })
}


#[tauri::command]
pub async fn run_changeset_versions<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    file: String,
) -> Result<Vec<ChangesetRow>, AgentError> {
    let gdb = app.state::<GroupState>();
    SqliteChangesetRecorder::new(gdb.db.clone())
        .run_changeset_versions(&run_id, &file)
        .map_err(|e| AgentError::Storage {
            message: e.to_string(),
        })
}



#[tauri::command]
pub async fn session_changesets<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<ChangesetRow>, AgentError> {
    let gdb = app.state::<GroupState>();
    SqliteChangesetRecorder::new(gdb.db.clone())
        .session_changesets(&session_id, limit.unwrap_or(500))
        .map_err(|e| AgentError::Storage {
            message: e.to_string(),
        })
}



#[tauri::command]
pub async fn changeset_rollback<R: Runtime>(
    app: AppHandle<R>,
    change_id: String,
) -> Result<String, AgentError> {
    let gdb = app.state::<GroupState>();
    SqliteChangesetRecorder::new(gdb.db.clone()).rollback(&change_id)
}
