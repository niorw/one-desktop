





















use crate::agent::engine::{REASONING_PROTOCOL, AgentLoopEngine, ResumePoint};
use crate::agent::ports::{EventBus, TaskHeartbeat};
use crate::group::agent_repo::AgentProfileRepository;
use crate::group::group_repo::GroupRepository;
use crate::group::roundtable::emit_worker_status;
use crate::group::roundtable_repo::{RoundtableMessage, RoundtableRepository};
use crate::group::task_board::{SubTask, Task, TaskStatus};
use crate::group::task_board_repo::TaskBoardRepository;
use crate::group::worker::{worker_session_id, WorkerPool, WorkerStatus};
use crate::group::worker_repo::WorkerRepository;
use crate::group::workspace::WorkspaceManager;
use crate::group::GroupStatus;
use crate::session::manager::SessionManager;
use crate::storage::connection::DbConnection;
use crate::storage::longtask_repo::LongTaskRepository;
use crate::storage::repository::Repository;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{interval as tokio_interval, Duration as TokioDuration};


type SchedFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;






fn log_persist_failure(what: &str, task_id: &str, r: rusqlite::Result<()>) {
    if let Err(e) = r {
        tracing::warn!(
            target: "onedesktop.scheduler",
            task_id = %task_id,
            error = %e,
            "持久化失败（ADR-023 不静默）: {what}"
        );
    }
}




static SCHEDULER_HANDLE: OnceLock<Arc<TaskScheduler>> = OnceLock::new();



const HEARTBEAT_INTERVAL_SECS: u64 = 5;








pub struct TaskScheduler {
    db: Arc<DbConnection>,
    engine: Arc<AgentLoopEngine>,
    
    executor: Arc<dyn crate::agent::executor::AgentExecutor>,
    
    cli_executors: HashMap<String, Arc<dyn crate::agent::executor::AgentExecutor>>,
    
    
    heartbeat: Arc<dyn TaskHeartbeat>,
    session_manager: Arc<SessionManager>,
    bus: Arc<dyn EventBus>,
    
    dispatch_lock: Arc<AsyncMutex<()>>,
    
    completed_batches: Arc<AsyncMutex<HashSet<String>>>,
}

impl TaskScheduler {
    pub fn new(
        db: Arc<DbConnection>,
        engine: Arc<AgentLoopEngine>,
        executor: Arc<dyn crate::agent::executor::AgentExecutor>,
        cli_executors: HashMap<String, Arc<dyn crate::agent::executor::AgentExecutor>>,
        session_manager: Arc<SessionManager>,
        bus: Arc<dyn EventBus>,
        heartbeat: Arc<dyn TaskHeartbeat>,
    ) -> Self {
        Self {
            db,
            engine,
            executor,
            cli_executors,
            session_manager,
            bus,
            heartbeat,
            dispatch_lock: Arc::new(AsyncMutex::new(())),
            completed_batches: Arc::new(AsyncMutex::new(HashSet::new())),
        }
    }

    
    
    
    pub fn set_scheduler_handle(handle: Arc<TaskScheduler>) {
        let _ = SCHEDULER_HANDLE.set(handle);
    }

    
    pub fn get_scheduler_handle() -> Option<Arc<TaskScheduler>> {
        SCHEDULER_HANDLE.get().cloned()
    }

    
    
    
    
    pub async fn sweep_stale_tasks(&self, timeout_secs: i64) -> Result<usize, String> {
        let repo = TaskBoardRepository::new(&self.db);
        let stale = repo.find_stale(timeout_secs).map_err(|e| e.to_string())?;
        let n = stale.len();
        for t in &stale {
            
            
            log_persist_failure(
                "update_status→Failed",
                &t.id,
                repo.update_status(&t.id, TaskStatus::Failed),
            );
            tracing::warn!(
                target: "onedesktop.scheduler",
                "swept stale task {} (last_heartbeat={:?}) as Failed",
                t.id, t.last_heartbeat
            );
            
            self.bus.emit(
                "group-event",
                "group:task_failed",
                Some(&t.group_id),
                json!({
                    "group_id": t.group_id,
                    "task_id": t.id,
                    "description": t.description,
                    "reason": "stale_heartbeat",
                }),
            );
        }
        Ok(n)
    }

    
    
    
    
    
    
    
    
    pub async fn run_sweeper_loop(
        self: Arc<Self>,
        timeout_secs: i64,
        sweep_interval_secs: u64,
    ) {
        let mut ticker = tokio_interval(TokioDuration::from_secs(sweep_interval_secs));
        loop {
            ticker.tick().await;
            if let Err(e) = self.sweep_stale_tasks(timeout_secs).await {
                tracing::warn!(target: "onedesktop.scheduler", "sweep error: {}", e);
            }
        }
    }

    
    
    
    
    
    
