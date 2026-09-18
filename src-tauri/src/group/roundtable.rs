
















use crate::agent::engine::{REASONING_PROTOCOL, AgentLoopEngine, RunRequest, StopReason};
use crate::agent::ledger::RunKind;
use async_trait::async_trait;
use crate::agent::tool_registry::GroupMessageSender;
use crate::a2a::model::{A2aTask, A2aTaskState};
use crate::config::load_config;
use crate::group::agent_repo::AgentProfileRepository;
use crate::group::group::GroupKind;
use crate::group::group_repo::GroupRepository;
use crate::group::manager::GroupManager;
use crate::group::roundtable_repo::{
    roundtable_messages_to_a2a_task, RoundtableAlternative, RoundtableAlternativeRepository,
    RoundtableMessage, RoundtableRepository, RoundtableSummary, RoundtableSummaryRepository,
};
use crate::group::topology::{Channel, Endpoint};
use crate::group::worker::{Worker, WorkerStatus};
use crate::group::worker_metric_repo::WorkerMetricRepository;
use crate::group::worker_repo::WorkerRepository;

use crate::group::topology_router::{enforce_mention, enforce_topology, parse_rt_session};
use crate::group::workspace::WorkspaceManager;
use crate::llm;
use crate::llm::client;
use crate::session::manager::SessionManager;
use crate::session::model::CreateMessagePayload;
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use crate::agent::ports::{EventBus, RunObserver};
use crate::types::AgentEvent;
use serde::Serialize;
use serde_json::json;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};



fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}




static RT_TURN_LOCKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::OnceLock::new();

fn rt_turn_lock(worker_key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let map = RT_TURN_LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(worker_key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}



fn roundtable_session_id(group_id: &str, worker_id: &str) -> String {
    format!("rt:{}:{}", group_id, worker_id)
}



const ALL_MEMBERS: &str = "__all__";




#[derive(Debug, Clone, Serialize)]
pub struct WorkerStatusEvent {
    pub group_id: String,
    pub worker_id: String,
    pub status: WorkerStatus,
    pub current_task_id: Option<String>,
}







#[derive(Debug, Clone, Serialize)]
pub struct WorkerNoticeEvent {
    pub group_id: String,
    pub worker_id: String,
    pub worker_name: String,
    pub kind: String,
    pub detail: String,
}


static RT_IDLE_NOTICE_AT: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, i64>>,
> = std::sync::OnceLock::new();




fn worker_failure_notice(name: &str, stop: &StopReason, text_empty: bool) -> Option<String> {
    let reason = match stop {
        StopReason::Completed => {
            if text_empty {
                "回合结束但未产出任何内容"
            } else {
                return None;
            }
        }
        StopReason::Cancelled => return None,
        
        
        StopReason::Paused => return None,
        StopReason::ToolsExhausted => "达到最大迭代仍未给出结论（工具循环耗尽）",
        StopReason::TimedOut => "LLM 调用超时",
        StopReason::LlmError => "LLM / 存储错误",
        StopReason::ToolError => "工具连续调用失败，已停止重试",
        
        StopReason::Truncated => "输出被截断（命中输出上限），内容不完整",
    };
    Some(format!("【Agent 异常】{}：{}", name, reason))
}


pub struct RoundtableBus {
    db: Arc<DbConnection>,
    engine: Arc<AgentLoopEngine>,
    session_manager: Arc<SessionManager>,
    observer: Arc<dyn RunObserver>,
    bus: Arc<dyn EventBus>,
    broadcaster: RoundtableBroadcaster,
}

impl RoundtableBus {
    pub fn new(
        db: Arc<DbConnection>,
        engine: Arc<AgentLoopEngine>,
        session_manager: Arc<SessionManager>,
        observer: Arc<dyn RunObserver>,
        bus: Arc<dyn EventBus>,
    ) -> Self {
        let broadcaster = RoundtableBroadcaster::new(
            db.clone(),
            engine.clone(),
            session_manager.clone(),
            observer.clone(),
            bus.clone(),
        );
        Self {
            db,
            engine,
            session_manager,
            observer,
            bus,
            broadcaster,
        }
    }

    
    
    pub fn post(
        &self,
        group_id: String,
        content: String,
        mentions: Vec<String>,
        sender_ref: String,
        attachments: Vec<String>,
    ) -> impl Future<Output = Result<RoundtableMessage, String>> {
        let db = self.db.clone();
        let engine = self.engine.clone();
        let session_manager = self.session_manager.clone();
        let bus = self.bus.clone();
        let observer = self.observer.clone();
        async move {
            let owner_msg = persist_owner_message(
                &db,
                &group_id,
                &sender_ref,
                &content,
                &mentions,
                &attachments,
            );
            emit_message(&bus, &owner_msg);

            if !mentions.is_empty() {
                let worker_repo = WorkerRepository::new(&db);
                let mut targets: Vec<Worker> = Vec::new();
                for wid in &mentions {
                    
                    
                    if let Err(dec) = enforce_mention(&db, &group_id, wid) {
                        tracing::warn!(
                            target: "onedesktop.roundtable",
                            group = %group_id, worker = %wid, reason = ?dec.reason,
                            "mention blocked by topology policy (channel=Mention); worker not summoned"
                        );
                        continue;
                    }
                    if let Ok(Some(w)) = worker_repo.find_by_id(wid) {
                        targets.push(w);
                    }
                }
                if !targets.is_empty() {
                    broadcast_worker_turns(
                        &db,
                        &engine,
                        &session_manager,
                        &observer,
                        &bus,
                        &group_id,
                        &content,
                        targets,
                        owner_msg.seq,
                        false,
                        None,
                    );
                }
            }
            Ok(owner_msg)
        }
    }

    
    
    pub fn broadcast(
        &self,
        group_id: String,
        content: String,
        sender_ref: String,
        attachments: Vec<String>,
    ) -> impl Future<Output = Result<RoundtableMessage, String>> {
        let db = self.db.clone();
        let bus = self.bus.clone();
        let broadcaster = self.broadcaster.clone();
        async move {
            let owner_msg = persist_owner_message(
                &db,
                &group_id,
                &sender_ref,
                &content,
                &[ALL_MEMBERS.to_string()],
                &attachments,
            );
            emit_message(&bus, &owner_msg);
            broadcaster
                .dispatch_all(&group_id, &content, owner_msg.seq)
                .await;
            Ok(owner_msg)
        }
    }

    
    
    
    
    
    
    
    
    
    
    pub async fn send_worker_message(
        &self,
        from_session: &str,
        to_worker: &str,
        content: &str,
    ) -> Result<(), String> {
        
        if let Err(dec) = enforce_topology(
            &self.db,
            from_session,
            Endpoint::Worker(to_worker.to_string()),
            Channel::Message,
        ) {
            return Err(format!(
                "拓扑策略拒绝 Worker 直连消息（{} → {}，原因 {:?}）",
                from_session, to_worker, dec.reason
            ));
        }
        
        let (group_id, from_w) = parse_rt_session(from_session)
            .ok_or_else(|| "仅群 Worker 会话（rt:{group}:{worker}）可发起直连消息".to_string())?;
        
        let msg = persist_direct_message(&self.db, &group_id, &from_w, to_worker, content);
        emit_message(&self.bus, &msg);
        
        let worker = WorkerRepository::new(&self.db)
            .find_by_id(to_worker)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("目标 Worker {} 不存在", to_worker))?;
        let broadcast_seq = msg.seq + 1; 
        run_worker_turn(
            self.db.clone(),
            self.engine.clone(),
            self.session_manager.clone(),
            self.observer.clone(),
            self.bus.clone(),
            group_id,
            worker.id,
            content.to_string(),
            broadcast_seq,
            false,
            None,
            vec![],
            0,
        )
        .await;
        Ok(())
    }

    
    
    
    
    
    
    
    pub async fn rerun_from_message(
        &self,
        group_id: String,
        seq: i64,
        mode: RerunMode,
        worker_id: Option<String>,
        prompt: Option<String>,
    ) -> Result<RoundtableMessage, String> {
        let msgs = RoundtableRepository::new(&self.db)
            .find_by_group(&group_id)
            .map_err(|e| e.to_string())?;
        let plan = plan_rerun(
            &msgs,
            seq,
            mode,
            worker_id.as_deref(),
            prompt.as_deref(),
        )?;

        
        let all = WorkerRepository::new(&self.db)
            .list_by_group(&group_id)
            .map_err(|e| e.to_string())?;
        if all.is_empty() {
            return Err("群内没有可用 Agent".into());
        }
        let targets: Vec<Worker> = if plan.worker_ids.is_empty() {
            all
        } else {
            let picked: Vec<Worker> = all
                .into_iter()
                .filter(|w| plan.worker_ids.contains(&w.id))
                .collect();
            if picked.is_empty() {
                return Err("指定的 Agent 不在本群，无法重跑".into());
            }
            picked
        };

        
        let note = RoundtableMessage {
            seq: 0,
            group_id: group_id.clone(),
            author: String::new(),
            worker_id: String::new(),
            author_kind: "system".into(),
            content: plan.note.clone(),
            mentions: vec![],
            attachments: vec![],
            created_at: crate::agent::ledger::now_unix_ms(),
            session_id: String::new(),
        };
        let note_seq = RoundtableRepository::new(&self.db)
            .create(&note)
            .map_err(|e| e.to_string())?;
        let note = RoundtableMessage {
            seq: note_seq,
            ..note
        };
        emit_message(&self.bus, &note);

        broadcast_worker_turns(
            &self.db,
            &self.engine,
            &self.session_manager,
            &self.observer,
            &self.bus,
            &group_id,
            &plan.prompt,
            targets,
            plan.anchor_seq,
            false,
            None,
        );

        Ok(note)
    }

    pub async fn summarize(&self, group_id: String) -> Result<RoundtableSummary, String> {
        let msgs = RoundtableRepository::new(&self.db)
            .find_by_group(&group_id)
            .map_err(|e| e.to_string())?;
        if msgs.len() < 2 {
            return Err("圆桌消息不足，无法生成摘要（至少需要 2 条）".into());
        }
        let seq_start = msgs.first().map(|m| m.seq).unwrap_or(0);
        let seq_end = msgs.last().map(|m| m.seq).unwrap_or(0);
        let transcript = build_transcript(&msgs);

        let model = self.resolve_owner_model(&group_id)?;
        let provider_name = self.resolve_owner_provider(&group_id);
        let config = load_config();
        let provider = llm::create_provider(&provider_name, config.api_key, model);
        let content = run_summary_llm(provider, &transcript).await?;

        let summary = RoundtableSummary {
            id: 0,
            group_id: group_id.clone(),
            content,
            source_seq_start: seq_start,
            source_seq_end: seq_end,
            message_count: msgs.len() as i32,
            created_at: now_ms(),
        };
        let id = RoundtableSummaryRepository::new(&self.db)
            .create(&summary)
            .map_err(|e| e.to_string())?;
        let summary = RoundtableSummary { id, ..summary };
        emit_summary(&self.bus, &summary);
        Ok(summary)
    }

    
    
    
    
    
    pub fn export_a2a(&self, group_id: &str) -> Result<A2aTask, String> {
        let msgs = RoundtableRepository::new(&self.db)
            .find_by_group(group_id)
            .map_err(|e| e.to_string())?;
        Ok(roundtable_messages_to_a2a_task(&msgs, group_id))
    }

    
    pub fn get_a2a_task(&self, group_id: &str, task_id: &str) -> Result<Option<A2aTask>, String> {
        let task = self.export_a2a(group_id)?;
        if task.task_id == task_id {
            Ok(Some(task))
        } else {
            Ok(None)
        }
    }

    
    
    
    
    
    
    
    
    
    
    
    pub async fn send_a2a_task(&self, group_id: &str, task: A2aTask) -> A2aTask {
        let prompt = task.task_card_text();
        let broadcast = task
            .metadata
            .get("broadcast")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mentions = task
            .metadata
            .get("mentions")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        let sender = task
            .metadata
            .get("sender")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| self.resolve_owner_ref(group_id));

        if broadcast {
            let _ = self
                .broadcast(group_id.to_string(), prompt, sender, vec![])
                .await;
        } else {
            let _ = self
                .post(group_id.to_string(), prompt, mentions, sender, vec![])
                .await;
        }

        A2aTask {
            task_id: task.task_id.clone(),
            context_id: group_id.to_string(),
            status: A2aTaskState::Working,
            messages: task.messages,
            artifacts: vec![],
            metadata: task.metadata,
        }
    }

    
    fn resolve_owner_ref(&self, group_id: &str) -> String {
        match GroupManager::new(self.db.clone()).get_group(group_id) {
            Ok(Some(g)) => g.owner_agent_ref,
            _ => "owner".to_string(),
        }
    }

    
    fn resolve_owner_model(&self, group_id: &str) -> Result<String, String> {
        let group = GroupManager::new(self.db.clone())
            .get_group(group_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "group not found".to_string())?;
        let model = match AgentProfileRepository::new(&self.db).find_by_id(&group.owner_agent_ref) {
            Ok(Some(p)) => p.model,
            _ => "deepseek-chat".to_string(),
        };
        Ok(model)
    }

    
    fn resolve_owner_provider(&self, group_id: &str) -> String {
        let group = GroupManager::new(self.db.clone())
            .get_group(group_id)
            .ok()
            .flatten();
        match group {
            Some(g) => match AgentProfileRepository::new(&self.db).find_by_id(&g.owner_agent_ref) {
                Ok(Some(p)) => llm::resolve_internal_provider(&p.provider),
                _ => "deepseek".to_string(),
            },
            None => "deepseek".to_string(),
        }
    }
}


