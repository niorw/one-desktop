
















use crate::group::agent_profile::CreateAgentProfilePayload;
use crate::group::agent_repo::AgentProfileRepository;
use crate::group::group_repo::GroupRepository;
use crate::group::worker::CreateWorkerPayload;
use crate::group::worker_repo::WorkerRepository;
use crate::group::{CreateGroupPayload, GroupKind, SeatType};
use crate::mcp::model::*;
use crate::session::model::SessionQuery;
use crate::skill::model::*;
use crate::storage::connection::DbConnection;
use crate::storage::mcp_repo::McpServerRepository;
use crate::storage::repository::Repository;
use crate::group::task_board::{TaskStatus as KanbanTaskStatus};
use crate::scheduler::model::{ActionType, TaskSource, TaskStatus as SchedStatus, TaskType};
use crate::storage::session_repo::SessionRepository;
use crate::storage::skill_repo::SkillRepository;
use rusqlite::{params, Result as SqliteResult};
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;


const DEFAULT_SKILLS: &[&str] = &[
    "brainstorming",
    "writing-plans",
    "executing-plans",
    "humanizer",
    "comparative-economic-analysis",
];


pub fn seed_defaults(db: &Arc<DbConnection>) {
    seed_skills(db);
    seed_mcp(db);
}









pub fn seed_demo_data(db: &Arc<DbConnection>) {
    
    
    let persona_added = crate::group::persona_presets::seed_persona_presets(db);
    if persona_added > 0 {
        tracing::info!(
            target: "onedesktop.seed",
            count = persona_added,
            "seeded persona presets"
        );
    }

    
    
    let functional_added = crate::group::functional_presets::seed_functional_presets(db);
    if functional_added > 0 {
        tracing::info!(
            target: "onedesktop.seed",
            count = functional_added,
            "seeded functional presets"
        );
    }

    let session_repo = SessionRepository::new(db.as_ref());
    if session_repo
        .find_all(SessionQuery::default())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        return; 
    }

    
    let agent_repo = AgentProfileRepository::new(db.as_ref());
    let researcher = agent_repo
        .create(CreateAgentProfilePayload {
            name: "研究助手".into(),
            model: "deepseek-chat".into(),
            system_prompt: "你是一名严谨的研究助手，擅长信息检索、事实核验与结构化摘要。".into(),
            capabilities: vec!["web_search".into(), "summarize".into()],
            skills: vec![],
            mcp: vec![],
            tools: vec!["fs".into()],
        })
        .expect("seed: create researcher agent");
    let engineer = agent_repo
        .create(CreateAgentProfilePayload {
            name: "代码工程师".into(),
            model: "deepseek-chat".into(),
            system_prompt: "你是一名资深代码工程师，擅长生成、审查与重构代码，并解释技术取舍。"
                .into(),
            capabilities: vec!["codegen".into(), "review".into()],
            skills: vec![],
            mcp: vec![],
            tools: vec!["fs".into(), "shell".into()],
        })
        .expect("seed: create engineer agent");
    let _writer = agent_repo
        .create(CreateAgentProfilePayload {
            name: "文案策划".into(),
            model: "deepseek-chat".into(),
            system_prompt: "你是一名产品文案策划，擅长把复杂功能翻译成清晰、有说服力的用户语言。"
                .into(),
            capabilities: vec!["writing".into(), "brainstorm".into()],
            skills: vec![],
            mcp: vec![],
            tools: vec!["fs".into()],
        })
        .expect("seed: create writer agent");

    
    let group_repo = GroupRepository::new(db.as_ref());
    let group = group_repo
        .create(CreateGroupPayload {
            name: "竞品分析群".into(),
            goal: "对比 Notion / 飞书文档 / 语雀 三款笔记类产品，输出结构化竞品分析报告。".into(),
            owner_agent_ref: researcher.id.clone(),
            seat_config: json!({ "static": [] }),
            kind: GroupKind::Research,
        })
        .expect("seed: create demo group");

    let worker_repo = WorkerRepository::new(db.as_ref());
    let _w_research = worker_repo
        .create(CreateWorkerPayload {
            group_id: group.id.clone(),
            agent_ref: researcher.id.clone(),
            seat_type: SeatType::Static,
            capabilities: vec!["web_search".into(), "summarize".into()],
            max_concurrency: 2,
        })
        .expect("seed: create research worker");
    let _w_engine = worker_repo
        .create(CreateWorkerPayload {
            group_id: group.id.clone(),
            agent_ref: engineer.id.clone(),
            seat_type: SeatType::Static,
            capabilities: vec!["codegen".into()],
            max_concurrency: 1,
        })
        .expect("seed: create engineer worker");
    let _w_writer = worker_repo
        .create(CreateWorkerPayload {
            group_id: group.id.clone(),
            agent_ref: engineer.id.clone(),
            seat_type: SeatType::Static,
            capabilities: vec!["writing".into()],
            max_concurrency: 1,
        })
        .expect("seed: create writer worker");

    
    
    
    

    tracing::info!(target: "onedesktop.seed", "demo data seeded");
}