    pub fn submit_batch(
        self: Arc<Self>,
        group_id: &str,
        batch_id: &str,
        subtasks: Vec<SubTask>,
        auto_approve: bool,
    ) -> impl Future<Output = Result<(), String>> {
        let db = self.db.clone();
        let bus = self.bus.clone();
        let group_id = group_id.to_string();
        let batch_id = batch_id.to_string();
        tracing::info!(
            target: "onedesktop.scheduler",
            group_id = %group_id,
            batch_id = %batch_id,
            task_count = subtasks.len(),
            auto_approve = auto_approve,
            "submit_batch: tasks persisted{}",
            if auto_approve { " and dispatch triggered" } else { " (awaiting approval)" }
        );
        async move {
            {
                let repo = TaskBoardRepository::new(&db);
                
                
                
                
                
                let existing: HashSet<String> = repo
                    .find_by_group(&group_id)
                    .map(|ts| ts.into_iter().map(|t| t.id).collect())
                    .unwrap_or_default();
                let mut id_map: HashMap<String, String> = HashMap::new();
                for st in &subtasks {
                    if existing.contains(&st.id) && !id_map.contains_key(&st.id) {
                        let suffix: String =
                            uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
                        id_map.insert(st.id.clone(), format!("{}_{}", st.id, suffix));
                    }
                }
                for st in &subtasks {
                    let mut payload = st.with_batch(&group_id, &batch_id);
                    if let Some(nid) = id_map.get(&st.id) {
                        payload.id = nid.clone();
                    }
                    if !id_map.is_empty() {
                        payload.depends_on = payload
                            .depends_on
                            .iter()
                            .map(|d| id_map.get(d).cloned().unwrap_or_else(|| d.clone()))
                            .collect();
                    }
                    if !auto_approve {
                        payload.status = Some(TaskStatus::AwaitingApproval);
                    }
                    repo.create(payload).map_err(|e| e.to_string())?;
                }
            }
            if !auto_approve {
                
                bus.emit(
                    "group-event",
                    "group:batch_awaiting_approval",
                    Some(&group_id),
                    json!({
                        "type": "batch_awaiting_approval",
                        "group_id": group_id,
                        "batch_id": batch_id,
                        "task_count": subtasks.len(),
                    }),
                );
                Ok(())
            } else {
                process_batch(self, group_id, batch_id).await
            }
        }
    }

    
    
    pub fn approve_batch(self: Arc<Self>, group_id: &str, batch_id: &str) -> SchedFuture {
        let db = self.db.clone();
        let group_id = group_id.to_string();
        let batch_id = batch_id.to_string();
        Box::pin(async move {
            let n = TaskBoardRepository::new(&db)
                .approve_batch(&group_id, &batch_id)
                .map_err(|e| e.to_string())?;
            tracing::info!(
                target: "onedesktop.scheduler",
                group_id = %group_id,
                batch_id = %batch_id,
                approved = n,
                "approve_batch: tasks released to Pending"
            );
            process_batch(self, group_id, batch_id).await
        })
    }

    
    
    pub fn process_batch_entry(self: Arc<Self>, group_id: &str, batch_id: &str) -> SchedFuture {
        let group_id = group_id.to_string();
        let batch_id = batch_id.to_string();
        Box::pin(async move { process_batch(self, group_id, batch_id).await })
    }

    
    
    
    
    pub fn cancel_batch(self: Arc<Self>, group_id: &str, batch_id: &str) -> SchedFuture {
        let db = self.db.clone();
        let engine = self.engine.clone();
        let completed_batches = self.completed_batches.clone();
        let bus = self.bus.clone();
        let group_id = group_id.to_string();
        let batch_id = batch_id.to_string();
        Box::pin(async move {
            cancel_batch(db, engine, completed_batches, bus, group_id, batch_id).await
        })
    }
}





fn choose_covering_agent(
    db: &DbConnection,
    seat_caps: &[String],
    required: Option<&str>,
) -> Option<String> {
    let all = AgentProfileRepository::new(db).find_all(()).ok()?;
    if !seat_caps.is_empty() {
        if let Some(p) = all
            .iter()
            .find(|p| seat_caps.iter().all(|c| p.capabilities.iter().any(|x| x == c)))
        {
            return Some(p.id.clone());
        }
    }
    if let Some(req) = required {
        if let Some(p) = all.iter().find(|p| p.capabilities.iter().any(|x| x == req)) {
            return Some(p.id.clone());
        }
    }
    None
}