pub struct RoundtableBroadcaster {
    db: Arc<DbConnection>,
    engine: Arc<AgentLoopEngine>,
    session_manager: Arc<SessionManager>,
    observer: Arc<dyn RunObserver>,
    bus: Arc<dyn EventBus>,
}

impl Clone for RoundtableBroadcaster {
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            engine: self.engine.clone(),
            session_manager: self.session_manager.clone(),
            observer: self.observer.clone(),
            bus: self.bus.clone(),
        }
    }
}

impl RoundtableBroadcaster {
    pub fn new(
        db: Arc<DbConnection>,
        engine: Arc<AgentLoopEngine>,
        session_manager: Arc<SessionManager>,
        observer: Arc<dyn RunObserver>,
        bus: Arc<dyn EventBus>,
    ) -> Self {
        Self {
            db,
            engine,
            session_manager,
            observer,
            bus,
        }
    }

    
    pub async fn dispatch_all(&self, group_id: &str, content: &str, broadcast_seq: i64) {
        let workers = match WorkerRepository::new(&self.db).list_by_group(group_id) {
            Ok(ws) => ws,
            Err(_) => return,
        };
        if workers.is_empty() {
            return;
        }
        let sids: Vec<String> = workers
            .iter()
            .map(|w| roundtable_session_id(group_id, &w.id))
            .collect();
        for w in &workers {
            let db = self.db.clone();
            let engine = self.engine.clone();
            let session_manager = self.session_manager.clone();
            let observer = self.observer.clone();
            let bus = self.bus.clone();
            let g = group_id.to_string();
            let wid = w.id.clone();
            
            
            
            let p = content.to_string();
            let others: Vec<String> = sids
                .iter()
                .filter(|s| *s != &roundtable_session_id(group_id, &wid))
                .cloned()
                .collect();
            tokio::spawn(async move {
                run_worker_turn(
                    db,
                    engine,
                    session_manager,
                    observer,
                    bus,
                    g,
                    wid,
                    p,
                    broadcast_seq,
                    false,
                    None,
                    others,
                    0,
                )
                .await;
            });
        }
    }
}


fn broadcast_worker_turns(
    db: &Arc<DbConnection>,
    engine: &Arc<AgentLoopEngine>,
    session_manager: &Arc<SessionManager>,
    observer: &Arc<dyn RunObserver>,
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    content: &str,
    workers: Vec<Worker>,
    broadcast_seq: i64,
    race: bool,
    winner: Option<Arc<AtomicBool>>,
) {
    for w in workers {
        let db = db.clone();
        let engine = engine.clone();
        let session_manager = session_manager.clone();
        let observer = observer.clone();
        let bus = bus.clone();
        let g = group_id.to_string();
        let wid = w.id.clone();
        
        let p = content.to_string();
        let win = winner.clone();
        tokio::spawn(async move {
            run_worker_turn(
                db,
                engine,
                session_manager,
                observer,
                bus,
                g,
                wid,
                p,
                broadcast_seq,
                race,
                win,
                vec![],
                0,
            )
            .await;
        });
    }
}