const DEMO_GROUP_NAME: &str = "竞品分析示例组";



pub fn seed_demo_tasks(db: &Arc<DbConnection>) {
    let tasks_empty = db
        .as_ref()
        .with_conn(|conn| {
            Ok(conn
                .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0))
        })
        .unwrap_or(0)
        == 0;
    let sched_empty = db
        .as_ref()
        .with_conn(|conn| {
            Ok(conn
                .query_row("SELECT COUNT(*) FROM scheduled_tasks", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0))
        })
        .unwrap_or(0)
        == 0;
    
    if tasks_empty {
        seed_demo_kanban(db);
    }
    if sched_empty {
        seed_demo_scheduled(db);
    }
}



fn seed_demo_kanban(db: &Arc<DbConnection>) {
    let now = chrono::Utc::now().timestamp();

    
    let group_repo = GroupRepository::new(db.as_ref());
    let group = match group_repo
        .find_all(())
        .ok()
        .and_then(|gs| gs.into_iter().find(|g| g.name == DEMO_GROUP_NAME))
    {
        Some(g) => g,
        None => group_repo
            .create(CreateGroupPayload {
                name: DEMO_GROUP_NAME.to_string(),
                goal: "对比 Notion / 飞书文档 / 语雀 三款笔记类产品，输出结构化竞品分析报告。".to_string(),
                owner_agent_ref: "demo_agent".to_string(),
                seat_config: json!({ "static": [] }),
                kind: GroupKind::Research,
            })
            .expect("seed: create demo group for tasks"),
    };
    let group_id = group.id.clone();

    
    let worker_repo = WorkerRepository::new(db.as_ref());
    let (w_research, w_engineer) = match worker_repo.list_by_group(&group_id).unwrap_or_default() {
        ws if ws.len() >= 2 => (ws[0].id.clone(), ws[1].id.clone()),
        _ => {
            let wr = worker_repo
                .create(CreateWorkerPayload {
                    group_id: group_id.clone(),
                    agent_ref: "demo_researcher".to_string(),
                    seat_type: SeatType::Static,
                    capabilities: vec!["web_search".into(), "summarize".into()],
                    max_concurrency: 2,
                })
                .expect("seed: create research worker");
            let we = worker_repo
                .create(CreateWorkerPayload {
                    group_id: group_id.clone(),
                    agent_ref: "demo_engineer".to_string(),
                    seat_type: SeatType::Static,
                    capabilities: vec!["code".into()],
                    max_concurrency: 1,
                })
                .expect("seed: create engineer worker");
            (wr.id, we.id)
        }
    };

    let g = group_id.as_str();

    
    
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_t_seo_1", g, Some("bat_seo".into()), Some(w_research.clone()),
        "抓取竞品官网定价页与功能清单", vec![], vec![], None,
        KanbanTaskStatus::Pending, 0, Some(w_research.clone()), vec![], None, None,
    ).expect("seed: insert t_seo_1");
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_t_seo_2", g, Some("bat_seo".into()), Some(w_engineer.clone()),
        "解析定价模型并生成对比表", vec!["demo_kb_t_seo_1".into()], vec![], None,
        KanbanTaskStatus::InProgress, 0, Some(w_engineer.clone()), vec![], Some("code".into()), Some(now),
    ).expect("seed: insert t_seo_2");
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_t_seo_3", g, Some("bat_seo".into()), Some(w_research.clone()),
        "输出竞品功能矩阵 v1（Markdown）", vec![], vec!["demo_kb_t_seo_1".into()], Some("matrix.md".into()),
        KanbanTaskStatus::Completed, 0, Some(w_research.clone()), vec!["matrix.md".into()], None, Some(now),
    ).expect("seed: insert t_seo_3");
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_t_api_1", g, None, Some(w_engineer.clone()),
        "调用第三方 API 拉取用户评论数据", vec![], vec![], None,
        KanbanTaskStatus::Failed, 2, Some(w_engineer.clone()), vec![], None, Some(now),
    ).expect("seed: insert t_api_1");
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_t_old_1", g, None, None,
        "旧版周报模板（已废弃，待清理）", vec![], vec![], None,
        KanbanTaskStatus::Cancelled, 0, None, vec![], None, None,
    ).expect("seed: insert t_old_1");
    
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_t_draft_1", g, None, Some(w_research.clone()),
        "撰写竞品分析终稿", vec![], vec!["demo_kb_t_seo_3".into()], None,
        KanbanTaskStatus::InProgress, 0, Some(w_research.clone()), vec![], Some("write".into()), Some(now - 600),
    ).expect("seed: insert t_draft_1");

    
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_p_1", "personal", None, None,
        "整理本周阅读清单", vec![], vec![], None,
        KanbanTaskStatus::Pending, 0, None, vec![], None, None,
    ).expect("seed: insert p_1");
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_p_2", "personal", None, None,
        "重写项目 README", vec![], vec![], None,
        KanbanTaskStatus::InProgress, 0, None, vec![], None, Some(now),
    ).expect("seed: insert p_2");
    seed_insert_kanban_task(
        db.as_ref(), "demo_kb_p_3", "personal", None, None,
        "配置本地构建缓存", vec![], vec![], Some("cache.md".into()),
        KanbanTaskStatus::Completed, 0, None, vec!["cache.md".into()], None, Some(now),
    ).expect("seed: insert p_3");

    tracing::info!(target: "onedesktop.seed", "demo kanban tasks seeded");
}