fn process_batch(sched: Arc<TaskScheduler>, group_id: String, batch_id: String) -> SchedFuture {
    Box::pin(async move {
        let db = sched.db.clone();
        let dispatch_lock = sched.dispatch_lock.clone();
        let completed_batches = sched.completed_batches.clone();
        let bus = sched.bus.clone();
        
        
        
        
        let g_status = GroupRepository::new(&db)
            .find_by_id(&group_id)
            .map_err(|e| e.to_string())?;
        match g_status {
            Some(g) if g.status == GroupStatus::Active => {}
            _ => {
                tracing::info!(
                    target: "onedesktop.scheduler",
                    group_id = %group_id,
                    batch_id = %batch_id,
                    "group not Active; dispatch held (paused or lifecycle state)"
                );
                return Ok(());
            }
        }

        
        
        
        
        let candidates: Vec<Task> = {
            let _guard = dispatch_lock.lock().await;
            let repo = TaskBoardRepository::new(&db);
            let all = repo.find_by_group(&group_id).map_err(|e| e.to_string())?;
            all.iter()
                .filter(|t| {
                    if t.batch_id.as_deref() != Some(&batch_id) {
                        return false; 
                    }
                    if t.status != TaskStatus::Pending {
                        return false;
                    }
                    t.depends_on.iter().all(|dep| {
                        all.iter()
                            .any(|x| &x.id == dep && x.status == TaskStatus::Completed)
                    })
                })
                .cloned()
                .collect()
        };

        
        for task in &candidates {
            if let Err(e) = dispatch_task(
                sched.clone(),
                group_id.clone(),
                batch_id.clone(),
                task.clone(),
            )
            .await
            {
                tracing::warn!(
                    target: "onedesktop.scheduler",
                    task_id = %task.id,
                    error = %e,
                    "dispatch skipped, task stays Pending"
                );
            }
        }

        
        let tasks = {
            let _guard = dispatch_lock.lock().await;
            TaskBoardRepository::new(&db)
                .find_by_batch(&group_id, &batch_id)
                .map_err(|e| e.to_string())?
        };
        let all_terminal = !tasks.is_empty()
            && tasks.iter().all(|t| {
                matches!(
                    t.status,
                    TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
                )
            });
        if all_terminal {
            let mut done = completed_batches.lock().await;
            if !done.contains(&batch_id) {
                done.insert(batch_id.clone());
                bus.emit(
                    "group-event",
                    "group:batch_completed",
                    Some(&group_id),
                    json!({
                        "type": "batch_completed",
                        "group_id": group_id,
                        "batch_id": batch_id,
                        "terminal_count": tasks.len(),
                    }),
                );
                tracing::info!(
                    target: "onedesktop.scheduler",
                    group_id = %group_id,
                    batch_id = %batch_id,
                    "batch fully completed -> owner notified"
                );
            }
        }
        Ok(())
    })
}