fn spawn_worker_followup(
    db: Arc<DbConnection>,
    engine: Arc<AgentLoopEngine>,
    session_manager: Arc<SessionManager>,
    observer: Arc<dyn RunObserver>,
    bus: Arc<dyn EventBus>,
    group_id: String,
    worker_id: String,
    prompt: String,
    broadcast_seq: i64,
    depth: u32,
) {
    tokio::spawn(async move {
        run_worker_turn(
            db,
            engine,
            session_manager,
            observer,
            bus,
            group_id,
            worker_id,
            prompt,
            broadcast_seq,
            false,
            None,
            vec![],
            depth,
        )
        .await;
    });
}









fn continue_to_mentioned_workers(
    db: Arc<DbConnection>,
    engine: Arc<AgentLoopEngine>,
    session_manager: Arc<SessionManager>,
    observer: Arc<dyn RunObserver>,
    bus: Arc<dyn EventBus>,
    group_id: &str,
    from_worker_id: &str,
    reply_mentions: &[String],
    final_text: &str,
    posted_seq: i64,
    depth: u32,
) {
    const MAX_WORKER_MENTION_DEPTH: u32 = 90;
    if depth >= MAX_WORKER_MENTION_DEPTH || reply_mentions.is_empty() {
        return;
    }
    
    let next_seq = posted_seq + 1;
    let from_sid = roundtable_session_id(group_id, from_worker_id);
    for tid in reply_mentions {
        
        if enforce_topology(
            &db,
            &from_sid,
            Endpoint::Worker(tid.clone()),
            Channel::Message,
        )
        .is_err()
        {
            tracing::debug!(
                target: "onedesktop.roundtable",
                group = %group_id, from = %from_worker_id, to = %tid,
                "worker mention blocked by topology (channel=Message); not auto-summoned"
            );
            continue;
        }
        
        let next_depth = depth + 1;
        tracing::info!(
            target: "onedesktop.roundtable",
            group = %group_id, from = %from_worker_id, to = %tid, depth = next_depth,
            "worker→worker @ mention → auto-summoning next turn"
        );
        spawn_worker_followup(
            db.clone(),
            engine.clone(),
            session_manager.clone(),
            observer.clone(),
            bus.clone(),
            group_id.to_string(),
            tid.clone(),
            final_text.to_string(),
            next_seq,
            next_depth,
        );
    }
}











#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RerunMode {
    Rerun,
    Fork,
}

impl RerunMode {
    
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "rerun" => Ok(Self::Rerun),
            "fork" => Ok(Self::Fork),
            other => Err(format!("未知重跑模式：{}", other)),
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RerunPlan {
    
    pub anchor_seq: i64,
    
    pub prompt: String,
    
    pub worker_ids: Vec<String>,
    
    pub note: String,
}






pub fn plan_rerun(
    msgs: &[RoundtableMessage],
    seq: i64,
    mode: RerunMode,
    worker_id: Option<&str>,
    prompt: Option<&str>,
) -> Result<RerunPlan, String> {
    let target = msgs
        .iter()
        .find(|m| m.seq == seq)
        .ok_or_else(|| format!("圆桌消息 #{} 不存在", seq))?;

    match mode {
        RerunMode::Rerun => {
            if target.author_kind != "worker" {
                return Err("只有 Agent 发言可以重跑；群主/系统消息请使用「分叉」".into());
            }
            
            let trigger = msgs
                .iter()
                .rev()
                .find(|m| m.seq < seq && m.author_kind != "worker")
                .ok_or_else(|| "未找到触发该发言的指令消息，无法重跑".to_string())?;
            let wid = worker_id
                .map(str::to_string)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    Some(target.worker_id.clone()).filter(|s| !s.is_empty())
                })
                .ok_or_else(|| "该发言未记录 Agent，无法定位重跑对象".to_string())?;
            let text = prompt
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(trigger.content.as_str())
                .to_string();
            Ok(RerunPlan {
                anchor_seq: trigger.seq,
                prompt: text,
                worker_ids: vec![wid],
                note: format!("[重跑] 基于 #{} 的指令重跑 #{} 的发言", trigger.seq, seq),
            })
        }
        RerunMode::Fork => {
            let text = prompt
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(target.content.as_str())
                .trim()
                .to_string();
            if text.is_empty() {
                return Err("分叉需要一条非空指令".into());
            }
            let worker_ids = worker_id
                .map(str::to_string)
                .filter(|s| !s.is_empty())
                .map(|w| vec![w])
                .unwrap_or_default(); 
            Ok(RerunPlan {
                
                anchor_seq: target.seq,
                prompt: text,
                worker_ids,
                note: format!("[分叉] 从 #{} 处分叉重跑", seq),
            })
        }
    }
}



const WORKER_HISTORY_CAP: usize = 40;





fn build_worker_seed(
    msgs: &[RoundtableMessage],
    broadcast_seq: i64,
    names: &std::collections::HashMap<String, String>,
) -> Vec<(String, String)> {
    let hist: Vec<&RoundtableMessage> = msgs.iter().filter(|m| m.seq < broadcast_seq).collect();
    let label_for = |m: &RoundtableMessage| -> String {
        match m.author_kind.as_str() {
            "owner" => "群主".to_string(),
            "worker" => names
                .get(&m.worker_id)
                .cloned()
                .unwrap_or_else(|| m.author.clone()),
            _ => "系统".to_string(),
        }
    };
    let role_content = |m: &RoundtableMessage| -> (String, String) {
        let role = if m.author_kind == "worker" {
            "assistant"
        } else {
            "user"
        }
        .to_string();
        let mut text = format!("{}：{}\n", label_for(m), m.content);
        
        
        if !m.attachments.is_empty() {
            let names: Vec<String> = m
                .attachments
                .iter()
                .map(|p| {
                    p.rsplit(['/', '\\'])
                        .next()
                        .unwrap_or(p)
                        .to_string()
                })
                .collect();
            text.push_str(&format!("附件：{}\n", names.join("、")));
        }
        (role, text)
    };
    if hist.len() <= WORKER_HISTORY_CAP {
        hist.iter().map(|m| role_content(m)).collect()
    } else {
        let overflow = hist.len() - WORKER_HISTORY_CAP;
        let older = &hist[..overflow];
        let mut summary = String::from("以下是更早的讨论（已压缩，按时间顺序）：\n");
        for m in older {
            let snippet: String = m.content.chars().take(160).collect();
            summary.push_str(&format!("- {}：{}\n", label_for(m), snippet));
        }
        let mut seed = vec![("user".to_string(), summary)];
        seed.extend(hist[overflow..].iter().map(|m| role_content(m)));
        seed
    }
}






fn roster_block(
    ws: &[crate::group::worker::Worker],
    names: &std::collections::HashMap<String, String>,
    self_id: &str,
) -> String {
    if ws.is_empty() {
        return String::new();
    }
    let mut s = String::from("[群成员名册] 当前群成员（id → 昵称）：\n");
    for w in ws {
        let n = names.get(&w.id).cloned().unwrap_or_else(|| w.id.clone());
        let self_mark = if w.id == self_id { "（这是你）" } else { "" };
        s.push_str(&format!("- {} → {}{}\n", w.id, n, self_mark));
    }
    s.push_str(
        "协作规则：回复中提及他人请在昵称前加 @（如 @反方一辩）；\
         调用 send_to_worker 时 target_worker 必须用上方列出的 id（不是昵称），否则会报「目标不存在」。\n",
    );
    s
}







fn group_goal_block(group_name: &str, goal: &str) -> String {
    let goal = goal.trim();
    if goal.is_empty() {
        return String::new();
    }
    format!("[群场景] 群名称：{}\n群目标：{}\n", group_name, goal)
}