fn seed_demo_scheduled(db: &Arc<DbConnection>) {
    let now_iso = chrono::Utc::now().to_rfc3339();

    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_daily", "每日竞品价格快照", Some("抓取并归档当日竞品定价"),
        &TaskType::Cron, "0 9 * * *", &ActionType::Agent, "抓取竞品价格",
        &TaskSource::AgentDialog, &SchedStatus::Active,
        Some(iso_at(-1, 9, 0)), Some(iso_at(0, 9, 0)), 12, &now_iso, &now_iso,
    ).expect("seed: insert st_daily");
    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_today_a", "整理当日舆情摘要", Some("聚合当日舆情要点"),
        &TaskType::Cron, "0 11 * * *", &ActionType::Agent, "舆情摘要",
        &TaskSource::AgentDialog, &SchedStatus::Active,
        Some(iso_at(-1, 11, 0)), Some(iso_at(0, 11, 0)), 9, &now_iso, &now_iso,
    ).expect("seed: insert st_today_a");
    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_today_b", "待办的临时备份", Some("临时数据备份（已暂停）"),
        &TaskType::Interval, "PT2H", &ActionType::Agent, "备份",
        &TaskSource::AgentDialog, &SchedStatus::Paused,
        Some(iso_at(-1, 13, 0)), Some(iso_at(0, 15, 0)), 4, &now_iso, &now_iso,
    ).expect("seed: insert st_today_b");
    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_fail", "失败重试的舆情抓取", Some("抓取舆情，失败待重试"),
        &TaskType::Interval, "PT6H", &ActionType::Agent, "舆情抓取",
        &TaskSource::AgentDialog, &SchedStatus::Failed,
        Some(iso_at(0, 4, 0)), Some(iso_at(0, 22, 0)), 5, &now_iso, &now_iso,
    ).expect("seed: insert st_fail");
    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_weekly", "周报自动生成", Some("汇总本周群协作产出"),
        &TaskType::Cron, "0 18 * * 5", &ActionType::Agent, "生成周报",
        &TaskSource::AgentDialog, &SchedStatus::Active,
        Some(iso_at(-4, 18, 0)), Some(iso_at(2, 18, 0)), 8, &now_iso, &now_iso,
    ).expect("seed: insert st_weekly");
    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_monthly", "月度成本汇总", Some("统计 Agent 调用成本"),
        &TaskType::Interval, "P1M", &ActionType::Agent, "成本汇总",
        &TaskSource::SystemInit, &SchedStatus::Paused,
        Some(iso_at(-20, 10, 0)), Some(iso_at(5, 10, 0)), 3, &now_iso, &now_iso,
    ).expect("seed: insert st_monthly");
    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_once", "一次性数据归档", Some("归档上月运行日志"),
        &TaskType::Once, &iso_at(-1, 2, 0), &ActionType::Agent, "归档日志",
        &TaskSource::AgentDialog, &SchedStatus::Completed,
        Some(iso_at(-1, 2, 0)), Some(iso_at(-1, 2, 0)), 1, &now_iso, &now_iso,
    ).expect("seed: insert st_once");
    seed_insert_scheduled_task(
        db.as_ref(), "demo_st_expired", "过期未执行的巡检", Some("每周日巡检，已过期"),
        &TaskType::Cron, "0 3 * * 0", &ActionType::Agent, "巡检",
        &TaskSource::SystemInit, &SchedStatus::Expired,
        Some(iso_at(-8, 3, 0)), Some(iso_at(-3, 3, 0)), 6, &now_iso, &now_iso,
    ).expect("seed: insert st_expired");

    tracing::info!(target: "onedesktop.seed", "demo scheduled tasks seeded");
}