fn dispatch_task(
    sched: Arc<TaskScheduler>,
    group_id: String,
    batch_id: String,
    task: Task,
) -> SchedFuture {
    Box::pin(async move {
        let db = sched.db.clone();
        let executor = sched.executor.clone();
        let cli_executors = sched.cli_executors.clone();
        let session_manager = sched.session_manager.clone();
        let dispatch_lock = sched.dispatch_lock.clone();
        
        let (
            worker_id,
            session_id,
            preamble,
            caps,
            model,
            provider_name,
            profile_executor,
        ) = {
            let _guard = dispatch_lock.lock().await;
            let repo = TaskBoardRepository::new(&db);
            let current = repo
                .find_by_id(&task.id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("task {} not found", task.id))?;
            if current.status != TaskStatus::Pending {
                return Ok(()); 
            }

            
            let need: Vec<String> = task.capability.clone().into_iter().collect();
            let wid = match &task.worker_id {
                Some(id) => id.clone(),
                None => {
                    let pool = WorkerPool::new(group_id.clone(), db.clone());
                    pool.pick(&need)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| {
                            if task.capability.is_some() {
                                "no idle worker available with the required capability".to_string()
                            } else {
                                "no idle worker available for dispatch".to_string()
                            }
                        })?
                        .id
                }
            };

            let worker_repo = WorkerRepository::new(&db);
            let mut worker = worker_repo
                .find_by_id(&wid)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("worker {} not found", wid))?;
            
            if worker.agent_ref.is_empty() {
                let chosen = choose_covering_agent(&db, &worker.capabilities, task.capability.as_deref())
                    .ok_or_else(|| {
                        "capability seat has no matching agent in catalog to fulfill it".to_string()
                    })?;
                WorkerPool::new(group_id.clone(), db.clone())
                    .set_agent(&wid, &chosen)
                    .map_err(|e| e.to_string())?;
                worker = worker_repo
                    .find_by_id(&wid)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("worker {} not found after seat fill", wid))?;
            }
            let agent_repo = AgentProfileRepository::new(&db);
            let profile = agent_repo
                .find_by_id(&worker.agent_ref)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("agent preset {} not found", worker.agent_ref))?;
            
            
            let skill_l1 = crate::skill::SkillManager::new(db.clone()).l1_block(&profile.skills);

            
            let pool = WorkerPool::new(group_id.clone(), db.clone());
            pool.acquire(&wid, &task.id).map_err(|e| e.to_string())?;
            repo.update_status(&task.id, TaskStatus::InProgress)
                .map_err(|e| e.to_string())?;

            let sid = worker_session_id(&group_id, &wid);
            (
                wid,
                sid,
                profile.system_prompt.clone(),
                profile.capabilities_block(&skill_l1),
                profile.model.clone(),
                profile.provider.clone(),
                profile.executor.clone(),
            )
        };

        
        tracing::info!(
            target: "onedesktop.scheduler",
            group_id = %group_id,
            batch_id = %batch_id,
            task_id = %task.id,
            worker_id = %worker_id,
            session_id = %session_id,
            executor = ?profile_executor,
            "dispatch: task claimed by worker, engine run starting"
        );
        
        
        emit_worker_status(
            &sched.bus,
            &group_id,
            &worker_id,
            &WorkerStatus::Busy,
            Some(task.id.clone()),
        );
        let hb = sched.heartbeat.clone();
        let hb_tid = task.id.clone();
        let _ = hb.beat(&hb_tid);
        let beater = tokio::spawn(async move {
            let mut iv = tokio_interval(TokioDuration::from_secs(HEARTBEAT_INTERVAL_SECS));
            loop {
                iv.tick().await;
                let _ = hb.beat(&hb_tid);
            }
        });

        
        
        
        
        notify_task_start(&db, &sched.bus, &group_id, &worker_id, &task.id, &task.description);

        
        if session_manager
            .get_session(&session_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            session_manager
                .create_session_with_id(
                    session_id.clone(),
                    format!("worker-{}", worker_id),
                    model.clone(),
                    preamble.clone(),
                )
                .map_err(|e| e.to_string())?;
            
            
            
            
            session_manager
                .set_session_mode(&session_id, Some("worker"), Some(group_id.as_str()))
                .map_err(|e| e.to_string())?;
            
            
            session_manager
                .set_session_workspace(&session_id, &group_id)
                .map_err(|e| e.to_string())?;
        }

        
        let executor = executor.clone();
        let cli_executors = cli_executors.clone();
        let db = db.clone();
        let bus = sched.bus.clone();
        let gid = group_id.clone();
        let bid = batch_id.clone();
        let tid = task.id.clone();
        let wid = worker_id.clone();
        let aid = session_id.clone();
        
        let desc = task.task_card();
        let caps = caps.clone();

        tokio::spawn(async move {
            
            let wm = WorkspaceManager::new();
            
            
            let ws_root = wm.ensure(&gid, None).ok();
            let ws_note = ws_root
                .as_ref()
                .map(|r| {
                    format!(
                        "\n\n[Workspace] Your group working directory is: {}\nUse relative paths for file operations; all files are confined to this directory.",
                        r.display()
                    )
                })
                .unwrap_or_default();
            let ws_preamble = if caps.is_empty() {
                format!("{}{}\n\n{}", preamble, ws_note, REASONING_PROTOCOL)
            } else {
                format!("{}\n\n{}\n{}\n\n{}", preamble, caps, ws_note, REASONING_PROTOCOL)
            };

            
            
            
            
            let resume_meta = find_task_resume(&db, &tid);
            let mut metadata = std::collections::BTreeMap::new();
            metadata.insert("model".into(), serde_json::json!(model));
            metadata.insert("provider".into(), serde_json::json!(provider_name));
            metadata.insert("system_prompt".into(), serde_json::json!(ws_preamble));
            metadata.insert("max_iterations".into(), serde_json::json!(20));
            metadata.insert("auto_approve".into(), serde_json::json!(true));
            if let Some((rp, _)) = &resume_meta {
                metadata.insert("resume".into(), serde_json::json!(rp));
            }
            if let Some(ex) = &profile_executor {
                metadata.insert("executor".into(), serde_json::json!(ex));
            }
            if let Some(r) = &ws_root {
                metadata.insert(
                    "workspace_root".into(),
                    serde_json::json!(r.display().to_string()),
                );
            }
            
            
            
            metadata.insert("group_id".into(), serde_json::json!(gid.clone()));
            metadata.insert("seat_id".into(), serde_json::json!(wid.clone()));
            let a2a_task = crate::a2a::model::A2aTask {
                task_id: tid.clone(),
                context_id: aid.clone(),
                status: crate::a2a::model::A2aTaskState::Working,
                messages: vec![crate::a2a::model::A2aMessage {
                    message_id: format!("msg-{}", tid),
                    context_id: aid.clone(),
                    task_id: Some(tid.clone()),
                    role: "user".into(),
                    parts: vec![crate::a2a::model::A2aPart::text(&desc)],
                    reference_task_ids: vec![tid.clone()],
                }],
                artifacts: vec![],
                metadata,
            };
            
            let ex: Arc<dyn crate::agent::executor::AgentExecutor> =
                match a2a_task.metadata.get("executor").and_then(|v| v.as_str()) {
                    Some(name) => cli_executors
                        .get(name)
                        .cloned()
                        .unwrap_or_else(|| executor.clone()),
                    None => executor.clone(),
                };
            
            let run_outcome = match ex.run(a2a_task).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(
                        target: "onedesktop.scheduler",
                        task_id = %tid,
                        error = %e,
                        "executor run failed; task marked Failed"
                    );
                    log_persist_failure(
                        "mark_failed（executor 失败）",
                        &tid,
                        TaskBoardRepository::new(&db)
                            .mark_failed(&tid, &truncate_err(&e.to_string())),
                    );
                    let wpool = WorkerPool::new(gid.clone(), db.clone());
                    wpool.release(&wid).ok();
                    
                    emit_worker_status(&bus, &gid, &wid, &WorkerStatus::Idle, None);
                    let _ = sched.process_batch_entry(&gid, &bid).await;
                    beater.abort();
                    return;
                }
            };

            
            
            let trepo = TaskBoardRepository::new(&db);
            if let Ok(Some(cur)) = trepo.find_by_id(&tid) {
                if cur.status == TaskStatus::InProgress {
                    match run_outcome.status {
                        crate::a2a::model::A2aTaskState::Completed => {
                            
                            
                            if !run_outcome.written_files.is_empty() {
                                log_persist_failure(
                                    "append_outputs（产出物回填）",
                                    &tid,
                                    trepo.append_outputs(&tid, &run_outcome.written_files),
                                );
                            }
                            trepo.mark_completed(&tid).ok();
                            
                            
                            notify_owner_task_done(
                                &db,
                                &bus,
                                &gid,
                                &wid,
                                &tid,
                                &desc,
                                &run_outcome.final_text,
                                &run_outcome.written_files,
                            );
                        }
                        _ => {
                            log_persist_failure(
                                "mark_failed（非 Completed 终态）",
                                &tid,
                                trepo.mark_failed(&tid, &truncate_err(&run_outcome.final_text)),
                            );
                        }
                    }
                }
            }
            let wpool = WorkerPool::new(gid.clone(), db.clone());
            wpool.release(&wid).ok();
            
            emit_worker_status(&bus, &gid, &wid, &WorkerStatus::Idle, None);
            
            
            if let Some((_, resume_run_id)) = &resume_meta {
                let _ = LongTaskRepository::new(&db).mark_superseded(resume_run_id);
            }
            let _ = sched.process_batch_entry(&gid, &bid).await;
            
            beater.abort();
        });

        Ok(())
    })
}



