



















use crate::commands::agent::AgentState;
use crate::commands::group::GroupState;
use crate::commands::session::SessionState;
use crate::group::agent_profile::CreateAgentProfilePayload;
use crate::group::agent_repo::AgentProfileRepository;
use crate::group::manager::GroupManager;
use crate::group::roundtable::RoundtableBus;
use crate::group::roundtable_repo::{
    RoundtableAlternative, RoundtableAlternativeRepository, RoundtableMessage,
    RoundtableRepository, RoundtableSummaryRepository,
};
use crate::group::scheduler::TaskScheduler;
use crate::group::task_board::{SubTask, TaskStatus};
use crate::group::task_board_repo::TaskBoardRepository;
use crate::group::worker::worker_session_id;
use crate::group::worker_repo::WorkerRepository;
use crate::group::{CreateGroupPayload, GroupKind, GroupStatus};
use crate::storage::connection::DbConnection;
use crate::storage::repository::Repository;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;



static INTEGRATION_LOCK: StdMutex<()> = StdMutex::new(());
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Listener, Manager};
use tokio::time::{sleep, timeout, Duration};

const TASK_DESC: &str =
    "请用一句话（不超过40字）解释 Rust 的所有权（ownership）机制。直接给出答案，不要调用任何工具。";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "live LLM full-chain: run with `cargo test --lib -- --ignored` + ONDESKTOP_LIVE_INTEGRATION=1 + DEEPSEEK_API_KEY"]
