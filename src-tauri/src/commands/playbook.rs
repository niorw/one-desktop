









use crate::commands::group::GroupState;
use crate::group::playbook_repo::{Playbook, PlaybookRepository, SavePlaybookPayload};
use tauri::{AppHandle, Manager, Runtime};


#[tauri::command]
pub async fn playbook_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<Playbook>, String> {
    let gdb = app.state::<GroupState>();
    PlaybookRepository::new(gdb.db.as_ref())
        .list()
        .map_err(|e| e.to_string())
}


#[tauri::command]
pub async fn playbook_save<R: Runtime>(
    app: AppHandle<R>,
    payload: SavePlaybookPayload,
) -> Result<Playbook, String> {
    let gdb = app.state::<GroupState>();
    if payload.name.trim().is_empty() {
        return Err("playbook name is required".into());
    }
    if payload.steps.is_empty() {
        return Err("playbook needs at least one step".into());
    }
    PlaybookRepository::new(gdb.db.as_ref())
        .save(payload)
        .map_err(|e| e.to_string())
}


#[tauri::command]
pub async fn playbook_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<(), String> {
    let gdb = app.state::<GroupState>();
    PlaybookRepository::new(gdb.db.as_ref())
        .delete(&id)
        .map_err(|e| e.to_string())
}