fn cancel_batch(
    db: Arc<DbConnection>,
    engine: Arc<AgentLoopEngine>,
    completed_batches: Arc<AsyncMutex<HashSet<String>>>,
    bus: Arc<dyn crate::agent::ports::EventBus>,
    group_id: String,
    batch_id: String,
) -> SchedFuture {
    Box::pin(async move {
        let repo = TaskBoardRepository::new(&db);
        let tasks = repo
            .find_by_batch(&group_id, &batch_id)
            .map_err(|e| e.to_string())?;
        for t in tasks {
            match t.status {
                TaskStatus::InProgress => {
                    
                    if let Some(wid) = &t.worker_id {
                        let sid = worker_session_id(&group_id, wid);
                        engine.cancel(&sid).await;
                        let wpool = WorkerPool::new(group_id.clone(), db.clone());
                        wpool.release(wid).ok();
                        
                        emit_worker_status(&bus, &group_id, wid, &WorkerStatus::Idle, None);
                    }
                    repo.update_status(&t.id, TaskStatus::Cancelled)
                        .map_err(|e| e.to_string())?;
                }
                TaskStatus::Pending => {
                    
                    repo.update_status(&t.id, TaskStatus::Cancelled)
                        .map_err(|e| e.to_string())?;
                }
                _ => {}
            }
        }
        
        completed_batches.lock().await.insert(batch_id.clone());
        bus.emit(
            "group-event",
            "group:batch_cancelled",
            Some(&group_id),
            json!({
                "type": "batch_cancelled",
                "group_id": group_id,
                "batch_id": batch_id,
            }),
        );
        tracing::info!(
            target: "onedesktop.scheduler",
            group_id = %group_id,
            batch_id = %batch_id,
            "batch cancelled by owner"
        );
        Ok(())
    })
}