fn seed_insert_kanban_task(
    db: &DbConnection,
    id: &str,
    group_id: &str,
    batch_id: Option<String>,
    worker_id: Option<String>,
    description: &str,
    depends_on: Vec<String>,
    input_refs: Vec<String>,
    output_spec: Option<String>,
    status: KanbanTaskStatus,
    retry_count: i32,
    assigned_worker: Option<String>,
    outputs: Vec<String>,
    capability: Option<String>,
    last_heartbeat: Option<i64>,
) -> SqliteResult<()> {
    db.with_conn_mut(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO tasks \
             (id,group_id,batch_id,worker_id,description,depends_on,input_refs,output_spec,status,retry_count,assigned_worker,outputs,reasoning,capability,last_heartbeat) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,?13,?14)",
            params![
                id, group_id, batch_id, worker_id, description,
                serde_json::to_string(&depends_on).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&input_refs).unwrap_or_else(|_| "[]".into()),
                output_spec,
                serde_json::to_string(&status).unwrap(),
                retry_count,
                assigned_worker,
                serde_json::to_string(&outputs).unwrap_or_else(|_| "[]".into()),
                capability,
                last_heartbeat,
            ],
        )
        .map(|_| ())
    })
}


fn seed_insert_scheduled_task(
    db: &DbConnection,
    id: &str,
    title: &str,
    description: Option<&str>,
    type_: &TaskType,
    schedule_expr: &str,
    action_type: &ActionType,
    action_payload: &str,
    source: &TaskSource,
    status: &SchedStatus,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    run_count: i64,
    created_at: &str,
    updated_at: &str,
) -> SqliteResult<()> {
    db.with_conn_mut(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO scheduled_tasks \
             (id,title,description,type,schedule,action_type,action_payload,source,status,last_run_at,next_run_at,run_count,created_at,updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                id, title, description, type_.as_str(), schedule_expr,
                action_type.as_str(), action_payload, source.as_str(),
                status.as_str(), last_run_at, next_run_at, run_count,
                created_at, updated_at,
            ],
        )
        .map(|_| ())
    })
}


