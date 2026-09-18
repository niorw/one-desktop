-- OneDesktop 数据库初始化迁移（版本 1）。
--
-- 本文件由 src-tauri-shortcut 的 run_migrations 原始内联 DDL 抽出，SQL 语义与原实现
-- 完全一致（CREATE TABLE IF NOT EXISTS + 幂等种子），向后兼容既有库（user_version 0 -> 1）。
--
-- 不变量（PORTABILITY INVARIANT）：
--   迁移 SQL 不得包含任何绝对本地路径（/Users/、/home/、C:\、/Volumes/）。
--   所有路径相关的根目录必须在运行时经 crate::paths 解析，绝不可写死进 schema 或种子数据。
--   库内「运行期数据」的路径（workspaces.path、tasks.outputs 等）属用户环境变量，
--   迁移到其他环境时按设计需随对应文件夹一起搬移（见 docs/design/db-migrations.md）。
--
-- 后续增量变更：新增 0002_*.sql / 0003_*.sql，绝不再修改本文件。

-- ── 1. 会话与消息：sessions / messages / session_summaries / settings ──
CREATE TABLE IF NOT EXISTS sessions (
                    id          TEXT PRIMARY KEY,
                    title       TEXT NOT NULL DEFAULT 'New Session',
                    model       TEXT NOT NULL DEFAULT 'gpt-4o',
                    preamble    TEXT NOT NULL DEFAULT '',
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    role        TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    tool_name   TEXT,
                    tool_args   TEXT,
                    tool_result TEXT,
                    token_usage INTEGER NOT NULL DEFAULT 0,
                    reasoning_content TEXT DEFAULT '',
                    created_at  TEXT NOT NULL,
                    -- G1/G2 思考可视化：call_id 让 tool_call 与 tool_result 重启后仍可精确配对；
                    -- item_kind 固化「这行是什么」（user/assistant/tool），回放不再靠前端启发式猜。
                    -- seq 不落列——读取时用 ROW_NUMBER() 派生，避免写侧再维护一个易漂移的计数器。
                    call_id     TEXT,
                    item_kind   TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_messages_session
                    ON messages(session_id, created_at);

                CREATE TABLE IF NOT EXISTS session_summaries (
                    session_id  TEXT PRIMARY KEY,
                    summary     TEXT NOT NULL,
                    msg_count   INTEGER NOT NULL DEFAULT 0,
                    created_at  TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                INSERT OR IGNORE INTO settings (key, value)
                VALUES ('provider', 'deepseek'),
                       ('preamble', 'You are an AI agent with reasoning capabilities.\n\n1. Think step by step inside <thinking> tags when useful.\n2. Use tools via <action>{\"tool\":\"name\",\"params\":{}}</action>.\n3. Answer in clean Markdown. Tables must use proper GFM syntax with each row on its own line and a separator line (e.g., |---|). Do not put an entire table on one line.\n\nTools: read_file, write_file, list_dir, run_shell.'),
                       ('temperature', '0.7'),
                       ('max_tokens', '0'),
                       ('max_iterations', '20'),
                        ('token_budget', '100000');

-- ── 2. 平台配置：mcp_servers / skills / scheduled_tasks ──
CREATE TABLE IF NOT EXISTS mcp_servers (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    transport   TEXT NOT NULL DEFAULT 'stdio',
                    command     TEXT,
                    args        TEXT NOT NULL DEFAULT '[]',
                    env         TEXT NOT NULL DEFAULT '{}',
                    url         TEXT,
                    enabled     INTEGER NOT NULL DEFAULT 0,
                    status      TEXT NOT NULL DEFAULT 'disabled',
                    capabilities TEXT NOT NULL DEFAULT '{}',
                    error       TEXT,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS skills (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    version     TEXT NOT NULL DEFAULT '1.0.0',
                    source      TEXT NOT NULL DEFAULT 'local',
                    path        TEXT,
                    url         TEXT,
                    status      TEXT NOT NULL DEFAULT 'enabled',
                    dependencies TEXT NOT NULL DEFAULT '[]',
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS scheduled_tasks (
                    id          TEXT PRIMARY KEY,
                    title       TEXT NOT NULL,
                    description TEXT,
                    type        TEXT NOT NULL DEFAULT 'cron',
                    schedule    TEXT NOT NULL DEFAULT '',
                    action_type TEXT NOT NULL DEFAULT 'agent',
                    action_payload TEXT NOT NULL DEFAULT '{}',
                    source      TEXT NOT NULL DEFAULT 'agent_dialog',
                    status      TEXT NOT NULL DEFAULT 'active',
                    last_run_at TEXT,
                    next_run_at TEXT,
                    run_count   INTEGER NOT NULL DEFAULT 0,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                );

-- ── 3. 群协作：agents / groups / workers / tasks ──
CREATE TABLE IF NOT EXISTS agents (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    model       TEXT NOT NULL,
                    system_prompt TEXT NOT NULL,
                    capabilities TEXT NOT NULL DEFAULT '[]',
                    skills      TEXT NOT NULL DEFAULT '[]',
                    mcp         TEXT NOT NULL DEFAULT '[]',
                    tools       TEXT NOT NULL DEFAULT '[]',
                    created_at  INTEGER NOT NULL,
                    token_budget INTEGER NOT NULL DEFAULT 100000,
                    provider    TEXT NOT NULL DEFAULT 'deepseek',
                    executor    TEXT,
                    disallowed_tools TEXT NOT NULL DEFAULT '[]',
                    permission_mode TEXT NOT NULL DEFAULT 'default',
                    max_turns   INTEGER NOT NULL DEFAULT 0,
                    isolation   TEXT NOT NULL DEFAULT 'none'
                );

                CREATE TABLE IF NOT EXISTS groups (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    goal        TEXT NOT NULL,
                    owner_agent_ref TEXT NOT NULL,
                    status      TEXT NOT NULL DEFAULT '\"Active\"',
                    seat_config TEXT NOT NULL DEFAULT '{}',
                    created_at  INTEGER NOT NULL,
                    kind        TEXT NOT NULL DEFAULT '\"Chat\"'
                );

                CREATE TABLE IF NOT EXISTS workers (
                    id          TEXT PRIMARY KEY,
                    group_id    TEXT NOT NULL,
                    agent_ref   TEXT NOT NULL,
                    seat_type   TEXT NOT NULL,
                    status      TEXT NOT NULL DEFAULT '\"Idle\"',
                    max_concurrency INTEGER NOT NULL DEFAULT 1,
                    capabilities TEXT NOT NULL DEFAULT '[]',
                    current_task_id TEXT,
                    last_heartbeat INTEGER
                );

                CREATE TABLE IF NOT EXISTS tasks (
                    id          TEXT PRIMARY KEY,
                    group_id    TEXT NOT NULL,
                    batch_id    TEXT,
                    worker_id   TEXT,
                    description TEXT NOT NULL,
                    depends_on  TEXT NOT NULL DEFAULT '[]',
                    input_refs  TEXT NOT NULL DEFAULT '[]',
                    output_spec TEXT,
                    status      TEXT NOT NULL DEFAULT '\"Pending\"',
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    assigned_worker TEXT,
                    outputs     TEXT NOT NULL DEFAULT '[]',
                    reasoning   TEXT,
                    capability  TEXT,
                    last_heartbeat INTEGER
                );

-- ── 4. 圆桌：roundtable_messages / summaries / alternatives ──
                CREATE TABLE IF NOT EXISTS roundtable_messages (
                    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id    TEXT NOT NULL,
                    author      TEXT NOT NULL,
                    author_kind TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    mentions    TEXT NOT NULL DEFAULT '[]',
                    attachments TEXT NOT NULL DEFAULT '[]',
                    created_at  INTEGER NOT NULL,
                    session_id  TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS roundtable_summaries (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id        TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    source_seq_start INTEGER NOT NULL DEFAULT 0,
                    source_seq_end   INTEGER NOT NULL DEFAULT 0,
                    message_count    INTEGER NOT NULL DEFAULT 0,
                    created_at      INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS roundtable_alternatives (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id    TEXT NOT NULL,
                    trigger_seq INTEGER NOT NULL,
                    worker_id   TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    created_at  INTEGER NOT NULL
                );

-- ── 5. 拓扑 / 预算 / 指标 / 权限 / 密钥 ──
                CREATE TABLE IF NOT EXISTS topology_policies (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id    TEXT NOT NULL,
                    version     INTEGER NOT NULL,
                    policy_json TEXT NOT NULL,
                    created_at  INTEGER NOT NULL,
                    UNIQUE(group_id, version)
                );
                CREATE INDEX IF NOT EXISTS idx_topo_group_ver
                    ON topology_policies(group_id, version DESC);

                -- F8 预算护栏（ADR-018）：skill 预算上限 + 每 (run, skill) 累计用量。additive。
                CREATE TABLE IF NOT EXISTS skill_budgets (
                    skill_id           TEXT PRIMARY KEY,
                    token_limit        INTEGER,
                    cost_cents_limit   INTEGER,
                    time_secs_limit    INTEGER,
                    version            INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS skill_budget_usage (
                    run_id     TEXT NOT NULL,
                    skill_id   TEXT NOT NULL,
                    tokens     INTEGER NOT NULL DEFAULT 0,
                    cost_cents INTEGER NOT NULL DEFAULT 0,
                    elapsed_ms INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (run_id, skill_id)
                );

                CREATE TABLE IF NOT EXISTS worker_metrics (
                    worker_id          TEXT PRIMARY KEY,
                    group_id           TEXT NOT NULL,
                    total_tokens       INTEGER NOT NULL DEFAULT 0,
                    total_duration_ms  INTEGER NOT NULL DEFAULT 0,
                    runs               INTEGER NOT NULL DEFAULT 0,
                    last_msg_count      INTEGER NOT NULL DEFAULT 0,
                    last_context_tokens INTEGER NOT NULL DEFAULT 0,
                    last_total_tokens   INTEGER NOT NULL DEFAULT 0,
                    updated_at          INTEGER NOT NULL,
                    trace_id            TEXT
                );

                CREATE TABLE IF NOT EXISTS tool_permissions (
                    tool_name TEXT NOT NULL,
                    scope     TEXT NOT NULL DEFAULT 'all',
                    action    TEXT NOT NULL DEFAULT 'ask',
                    PRIMARY KEY (tool_name, scope)
                );

                CREATE TABLE IF NOT EXISTS secrets (
                    id          TEXT PRIMARY KEY,
                    scope       TEXT NOT NULL,
                    key         TEXT NOT NULL,
                    value       TEXT NOT NULL,
                    created_at  TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS playbooks (
                    id               TEXT PRIMARY KEY,
                    name             TEXT NOT NULL,
                    steps            TEXT NOT NULL DEFAULT '[]',
                    success_criteria TEXT,
                    guardrails       TEXT,
                    source_run_id    TEXT,
                    created_at       TEXT NOT NULL,
                    updated_at       TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS changeset (
                    id          TEXT PRIMARY KEY,
                    file        TEXT NOT NULL,
                    holder      TEXT NOT NULL,
                    run_id      TEXT,
                    before_hash TEXT,
                    after_hash  TEXT NOT NULL,
                    before_content TEXT,
                    created_at  TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_changeset_file ON changeset(file);

-- ── 6. 执行实例：runs / run_steps / blackboard / message_log ──
CREATE TABLE IF NOT EXISTS runs (
                    id            TEXT PRIMARY KEY,
                    session_id    TEXT NOT NULL,
                    group_id      TEXT,
                    seat_id       TEXT,
                    kind          TEXT NOT NULL,
                    started_at    INTEGER NOT NULL,
                    ended_at      INTEGER,
                    status        TEXT NOT NULL DEFAULT 'running',
                    model         TEXT,
                    prompt_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    iterations    INTEGER NOT NULL DEFAULT 0,
                    error_kind    TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_runs_group   ON runs(group_id, started_at DESC);

                CREATE TABLE IF NOT EXISTS run_steps (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    seq           INTEGER NOT NULL,
                    kind          TEXT NOT NULL,
                    name          TEXT,
                    origin        TEXT,
                    args_digest   TEXT,
                    outcome       TEXT NOT NULL,
                    unavailable_reason TEXT,
                    approval_source   TEXT,
                    approval_decision TEXT,
                    duration_ms   INTEGER,
                    started_at    INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id, seq);

CREATE TABLE IF NOT EXISTS blackboard (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id  TEXT NOT NULL,
                    key         TEXT NOT NULL,
                    value       TEXT NOT NULL,
                    version     INTEGER NOT NULL DEFAULT 1,
                    created_at  INTEGER NOT NULL,
                    updated_at  INTEGER NOT NULL,
                    UNIQUE(session_id, key)
                );
                CREATE INDEX IF NOT EXISTS idx_blackboard_session
                    ON blackboard(session_id, key);

CREATE TABLE IF NOT EXISTS message_log (
                    id           TEXT PRIMARY KEY,
                    from_session TEXT NOT NULL,
                    to_session   TEXT NOT NULL,
                    kind         TEXT NOT NULL,
                    body_path    TEXT NOT NULL,
                    delivered    INTEGER NOT NULL DEFAULT 0,
                    created_at   INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_message_log_recipient
                    ON message_log(to_session, delivered, created_at);

CREATE TABLE IF NOT EXISTS calendar_events (
                    id          TEXT PRIMARY KEY,
                    date_key    TEXT NOT NULL,
                    title       TEXT NOT NULL DEFAULT '',
                    content     TEXT NOT NULL DEFAULT '',
                    time_start  TEXT,
                    time_end    TEXT,
                    color       TEXT NOT NULL DEFAULT '#0a84ff',
                    kind        TEXT NOT NULL DEFAULT 'schedule',
                    created_at  INTEGER NOT NULL,
                    updated_at  INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_calendar_events_date
                    ON calendar_events(date_key);

CREATE TABLE IF NOT EXISTS agent_trace (
                    id          INTEGER PRIMARY KEY,
                    session_id  TEXT NOT NULL,
                    scene       TEXT NOT NULL DEFAULT 'chat',
                    agent_type  TEXT,
                    kind        TEXT NOT NULL,
                    name        TEXT,
                    seq         INTEGER NOT NULL DEFAULT 0,
                    call_id     TEXT,
                    parent_id   INTEGER,
                    content     TEXT,
                    args        TEXT,
                    result      TEXT,
                    reasoning   TEXT,
                    is_error    INTEGER,
                    started_at  INTEGER,
                    ended_at    INTEGER,
                    created_at  TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_trace_session ON agent_trace(session_id, id);
                CREATE INDEX IF NOT EXISTS idx_trace_call ON agent_trace(call_id, kind);

-- ── 7. 工作区与灵感：workspaces / inspirations ──
CREATE TABLE IF NOT EXISTS workspaces (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    icon        TEXT NOT NULL DEFAULT '',
                    path        TEXT,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                );
                INSERT OR IGNORE INTO workspaces (id, name, icon, created_at, updated_at)
                VALUES ('default', '默认工作区', '', datetime('now'), datetime('now'));
                -- additive：兼容旧库中「未命名项目」/「任务」等旧名，统一为「默认工作区」
                UPDATE workspaces SET name = '默认工作区' WHERE id = 'default' AND name IN ('未命名项目', '任务', '默认空间');

                CREATE TABLE IF NOT EXISTS inspirations (
                    id           TEXT PRIMARY KEY,
                    workspace_id TEXT,
                    content      TEXT NOT NULL,
                    tags         TEXT NOT NULL DEFAULT '[]',
                    created_at   INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_inspirations_workspace
                    ON inspirations(workspace_id, created_at);