fn find_task_resume(db: &DbConnection, task_id: &str) -> Option<(ResumePoint, String)> {
    let run = LongTaskRepository::new(db)
        .latest_resumable_run_of_job(task_id)
        .ok()??;
    if run.iteration == 0 && run.tokens_used == 0 {
        return None;
    }
    let rp = ResumePoint {
        iteration: run.iteration,
        tokens_used: run.tokens_used,
        job_id: Some(task_id.to_string()),
        attempt_no: run.attempt_no,
    };
    tracing::info!(
        target: "onedesktop.scheduler",
        task_id = %task_id,
        run_id = %run.run_id,
        from_iteration = run.iteration,
        prior_tokens = run.tokens_used,
        "dispatch: task has resumable run, resuming from checkpoint"
    );
    Some((rp, run.run_id))
}













pub fn recover_orphan_dag_tasks(db: &Arc<DbConnection>, bus: &Arc<dyn EventBus>) -> usize {
    let repo = TaskBoardRepository::new(db);
    let orphans = match repo.find_in_progress() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                target: "onedesktop.scheduler",
                error = %e,
                "任务层启动恢复：扫描 InProgress 孤儿失败"
            );
            return 0;
        }
    };
    if orphans.is_empty() {
        return 0;
    }

    
    let mut by_group: HashMap<String, Vec<&Task>> = HashMap::new();
    for t in &orphans {
        by_group.entry(t.group_id.clone()).or_default().push(t);
        let _ = repo.update_status(&t.id, TaskStatus::Pending);
        if let Some(wid) = &t.worker_id {
            let _ = WorkerRepository::new(db).update_status(wid, WorkerStatus::Idle);
        }
        bus.emit(
            "group-event",
            "group:task_status_changed",
            Some(&t.group_id),
            json!({
                "type": "task_status_changed",
                "group_id": t.group_id,
                "task_id": t.id,
                "from": TaskStatus::InProgress,
                "to": TaskStatus::Pending,
            }),
        );
    }
    for (gid, ts) in &by_group {
        let descs: Vec<String> = ts
            .iter()
            .map(|t| t.description.clone())
            .collect();
        let content = format!(
            "检测到 {} 个任务因进程重启中断，已重置为待执行：{}。请查看 DAG 重新启动。",
            ts.len(),
            descs.join("；")
        );
        let msg = RoundtableMessage {
            seq: 0,
            group_id: gid.clone(),
            author: String::new(),
            worker_id: String::new(),
            author_kind: "system".into(),
            content,
            mentions: vec![],
            attachments: vec![],
            created_at: crate::agent::ledger::now_unix_ms(),
            session_id: String::new(),
        };
        match RoundtableRepository::new(db).create(&msg) {
            Ok(seq) => {
                let msg = RoundtableMessage { seq, ..msg };
                let _ = bus.emit(
                    "roundtable-message",
                    "group:roundtable_message",
                    Some(gid),
                    serde_json::to_value(&msg).unwrap_or_default(),
                );
            }
            Err(e) => {
                tracing::warn!(
                    target: "onedesktop.scheduler",
                    group_id = %gid,
                    error = %e,
                    "任务层启动恢复：system 汇总通知失败"
                );
            }
        }
    }
    tracing::info!(
        target: "onedesktop.scheduler",
        reset = orphans.len(),
        "任务层启动恢复：孤儿 InProgress 任务已重置为 Pending"
    );
    orphans.len()
}



fn truncate_err(s: &str) -> String {
    const MAX_CHARS: usize = 300;
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    let mut out: String = t.chars().take(MAX_CHARS).collect();
    if t.chars().count() > MAX_CHARS {
        out.push('…');
    }
    out
}







fn notify_owner_task_done(
    db: &DbConnection,
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    worker_id: &str,
    task_id: &str,
    desc: &str,
    final_text: &str,
    written_files: &[String],
) {
    let files: Vec<String> = written_files
        .iter()
        .map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p).to_string())
        .collect();
    
    let mut content = final_text.trim().to_string();
    if content.is_empty() {
        content = format!("任务「{}」已完成。", desc);
    }
    if !files.is_empty() {
        content.push_str(&format!("\n\n产出物：{}。", files.join("、")));
    }
    content.push_str("\n\n请查看 DAG 确认下一执行者。");
    post_worker_roundtable_msg(db, bus, group_id, worker_id, content, written_files.to_vec())
        .map(|_| ())
        .unwrap_or_else(|| {
            tracing::warn!(
                target: "onedesktop.scheduler",
                task_id = %task_id,
                "task-done worker message failed"
            );
        });
}