fn iso_at(days_offset: i64, hour: u32, min: u32) -> String {
    use chrono::{Duration, Local, TimeZone};
    let base = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
    let target = base
        + Duration::days(days_offset)
        + Duration::hours(hour as i64)
        + Duration::minutes(min as i64);
    Local
        .from_local_datetime(&target)
        .single()
        .unwrap_or_else(|| Local::now())
        .to_rfc3339()
}



fn seed_skills(db: &Arc<DbConnection>) {
    let repo = SkillRepository::new(db);
    if repo.find_all(()).map(|v| !v.is_empty()).unwrap_or(false) {
        return; 
    }

    let src_root = workbuddy_skills_dir();
    for name in DEFAULT_SKILLS {
        let src = src_root.join(name);
        let skill_md = src.join("SKILL.md");
        if !skill_md.is_file() {
            tracing::warn!(target: "onedesktop.seed", skill = name, "WorkBuddy skill not found, skipping");
            continue;
        }
        let dest = crate::paths::skill_dir("local", name);
        if let Err(e) = copy_dir_recursive(&src, &dest) {
            tracing::warn!(target: "onedesktop.seed", skill = name, error = %e, "failed to copy skill, skipping");
            continue;
        }
        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let (sname, desc, version) = parse_skill_frontmatter(&content).unwrap_or_else(|| {
            (
                (*name).to_string(),
                "Imported WorkBuddy skill".to_string(),
                "1.0.0".to_string(),
            )
        });
        let payload = CreateSkillPayload {
            id: (*name).to_string(),
            name: sname,
            description: desc,
            version,
            source: SkillSource::Local,
            path: Some(dest.to_string_lossy().into_owned()),
            url: None,
            status: SkillStatus::Enabled,
            dependencies: vec![],
        };
        match repo.create(payload) {
            Ok(_) => tracing::info!(target: "onedesktop.seed", skill = name, "seeded skill"),
            Err(e) => {
                tracing::warn!(target: "onedesktop.seed", skill = name, error = %e, "failed to insert skill")
            }
        }
    }
}