async fn full_chain_group_dispatch_completes() {
    
    if std::env::var("ONDESKTOP_LIVE_INTEGRATION").is_err() {
        eprintln!(
            "[integration] SKIP: set ONDESKTOP_LIVE_INTEGRATION=1 and DEEPSEEK_API_KEY to run"
        );
        return;
    }
    let api_key = match std::env::var("DEEPSEEK_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            eprintln!("[integration] SKIP: DEEPSEEK_API_KEY not set");
            return;
        }
    };

    
    let _guard = INTEGRATION_LOCK.lock().unwrap();

    
    
    let fake_home = std::env::temp_dir().join(format!("od_it_{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&fake_home).unwrap();
    std::env::set_var("HOME", &fake_home);

    
    
    let cfg_dir = crate::paths::data_dir();
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        format!(r#"{{"api_key":"{}"}}"#, api_key),
    )
    .unwrap();

    
    
    
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    crate::paths::ensure_dirs();
    let db = Arc::new(DbConnection::open(&crate::paths::db_dir()).expect("open db"));
    crate::wire_states(&handle, db, false);

    
    let db = handle.state::<GroupState>().db.clone();

    
    handle.state::<AgentState>().engine.set_auto_approve(true);

    
    let preset = AgentProfileRepository::new(&*db)
        .create(CreateAgentProfilePayload {
            name: "explainer".into(),
            model: "deepseek-v4-flash".into(),
            system_prompt: "你是严谨的技术讲解员。只以纯文本回答，禁止使用任何工具。".into(),
            capabilities: vec!["explain".into()],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("create preset");

    
    let group = GroupManager::new(db.clone())
        .create_group(CreateGroupPayload {
            name: "explain-squad".into(),
            goal: "回答技术问题".into(),
            owner_agent_ref: preset.id.clone(),
            seat_config: serde_json::json!({ "static": [preset.id] }),
            kind: GroupKind::Chat,
        })
        .expect("create group");
    assert_eq!(group.status, GroupStatus::Active);

    
    let completed = Arc::new(AtomicBool::new(false));
    let completed2 = completed.clone();
    let _listener = handle.clone().listen("group-event", move |e| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&e.payload()) {
            if v.get("type").and_then(|t| t.as_str()) == Some("batch_completed") {
                completed2.store(true, Ordering::SeqCst);
            }
        }
    });

    
    
    let subtask = SubTask::new("t_explain", None, TASK_DESC, vec![]);
    let batch_id = format!("batch_{}", uuid::Uuid::new_v4().simple());
    handle
        .state::<Arc<TaskScheduler>>()
        .inner()
        .clone()
        .submit_batch(&group.id, &batch_id, vec![subtask], true)
        .await
        .expect("submit batch");

    
    let tasks = timeout(Duration::from_secs(180), async {
        loop {
            let tasks = TaskBoardRepository::new(&*db)
                .find_by_batch(&group.id, &batch_id)
                .unwrap();
            if !tasks.is_empty()
                && tasks.iter().all(|t| {
                    matches!(
                        t.status,
                        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
                    )
                })
            {
                return tasks;
            }
            sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .expect("batch did not finish within 180s");

    
    assert!(
        tasks.iter().all(|t| t.status == TaskStatus::Completed),
        "expected all tasks Completed, got: {:?}",
        tasks
            .iter()
            .map(|t| format!("{:?}", t.status))
            .collect::<Vec<_>>()
    );
    assert!(
        completed.load(Ordering::SeqCst),
        "batch_completed event not emitted"
    );

    
    let workers = WorkerRepository::new(&*db)
        .list_by_group(&group.id)
        .expect("list workers");
    assert!(!workers.is_empty(), "group should have at least one worker");
    let sid = worker_session_id(&group.id, &workers[0].id);
    let msgs = handle
        .state::<SessionState>()
        .0
        .get_messages(&sid)
        .expect("get messages");
    let answer = msgs
        .iter()
        .find(|m| m.role == "assistant" && !m.content.trim().is_empty());
    assert!(
        answer.is_some(),
        "worker session {} has no assistant answer; messages={:?}",
        sid,
        msgs
    );

    eprintln!(
        "[integration] PASS: group={} batch={} worker_session={} answer_len={}",
        group.id,
        batch_id,
        sid,
        answer.map(|m| m.content.len()).unwrap_or(0)
    );
}



#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "live LLM roundtable summarize: run with `cargo test --lib -- --ignored` + ONDESKTOP_LIVE_INTEGRATION=1 + DEEPSEEK_API_KEY"]
async fn full_chain_roundtable_summarize() {
    if std::env::var("ONDESKTOP_LIVE_INTEGRATION").is_err() {
        eprintln!("[integration] SKIP roundtable summarize: set ONDESKTOP_LIVE_INTEGRATION=1 and DEEPSEEK_API_KEY");
        return;
    }
    let api_key = match std::env::var("DEEPSEEK_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            eprintln!("[integration] SKIP roundtable summarize: DEEPSEEK_API_KEY not set");
            return;
        }
    };

    
    let _guard = INTEGRATION_LOCK.lock().unwrap();

    
    let fake_home = std::env::temp_dir().join(format!("od_it_{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&fake_home).unwrap();
    std::env::set_var("HOME", &fake_home);
    let cfg_dir = crate::paths::data_dir();
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(
        cfg_dir.join("config.json"),
        format!(r#"{{"api_key":"{}"}}"#, api_key),
    )
    .unwrap();

    
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    crate::paths::ensure_dirs();
    let db = Arc::new(DbConnection::open(&crate::paths::db_dir()).expect("open db"));
    crate::wire_states(&handle, db, false);
    let db = handle.state::<GroupState>().db.clone();
    handle.state::<AgentState>().engine.set_auto_approve(true);

    
    let preset = AgentProfileRepository::new(&*db)
        .create(CreateAgentProfilePayload {
            name: "explainer".into(),
            model: "deepseek-v4-flash".into(),
            system_prompt: "你是严谨的技术讲解员。".into(),
            capabilities: vec![],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("create preset");
    let group = GroupManager::new(db.clone())
        .create_group(CreateGroupPayload {
            name: "sum-squad".into(),
            goal: "测试摘要聚合".into(),
            owner_agent_ref: preset.id.clone(),
            seat_config: serde_json::json!({ "static": [preset.id] }),
            kind: GroupKind::Chat,
        })
        .expect("create group");

    
    let repo = RoundtableRepository::new(&*db);
    let mk = |author: &str, kind: &str, content: &str| RoundtableMessage {
        seq: 0,
        group_id: group.id.clone(),
        author: author.into(),
        worker_id: String::new(),
        author_kind: kind.into(),
        content: content.into(),
        mentions: vec![],
        attachments: vec![],
        created_at: 0,
        session_id: String::new(),
    };
    repo.create(&mk(
        "ag_owner",
        "owner",
        "我们怎么设计缓存层？要考虑命中率与失效策略。",
    ))
    .unwrap();
    repo.create(&mk(
        &preset.id,
        "worker",
        "建议用 LRU，TTL 5 分钟，写时失效；命中率可达 90%+。",
    ))
    .unwrap();
    repo.create(&mk("ag_owner", "owner", "那一致性怎么保证？"))
        .unwrap();
    repo.create(&mk(
        &preset.id,
        "worker",
        "写直达（write-through）+ 失效广播，保证最终一致。",
    ))
    .unwrap();

    
    
    let summary = handle
        .state::<Arc<RoundtableBus>>()
        .inner()
        .summarize(group.id.clone())
        .await
        .expect("summarize");
    assert!(!summary.content.trim().is_empty(), "summary content empty");
    assert!(
        summary.message_count >= 4,
        "expected >=4 messages aggregated"
    );

    
    let persisted = RoundtableSummaryRepository::new(&*db)
        .find_by_group(&group.id)
        .expect("find summaries");
    assert!(!persisted.is_empty(), "summary not persisted");
    assert_eq!(persisted.last().unwrap().id, summary.id);

    eprintln!(
        "[integration] PASS roundtable summarize: group={} summary_id={} len={} messages={}",
        group.id,
        summary.id,
        summary.content.len(),
        summary.message_count
    );
}









#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r6_alternatives_commands_work() {
    let _guard = INTEGRATION_LOCK.lock().unwrap();
    let db_path = std::env::temp_dir().join(format!(
        "od_it_db_{}.db",
        uuid::Uuid::new_v4().simple()
    ));

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    let db = Arc::new(DbConnection::open(&db_path).expect("open temp db"));
    crate::wire_states(&handle, db, false);
    let db = handle.state::<GroupState>().db.clone();

    let now = crate::agent::ledger::now_unix_ms();
    
    let repo = RoundtableAlternativeRepository::new(&db);
    let id_a = repo
        .create(&RoundtableAlternative {
            id: 0,
            group_id: "g1".into(),
            trigger_seq: 5,
            worker_id: "w_a".into(),
            content: "方案 A".into(),
            created_at: now,
        })
        .expect("create alt A");
    repo.create(&RoundtableAlternative {
        id: 0,
        group_id: "g1".into(),
        trigger_seq: 5,
        worker_id: "w_b".into(),
        content: "方案 B".into(),
        created_at: now + 1,
    })
    .expect("create alt B");

    
    let alts = crate::commands::group::group_list_alternatives(handle.clone(), "g1".into())
        .await
        .expect("list alternatives");
    assert_eq!(alts.len(), 2);
    assert_eq!(alts[0].trigger_seq, 5);
    assert_eq!(alts[0].worker_id, "w_a");

    
    let msg = crate::commands::group::group_pick_alternative(handle.clone(), "g1".into(), id_a)
        .await
        .expect("pick alternative");
    assert_eq!(msg.author_kind, "system");
    assert!(
        msg.content.contains("方案 A") || msg.content.contains("w_a"),
        "pick msg should mention the picked alternative"
    );
    let msgs = RoundtableRepository::new(&db).find_by_group("g1").unwrap();
    assert!(
        msgs.iter().any(|m| m.author_kind == "system" && m.seq == msg.seq),
        "pick system message should be persisted"
    );

    
    assert!(
        crate::commands::group::group_pick_alternative(handle.clone(), "g1".into(), 999_999)
            .await
            .is_err()
    );

    let _ = std::fs::remove_dir_all(&db_path);
    eprintln!("[integration] PASS r6 alternatives commands (list=2, pick persisted)");
}






#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r4r5_insight_queries_work() {
    let _guard = INTEGRATION_LOCK.lock().unwrap();
    let db_path = std::env::temp_dir().join(format!(
        "od_it_db_{}.db",
        uuid::Uuid::new_v4().simple()
    ));

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    let db = Arc::new(DbConnection::open(&db_path).expect("open temp db"));
    crate::wire_states(&handle, db, false);
    let db = handle.state::<GroupState>().db.clone();

    
    let ledger = crate::agent::ledger_sqlite::SqliteRunLedger::new(db.clone());
    use crate::agent::ledger::*;
    let now = now_unix_ms();

    
    let r1 = ledger.begin(RunBegin {
        run_id: "test-run-1".to_string(),
        session_id: "rt:g9:w1".into(),
        group_id: Some("g9".into()),
        seat_id: Some("w1".into()),
        kind: RunKind::Worker,
        model: Some("deepseek-chat".into()),
        job_id: None,
        attempt_no: 1,
    });
    ledger.step(
        &r1,
        RunStep {
            seq: 0,
            kind: RunStepKind::Llm,
            name: Some("deepseek-chat".into()),
            origin: None,
            args_digest: None,
            outcome: StepOutcome::Ok,
            unavailable_reason: None,
            approval_source: None,
            approval_decision: None,
            duration_ms: Some(120),
            started_at: now,
        },
    );
    ledger.step(
        &r1,
        RunStep {
            seq: 0,
            kind: RunStepKind::Tool,
            name: Some("write_file".into()),
            origin: Some("builtin".into()),
            args_digest: Some("d1".into()),
            outcome: StepOutcome::Ok,
            unavailable_reason: None,
            approval_source: Some(ApprovalSource::AutoApprove),
            approval_decision: Some(ApprovalDecision::Accept),
            duration_ms: Some(30),
            started_at: now,
        },
    );
    ledger.finish(
        &r1,
        RunFinish {
            status: RunStatus::Ok,
            ended_at: now + 500,
            model: Some("deepseek-chat".into()),
            prompt_tokens: 1000,
            output_tokens: 2000,
            reasoning_tokens: 0,
            iterations: 1,
            error_kind: None,
        },
    );

    
    
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    let r2 = ledger.begin(RunBegin {
        run_id: "test-run-2".to_string(),
        session_id: "rt:g9:w2".into(),
        group_id: Some("g9".into()),
        seat_id: Some("w2".into()),
        kind: RunKind::Worker,
        model: Some("deepseek-chat".into()),
        job_id: None,
        attempt_no: 1,
    });
    ledger.finish(
        &r2,
        RunFinish {
            status: RunStatus::Failed,
            ended_at: now + 300,
            model: Some("deepseek-chat".into()),
            prompt_tokens: 500,
            output_tokens: 300,
            reasoning_tokens: 0,
            iterations: 1,
            error_kind: Some("provider".into()),
        },
    );

    
    let group_insight = crate::commands::insight::insight_group_runs(handle.clone(), "g9".into())
        .await
        .expect("group insight");
    assert_eq!(group_insight.summary.run_count, 2);
    assert_eq!(group_insight.summary.prompt_tokens, 1500);
    assert_eq!(group_insight.summary.output_tokens, 2300);
    
    
    assert!(
        (650..=950).contains(&group_insight.summary.total_duration_ms),
        "total_duration_ms = {}",
        group_insight.summary.total_duration_ms
    );
    assert!(group_insight.summary.est_cost_yuan > 0.0);

    
    assert_eq!(group_insight.runs.len(), 2);
    assert_eq!(group_insight.runs[0].run.seat_id.as_deref(), Some("w1"));
    assert_eq!(group_insight.runs[0].steps.len(), 2);
    assert_eq!(group_insight.runs[0].steps[0].kind, "llm");
    assert_eq!(group_insight.runs[0].steps[1].kind, "tool");
    assert_eq!(group_insight.runs[1].run.status, "failed");

    
    let seat1 = crate::commands::insight::insight_seat_runs(handle.clone(), "w1".into(), None)
        .await
        .expect("seat insight w1");
    assert_eq!(seat1.summary.total_runs, 1);
    assert_eq!(seat1.summary.success_runs, 1);
    assert_eq!(seat1.summary.total_tokens, 3000);
    assert!(seat1.summary.est_cost_yuan > 0.0);
    assert_eq!(seat1.recent_runs.len(), 1);

    let seat2 = crate::commands::insight::insight_seat_runs(handle.clone(), "w2".into(), None)
        .await
        .expect("seat insight w2");
    assert_eq!(seat2.summary.total_runs, 1);
    assert_eq!(seat2.summary.success_runs, 0);

    let _ = std::fs::remove_dir_all(&db_path);
    eprintln!("[integration] PASS r4r5 insight queries (summary/gantt/seat agg)");
}








#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r7_upgrade_commands_work() {
    let _guard = INTEGRATION_LOCK.lock().unwrap();
    let db_path = std::env::temp_dir().join(format!(
        "od_it_db_{}.db",
        uuid::Uuid::new_v4().simple()
    ));

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    let db = Arc::new(DbConnection::open(&db_path).expect("open temp db"));
    crate::wire_states(&handle, db, false);
    let db = handle.state::<GroupState>().db.clone();

    
    let ar = AgentProfileRepository::new(&db);
    let owner = ar
        .create(CreateAgentProfilePayload {
            name: "owner-ag".into(),
            model: "deepseek-v4-flash".into(),
            system_prompt: "群主".into(),
            capabilities: vec![],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("owner preset");
    let s1 = ar
        .create(CreateAgentProfilePayload {
            name: "coder".into(),
            model: "deepseek-v4-flash".into(),
            system_prompt: "编码".into(),
            capabilities: vec!["code".into()],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("seat1 preset");
    let s2 = ar
        .create(CreateAgentProfilePayload {
            name: "writer".into(),
            model: "deepseek-v4-flash".into(),
            system_prompt: "写作".into(),
            capabilities: vec!["write".into()],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("seat2 preset");

    
    let sm = handle.state::<SessionState>();
    let chat = sm
        .0
        .create_session("升级测试".into(), "deepseek-v4-flash".into(), "p".into(), None)
        .expect("create chat session");
    sm.0.add_message(crate::session::model::CreateMessagePayload {
        session_id: chat.id.clone(),
        role: "user".into(),
        content: "帮我做一个竞品分析".into(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        token_usage: 0,
        reasoning_content: String::new(),
        call_id: None,
    })
    .expect("user msg");
    sm.0.add_message(crate::session::model::CreateMessagePayload {
        session_id: chat.id.clone(),
        role: "assistant".into(),
        content: "好的，我来拆解。".into(),
        tool_name: None,
        tool_args: None,
        tool_result: None,
        token_usage: 0,
        reasoning_content: String::new(),
        call_id: None,
    })
    .expect("assistant msg");

    
    let group = crate::commands::upgrade::session_confirm_upgrade(
        handle.clone(),
        chat.id.clone(),
        "竞品分析群".into(),
        "并行产出竞品对比".into(),
        owner.id.clone(),
        vec![s1.id.clone(), s2.id.clone()],
        vec![],
    )
    .await
    .expect("confirm upgrade");

    
    let upgraded = sm
        .0
        .get_session(&chat.id)
        .expect("get session")
        .expect("session exists");
    assert_eq!(upgraded.mode.as_deref(), Some("group"), "session.mode=group");
    assert_eq!(upgraded.group_id.as_deref(), Some(group.id.as_str()));
    let msgs = sm.0.get_messages(&chat.id).expect("messages");
    assert_eq!(msgs.len(), 2, "历史消息不丢");

    
    let rmsgs = RoundtableRepository::new(&db).find_by_group(&group.id).unwrap();
    assert_eq!(rmsgs.len(), 1, "群首条消息 = 会话上下文种子");
    assert_eq!(rmsgs[0].author_kind, "system");
    assert!(rmsgs[0].content.contains("竞品分析"), "种子携带单聊上下文");
    let workers = WorkerRepository::new(&db).list_by_group(&group.id).unwrap();
    assert_eq!(workers.len(), 2, "两个静态席位已注册");

    
    crate::commands::upgrade::session_fold_to_chat(handle.clone(), chat.id.clone())
        .await
        .expect("fold back");
    let folded = sm
        .0
        .get_session(&chat.id)
        .expect("get session")
        .expect("session exists");
    assert_eq!(folded.mode, None, "mode 置空");
    assert_eq!(folded.group_id, None, "group_id 置空");
    let rmsgs_after = RoundtableRepository::new(&db).find_by_group(&group.id).unwrap();
    assert_eq!(rmsgs_after.len(), 1, "群实体保留（含产出物）");
    let msgs_after = sm.0.get_messages(&chat.id).expect("messages");
    assert_eq!(msgs_after.len(), 2, "消息仍保留");

    let _ = std::fs::remove_dir_all(&db_path);
    eprintln!("[integration] PASS r7 upgrade/fold (mode=group → fold, messages kept)");
}


















#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ipc_create_group_full_topology_contract() {
    let _guard = INTEGRATION_LOCK.lock().unwrap();
    let db_path = std::env::temp_dir().join(format!(
        "od_it_ipc1_{}.db",
        uuid::Uuid::new_v4().simple()
    ));

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    let db = Arc::new(DbConnection::open(&db_path).expect("open temp db"));
    crate::wire_states(&handle, db, false);

    
    let preset = AgentProfileRepository::new(handle.state::<GroupState>().db.as_ref())
        .create(CreateAgentProfilePayload {
            name: "ipc-owner".into(),
            model: "deepseek-chat".into(),
            system_prompt: "t".into(),
            capabilities: vec!["research".into()],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("create preset");

    
    let spread_body = serde_json::json!({
        "name": "ipc-squad",
        "goal": "contract check",
        "owner_agent_ref": preset.id,
        "seat_config": { "static": [preset.id] },
        "topology": { "version": 1, "default": "Allow", "edges": [] },
    });
    assert!(
        spread_body.get("payload").is_none(),
        "展开传参时没有 payload key（这正是 missing required key payload 的来源）"
    );
    let spread_pl: Result<CreateGroupPayload, _> =
        serde_json::from_value(spread_body.get("payload").cloned().unwrap_or(serde_json::Value::Null));
    assert!(spread_pl.is_err(), "展开传参必须反序列化失败（旧 bug 复现）");

    
    let wrapped = serde_json::json!({
        "payload": {
            "name": "ipc-squad",
            "goal": "contract check",
            "owner_agent_ref": preset.id,
            "seat_config": { "static": [preset.id] },
        }
    });
    let pl: CreateGroupPayload =
        serde_json::from_value(wrapped["payload"].clone()).expect("{{ payload }} 包装可反序列化");

    
    let g = crate::commands::group::create_group(handle.clone(), pl)
        .await
        .expect("create_group 命令执行成功");
    assert_eq!(g.status, GroupStatus::Active, "群默认 Active");

    
    let policy: crate::group::topology::TopologyPolicy = serde_json::from_value(
        serde_json::json!({ "version": 1, "default": "Allow", "edges": [] }),
    )
    .expect("full 拓扑 JSON 可反序列化");
    let ver = crate::commands::group::group_topology_set(handle.clone(), g.id.clone(), policy)
        .await
        .expect("group_topology_set 命令执行成功");
    assert!(ver >= 1, "返回新版本号");

    
    let latest = crate::group::topology_repo::TopologyPolicyRepository::new(
        handle.state::<GroupState>().db.as_ref(),
    )
    .latest_for_group(&g.id)
    .unwrap()
    .expect("topology snapshot exists");
    assert_eq!(
        latest.default,
        crate::group::topology::RouteAction::Allow,
        "full 拓扑 default=Allow 已固化"
    );

    let _ = std::fs::remove_file(&db_path);
    eprintln!("[integration] PASS ipc create_group + group_topology_set ({{ payload }} contract + full topology)");
}








#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ipc_structured_error_contract() {
    let _guard = INTEGRATION_LOCK.lock().unwrap();
    
    let db_path = std::env::temp_dir().join(format!(
        "od_it_err_{}.db",
        uuid::Uuid::new_v4().simple()
    ));

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    let db = Arc::new(DbConnection::open(&db_path).expect("open temp db"));
    crate::wire_states(&handle, db, false);

    
    let err = crate::commands::group::group_add_capability_seat(
        handle.clone(),
        "grp_x".into(),
        vec![],
        Some(1),
    )
    .await
    .expect_err("空能力必须失败");
    assert_eq!(err.error_code(), "UNKNOWN", "未迁移业务错误兜底 UNKNOWN");
    assert!(err.user_message().contains("能力席位"), "中文 message 保留");

    
    let err2 = crate::commands::group::create_group(
        handle.clone(),
        CreateGroupPayload {
            name: "   ".into(), 
            goal: "x".into(),
            owner_agent_ref: "ag_owner".into(),
            seat_config: serde_json::json!({"static": []}),
            kind: GroupKind::Chat,
        },
    )
    .await
    .expect_err("空群名必须失败");
    assert_eq!(err2.error_code(), "UNKNOWN");

    
    let v = serde_json::to_value(&err2).unwrap();
    assert!(v.get("code").is_some(), "必须有 code 字段");
    assert!(v.get("message").is_some(), "必须有 message 字段");
    assert_eq!(v["code"], "UNKNOWN");

    let _ = std::fs::remove_file(&db_path);
    eprintln!("[integration] PASS ipc_structured_error_contract (code/message JSON)");
}



#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r8_group_kind_serialized_in_list() {
    let _guard = INTEGRATION_LOCK.lock().unwrap();
    let db_path = std::env::temp_dir().join(format!(
        "od_it_db_{}.db",
        uuid::Uuid::new_v4().simple()
    ));

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    let db = Arc::new(DbConnection::open(&db_path).expect("open temp db"));
    crate::wire_states(&handle, db, false);
    let db = handle.state::<GroupState>().db.clone();

    
    let agent_repo = AgentProfileRepository::new(db.as_ref());
    let owner = agent_repo
        .create(CreateAgentProfilePayload {
            name: "owner".into(),
            model: "deepseek-chat".into(),
            system_prompt: "x".into(),
            capabilities: vec![],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("create owner");
    let group_repo = crate::group::group_repo::GroupRepository::new(db.as_ref());
    group_repo
        .create(CreateGroupPayload {
            name: "kind 序列化验证群".into(),
            goal: "验证 kind 字段".into(),
            owner_agent_ref: owner.id.clone(),
            seat_config: serde_json::json!({"static": []}),
            kind: GroupKind::Chat,
        })
        .expect("create group");

    
    let groups = group_repo.find_all(()).expect("find_all");
    assert_eq!(groups.len(), 1);
    let raw = serde_json::to_value(&groups[0]).expect("serialize group");
    eprintln!("[probe] group[0] = {}", serde_json::to_string_pretty(&raw).unwrap());
    assert!(raw.get("kind").is_some(), "序列化必须返回 kind 字段");
    assert_eq!(raw["kind"], "Chat", "kind 应为 Chat");

    let _ = std::fs::remove_file(&db_path);
    eprintln!("[integration] PASS r8_group_kind_serialized_in_list");
}












#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn coordinator_approval_loop_works() {
    let _guard = INTEGRATION_LOCK.lock().unwrap();
    let db_path = std::env::temp_dir().join(format!(
        "od_it_db_{}.db",
        uuid::Uuid::new_v4().simple()
    ));

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app should build");
    let handle = app.handle().clone();
    let db = Arc::new(DbConnection::open(&db_path).expect("open temp db"));
    crate::wire_states(&handle, db, false);
    let db = handle.state::<GroupState>().db.clone();

    
    let owner = AgentProfileRepository::new(&db)
        .create(CreateAgentProfilePayload {
            name: "coordinator-owner".into(),
            model: "deepseek-chat".into(),
            system_prompt: "群主".into(),
            capabilities: vec![],
            skills: vec![],
            mcp: vec![],
            tools: vec![],
        })
        .expect("create owner");
    let group = GroupManager::new(db.clone())
        .create_group(CreateGroupPayload {
            name: "coord-loop".into(),
            goal: "验证拆解审批闭环".into(),
            owner_agent_ref: owner.id.clone(),
            seat_config: serde_json::json!({ "static": [] }),
            kind: GroupKind::Chat,
        })
        .expect("create group");
    assert_eq!(group.status, GroupStatus::Active);

    
    let awaiting = Arc::new(AtomicBool::new(false));
    let awaiting2 = awaiting.clone();
    let _listener = handle.clone().listen("group-event", move |e| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&e.payload()) {
            if v.get("type").and_then(|t| t.as_str()) == Some("batch_awaiting_approval") {
                awaiting2.store(true, Ordering::SeqCst);
            }
        }
    });

    
    let batch_id = crate::commands::group::group_assign_tasks(
        handle.state::<Arc<TaskScheduler>>(),
        group.id.clone(),
        vec![
            SubTask::new("t1", None, "子任务一：调研竞品".into(), vec![]),
            SubTask::new("t2", None, "子任务二：产出方案".into(), vec!["t1".into()]),
        ],
        Some("coordinator".into()),
        Some(false),
    )
    .await
    .expect("coordinator submit batch");

    
    let tasks = TaskBoardRepository::new(&db)
        .find_by_batch(&group.id, &batch_id)
        .expect("find tasks");
    assert_eq!(tasks.len(), 2, "批次含 2 个子任务");
    assert!(
        tasks.iter().all(|t| t.status == TaskStatus::AwaitingApproval),
        "coordinator 批次必须停在 AwaitingApproval（fail-closed），实际: {:?}",
        tasks.iter().map(|t| format!("{:?}", t.status)).collect::<Vec<_>>()
    );

    
    assert!(
        awaiting.load(Ordering::SeqCst),
        "group:batch_awaiting_approval 事件未发出"
    );

    
    crate::commands::group::group_approve_batch(
        handle.state::<Arc<TaskScheduler>>(),
        group.id.clone(),
        batch_id.clone(),
    )
    .await
    .expect("approve batch");
    let tasks2 = TaskBoardRepository::new(&db)
        .find_by_batch(&group.id, &batch_id)
        .expect("find tasks after approve");
    assert!(
        tasks2.iter().all(|t| t.status != TaskStatus::AwaitingApproval),
        "批准后不应残留 AwaitingApproval（闸门必须释放）"
    );
    assert!(
        tasks2.iter().all(|t| t.status == TaskStatus::Pending),
        "空席位群批准后应确定性停在 Pending，实际: {:?}",
        tasks2.iter().map(|t| format!("{:?}", t.status)).collect::<Vec<_>>()
    );

    let _ = std::fs::remove_file(&db_path);
    eprintln!(
        "[integration] PASS coordinator_approval_loop (submit→AwaitingApproval→approve→Pending) group={} batch={}",
        group.id, batch_id
    );
}