fn post_worker_roundtable_msg(
    db: &DbConnection,
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    worker_id: &str,
    content: String,
    attachments: Vec<String>,
) -> Option<RoundtableMessage> {
    
    let agent_name = WorkerRepository::new(db)
        .find_by_id(worker_id)
        .ok()
        .flatten()
        .and_then(|w| {
            AgentProfileRepository::new(db)
                .find_by_id(&w.agent_ref)
                .ok()
                .flatten()
        })
        .map(|p| p.name)
        .unwrap_or_else(|| worker_id.to_string());
    let msg = RoundtableMessage {
        seq: 0,
        group_id: group_id.to_string(),
        author: agent_name,
        worker_id: worker_id.to_string(),
        author_kind: "worker".into(),
        content,
        mentions: vec![],
        attachments,
        created_at: crate::agent::ledger::now_unix_ms(),
        session_id: String::new(),
    };
    match RoundtableRepository::new(db).create(&msg) {
        Ok(seq) => {
            let msg = RoundtableMessage { seq, ..msg };
            let _ = bus.emit(
                "roundtable-message",
                "group:roundtable_message",
                Some(group_id),
                serde_json::to_value(&msg).unwrap_or_default(),
            );
            Some(msg)
        }
        Err(e) => {
            tracing::warn!(
                target: "onedesktop.scheduler",
                group_id = %group_id,
                error = %e,
                "worker roundtable message failed"
            );
            None
        }
    }
}