fn seed_mcp(db: &Arc<DbConnection>) {
    let repo = McpServerRepository::new(db);
    let populated = repo.find_all(()).map(|v| !v.is_empty()).unwrap_or(false);

    
    
    if !populated {
        let mcp_json = workbuddy_dir().join("mcp.json");
        if let Ok(text) = std::fs::read_to_string(&mcp_json) {
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(json) => {
                    if let Some(servers) = json.get("mcpServers").and_then(|v| v.as_object()) {
                        for (id, cfg) in servers {
                            let payload = server_from_json(id, cfg);
                            match repo.create(payload) {
                                Ok(_) => {
                                    tracing::info!(target: "onedesktop.seed", server = id, "seeded WorkBuddy MCP server")
                                }
                                Err(e) => {
                                    tracing::warn!(target: "onedesktop.seed", server = id, error = %e, "failed to insert MCP server")
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(target: "onedesktop.seed", error = %e, "failed to parse WorkBuddy mcp.json")
                }
            }
        }
    }

    
    
    let home = dirs::home_dir().unwrap_or_else(|| Path::new("/").to_path_buf());
    let home_str = home.to_string_lossy().into_owned();
    let defaults: Vec<(String, String, Vec<String>)> = vec![
        (
            "filesystem".to_string(),
            "Filesystem (local)".to_string(),
            vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                home_str,
            ],
        ),
        (
            "fetch".to_string(),
            "Fetch (web)".to_string(),
            vec!["-y".into(), "@modelcontextprotocol/server-fetch".into()],
        ),
        (
            "tavily".to_string(),
            "Tavily Web Search".to_string(),
            vec!["-y".into(), "tavily-mcp".into()],
        ),
        (
            "brave".to_string(),
            "Brave Web Search".to_string(),
            vec!["-y".into(), "@brave/brave-search-mcp-server".into()],
        ),
    ];
    for (id, name, args) in defaults {
        if repo.find_by_id(&id).ok().flatten().is_some() {
            continue;
        }
        let payload = CreateMcpServerPayload {
            id: id.clone(),
            name,
            transport: McpTransport::Stdio,
            command: Some("npx".to_string()),
            args,
            env: HashMap::new(),
            url: None,
            enabled: false,
        };
        match repo.create(payload) {
            Ok(_) => {
                tracing::info!(target: "onedesktop.seed", server = %id, "seeded default MCP server")
            }
            Err(e) => {
                tracing::warn!(target: "onedesktop.seed", server = %id, error = %e, "failed to insert MCP server")
            }
        }
    }
}

fn server_from_json(id: &str, cfg: &serde_json::Value) -> CreateMcpServerPayload {
    let command = cfg
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let args = cfg
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let env = cfg
        .get("env")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    CreateMcpServerPayload {
        id: id.to_string(),
        name: id.to_string(),
        transport: McpTransport::Stdio,
        command,
        args,
        env,
        url: None,
        enabled: false,
    }
}



fn workbuddy_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .expect("Cannot find home directory")
        .join(".workbuddy")
}

fn workbuddy_skills_dir() -> std::path::PathBuf {
    workbuddy_dir().join("skills")
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}



fn parse_skill_frontmatter(content: &str) -> Option<(String, String, String)> {
    let rest = content.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let fm = &rest[..end];
    let name = extract_yaml_value(fm, "name")?;
    let description = extract_yaml_value(fm, "description").unwrap_or_default();
    let version = extract_yaml_value(fm, "version").unwrap_or_else(|| "1.0.0".to_string());
    Some((name, description, version))
}

fn extract_yaml_value(fm: &str, key: &str) -> Option<String> {
    fm.lines().find_map(|line| {
        let line = line.trim();
        let prefix = format!("{}:", key);
        if let Some(stripped) = line.strip_prefix(&prefix) {
            let v = stripped
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use crate::group::task_board_repo::TaskBoardRepository;
    use crate::storage::task_repo::TaskRepository;

    #[test]
    fn seed_populates_from_workbuddy() {
        let tmp =
            std::env::temp_dir().join(format!("onedesktop_seed_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let db = Arc::new(DbConnection::open(&tmp).unwrap());

        seed_defaults(&db);
        let skills = SkillRepository::new(&db).find_all(()).unwrap();
        let mcps = McpServerRepository::new(&db).find_all(()).unwrap();
        assert!(!skills.is_empty(), "expected seeded skills");
        assert!(!mcps.is_empty(), "expected seeded MCP servers");
        assert!(
            mcps.iter().any(|m| m.id == "phabricator"),
            "phabricator MCP should be imported from WorkBuddy mcp.json"
        );

        
        let before = skills.len();
        seed_defaults(&db);
        let after = SkillRepository::new(&db).find_all(()).unwrap();
        assert_eq!(after.len(), before, "seed must be idempotent");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn seed_demo_tasks_populates_and_is_idempotent() {
        let tmp =
            std::env::temp_dir().join(format!("onedesktop_seed_tasks_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let db = Arc::new(DbConnection::open(&tmp).unwrap());

        
        seed_demo_tasks(&db);
        let tasks = TaskBoardRepository::new(&db).list_all().unwrap();
        assert!(
            tasks.iter().any(|t| t.id == "demo_kb_t_seo_1"),
            "expected demo kanban task"
        );
        let sched = TaskRepository::new(&db).find_all(()).unwrap();
        assert!(
            sched.iter().any(|s| s.id == "demo_st_daily"),
            "expected demo scheduled task"
        );
        
        let before = tasks.len();
        seed_demo_tasks(&db);
        let after = TaskBoardRepository::new(&db).list_all().unwrap();
        assert_eq!(after.len(), before, "seed_demo_tasks must be idempotent");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
