




use crate::commands::agent::AgentState;
use crate::group::agent_adapter::{parse_agent_md, render_agent_md, LocalAgentEntry};
use crate::group::agent_profile::{
    AgentProfile, AgentProfileExt, CreateAgentProfilePayload, UpdateAgentProfilePayload,
};
use crate::group::agent_repo::AgentProfileRepository;
use crate::group::manager::GroupManager;
use crate::group::roundtable::{RerunMode, RoundtableBus};
use crate::group::roundtable_repo::{
    RoundtableAlternative, RoundtableAlternativeRepository, RoundtableMessage, RoundtableRepository,
    RoundtableSummary, RoundtableSummaryRepository,
};
use crate::group::scheduler::TaskScheduler;
use crate::group::task_board::{CreateTaskPayload, SubTask, Task, TaskStatus};
use uuid::Uuid;
use crate::group::task_board_repo::TaskBoardRepository;
use crate::group::worker::{worker_session_id, Worker, WorkerPool, WorkerStatus};
use crate::group::worker_metric_repo::{WorkerMetric, WorkerMetricRepository};
use crate::group::worker_repo::WorkerRepository;
use crate::group::manifest::GroupManifest;
use crate::group::workspace::WorkspaceManager;

use crate::agent::blackboard_sqlite::SqliteBlackboard;
use crate::agent::ports::Blackboard;
use crate::group::topology::{TopologyPolicy};
use crate::group::topology_repo::TopologyPolicyRepository;
use crate::group::{CreateGroupPayload, Group, GroupListItem};
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};


pub struct GroupState {
    pub db: Arc<DbConnection>,
}


#[derive(Debug, Clone, Serialize)]
pub struct DeliverableMedia {
    
    pub r#type: String,
    
    pub path: String,
    
    pub name: String,
}



#[derive(Debug, Clone, Serialize)]
pub struct TraceRef {
    
    pub source: String,
    
    pub key: String,
}


#[derive(Debug, Clone, Serialize)]
pub struct Deliverable {
    pub id: String,
    
    pub kind: String,
    pub title: String,
    
    pub author: String,
    
    pub worker_id: String,
    pub created_at: i64,
    
    pub preview: String,
    
    pub content: String,
    
    pub ref_seq: Option<i64>,
    
    pub ref_id: Option<String>,
    
    pub meta: String,
    
    pub media: Vec<DeliverableMedia>,
    
    pub trace_ref: Option<TraceRef>,
}



fn classify_media(s: &str) -> Option<DeliverableMedia> {
    let trimmed = s.trim();
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return None;
    }
    let lower = trimmed.to_lowercase();
    let is_img = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]
        .iter()
        .any(|e| lower.ends_with(&format!(".{}", e)));
    let is_abs = trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || (trimmed.len() > 3
            && trimmed.chars().nth(1) == Some(':')
            && trimmed.chars().nth(2) == Some('\\'));
    if is_img || is_abs {
        let name = trimmed
            .split(['/', '\\'])
            .last()
            .unwrap_or(trimmed)
            .to_string();
        Some(DeliverableMedia {
            r#type: if is_img {
                "image".into()
            } else {
                "file".into()
            },
            path: trimmed.to_string(),
            name,
        })
    } else {
        None
    }
}


fn path_to_media(p: &str) -> DeliverableMedia {
    let lower = p.to_lowercase();
    let is_img = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]
        .iter()
        .any(|e| lower.ends_with(&format!(".{}", e)));
    let name = p.split(['/', '\\']).last().unwrap_or(p).to_string();
    DeliverableMedia {
        r#type: if is_img {
            "image".into()
        } else {
            "file".into()
        },
        path: p.to_string(),
        name,
    }
}


fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let taken: String = s.chars().take(max).collect();
        format!("{}…", taken)
    }
}








fn extract_media_from_content(s: &str) -> Vec<DeliverableMedia> {
    let mut out: Vec<DeliverableMedia> = Vec::new();
    
    for (idx, seg) in s.split('`').enumerate() {
        if idx % 2 == 1 {
            if let Some(m) = classify_media(seg) {
                out.push(m);
            }
            continue;
        }
        for tok in seg.split(|c: char| {
            
            
            c.is_whitespace()
                || matches!(
                    c,
                    '(' | ')' | '[' | ']' | '"' | '\'' | '，' | '。' | '、' | '；' | '：' | ',' | ';'
                )
        }) {
            let t = tok.trim();
            if t.is_empty() {
                continue;
            }
            let has_ext = t
                .rfind('.')
                .map(|i| {
                    i > 0
                        && (t.len() - i - 1) <= 6
                        && t[i + 1..].chars().all(|c| c.is_ascii_alphanumeric())
                })
                .unwrap_or(false);
            let abs = t.starts_with('/')
                || t.starts_with('\\')
                || (t.len() > 3
                    && t.chars().nth(1) == Some(':')
                    && t.chars().nth(2) == Some('\\'));
            if abs && has_ext {
                out.push(path_to_media(t));
            }
        }
    }
    out
}


fn merge_media(mut a: Vec<DeliverableMedia>, b: Vec<DeliverableMedia>) -> Vec<DeliverableMedia> {
    for m in b {
        if !a.iter().any(|x| x.path == m.path) {
            a.push(m);
        }
    }
    a
}