fn chat_style_block(kind: &GroupKind) -> &'static str {
    match kind {
        
        GroupKind::Dev => "\n\n[发言风格] 你是研发工程师，在群里做技术协作：\
            - 可以输出完整代码、命令、文件路径与结构化方案；必要时代码块、列表、表格都正常用；\
            - 内容要专业、详尽、有依据，宁可一次说透，不要刻意拆成短句；\
            - 直接给结论和关键细节，少寒暄；但保持礼貌、不啰嗦。",
        
        GroupKind::Research => "\n\n[发言风格] 你是调研分析师，在群里输出调研结论：\
            - 可以有条理地用列表/表格组织发现，需要时可附来源或依据；\
            - 保持专业、客观、简明，一段说清一个点，别堆砌；\
            - 直接给要点，少客套；避免写成动辄千字的长报告。",
        
        GroupKind::Chat => "\n\n[发言风格] 你是在微信群里和群友聊天，不是在写报告或做汇报：\
            - 用日常口语，简短自然，像真人微信发言；\
            - 一句话能说清就别写一段；需要展开时按「短句连发」的节奏，每句一段；\
            - 不要用 Markdown 标题（#）、不要分点列表、不要表格、不要代码块（除非对方明确要代码）；\
            - 不要写「好的」「如下」「总结一下」「综上所述」之类的开场套话；\
            - 保持你的角色观点和立场，但语气可以随意、有温度，允许用表情。",
    }
}








fn strip_speaker_prefix(text: &str, speaker: &str) -> String {
    let norm: Vec<char> = speaker.chars().filter(|c| !c.is_whitespace()).collect();
    if norm.is_empty() {
        return text.to_string();
    }
    let mut result = text.to_string();
    for _ in 0..3 {
        let cur: Vec<char> = result.chars().collect();
        
        let mut i = 0;
        while i < cur.len() && cur[i].is_whitespace() {
            i += 1;
        }
        
        if i < cur.len() && cur[i] == '@' {
            i += 1;
        }
        
        let mut ni = 0;
        let mut j = i;
        while ni < norm.len() && j < cur.len() {
            if cur[j].is_whitespace() {
                j += 1;
                continue;
            }
            if cur[j] == norm[ni] {
                ni += 1;
                j += 1;
            } else {
                break;
            }
        }
        if ni != norm.len() {
            break; 
        }
        
        let mut k = j;
        
        while k < cur.len() && cur[k].is_whitespace() {
            k += 1;
        }
        if k < cur.len() && cur[k] == '#' {
            k += 1;
            while k < cur.len() && cur[k].is_ascii_digit() {
                k += 1;
            }
        }
        
        while k < cur.len() && cur[k].is_whitespace() {
            k += 1;
        }
        if k < cur.len() && (cur[k] == ':' || cur[k] == '：') {
            let mut m = k + 1;
            while m < cur.len() && cur[m].is_whitespace() {
                m += 1;
            }
            result = cur[m..].iter().collect();
            continue;
        }
        break;
    }
    result
}








fn split_roundtable_reply(text: &str, kind: &GroupKind) -> Vec<String> {
    
    if *kind != GroupKind::Chat {
        let t = text.trim().to_string();
        return if t.is_empty() { vec![] } else { vec![t] };
    }
    let units = split_into_units(text);
    if units.len() <= 1 {
        return units;
    }
    group_into_bubbles(units)
}





fn split_into_units(text: &str) -> Vec<String> {
    fn is_boundary(c: char) -> bool {
        matches!(c, '。' | '！' | '？' | '；' | ';' | '!' | '?' | '\n')
    }
    let mut units: Vec<String> = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    for i in 0..n {
        let c = chars[i];
        cur.push(c);
        if is_boundary(c) {
            
            if c == '.' {
                let prev = chars[..i].iter().rev().find(|&&x| !x.is_whitespace());
                let after_ws = i + 1 >= n || chars[i + 1].is_whitespace() || chars[i + 1] == '\n';
                if prev.map(|p| p.is_ascii_uppercase()).unwrap_or(false) && after_ws {
                    continue; 
                }
            }
            let unit = cur.trim().to_string();
            cur = String::new();
            if !unit.is_empty() {
                units.push(unit);
            }
        }
    }
    let tail = cur.trim().to_string();
    if !tail.is_empty() {
        units.push(tail);
    }
    units
}






fn group_into_bubbles(units: Vec<String>) -> Vec<String> {
    const TARGET: usize = 20; 
    const HARD_MAX: usize = 120; 
    const MIN_MERGE: usize = 6; 
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for u in units {
        let u = u.trim().to_string();
        if u.is_empty() {
            continue;
        }
        let cur_len = cur.chars().count();
        let u_len = u.chars().count();
        let force_merge = cur_len > 0 && cur_len < MIN_MERGE;
        let start_new =
            !cur.is_empty() && !force_merge && (cur_len + u_len > HARD_MAX || (cur_len >= TARGET && u_len >= MIN_MERGE));
        if start_new {
            out.push(cur.trim().to_string());
            cur = String::new();
        }
        if cur.is_empty() {
            cur = u;
        } else {
            cur = format!("{}\n{}", cur, u);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}




fn human_typing_delay(content_len: usize) -> std::time::Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0x9E3779B9);
    let len_factor = ((content_len as u64).min(120)) * 8; 
    let jitter = nanos % 760; 
    std::time::Duration::from_millis(2000 + len_factor + jitter)
}