fn notify_task_start(
    db: &DbConnection,
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    worker_id: &str,
    task_id: &str,
    desc: &str,
) {
    let desc = desc.trim();
    let content = if desc.is_empty() {
        format!("开始执行任务（{}）。", task_id)
    } else {
        format!("开始执行任务「{}」。", desc)
    };
    post_worker_roundtable_msg(db, bus, group_id, worker_id, content, vec![]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::task_board::CreateTaskPayload;
    use crate::storage::connection::DbConnection;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use uuid::Uuid;

    
    struct RecordingBus {
        events: Mutex<Vec<(String, String, String)>>,
    }
    impl EventBus for RecordingBus {
        fn emit(
            &self,
            legacy_channel: &str,
            r#type: &str,
            _group_id: Option<&str>,
            payload: serde_json::Value,
        ) {
            self.events.lock().unwrap().push((
                legacy_channel.to_string(),
                r#type.to_string(),
                payload.to_string(),
            ));
        }
    }

    fn temp_db() -> Arc<DbConnection> {
        let dir = PathBuf::from(std::env::temp_dir()).join(format!(
            "od_sched_test_{}_{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(DbConnection::open(&dir).expect("open test db"))
    }

    #[test]
    fn recover_resets_orphan_inprogress_tasks_and_workers() {
        let db = temp_db();
        let recorder = Arc::new(RecordingBus {
            events: Mutex::new(vec![]),
        });
        let bus: Arc<dyn EventBus> = recorder.clone();
        let repo = TaskBoardRepository::new(&db);

        
        db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO workers (id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat) \
                 VALUES ('wk-r','g1','ag-1','\"Static\"','\"Busy\"',1,'[]','t-1',0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        
        repo.create(CreateTaskPayload {
            id: "t-1".to_string(),
            group_id: "g1".to_string(),
            batch_id: Some("b1".to_string()),
            worker_id: Some("wk-r".to_string()),
            description: "中断任务".to_string(),
            depends_on: vec![],
            input_refs: vec![],
            output_spec: None,
            status: Some(TaskStatus::InProgress),
            capability: None,
            reasoning: None,
        })
        .unwrap();

        let n = recover_orphan_dag_tasks(&db, &bus);
        assert_eq!(n, 1, "1 个孤儿任务被重置");

        let t = repo.find_by_id("t-1").unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Pending, "孤儿任务回到 Pending");

        let w: String = db
            .with_conn(|c| {
                c.query_row("SELECT status FROM workers WHERE id='wk-r'", [], |r| {
                    r.get::<_, String>(0)
                })
            })
            .unwrap();
        assert_eq!(w, "\"Idle\"", "Worker Busy 释放为 Idle");

        let events = recorder.events.lock().unwrap();
        assert!(
            events.iter().any(|(_, ty, _)| ty == "group:task_status_changed"),
            "应发 task_status_changed 事件"
        );
        assert!(
            events.iter().any(|(ch, _, _)| ch == "roundtable-message"),
            "应发圆桌 system 汇总通知（@管理员）"
        );
    }

    
    
    
    #[test]
    fn task_start_broadcasts_worker_message_to_roundtable() {
        let db = temp_db();
        let recorder = Arc::new(RecordingBus {
            events: Mutex::new(vec![]),
        });
        let bus: Arc<dyn EventBus> = recorder.clone();

        
        db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO workers (id,group_id,agent_ref,seat_type,status,max_concurrency,capabilities,current_task_id,last_heartbeat) \
                 VALUES ('wk-s','g1','','\"Static\"','\"Idle\"',1,'[]',NULL,0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        notify_task_start(&db, &bus, "g1", "wk-s", "t-1", "实现登录页");

        
        let (author, kind, content): (String, String, String) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT author, author_kind, content FROM roundtable_messages \
                     WHERE group_id='g1' AND worker_id='wk-s'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!(kind, "worker", "开工宣言应署 worker 身份");
        assert_eq!(author, "wk-s", "agent_ref 空时 author 兜底 worker_id");
        assert!(
            content.contains("开始执行任务") && content.contains("实现登录页"),
            "内容应含开工文案与任务描述，实际: {content}"
        );

        
        let evs = recorder.events.lock().unwrap();
        let found = evs.iter().any(|(ch, ty, payload)| {
            ch == "roundtable-message"
                && ty == "group:roundtable_message"
                && payload.contains("\"worker_id\":\"wk-s\"")
        });
        assert!(found, "开工宣言未广播到 roundtable-message 事件");
    }

    #[test]
    fn recover_ignores_completed_tasks() {
        let db = temp_db();
        let recorder = Arc::new(RecordingBus {
            events: Mutex::new(vec![]),
        });
        let bus: Arc<dyn EventBus> = recorder.clone();
        let repo = TaskBoardRepository::new(&db);
        repo.create(CreateTaskPayload {
            id: "t-ok".to_string(),
            group_id: "g1".to_string(),
            batch_id: Some("b1".to_string()),
            worker_id: None,
            description: "已完成".to_string(),
            depends_on: vec![],
            input_refs: vec![],
            output_spec: None,
            status: Some(TaskStatus::Completed),
            capability: None,
            reasoning: None,
        })
        .unwrap();

        assert_eq!(recover_orphan_dag_tasks(&db, &bus), 0, "终态任务不动");
        let events = recorder.events.lock().unwrap();
        assert!(events.is_empty(), "无孤儿不产生任何事件");
    }

    #[test]
    fn find_task_resume_returns_checkpoint_when_resumable() {
        let db = temp_db();
        let repo = TaskBoardRepository::new(&db);
        repo.create(CreateTaskPayload {
            id: "t-r".to_string(),
            group_id: "g1".to_string(),
            batch_id: Some("b1".to_string()),
            worker_id: None,
            description: "t".to_string(),
            depends_on: vec![],
            input_refs: vec![],
            output_spec: None,
            status: Some(TaskStatus::Pending),
            capability: None,
            reasoning: None,
        })
        .unwrap();
        
        db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO runs (id, session_id, group_id, seat_id, kind, started_at, status, model, job_id, checkpoint_json, attempt_no) \
                 VALUES ('r-1','g1:w','g1',NULL,'chat',0,'interrupted','m','t-r','{\"iteration\":3,\"tokens_used\":100,\"ts\":0}',2)",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let found = find_task_resume(&db, "t-r");
        assert!(found.is_some(), "有有效 checkpoint 的中断 run 应可续跑");
        let (rp, rid) = found.unwrap();
        assert_eq!(rp.iteration, 3);
        assert_eq!(rp.tokens_used, 100);
        assert_eq!(rp.attempt_no, 2);
        assert_eq!(rp.job_id.as_deref(), Some("t-r"));
        assert_eq!(rid, "r-1");
    }

    #[test]
    fn find_task_resume_ignores_empty_checkpoint_and_missing_run() {
        let db = temp_db();
        
        assert!(find_task_resume(&db, "t-none").is_none(), "无 run 应首跑");
        
        db.with_conn_mut(|c| {
            c.execute(
                "INSERT INTO runs (id, session_id, group_id, seat_id, kind, started_at, status, model, job_id, checkpoint_json, attempt_no) \
                 VALUES ('r-0','g1:w','g1',NULL,'chat',0,'interrupted','m','t-zero','{\"iteration\":0,\"tokens_used\":0,\"ts\":0}',1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(
            find_task_resume(&db, "t-zero").is_none(),
            "空 checkpoint 不应续跑"
        );
    }
}