#[tauri::command]
pub async fn create_agent_preset(
    app: AppHandle,
    payload: CreateAgentProfilePayload,
    ext: Option<AgentProfileExt>,
) -> Result<AgentProfile, String> {
    payload.validate()?;
    let db = app.state::<GroupState>();
    let repo = AgentProfileRepository::new(db.db.as_ref());
    repo.create_full(payload, ext.unwrap_or_default())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_agent_presets(app: AppHandle) -> Result<Vec<AgentProfile>, String> {
    let db = app.state::<GroupState>();
    let repo = AgentProfileRepository::new(db.db.as_ref());
    repo.find_all(()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_agent_preset(
    app: AppHandle,
    id: String,
    payload: UpdateAgentProfilePayload,
) -> Result<AgentProfile, String> {
    let db = app.state::<GroupState>();
    let repo = AgentProfileRepository::new(db.db.as_ref());
    repo.update(&id, payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_agent_preset(app: AppHandle, id: String) -> Result<(), String> {
    let db = app.state::<GroupState>();
    let repo = AgentProfileRepository::new(db.db.as_ref());
    repo.delete(&id).map_err(|e| e.to_string())
}







#[tauri::command]
pub async fn scan_local_agents(_app: AppHandle) -> Result<Vec<LocalAgentEntry>, String> {
    let mut entries: Vec<LocalAgentEntry> = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = vec![
        (format!("{}/.claude/agents", home), "home".to_string()),
        ("./.claude/agents".to_string(), "workspace".to_string()),
    ];
    for (dir, src) in candidates {
        let p = Path::new(&dir);
        if !p.exists() {
            continue;
        }
        if let Ok(read) = std::fs::read_dir(p) {
            for entry in read.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "md").unwrap_or(false) {
                    let name = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    entries.push(LocalAgentEntry {
                        name,
                        path: path.to_string_lossy().to_string(),
                        source: src.clone(),
                    });
                }
            }
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}


#[tauri::command]
pub async fn import_agent(app: AppHandle, path: String) -> Result<AgentProfile, String> {
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let (payload, ext) = parse_agent_md(&content)?;
    let db = app.state::<GroupState>();
    let repo = AgentProfileRepository::new(db.db.as_ref());
    repo.create_full(payload, ext).map_err(|e| e.to_string())
}



#[tauri::command]
pub async fn export_agent(
    app: AppHandle,
    id: String,
    dir: String,
    redact: bool,
) -> Result<String, String> {
    let db = app.state::<GroupState>();
    let repo = AgentProfileRepository::new(db.db.as_ref());
    let profile = repo
        .find_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or("agent 不存在")?;
    let md = render_agent_md(&profile, redact);
    let safe_name = profile.name.replace(['/', ' ', '\0'], "_");
    
    let out_dir = if dir.trim().is_empty() {
        crate::paths::data_dir().join("agent-exports")
    } else {
        Path::new(&dir).to_path_buf()
    };
    let out_path = out_dir.join(format!("{}.md", safe_name));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建目录失败: {}", e))?;
    std::fs::write(&out_path, md).map_err(|e| format!("写入失败: {}", e))?;
    Ok(out_path.to_string_lossy().to_string())
}





#[tauri::command]
pub async fn create_group<R: Runtime>(
    app: AppHandle<R>,
    payload: CreateGroupPayload,
) -> Result<Group, crate::error::AgentError> {
    let mut _g = crate::commands::CmdLog::begin("create_group", &[
        ("name", payload.name.clone()),
        ("owner", payload.owner_agent_ref.clone()),
    ]);
    let db = app.state::<GroupState>();
    match GroupManager::new(db.db.clone()).create_group(payload) {
        Ok(g) => Ok(g),
        Err(e) => {
            
            _g.fail(&e);
            
            Err(e.into())
        }
    }
}




#[tauri::command]
pub async fn group_create_from_manifest(
    app: AppHandle,
    manifest_json: String,
) -> Result<Group, String> {
    let manifest = GroupManifest::from_json(&manifest_json).map_err(|e| e.to_string())?;
    let db = app.state::<GroupState>();
    GroupManager::new(db.db.clone()).create_group_from_manifest(&manifest)
}

#[tauri::command]
pub async fn list_groups(app: AppHandle) -> Result<Vec<GroupListItem>, String> {
    let db = app.state::<GroupState>();
    GroupManager::new(db.db.clone()).list_groups()
}

#[tauri::command]
pub async fn get_group(app: AppHandle, id: String) -> Result<Option<Group>, String> {
    let db = app.state::<GroupState>();
    GroupManager::new(db.db.clone()).get_group(&id)
}

#[tauri::command]
pub async fn group_pause(app: AppHandle, id: String) -> Result<(), String> {
    let db = app.state::<GroupState>();
    GroupManager::new(db.db.clone()).pause(&id)?;
    
    crate::events::emit_envelope(
        &app,
        "group-event",
        "group:paused",
        None,
        Some(&id),
        json!({ "type": "group_paused", "group_id": id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn group_resume(
    app: AppHandle,
    scheduler: State<'_, Arc<TaskScheduler>>,
    id: String,
) -> Result<(), String> {
    let db = app.state::<GroupState>();
    GroupManager::new(db.db.clone()).resume(&id)?;
    
    let repo = TaskBoardRepository::new(db.db.as_ref());
    let tasks = repo.find_by_group(&id).map_err(|e| e.to_string())?;
    let mut pending_batches: Vec<String> = tasks
        .iter()
        .filter(|t| t.status == TaskStatus::Pending)
        .filter_map(|t| t.batch_id.clone())
        .collect();
    pending_batches.sort();
    pending_batches.dedup();
    for bid in pending_batches {
        let _ = scheduler.inner().clone().process_batch_entry(&id, &bid).await;
    }
    crate::events::emit_envelope(
        &app,
        "group-event",
        "group:resumed",
        None,
        Some(&id),
        json!({ "type": "group_resumed", "group_id": id }),
    );
    Ok(())
}



#[tauri::command]
pub async fn group_dissolve(app: AppHandle, id: String) -> Result<(), String> {
    let db = app.state::<GroupState>();
    
    let workers = WorkerRepository::new(db.db.as_ref())
        .list_by_group(&id)
        .map_err(|e| e.to_string())?;
    let agent_state = app.state::<AgentState>();
    for w in workers {
        let session_id = worker_session_id(&id, &w.id);
        agent_state.engine.cancel(&session_id).await;
    }
    
    GroupManager::new(db.db.clone()).dissolve(&id)
}


#[tauri::command]
pub async fn group_add_worker(
    app: AppHandle,
    group_id: String,
    agent_ref: String,
    capabilities: Option<Vec<String>>,
    max_concurrency: Option<i32>,
) -> Result<Worker, crate::error::AgentError> {
    let db = app.state::<GroupState>();
    GroupManager::new(db.db.clone())
        .add_worker(
            &group_id,
            &agent_ref,
            capabilities.unwrap_or_default(),
            max_concurrency.unwrap_or(1),
        )
        .map_err(|e| e.into())
}



#[tauri::command]
pub async fn group_add_capability_seat<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
    capabilities: Vec<String>,
    max_concurrency: Option<i32>,
) -> Result<Worker, crate::error::AgentError> {
    if capabilities.is_empty() {
        return Err(crate::error::AgentError::Legacy {
            message: "能力席位至少需要一个能力声明".into(),
        });
    }
    let db = app.state::<GroupState>();
    GroupManager::new(db.db.clone())
        .add_capability_seat(
            &group_id,
            capabilities,
        max_concurrency.unwrap_or(1),
    )
    .map_err(|e| e.into())
}



#[tauri::command]
pub async fn group_set_worker_agent(
    app: AppHandle,
    group_id: String,
    worker_id: String,
    agent_ref: String,
) -> Result<Worker, String> {
    let db = app.state::<GroupState>();
    let repo = WorkerRepository::new(db.db.as_ref());
    let w = repo
        .find_by_id(&worker_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "worker not found".to_string())?;
    if w.group_id != group_id {
        return Err("worker does not belong to this group".into());
    }
    let pool = WorkerPool::new(group_id.clone(), db.db.clone());
    let updated = pool.set_agent(&worker_id, &agent_ref).map_err(|e| e.to_string())?;
    crate::events::emit_envelope(
        &app,
        "group-event",
        "group:worker_updated",
        None,
        Some(&group_id),
        json!({ "type": "worker_updated", "group_id": group_id, "worker_id": worker_id, "agent_ref": agent_ref }),
    );
    Ok(updated)
}



#[tauri::command]
pub async fn group_set_worker_status(
    app: AppHandle,
    group_id: String,
    worker_id: String,
    status: String,
) -> Result<(), String> {
    let target = match status.as_str() {
        "idle" => WorkerStatus::Idle,
        "offline" => WorkerStatus::Offline,
        other => return Err(format!("unsupported worker status: {}", other)),
    };
    let db = app.state::<GroupState>();
    let repo = WorkerRepository::new(db.db.as_ref());
    let w = repo
        .find_by_id(&worker_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "worker not found".to_string())?;
    if w.group_id != group_id {
        return Err("worker does not belong to this group".into());
    }
    match (&w.status, &target) {
        (WorkerStatus::Idle, WorkerStatus::Offline)
        | (WorkerStatus::Offline, WorkerStatus::Idle) => {}
        _ => {
            return Err(format!(
                "cannot change worker status from {:?} to {:?}; only Idle<->Offline is allowed",
                w.status, target
            ))
        }
    }
    repo.update_status(&worker_id, target)
        .map_err(|e| e.to_string())
}



#[tauri::command]
pub async fn group_remove_worker(
    app: AppHandle,
    group_id: String,
    worker_id: String,
) -> Result<(), String> {
    let db = app.state::<GroupState>();
    let repo = WorkerRepository::new(db.db.as_ref());
    let w = repo
        .find_by_id(&worker_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "worker not found".to_string())?;
    if w.group_id != group_id {
        return Err("worker does not belong to this group".into());
    }
    if w.status == WorkerStatus::Busy {
        let agent_state = app.state::<AgentState>();
        let session_id = worker_session_id(&group_id, &worker_id);
        agent_state.engine.cancel(&session_id).await;
        if let Some(tid) = w.current_task_id {
            let trepo = TaskBoardRepository::new(db.db.as_ref());
            let _ = trepo.update_status(&tid, TaskStatus::Cancelled);
        }
    }
    repo.delete(&worker_id).map_err(|e| e.to_string())?;
    crate::events::emit_envelope(
        &app,
        "group-event",
        "group:worker_removed",
        None,
        Some(&group_id),
        json!({ "type": "worker_removed", "group_id": group_id, "worker_id": worker_id }),
    );
    Ok(())
}



#[tauri::command]
pub async fn group_assign_tasks(
    scheduler: State<'_, Arc<TaskScheduler>>,
    group_id: String,
    tasks: Vec<SubTask>,
    submitted_by: Option<String>,
    auto_approve: Option<bool>,
) -> Result<String, String> {
    let mut _g = crate::commands::CmdLog::begin("group_assign_tasks", &[
        ("group_id", group_id.clone()),
        ("task_count", tasks.len().to_string()),
        ("submitted_by", submitted_by.clone().unwrap_or_else(|| "owner".into())),
        ("auto_approve", auto_approve.unwrap_or(true).to_string()),
    ]);
    if tasks.is_empty() {
        _g.fail("tasks must not be empty");
        return Err("tasks must not be empty".into());
    }
    let batch_id = format!("batch_{}", uuid::Uuid::new_v4().simple());
    let auto_approve = auto_approve.unwrap_or(true);
    scheduler.inner().clone().submit_batch(&group_id, &batch_id, tasks, auto_approve).await?;
    Ok(batch_id)
}



#[tauri::command]
pub async fn group_approve_batch(
    scheduler: State<'_, Arc<TaskScheduler>>,
    group_id: String,
    batch_id: String,
) -> Result<(), String> {
    let mut _g = crate::commands::CmdLog::begin("group_approve_batch", &[
        ("group_id", group_id.clone()),
        ("batch_id", batch_id.clone()),
    ]);
    scheduler.inner().clone().approve_batch(&group_id, &batch_id).await
}


#[tauri::command]
pub async fn group_list_workers(app: AppHandle, group_id: String) -> Result<Vec<Worker>, String> {
    let db = app.state::<GroupState>();
    WorkerRepository::new(db.db.as_ref())
        .list_by_group(&group_id)
        .map_err(|e| e.to_string())
}


#[tauri::command]
pub async fn group_list_worker_metrics(
    app: AppHandle,
    group_id: String,
) -> Result<Vec<WorkerMetric>, String> {
    let gdb = app.state::<GroupState>();
    WorkerMetricRepository::new(gdb.db.as_ref())
        .list_by_group(&group_id)
        .map_err(|e| e.to_string())
}


#[tauri::command]
pub async fn group_list_tasks(
    app: AppHandle,
    group_id: String,
    batch_id: Option<String>,
) -> Result<Vec<Task>, String> {
    let db = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(db.db.as_ref());
    match batch_id {
        Some(b) => repo.find_by_batch(&group_id, &b).map_err(|e| e.to_string()),
        None => repo.find_by_group(&group_id).map_err(|e| e.to_string()),
    }
}


#[tauri::command]
pub async fn task_list_all(app: AppHandle) -> Result<Vec<Task>, String> {
    let db = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(db.db.as_ref());
    repo.list_all().map_err(|e| e.to_string())
}









#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCreateInput {
    pub description: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    
    #[serde(default)]
    pub status: Option<TaskStatus>,
}

#[tauri::command]
pub async fn task_create(app: AppHandle, payload: TaskCreateInput) -> Result<Task, String> {
    if payload.description.trim().is_empty() {
        return Err("task description is required".into());
    }
    let db = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(db.db.as_ref());
    let id = format!("task-{}", Uuid::new_v4().simple());
    let group_id = payload
        .group_id
        .filter(|g| !g.trim().is_empty())
        .unwrap_or_else(|| "personal".to_string());
    let p = CreateTaskPayload {
        id,
        group_id,
        batch_id: None,
        worker_id: None,
        description: payload.description.trim().to_string(),
        depends_on: payload.depends_on,
        input_refs: vec![],
        output_spec: None,
        status: payload.status,
        capability: payload.capability,
        reasoning: payload.reasoning,
    };
    repo.create(p).map_err(|e| e.to_string())
}







#[tauri::command]
pub async fn group_post_message(
    app: AppHandle,
    group_id: String,
    content: String,
    mentions: Option<Vec<String>>,
    attachments: Option<Vec<String>>,
) -> Result<RoundtableMessage, String> {
    let mut _g = crate::commands::CmdLog::begin("group_post_message", &[
        ("group_id", group_id.clone()),
        ("content_len", content.len().to_string()),
        ("mentions", mentions.clone().unwrap_or_default().join(",")),
    ]);
    let gdb = app.state::<GroupState>();
    let group = GroupManager::new(gdb.db.clone())
        .get_group(&group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "group not found".to_string())?;
    let bus = app.state::<Arc<RoundtableBus>>().inner();
    let r = bus
        .post(
            group_id,
            content,
            mentions.unwrap_or_default(),
            group.owner_agent_ref,
            attachments.unwrap_or_default(),
        )
        .await;
    if let Err(e) = &r {
        _g.fail(e);
    }
    r
}


#[tauri::command]
pub async fn group_roundtable_broadcast(
    app: AppHandle,
    group_id: String,
    content: String,
    attachments: Option<Vec<String>>,
) -> Result<RoundtableMessage, String> {
    let mut _g = crate::commands::CmdLog::begin("group_roundtable_broadcast", &[
        ("group_id", group_id.clone()),
        ("content_len", content.len().to_string()),
    ]);
    let gdb = app.state::<GroupState>();
    let group = GroupManager::new(gdb.db.clone())
        .get_group(&group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "group not found".to_string())?;
    let bus = app.state::<Arc<RoundtableBus>>().inner();
    let r = bus
        .broadcast(
            group_id,
            content,
            group.owner_agent_ref,
            attachments.unwrap_or_default(),
        )
        .await;
    if let Err(e) = &r {
        _g.fail(e);
    }
    r
}





#[tauri::command]
pub async fn group_topology_get(app: AppHandle, group_id: String) -> Result<TopologyPolicy, String> {
    let gdb = app.state::<GroupState>();
    let repo = TopologyPolicyRepository::new(gdb.db.as_ref());
    let policy = repo
        .latest_for_group(&group_id)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(policy)
}






#[tauri::command]
pub async fn group_topology_set<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
    policy: TopologyPolicy,
) -> Result<u64, String> {
    let gdb = app.state::<GroupState>();
    let repo = TopologyPolicyRepository::new(gdb.db.as_ref());
    let version = repo.commit_next(&group_id, policy).map_err(|e| e.to_string())?;
    Ok(version)
}


#[tauri::command]
pub async fn group_list_messages(
    app: AppHandle,
    group_id: String,
) -> Result<Vec<RoundtableMessage>, String> {
    let gdb = app.state::<GroupState>();
    RoundtableRepository::new(gdb.db.as_ref())
        .find_by_group(&group_id)
        .map_err(|e| e.to_string())
}


#[derive(Debug, Clone, Serialize)]
pub struct BlackboardEntry {
    pub key: String,
    pub value: String,
    pub version: u64,
}


#[derive(Debug, Clone, Serialize)]
pub struct BlackboardSnapshot {
    pub group_id: String,
    pub entries: Vec<BlackboardEntry>,
}




#[tauri::command]
pub async fn group_blackboard_get(
    app: AppHandle,
    group_id: String,
) -> Result<BlackboardSnapshot, String> {
    let gdb = app.state::<GroupState>();
    let bb = SqliteBlackboard::new(gdb.db.clone());
    let entries = bb
        .list(&format!("bb:{}", group_id))
        .into_iter()
        .map(|(key, value, version)| BlackboardEntry { key, value, version })
        .collect();
    Ok(BlackboardSnapshot { group_id, entries })
}






#[tauri::command]
pub async fn group_blackboard_set(
    app: AppHandle,
    group_id: String,
    key: String,
    value: String,
    expected_version: u64,
) -> Result<u64, crate::error::AgentError> {
    let gdb = app.state::<GroupState>();
    let bb = SqliteBlackboard::new(gdb.db.clone());
    bb.cas_write(&format!("bb:{}", group_id), &key, &value, expected_version)
        .map_err(|e| match e {
            
            crate::agent::ports::BlackboardError::Conflict(current) => {
                crate::error::AgentError::Legacy {
                    message: format!(
                        "版本冲突：期望版本 {}，当前已是版本 {}。请先读取最新值再更新。",
                        expected_version, current
                    ),
                }
            }
            crate::agent::ports::BlackboardError::RoutingDenied(reason) => {
                crate::error::AgentError::Legacy {
                    message: format!("拓扑策略拒绝写入共享黑板：{}", reason),
                }
            }
            crate::agent::ports::BlackboardError::Store(msg) => {
                crate::error::AgentError::Legacy {
                    message: format!("黑板存储失败：{}", msg),
                }
            }
        })
}



#[tauri::command]
pub async fn group_list_alternatives<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
) -> Result<Vec<RoundtableAlternative>, String> {
    let gdb = app.state::<GroupState>();
    
    RoundtableAlternativeRepository::new(gdb.db.as_ref())
        .find_before(&group_id, i64::MAX)
        .map_err(|e| e.to_string())
}






#[tauri::command]
pub async fn group_pick_alternative<R: Runtime>(
    app: AppHandle<R>,
    group_id: String,
    alt_id: i64,
) -> Result<RoundtableMessage, String> {
    let gdb = app.state::<GroupState>();
    let db = gdb.db.as_ref();
    let alt = RoundtableAlternativeRepository::new(db)
        .find_by_id(alt_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "alternative not found".to_string())?;
    
    let name = WorkerRepository::new(db)
        .find_by_id(&alt.worker_id)
        .ok()
        .flatten()
        .and_then(|w| {
            AgentProfileRepository::new(db)
                .find_by_id(&w.agent_ref)
                .ok()
                .flatten()
                .map(|p| p.name)
        })
        .unwrap_or_else(|| alt.worker_id.clone());
    let content = format!("[改选] 已将「{}」的方案作为后续任务种子", name);
    let msg = RoundtableMessage {
        seq: 0,
        group_id,
        author: String::new(),
        worker_id: String::new(),
        author_kind: "system".into(),
        content,
        mentions: vec![],
        attachments: vec![],
        created_at: crate::agent::ledger::now_unix_ms(),
        session_id: String::new(),
    };
    let seq = RoundtableRepository::new(db)
        .create(&msg)
        .map_err(|e| e.to_string())?;
    let msg = RoundtableMessage { seq, ..msg };
    
    let _ = app.emit("roundtable-message", &msg);
    Ok(msg)
}








#[tauri::command]
pub async fn group_rerun_from_message(
    app: AppHandle,
    group_id: String,
    seq: i64,
    mode: String,
    worker_id: Option<String>,
    prompt: Option<String>,
) -> Result<RoundtableMessage, String> {
    let mut _g = crate::commands::CmdLog::begin("group_rerun_from_message", &[
        ("group_id", group_id.clone()),
        ("seq", seq.to_string()),
        ("mode", mode.clone()),
        ("worker_id", worker_id.clone().unwrap_or_default()),
    ]);
    let gdb = app.state::<GroupState>();
    GroupManager::new(gdb.db.clone())
        .get_group(&group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "group not found".to_string())?;
    let mode = RerunMode::parse(&mode)?;
    let bus = app.state::<Arc<RoundtableBus>>().inner();
    let r = bus.rerun_from_message(group_id, seq, mode, worker_id, prompt).await;
    if let Err(e) = &r {
        _g.fail(e);
    }
    r
}


#[tauri::command]
pub async fn group_roundtable_summarize(
    app: AppHandle,
    group_id: String,
) -> Result<RoundtableSummary, String> {
    let mut _g = crate::commands::CmdLog::begin("group_roundtable_summarize", &[
        ("group_id", group_id.clone()),
    ]);
    let gdb = app.state::<GroupState>();
    
    GroupManager::new(gdb.db.clone())
        .get_group(&group_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "group not found".to_string())?;
    let bus = app.state::<Arc<RoundtableBus>>().inner();
    let r = bus.summarize(group_id).await;
    if let Err(e) = &r {
        _g.fail(e);
    }
    r
}


#[tauri::command]
pub async fn group_list_summaries(
    app: AppHandle,
    group_id: String,
) -> Result<Vec<RoundtableSummary>, String> {
    let gdb = app.state::<GroupState>();
    crate::group::roundtable_repo::RoundtableSummaryRepository::new(gdb.db.as_ref())
        .find_by_group(&group_id)
        .map_err(|e| e.to_string())
}







#[tauri::command]
pub async fn group_list_deliverables(
    app: AppHandle,
    group_id: String,
) -> Result<Vec<Deliverable>, String> {
    let gdb = app.state::<GroupState>();
    let db = gdb.db.as_ref();
    let mut items: Vec<Deliverable> = Vec::new();

    
    if let Ok(msgs) = RoundtableRepository::new(db).find_by_group(&group_id) {
        for m in msgs {
            if m.author_kind != "worker" {
                continue;
            }
            items.push(Deliverable {
                id: format!("msg_{}", m.seq),
                kind: "reply".into(),
                title: format!("{} 的回复", m.author),
                author: m.author.clone(),
                worker_id: m.worker_id.clone(),
                created_at: m.created_at,
                preview: truncate(&m.content, 140),
                content: m.content.clone(),
                ref_seq: Some(m.seq),
                ref_id: None,
                meta: String::new(),
                
                trace_ref: if m.session_id.is_empty() {
                    None
                } else {
                    Some(TraceRef {
                        source: "roundtable".into(),
                        key: m.session_id.clone(),
                    })
                },
                
                media: merge_media(
                    m.attachments.iter().map(|p| path_to_media(p)).collect(),
                    extract_media_from_content(&m.content),
                ),
            });
        }
    }

    
    if let Ok(tasks) = TaskBoardRepository::new(db).find_by_group(&group_id) {
        for tk in tasks {
            if tk.outputs.is_empty() {
                continue;
            }
            let author = tk
                .assigned_worker
                .clone()
                .or_else(|| tk.worker_id.clone())
                .unwrap_or_default();
            for (i, out) in tk.outputs.iter().enumerate() {
                items.push(Deliverable {
                    id: format!("task_{}_{}", tk.id, i),
                    kind: "task_output".into(),
                    title: tk.description.clone(),
                    author: author.clone(),
                    worker_id: tk.worker_id.clone().unwrap_or_default(),
                    created_at: 0, 
                    preview: truncate(out, 140),
                    content: out.clone(),
                    ref_seq: None,
                    ref_id: Some(tk.id.clone()),
                    meta: format!("输出 {}/{}", i + 1, tk.outputs.len()),
                    media: classify_media(out).into_iter().collect(),
                    
                    
                    trace_ref: tk
                        .worker_id
                        .as_ref()
                        .filter(|w| !w.is_empty())
                        .map(|w| TraceRef {
                            source: "run".into(),
                            key: worker_session_id(&group_id, w),
                        }),
                });
            }
        }
    }

    
    if let Ok(summaries) = RoundtableSummaryRepository::new(db).find_by_group(&group_id) {
        for s in summaries {
            items.push(Deliverable {
                id: format!("summary_{}", s.id),
                kind: "summary".into(),
                title: format!("群摘要 #{}", s.id),
                author: String::new(),
                worker_id: String::new(),
                created_at: s.created_at,
                preview: truncate(&s.content, 140),
                content: s.content.clone(),
                ref_seq: None,
                ref_id: Some(s.id.to_string()),
                meta: format!("聚合 {} 条消息", s.message_count),
                media: Vec::new(),
                
                trace_ref: None,
            });
        }
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}



#[tauri::command]
pub async fn group_cancel_batch(
    scheduler: State<'_, Arc<TaskScheduler>>,
    group_id: String,
    batch_id: String,
) -> Result<(), String> {
    scheduler.inner().clone().cancel_batch(&group_id, &batch_id).await
}






#[tauri::command]
pub async fn group_get_workspace(
    group_id: String,
    worker_id: Option<String>,
) -> Result<String, String> {
    let wm = WorkspaceManager::new();
    wm.ensure(&group_id, worker_id.as_deref())
        .map(|p| p.to_string_lossy().into_owned())
}










#[tauri::command]
pub async fn workspace_reveal(path: String) -> Result<(), crate::error::AgentError> {
    use std::path::PathBuf;
    use std::process::Command;

    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(crate::error::AgentError::Legacy {
            message: format!(
                "workspace_reveal requires absolute path (got: {})",
                path
            ),
        });
    }
    
    if path
        .chars()
        .any(|c| matches!(c, ';' | '&' | '|' | '`' | '$' | '\n' | '\r' | '"' | '\''))
    {
        return Err(crate::error::AgentError::Legacy {
            message: "workspace_reveal: forbidden char in path".into(),
        });
    }

    
    let canonical = p.canonicalize().unwrap_or(p);

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(&canonical).spawn();
    #[cfg(target_os = "windows")]
    let status = {
        
        let arg = format!("/select,{}", canonical.display());
        Command::new("explorer.exe").raw_arg(&arg).spawn()
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = {
        
        let dir = canonical.parent().unwrap_or(&canonical);
        Command::new("xdg-open").arg(dir).spawn()
    };

    match status {
        Ok(_) => Ok(()),
        Err(e) => Err(crate::error::AgentError::Legacy {
            message: format!(
                "failed to launch file manager for {}: {}",
                canonical.display(),
                e
            ),
        }),
    }
}














#[tauri::command]
pub async fn task_retry(
    app: AppHandle,
    scheduler: State<'_, Arc<TaskScheduler>>,
    task_id: String,
) -> Result<Task, String> {
    let mut _g = crate::commands::CmdLog::begin("task_retry", &[
        ("task_id", task_id.clone()),
    ]);
    let gdb = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(gdb.db.as_ref());
    let updated = repo.retry_task(&task_id).map_err(|e| e.to_string())?;
    
    
    let _ = crate::storage::longtask_repo::LongTaskRepository::new(gdb.db.as_ref())
        .mark_superseded_by_job(&task_id);
    if let Some(bid) = &updated.batch_id {
        let _ = scheduler
            .inner()
            .clone()
            .process_batch_entry(&updated.group_id, bid)
            .await;
    }
    crate::events::emit_envelope(
        &app,
        "group-event",
        "group:task_reset",
        None,
        Some(&updated.group_id),
        json!({ "type": "task_reset", "group_id": updated.group_id, "task_id": task_id, "action": "retry" }),
    );
    Ok(updated)
}






#[tauri::command]
pub async fn task_reassign(
    app: AppHandle,
    scheduler: State<'_, Arc<TaskScheduler>>,
    task_id: String,
    worker_id: Option<String>,
) -> Result<Task, String> {
    let mut _g = crate::commands::CmdLog::begin("task_reassign", &[
        ("task_id", task_id.clone()),
        ("worker_id", worker_id.clone().unwrap_or_default()),
    ]);
    let gdb = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(gdb.db.as_ref());
    let updated = repo
        .reassign_task(&task_id, worker_id)
        .map_err(|e| e.to_string())?;
    if let Some(bid) = &updated.batch_id {
        let _ = scheduler
            .inner()
            .clone()
            .process_batch_entry(&updated.group_id, bid)
            .await;
    }
    crate::events::emit_envelope(
        &app,
        "group-event",
        "group:task_reset",
        None,
        Some(&updated.group_id),
        json!({ "type": "task_reset", "group_id": updated.group_id, "task_id": task_id, "action": "reassign" }),
    );
    Ok(updated)
}






#[tauri::command]
pub async fn task_skip_dependency(
    app: AppHandle,
    scheduler: State<'_, Arc<TaskScheduler>>,
    task_id: String,
) -> Result<Task, String> {
    let gdb = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(gdb.db.as_ref());
    let updated = repo.skip_dependencies(&task_id).map_err(|e| e.to_string())?;
    if let Some(bid) = &updated.batch_id {
        let _ = scheduler
            .inner()
            .clone()
            .process_batch_entry(&updated.group_id, bid)
            .await;
    }
    crate::events::emit_envelope(
        &app,
        "group-event",
        "group:task_reset",
        None,
        Some(&updated.group_id),
        json!({ "type": "task_reset", "group_id": updated.group_id, "task_id": task_id, "action": "skip_dependency" }),
    );
    Ok(updated)
}













#[tauri::command]
pub async fn task_set_status(
    app: AppHandle,
    scheduler: State<'_, Arc<TaskScheduler>>,
    task_id: String,
    status: TaskStatus,
) -> Result<Task, String> {
    let gdb = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(gdb.db.as_ref());
    let cur = repo
        .find_by_id(&task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task {task_id} not found"))?;

    let is_terminal = matches!(
        status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
    );
    repo.update_status(&task_id, status.clone()).map_err(|e| e.to_string())?;
    emit_task_status_changed(&app, &cur.group_id, &task_id, &cur.status, &status);

    
    if is_terminal && cur.batch_id.is_some() {
        if let Some(bid) = &cur.batch_id {
            let _ = scheduler
                .inner()
                .clone()
                .process_batch_entry(&cur.group_id, bid)
                .await;
        }
    }

    repo.find_by_id(&task_id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task {task_id} not found"))
}


fn emit_task_status_changed(
    app: &AppHandle,
    group_id: &str,
    task_id: &str,
    from: &TaskStatus,
    to: &TaskStatus,
) {
    crate::events::emit_envelope(
        app,
        "group-event",
        "group:task_status_changed",
        None,
        Some(group_id),
        json!({ "type": "task_status_changed", "group_id": group_id, "task_id": task_id, "from": from, "to": to }),
    );
}






#[tauri::command]
pub async fn task_attach_outputs(
    app: AppHandle,
    scheduler: State<'_, Arc<TaskScheduler>>,
    task_id: String,
    paths: Vec<String>,
) -> Result<Task, String> {
    let mut _g = crate::commands::CmdLog::begin("task_attach_outputs", &[
        ("task_id", task_id.clone()),
        ("path_count", paths.len().to_string()),
    ]);
    let gdb = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(gdb.db.as_ref());
    let cur = repo
        .find_by_id(&task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task {task_id} not found"))?;

    let is_terminal = matches!(
        cur.status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
    );
    repo.append_outputs(&task_id, &paths).map_err(|e| e.to_string())?;
    if !is_terminal {
        repo.mark_completed(&task_id).map_err(|e| e.to_string())?;
        emit_task_status_changed(
            &app,
            &cur.group_id,
            &task_id,
            &cur.status,
            &TaskStatus::Completed,
        );
    }
    
    if let Some(bid) = &cur.batch_id {
        let _ = scheduler
            .inner()
            .clone()
            .process_batch_entry(&cur.group_id, bid)
            .await;
    }
    repo.find_by_id(&task_id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task {task_id} not found"))
}






#[tauri::command]
pub async fn task_launch(
    scheduler: State<'_, Arc<TaskScheduler>>,
    group_id: String,
    batch_id: String,
) -> Result<(), String> {
    let mut _g = crate::commands::CmdLog::begin("task_launch", &[
        ("group_id", group_id.clone()),
        ("batch_id", batch_id.clone()),
    ]);
    scheduler.inner().clone().process_batch_entry(&group_id, &batch_id).await
}



#[tauri::command]
pub async fn task_reorder(
    app: AppHandle,
    task_id: String,
    before_id: Option<String>,
) -> Result<Task, String> {
    let _g = crate::commands::CmdLog::begin("task_reorder", &[
        ("task_id", task_id.clone()),
        ("before_id", before_id.clone().unwrap_or_default()),
    ]);
    let gdb = app.state::<GroupState>();
    let repo = TaskBoardRepository::new(gdb.db.as_ref());
    repo.reorder(&task_id, before_id.as_deref())
        .map_err(|e| e.to_string())?;
    repo.find_by_id(&task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task {task_id} not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_media_finds_backtick_path() {
        let s = "已生成： `/tmp/x/lianliankan.html` 请查收";
        let m = extract_media_from_content(s);
        assert_eq!(m.len(), 1, "反引号路径应被识别");
        assert_eq!(m[0].path, "/tmp/x/lianliankan.html");
        assert_eq!(m[0].r#type, "file");
    }

    #[test]
    fn extract_media_finds_image_ext() {
        let s = "配图在 `/tmp/preview.png` 和 /var/a/b/shot.jpg 两处";
        let m = extract_media_from_content(s);
        let paths: Vec<&str> = m.iter().map(|x| x.path.as_str()).collect();
        assert!(paths.contains(&"/tmp/preview.png"));
        assert!(paths.contains(&"/var/a/b/shot.jpg"));
        assert!(m.iter().all(|x| x.r#type == "image"));
    }

    #[test]
    fn extract_media_skips_route_like_paths() {
        
        let s = "调用 GET /api/v1/users 与 POST /auth/login 完成";
        let m = extract_media_from_content(s);
        assert!(m.is_empty(), "纯路由路径不带文件后缀，不应识别为文件：{:?}", m);
    }

    #[test]
    fn extract_media_skips_bare_filename() {
        let s = "看 report.txt 和 data.csv 两个文件";
        let m = extract_media_from_content(s);
        assert!(m.is_empty(), "无绝对路径的裸文件名不应误判：{:?}", m);
    }

    #[test]
    fn extract_media_handles_windows_path() {
        let s = "落地在 `C:\\work\\out\\plan.pdf`";
        let m = extract_media_from_content(s);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].path, "C:\\work\\out\\plan.pdf");
    }

    #[test]
    fn merge_media_dedups_by_path() {
        let a = vec![path_to_media("/tmp/a.html"), path_to_media("/tmp/b.html")];
        let b = vec![path_to_media("/tmp/b.html"), path_to_media("/tmp/c.html")];
        let m = merge_media(a, b);
        let paths: Vec<&str> = m.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, vec!["/tmp/a.html", "/tmp/b.html", "/tmp/c.html"]);
    }
}