async fn run_worker_turn(
    db: Arc<DbConnection>,
    engine: Arc<AgentLoopEngine>,
    session_manager: Arc<SessionManager>,
    observer: Arc<dyn RunObserver>,
    bus: Arc<dyn EventBus>,
    group_id: String,
    worker_id: String,
    prompt: String,
    broadcast_seq: i64,
    race: bool,
    winner: Option<Arc<AtomicBool>>,
    other_sids: Vec<String>,
    
    depth: u32,
) {
    tracing::info!(
        target: "onedesktop.roundtable",
        group_id = %group_id,
        worker_id = %worker_id,
        broadcast_seq,
        race,
        prompt_len = prompt.len(),
        "run_worker_turn: worker round starting"
    );
    
    let worker_repo = WorkerRepository::new(&db);
    let worker = match worker_repo.find_by_id(&worker_id) {
        Ok(Some(w)) => w,
        _ => {
            
            notify_worker_failure(
                &db,
                &bus,
                &group_id,
                &worker_id,
                &worker_id,
                &format!("【Agent 异常】{}：Agent 记录不存在，已跳过本轮", worker_id),
            );
            return;
        }
    };
    let agent_repo = AgentProfileRepository::new(&db);
    let profile = match agent_repo.find_by_id(&worker.agent_ref) {
        Ok(Some(p)) => p,
        _ => {
            notify_worker_failure(
                &db,
                &bus,
                &group_id,
                &worker_id,
                &worker.agent_ref,
                &format!(
                    "【Agent 异常】{}：Agent 画像 {} 已丢失，已跳过本轮",
                    worker_id, worker.agent_ref
                ),
            );
            return;
        }
    };

    
    let _ = WorkerRepository::new(&db).update_status(&worker_id, WorkerStatus::Busy);
    
    emit_worker_status(&bus, &group_id, &worker_id, &WorkerStatus::Busy, None);

    
    
    
    let sid = roundtable_session_id(&group_id, &worker_id);
    let turn_lock = rt_turn_lock(&sid);
    let _turn_guard = turn_lock.lock().await;
    if session_manager.get_session(&sid).ok().flatten().is_none() {
        let _ = session_manager.create_session_with_id(
            sid.clone(),
            format!("rt-{}", worker_id),
            profile.model.clone(),
            profile.system_prompt.clone(),
        );
        
        
        
        let _ = session_manager.set_session_mode(&sid, Some("worker"), Some(group_id.as_str()));
        
        
        let _ = session_manager.set_session_workspace(&sid, &group_id);
    }
    
    
    let _ = session_manager.clear_session_messages(&sid);

    
    
    
    let mut names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(ws) = WorkerRepository::new(&db).list_by_group(&group_id) {
        let ar = AgentProfileRepository::new(&db);
        for w in &ws {
            if let Ok(Some(p)) = ar.find_by_id(&w.agent_ref) {
                names.insert(w.id.clone(), p.name.clone());
            }
        }
        
        
        let roster = roster_block(&ws, &names, &worker_id);
        if !roster.is_empty() {
            let _ = session_manager.add_message(CreateMessagePayload {
                session_id: sid.clone(),
                role: "user".into(),
                content: roster,
                tool_name: None,
                tool_args: None,
                tool_result: None,
                token_usage: 0,
                reasoning_content: String::new(),
                call_id: None,
            });
        }
    }
    
    
    
    let group = GroupRepository::new(&db).find_by_id(&group_id).ok().flatten();
    let group_kind: GroupKind = group.as_ref().map(|g| g.kind).unwrap_or(GroupKind::Chat);
    if let Some(g) = &group {
        let scene = group_goal_block(&g.name, &g.goal);
        if !scene.is_empty() {
            let _ = session_manager.add_message(CreateMessagePayload {
                session_id: sid.clone(),
                role: "user".into(),
                content: scene,
                tool_name: None,
                tool_args: None,
                tool_result: None,
                token_usage: 0,
                reasoning_content: String::new(),
                call_id: None,
            });
        }
    }
    if let Ok(hist) = RoundtableRepository::new(&db).find_by_group(&group_id) {
        for (role, content) in build_worker_seed(&hist, broadcast_seq, &names) {
            let _ = session_manager.add_message(CreateMessagePayload {
                session_id: sid.clone(),
                role,
                content,
                tool_name: None,
                tool_args: None,
                tool_result: None,
                token_usage: 0,
                reasoning_content: String::new(),
                call_id: None,
            });
        }
    }

    
    if let Ok(alts) =
        RoundtableAlternativeRepository::new(&db).find_before(&group_id, broadcast_seq)
    {
        if !alts.is_empty() {
            let mut block =
                String::from("\n\n[备选方案]（此前竞速中的落选思路，供参考，不代表最终结论）：\n");
            for a in alts.iter().take(6) {
                let name = names
                    .get(&a.worker_id)
                    .cloned()
                    .unwrap_or_else(|| a.worker_id.clone());
                let snippet: String = a.content.chars().take(300).collect();
                block.push_str(&format!("- {}：{}\n", name, snippet));
            }
            let _ = session_manager.add_message(CreateMessagePayload {
                session_id: sid.clone(),
                role: "user".into(),
                content: block,
                tool_name: None,
                tool_args: None,
                tool_result: None,
                token_usage: 0,
                reasoning_content: String::new(),
                call_id: None,
            });
        }
    }

    
    let config = load_config();
    let provider = llm::create_provider(
        &llm::resolve_internal_provider(&profile.provider),
        config.api_key,
        profile.model.clone(),
    );
    let wm = WorkspaceManager::new();
    
    
    let ws_root = wm.ensure(&group_id, None).ok();
    let ws_note = ws_root
        .as_ref()
        .map(|r| {
            format!(
                "\n\n[Workspace] Your group working directory is: {}\nUse relative paths for file operations; all files are confined to this directory.",
                r.display()
            )
        })
        .unwrap_or_default();
    let ws_preamble = {
        
        let skill_l1 = crate::skill::SkillManager::new(db.clone()).l1_block(&profile.skills);
        let caps = profile.capabilities_block(&skill_l1);
        
        
        
        let identity = format!(
            "\n\n[你的身份] 你是本群的「{}」（Worker id: {}，agent: {}）。当群主或其他 Worker 用 @{} 称呼你时，即是在召唤你发言。\
             回复时**直接输出你的内容**：不要以任何角色名（包括你自己或他人的昵称）作为开头前缀，也不要复述 \"@{}\" 这种对自己的 @。",
            profile.name, worker_id, worker.agent_ref, profile.name, profile.name
        );
        
        
        
        let chat_style = chat_style_block(&group_kind);
        if caps.is_empty() {
            format!("{}{}{}{}\n\n{}", profile.system_prompt, identity, chat_style, ws_note, REASONING_PROTOCOL)
        } else {
            format!("{}\n\n{}\n{}\n{}\n{}\n\n{}", profile.system_prompt, identity, caps, chat_style, ws_note, REASONING_PROTOCOL)
        }
    };
    let turn_start = std::time::Instant::now();
    
    let trace_id = format!("{}:rt:{}", group_id, worker_id);
    let outcome = engine
        .clone()
        .run_guarded(
            Arc::new(RoundtableStreamObserver {
                inner: observer.clone(),
                bus: bus.clone(),
                group_id: group_id.to_string(),
                worker_id: worker_id.to_string(),
                round: broadcast_seq,
            }),
                RunRequest {
                session_id: sid.clone(),
                user_message: prompt.to_string(),
                provider,
                preamble: ws_preamble.to_string(),
                temperature: 0.7,
                max_tokens_per_call: 4096,
                max_iterations: Some(20),
                token_budget: Some(profile.token_budget),
                workspace_root: ws_root,
                auto_approve_override: Some(true),
                trace_id: Some(trace_id.clone()),
                kind: RunKind::Worker,
                group_id: Some(group_id.to_string()),
                seat_id: Some(worker_id.to_string()),
                model: Some(profile.model.to_string()),
                
                
                tool_scope: Some(crate::agent::toolplane::ToolScope::all_except(
                    crate::agent::permission::DANGEROUS_TOOLS,
                )),
                
                session_kind: crate::agent::permission::SessionKind::AttendedWorker,
                
                resume: None,
                task_id: None,
            },
        )
        .await;

    
    let stop_reason = outcome.stop_reason.clone();
    let final_text = outcome.final_text;
    
    
    
    let mut worker_attachments: Vec<String> = outcome.written_files.clone();
    worker_attachments.sort();
    worker_attachments.dedup();

    
    let msgs = session_manager.get_messages(&sid).unwrap_or_default();
    let total_tokens: u64 = msgs.iter().map(|m| m.token_usage.max(0) as u64).sum();
    let msg_count = msgs.len() as i64;
    let last_context_tokens = msgs
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| m.token_usage.max(0) as i64)
        .unwrap_or(0);
    let duration_ms = turn_start.elapsed().as_millis() as u64;
    let _ = WorkerMetricRepository::new(&db).record(
        &worker_id,
        &group_id,
        total_tokens,
        duration_ms,
        msg_count,
        last_context_tokens,
        Some(&trace_id),
    );

    
    let should_post = if race {
        match &winner {
            Some(flag) => {
                if flag.load(Ordering::SeqCst) {
                    false
                } else if flag
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    for osid in &other_sids {
                        let _ = engine.cancel(osid).await;
                    }
                    true
                } else {
                    false
                }
            }
            None => true,
        }
    } else {
        true
    };
    if !should_post {
        
        
        if !final_text.trim().is_empty() {
            let _ = RoundtableAlternativeRepository::new(&db).create(&RoundtableAlternative {
                id: 0,
                group_id: group_id.clone(),
                trigger_seq: broadcast_seq,
                worker_id: worker_id.clone(),
                content: final_text,
                created_at: now_ms(),
            });
        }
        
        {
            let payload = json!({
                "type": "token",
                "group_id": group_id,
                "worker_id": worker_id,
                "round": broadcast_seq,
                "aborted": true,
            });
            bus.emit("roundtable-token", "roundtable:token", Some(&group_id), payload);
        }
        release_worker_status(&db, &bus, &group_id, &worker_id);
        return;
    }

    
    let text_empty = final_text.trim().is_empty();
    
    let reply_mentions: Vec<String> = if text_empty {
        vec![]
    } else {
        parse_worker_mentions(&final_text, &names, &worker.id)
    };
    
    let mut posted_seq = broadcast_seq;
    if !text_empty {
        
        
        
        
        
        let chunks = split_roundtable_reply(&final_text, &group_kind);
        
        
        let speaker_name = names.get(&worker.id).map(|s| s.as_str()).unwrap_or("");
        let n = chunks.len();
        let mut cursor_ts = now_ms();
        for (i, raw_chunk) in chunks.into_iter().enumerate() {
            let chunk = strip_speaker_prefix(&raw_chunk, speaker_name);
            if chunk.trim().is_empty() {
                continue;
            }
            let mentions = if i == 0 { reply_mentions.clone() } else { vec![] };
            let len = chunk.chars().count();
            let msg = RoundtableMessage {
                seq: 0,
                group_id: group_id.clone(),
                author: worker.agent_ref.clone(),
                worker_id: worker.id.clone(),
                author_kind: "worker".into(),
                content: chunk,
                mentions,
                attachments: if i == 0 {
                    worker_attachments.clone()
                } else {
                    vec![]
                },
                created_at: cursor_ts,
                session_id: sid.clone(),
            };
            if let Ok(seq) = RoundtableRepository::new(&db).create(&msg) {
                emit_message(&bus, &RoundtableMessage { seq, ..msg });
                posted_seq = seq;
            }
            
            if i + 1 < n {
                let d = human_typing_delay(len);
                cursor_ts += d.as_millis() as i64;
                tokio::time::sleep(d).await;
            }
        }
    }

    
    
    if let Some(detail) = worker_failure_notice(&profile.name, &stop_reason, text_empty) {
        tracing::warn!(
            target: "onedesktop.roundtable",
            group_id = %group_id,
            worker_id = %worker_id,
            stop_reason = ?stop_reason,
            text_empty,
            detail = %detail,
            "worker round abnormal — notifying owner"
        );
        notify_worker_failure(&db, &bus, &group_id, &worker_id, &profile.name, &detail);
    } else {
        tracing::debug!(
            target: "onedesktop.roundtable",
            group_id = %group_id,
            worker_id = %worker_id,
            stop_reason = ?stop_reason,
            "worker round finished (normal or race-lost)"
        );
    }

    
    
    
    continue_to_mentioned_workers(
        db.clone(),
        engine.clone(),
        session_manager.clone(),
        observer.clone(),
        bus.clone(),
        &group_id,
        &worker.id,
        &reply_mentions,
        &final_text,
        posted_seq,
        depth,
    );

    
    release_worker_status(&db, &bus, &group_id, &worker_id);
}








fn parse_worker_mentions(
    text: &str,
    names: &std::collections::HashMap<String, String>,
    self_id: &str,
) -> Vec<String> {
    
    let mut name_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (wid, nm) in names {
        name_to_id.insert(nm.to_lowercase(), wid.clone());
    }

    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' {
            let mut j = i + 1;
            let mut tok = String::new();
            while j < chars.len() {
                let c = chars[j];
                if c.is_alphanumeric() || c == '_' || c == '-' {
                    tok.push(c);
                    j += 1;
                } else {
                    
                    break;
                }
            }
            if !tok.is_empty() {
                let matched = if names.contains_key(&tok) {
                    Some(tok.clone())
                } else {
                    let low = tok.to_lowercase();
                    if let Some(id) = name_to_id.get(&low) {
                        Some(id.clone())
                    } else {
                        name_to_id
                            .iter()
                            .find(|(nm, _)| nm.contains(&low) || low.contains(*nm))
                            .map(|(_, wid)| wid.clone())
                    }
                };
                if let Some(id) = matched {
                    if id != self_id && !out.contains(&id) {
                        out.push(id);
                    }
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}


fn release_worker_status(
    db: &Arc<DbConnection>,
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    worker_id: &str,
) {
    let repo = WorkerRepository::new(db);
    let cur = repo.find_by_id(worker_id).ok().flatten().map(|w| w.status);
    if cur != Some(WorkerStatus::Offline) {
        let _ = repo.update_status(worker_id, WorkerStatus::Idle);
        emit_worker_status(bus, group_id, worker_id, &WorkerStatus::Idle, None);
    }
    
    notify_group_idle_if_all_done(db, bus, group_id);
}


fn notify_worker_failure(
    db: &Arc<DbConnection>,
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    worker_id: &str,
    worker_name: &str,
    detail: &str,
) {
    let msg = RoundtableMessage {
        seq: 0,
        group_id: group_id.to_string(),
        author: worker_name.to_string(),
        worker_id: worker_id.to_string(),
        author_kind: "system".into(),
        content: detail.to_string(),
        mentions: vec![],
        attachments: vec![],
        created_at: now_ms(),
        session_id: String::new(),
    };
    match RoundtableRepository::new(db).create(&msg) {
        Ok(seq) => emit_message(bus, &RoundtableMessage { seq, ..msg }),
        Err(e) => {
            tracing::warn!(target: "onedesktop.roundtable", error = %e, "persist worker notice failed")
        }
    }
    emit_worker_notice(bus, group_id, worker_id, worker_name, "failed", detail);
}


fn notify_group_idle_if_all_done(
    db: &Arc<DbConnection>,
    bus: &Arc<dyn EventBus>,
    group_id: &str,
) {
    let workers = match WorkerRepository::new(db).list_by_group(group_id) {
        Ok(ws) if !ws.is_empty() => ws,
        _ => return,
    };
    if workers.iter().any(|w| w.status == WorkerStatus::Busy) {
        return;
    }
    
    let now = now_ms();
    {
        let map = RT_IDLE_NOTICE_AT
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let mut guard = match map.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(prev) = guard.get(group_id) {
            if now - *prev < 1500 {
                return;
            }
        }
        guard.insert(group_id.to_string(), now);
    }
    let detail = format!("【全员空闲】{} 个 Agent 均已完成本轮，等待下一步指令", workers.len());
    emit_worker_notice(bus, group_id, "", "", "idle_all", &detail);
}


fn emit_worker_notice(
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    worker_id: &str,
    worker_name: &str,
    kind: &str,
    detail: &str,
) {
    let payload = WorkerNoticeEvent {
        group_id: group_id.to_string(),
        worker_id: worker_id.to_string(),
        worker_name: worker_name.to_string(),
        kind: kind.to_string(),
        detail: detail.to_string(),
    };
    bus.emit(
        "worker-notice",
        "group:worker_notice",
        Some(group_id),
        serde_json::to_value(&payload).unwrap_or_default(),
    );
}


fn persist_owner_message(
    db: &Arc<DbConnection>,
    group_id: &str,
    sender_ref: &str,
    content: &str,
    mentions: &[String],
    attachments: &[String],
) -> RoundtableMessage {
    let msg = RoundtableMessage {
        seq: 0,
        group_id: group_id.to_string(),
        author: sender_ref.to_string(),
        worker_id: String::new(),
        author_kind: "owner".into(),
        content: content.to_string(),
        mentions: mentions.to_vec(),
        attachments: attachments.to_vec(),
        created_at: now_ms(),
        session_id: String::new(),
    };
    match RoundtableRepository::new(db).create(&msg) {
        Ok(seq) => RoundtableMessage { seq, ..msg },
        Err(e) => {
            tracing::warn!(target: "onedesktop.roundtable", error = %e, "persist owner message failed");
            msg
        }
    }
}


fn persist_direct_message(
    db: &Arc<DbConnection>,
    group_id: &str,
    from_w: &str,
    to_worker: &str,
    content: &str,
) -> RoundtableMessage {
    let msg = RoundtableMessage {
        seq: 0,
        group_id: group_id.to_string(),
        author: from_w.to_string(),
        worker_id: from_w.to_string(),
        author_kind: "worker".into(),
        content: content.to_string(),
        mentions: vec![to_worker.to_string()],
        attachments: vec![],
        created_at: now_ms(),
        session_id: String::new(),
    };
    match RoundtableRepository::new(db).create(&msg) {
        Ok(seq) => RoundtableMessage { seq, ..msg },
        Err(e) => {
            tracing::warn!(target: "onedesktop.roundtable", error = %e, "persist direct message failed");
            msg
        }
    }
}


#[async_trait]
impl GroupMessageSender for RoundtableBus {
    async fn send_to_worker(
        &self,
        from_session: String,
        to_worker: String,
        content: String,
    ) -> Result<(), String> {
        self.send_worker_message(&from_session, &to_worker, &content)
            .await
    }
}


fn build_transcript(msgs: &[RoundtableMessage]) -> String {
    let mut out = String::new();
    for m in msgs {
        let role = match m.author_kind.as_str() {
            "owner" => "群主",
            "worker" => "Worker",
            "system" => "系统",
            other => other,
        };
        out.push_str(&format!(
            "[{}] {}\n{}\n\n",
            role,
            m.author,
            m.content.trim()
        ));
    }
    out.trim_end().to_string()
}



async fn run_summary_llm(
    provider: Arc<dyn crate::llm::provider::LlmProvider>,
    transcript: &str,
) -> Result<String, String> {
    let system = "你是一个 Agent 协作群的圆桌讨论聚合助手。你会收到一段多方（群主与各 Worker）的圆桌讨论记录。\
        请输出一份**结构化中文摘要**，要求：\n\
        1. 先一句话给出本轮讨论的核心结论；\n\
        2. 用要点列出各方的主要观点、分歧与达成的共识；\n\
        3. 标注仍悬而未决的问题（如有）；\n\
        4. 不编造记录中不存在的内容，不调用任何工具。";
    let user = format!(
        "下面是本轮圆桌讨论记录：\n\n{}\n\n请按上述结构输出摘要。",
        transcript
    );
    client::summarize_text(provider.as_ref(), system, &user, 0.3, 2048).await
}


fn emit_summary(bus: &Arc<dyn EventBus>, summary: &RoundtableSummary) {
    let payload = json!({
        "type": "summary",
        "group_id": summary.group_id,
        "summary": summary,
    });
    bus.emit(
        "roundtable-summary",
        "roundtable:summary",
        Some(&summary.group_id),
        payload,
    );
}


fn emit_message(bus: &Arc<dyn EventBus>, msg: &RoundtableMessage) {
    let payload = json!({
        "type": "message",
        "group_id": msg.group_id,
        "message": msg,
    });
    bus.emit(
        "roundtable-message",
        "roundtable:message",
        Some(&msg.group_id),
        payload,
    );
}





struct RoundtableStreamObserver {
    inner: Arc<dyn RunObserver>,
    bus: Arc<dyn EventBus>,
    group_id: String,
    worker_id: String,
    round: i64,
}

impl RunObserver for RoundtableStreamObserver {
    fn on(&self, ev: AgentEvent, via_new_bus: bool) {
        
        let token = match &ev {
            AgentEvent::Token { token, .. } => Some(token.clone()),
            _ => None,
        };
        
        self.inner.on(ev, via_new_bus);
        
        if let Some(tok) = token {
            let payload = json!({
                "type": "token",
                "group_id": self.group_id,
                "worker_id": self.worker_id,
                "round": self.round,
                "token": tok,
            });
            self.bus.emit(
                "roundtable-token",
                "roundtable:token",
                Some(&self.group_id),
                payload,
            );
        }
    }
}




pub fn emit_worker_status(
    bus: &Arc<dyn EventBus>,
    group_id: &str,
    worker_id: &str,
    status: &WorkerStatus,
    current_task_id: Option<String>,
) {
    let payload = WorkerStatusEvent {
        group_id: group_id.to_string(),
        worker_id: worker_id.to_string(),
        status: status.clone(),
        current_task_id,
    };
    bus.emit(
        "worker-status",
        "group:worker_status",
        Some(group_id),
        serde_json::to_value(&payload).unwrap_or_default(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn mk_msg(
        seq: i64,
        author: &str,
        worker_id: &str,
        kind: &str,
        content: &str,
    ) -> RoundtableMessage {
        RoundtableMessage {
            seq,
            group_id: "g1".into(),
            author: author.into(),
            worker_id: worker_id.into(),
            author_kind: kind.into(),
            content: content.into(),
            mentions: vec![],
            attachments: vec![],
            created_at: 0,
            session_id: String::new(),
        }
    }

    

    
    fn rerun_fixture() -> Vec<RoundtableMessage> {
        vec![
            mk_msg(1, "owner_ref", "", "owner", "问A"),
            mk_msg(2, "w1_ref", "w1", "worker", "答A"),
            mk_msg(3, "owner_ref", "", "owner", "问B"),
            mk_msg(4, "w2_ref", "w2", "worker", "答B"),
        ]
    }

    #[test]
    fn rerun_uses_trigger_anchor_and_original_seat() {
        let msgs = rerun_fixture();
        let plan = plan_rerun(&msgs, 4, RerunMode::Rerun, None, None).unwrap();
        
        assert_eq!(plan.anchor_seq, 3);
        assert_eq!(plan.prompt, "问B");
        assert_eq!(plan.worker_ids, vec!["w2".to_string()]);
        assert!(plan.note.contains("[重跑]"));
    }

    #[test]
    fn rerun_can_switch_seat_and_override_prompt() {
        let msgs = rerun_fixture();
        let plan = plan_rerun(&msgs, 4, RerunMode::Rerun, Some("w1"), Some("  换个角度答B  "))
            .unwrap();
        assert_eq!(plan.anchor_seq, 3);
        assert_eq!(plan.prompt, "换个角度答B", "指令应 trim 后覆盖原指令");
        assert_eq!(plan.worker_ids, vec!["w1".to_string()]);
    }

    #[test]
    fn rerun_rejects_non_worker_message() {
        let msgs = rerun_fixture();
        let err = plan_rerun(&msgs, 3, RerunMode::Rerun, None, None).unwrap_err();
        assert!(err.contains("分叉"), "群主消息应引导改用分叉，实际：{}", err);
    }

    #[test]
    fn rerun_rejects_worker_message_without_trigger() {
        
        let msgs = vec![mk_msg(1, "w1_ref", "w1", "worker", "自说自话")];
        let err = plan_rerun(&msgs, 1, RerunMode::Rerun, None, None).unwrap_err();
        assert!(err.contains("未找到触发"), "实际：{}", err);
    }

    #[test]
    fn fork_anchors_at_target_and_defaults_to_all_seats() {
        let msgs = rerun_fixture();
        let plan = plan_rerun(&msgs, 3, RerunMode::Fork, None, None).unwrap();
        
        assert_eq!(plan.anchor_seq, 3);
        assert_eq!(plan.prompt, "问B", "未给新指令时沿用原文");
        assert!(plan.worker_ids.is_empty(), "未指定 Agent 应表示全员扇出");
        assert!(plan.note.contains("[分叉]"));
    }

    #[test]
    fn fork_accepts_new_prompt_and_single_seat() {
        let msgs = rerun_fixture();
        let plan =
            plan_rerun(&msgs, 2, RerunMode::Fork, Some("w2"), Some("改走另一条路")).unwrap();
        assert_eq!(plan.anchor_seq, 2);
        assert_eq!(plan.prompt, "改走另一条路");
        assert_eq!(plan.worker_ids, vec!["w2".to_string()]);
    }

    #[test]
    fn fork_rejects_blank_prompt_on_blank_source() {
        let msgs = vec![mk_msg(1, "owner_ref", "", "owner", "   ")];
        let err = plan_rerun(&msgs, 1, RerunMode::Fork, None, Some("  ")).unwrap_err();
        assert!(err.contains("非空指令"), "实际：{}", err);
    }

    #[test]
    fn plan_rerun_rejects_missing_seq() {
        let msgs = rerun_fixture();
        let err = plan_rerun(&msgs, 99, RerunMode::Fork, None, None).unwrap_err();
        assert!(err.contains("#99"), "实际：{}", err);
    }

    #[test]
    fn rerun_mode_parse_rejects_unknown() {
        assert_eq!(RerunMode::parse("rerun").unwrap(), RerunMode::Rerun);
        assert_eq!(RerunMode::parse("fork").unwrap(), RerunMode::Fork);
        assert!(RerunMode::parse("nuke").is_err());
    }

    
    #[test]
    fn fork_anchor_truncates_seed_history() {
        let msgs = rerun_fixture();
        let plan = plan_rerun(&msgs, 3, RerunMode::Fork, None, None).unwrap();
        let mut names = HashMap::new();
        names.insert("w1".to_string(), "工程师甲".to_string());
        let seed = build_worker_seed(&msgs, plan.anchor_seq, &names);
        assert_eq!(seed.len(), 2, "分叉后只应看到 #1、#2");
        assert!(seed[1].1.contains("答A"));
    }

    #[test]
    fn seed_excludes_trigger_broadcast_and_same_round_replies() {
        
        
        let msgs = vec![
            mk_msg(1, "owner_ref", "", "owner", "问A"),
            mk_msg(2, "w1_ref", "w1", "worker", "答A"),
            mk_msg(3, "owner_ref", "", "owner", "问B"),
            mk_msg(4, "w2_ref", "w2", "worker", "答B"),
        ];
        let mut names = HashMap::new();
        names.insert("w1".into(), "工程师甲".into());
        names.insert("w2".into(), "工程师乙".into());

        let seed = build_worker_seed(&msgs, 3, &names);
        assert_eq!(seed.len(), 2, "应排除本轮广播与同轮回答，只留 2 条历史");
        assert_eq!(seed[0], ("user".into(), "群主：问A\n".into()));
        assert_eq!(seed[1], ("assistant".into(), "工程师甲：答A\n".into()));
    }

    #[test]
    fn seed_role_mapping_owner_worker_system() {
        let msgs = vec![
            mk_msg(1, "owner_ref", "", "owner", "群主发言"),
            mk_msg(2, "sys_ref", "", "system", "系统提示"),
            mk_msg(3, "w1_ref", "w1", "worker", "worker 发言"),
        ];
        let names = HashMap::new(); 
        let seed = build_worker_seed(&msgs, 4, &names);
        assert_eq!(seed.len(), 3);
        assert_eq!(seed[0].0, "user"); 
        assert!(seed[0].1.contains("群主：群主发言"));
        assert_eq!(seed[1].0, "user"); 
        assert!(seed[1].1.contains("系统：系统提示"));
        assert_eq!(seed[2].0, "assistant"); 
        assert!(seed[2].1.contains("w1_ref：worker 发言")); 
    }

    #[test]
    fn seed_compresses_overflow_history() {
        
        let mut msgs = Vec::new();
        for i in 1..=45 {
            msgs.push(mk_msg(i, "owner_ref", "", "owner", &format!("msg{}", i)));
        }
        let names = HashMap::new();
        let seed = build_worker_seed(&msgs, 46, &names);
        assert_eq!(seed.len(), WORKER_HISTORY_CAP + 1, "1 条摘要 + 40 条近期");
        
        assert_eq!(seed[0].0, "user");
        assert!(seed[0].1.contains("已压缩"), "首条应为摘要");
        assert!(seed[0].1.contains("msg1"), "摘要应包含最早讨论");
        
        assert!(seed.last().unwrap().1.contains("msg45"));
        
        assert!(!seed[0].1.contains("msg45"));
    }

    #[test]
    fn seed_empty_when_no_prior_history() {
        
        let msgs = vec![mk_msg(1, "owner_ref", "", "owner", "第一问")];
        let seed = build_worker_seed(&msgs, 1, &HashMap::new());
        assert!(
            seed.is_empty(),
            "触发消息自身(seq==broadcast_seq)应被排除，首轮种子为空"
        );
    }

    

    #[test]
    fn notice_none_for_normal_completion() {
        assert!(
            worker_failure_notice("架构师", &StopReason::Completed, false).is_none(),
            "正常完成且有产出 → 不打扰群主"
        );
    }

    #[test]
    fn notice_none_for_race_cancelled() {
        
        assert!(worker_failure_notice("架构师", &StopReason::Cancelled, true).is_none());
        assert!(worker_failure_notice("架构师", &StopReason::Cancelled, false).is_none());
    }

    #[test]
    fn notice_for_empty_output_even_if_completed() {
        let n = worker_failure_notice("架构师", &StopReason::Completed, true)
            .expect("空产出应通知群主");
        assert!(n.contains("架构师"));
        assert!(n.contains("未产出"));
        assert!(n.starts_with("【Agent 异常】"));
    }

    #[test]
    fn notice_for_each_abnormal_stop_reason() {
        for (stop, kw) in [
            (StopReason::ToolsExhausted, "工具循环耗尽"),
            (StopReason::TimedOut, "超时"),
            (StopReason::LlmError, "错误"),
        ] {
            let n = worker_failure_notice("测试Agent", &stop, false)
                .unwrap_or_else(|| panic!("{:?} 应产生通知", stop));
            assert!(n.contains(kw), "{:?} 文案应含「{}」，实际：{}", stop, kw, n);
            assert!(n.contains("测试Agent"));
        }
    }

    #[test]
    fn strip_speaker_prefix_handles_layers_and_variants() {
        
        assert_eq!(
            strip_speaker_prefix("理性分析师：行，给你讲个数据人的笑话——", "理性分析师"),
            "行，给你讲个数据人的笑话——"
        );
        
        assert_eq!(
            strip_speaker_prefix(
                "理性分析师：理性分析师：理性分析师：行，给你讲个数据人的笑话——",
                "理性分析师"
            ),
            "行，给你讲个数据人的笑话——"
        );
        
        assert_eq!(
            strip_speaker_prefix("Analyst: here is the data.", "Analyst"),
            "here is the data."
        );
        
        assert_eq!(
            strip_speaker_prefix("@理性 分析师：收到", "理性 分析师"),
            "收到"
        );
        
        assert_eq!(
            strip_speaker_prefix("理性分析师 #1：同意", "理性分析师"),
            "同意"
        );
        
        assert_eq!(
            strip_speaker_prefix("从数据上看这个结论站不住脚。", "理性分析师"),
            "从数据上看这个结论站不住脚。"
        );
        
        assert_eq!(
            strip_speaker_prefix("理性分析师这个角色很重要。", "理性分析师"),
            "理性分析师这个角色很重要。"
        );
        
        assert_eq!(strip_speaker_prefix("理性分析师：内容", ""), "理性分析师：内容");
        
        assert_eq!(strip_speaker_prefix("理性分析师：", "理性分析师").trim(), "");
    }

    #[test]
    fn split_into_units_chinese_punctuation() {
        let u = split_into_units("这个梗我懂。之前群里也有人发过类似的。");
        assert_eq!(u, vec!["这个梗我懂。", "之前群里也有人发过类似的。"]);
    }

    #[test]
    fn split_into_units_newline_and_collapse() {
        
        assert_eq!(split_into_units("哈哈\n笑死"), vec!["哈哈", "笑死"]);
        assert_eq!(split_into_units("a\n\n\nb"), vec!["a", "b"]);
    }

    #[test]
    fn split_into_units_english_abbreviation_not_split() {
        
        let u = split_into_units("Mr. Smith 来了。他说 hi。");
        assert_eq!(u, vec!["Mr. Smith 来了。", "他说 hi。"]);
    }

    #[test]
    fn group_into_bubbles_merges_short_mood_words() {
        
        let out = group_into_bubbles(vec!["嗯。".into(), "好，我看看。".into()]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("嗯。"));
        assert!(out[0].contains("好，我看看。"));
    }

    #[test]
    fn group_into_bubbles_natural_clusters() {
        
        let units = vec![
            "哈哈这个梗我懂。".into(),
            "之前群里也有人发过类似的。".into(),
            "老王那个表情包绝了。".into(),
            "笑死。".into(),
        ];
        let out = group_into_bubbles(units);
        assert_eq!(out.len(), 2, "应聚合成 2 个气泡，实际 {:?}", out);
        assert_eq!(out[0], "哈哈这个梗我懂。\n之前群里也有人发过类似的。");
        assert_eq!(out[1], "老王那个表情包绝了。\n笑死。");
    }

    #[test]
    fn group_into_bubbles_keeps_overlong_sentence_alone() {
        
        let long = "这是一个非常非常长的句子用来测试超长句是否保持原样不被强行拆分因为我们已经设置了硬上限并且这一句明显超过了一百二十个字所以我们期望它作为一个独立的气泡存在即使它很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长";
        let out = group_into_bubbles(vec![long.to_string()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], long);
    }

    #[test]
    fn split_roundtable_reply_chat_vs_nonchat() {
        
        let r = split_roundtable_reply("第一点。\n第二点。", &GroupKind::Research);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], "第一点。\n第二点。");
        
        let c = split_roundtable_reply(
            "这个梗我懂，之前群里老王也发过类似的。说真的那个表情包确实绝了，我每次看到都笑。你们觉得呢？",
            &GroupKind::Chat,
        );
        assert!(c.len() >= 2, "聊天型应拆成多条，实际 {:?}", c);
        
        for b in &c {
            assert!(!b.trim().is_empty());
        }
    }

    #[test]
    fn split_roundtable_reply_single_unit_returns_as_is() {
        
        let c = split_roundtable_reply("就一句话", &GroupKind::Chat);
        assert_eq!(c, vec!["就一句话"]);
    }

    #[test]
    fn human_typing_delay_floor_is_two_seconds() {
        
        for len in [0usize, 20, 60, 120] {
            let d = human_typing_delay(len);
            assert!(
                d >= std::time::Duration::from_millis(2000),
                "间隔应 ≥ 2s，实际 {:?}（len={}）",
                d,
                len
            );
        }
    }
}
