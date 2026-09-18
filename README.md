# OneDesktop

> 单机运行的 AI Agent 桌面工作台。Tauri 2 + React 18，无服务端、无账号体系，全部状态存于本机 SQLite。

[![Rust](https://img.shields.io/badge/Rust-2021-ed2024)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24c8db)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![Platform](https://img.shields.io/badge/Platform-macOS-lightgrey)](#平台支持)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

OneDesktop 把 LLM 从聊天窗口扩展为一个可编排的工作台：单个 Agent 走 ReAct 循环调用工具，
多个 Agent 组队通过圆桌讨论或任务看板协作，全过程可审计、可干预、可复现。
设计前提是**一台机器、一个人、多个 Agent** —— 因此没有账号、权限共享、跨端同步这类
只有在「有第二个人」时才成立的功能。

---

## 核心能力

### Agent 引擎
- ReAct 循环（`agent/engine/`），支持流式输出、中途引导（R-steer）、上下文自动压缩。
- 内置 10 个工具：`shell`、`filesystem`、`memory`、`automation`、`calendar`、`kanban`、`blackboard`、`group_assign`、`send_to_worker`、`weather`。
- 工具以 `ExecutableTool` 注册（`agent/tool_registry.rs`），可插拔扩展。
- 执行账本 `agent/ledger.rs` 记录每次工具调用的入参摘要与结果，支撑回放与审计。

### 多 Agent 协作
- **群组与席位**：`groups` 定义协作单元，`workers` 为席位，支持 Static 与 Capability 两类席位类型。
- **圆桌讨论**：多 Agent 轮次发言 + 结构化摘要（`roundtable_summaries`）、备选方案（`roundtable_alternatives`）。
- **WorkerPool 并行派发**：任务可并行下发到多个 worker，各自持有独立 session。
- **DAG 任务看板**：`tasks` 表承载任务拆解与依赖，Kanban 视图驱动状态流转。
- **拓扑路由**：`topology.rs` + `topology_policies` 决定消息在席位之间的流转路径。
- **Agent 画像与剧本**：`agents` 表存人格与能力描述，`playbooks` 存可复用的协作剧本，
  另附人格预设与职能预设。
- **共享黑板**：`blackboard` 表作为协作过程中的公共记忆。

### 权限与审批
- 工具权限为**三态** `Allow / Deny / Ask`，逐工具持久化于 `tool_permissions`。
- 工具按风险分级（Low / Medium / High），`run_shell`、`write_file`、`update_memory` 判为高风险。
- 高风险调用进入审批卡，决策为 `Accept` / `Edit`（改参数后放行）/ `Respond`（附反馈打回）/ `Ignore`。
- 无人值守场景 fail-closed：审批无人响应即挂起，不降级放行。
- `write_gate` 统一拦截内核写操作；敏感项（API Key 等）独立存于 `secrets` 表。

### 扩展
- **MCP**：管理 `stdio` / `sse` / `http` 三类 Server，通过 JSON-RPC 握手探测
  tools / resources / prompts 能力（`mcp/client.rs`）。
- **Skill**：来源 `local` / `url` / `builtin`，从 `SKILL.md` frontmatter 导入
  `name / description / version / dependencies`，带用量预算（`skill_budgets`）。
- **Agent Card**：`a2a/` 提供 Agent 能力描述模型。

### 自动化
- 调度类型 `cron`（5 段表达式）/ `once` / `interval`（`30m` / `2h` / `1d`）。
- 动作类型 `agent`（prompt）/ `shell`（command）/ `skill`（skill_id）。
- 引擎为 1 秒 `tokio` ticker，每跳从 DB 取活跃任务，无需内存缓存即可感知增删改；
  运行记录落库，进程重启自动恢复。

### 工作区与可观测
- `workspaces` 为一等实体，会话与记忆按工作区过滤；灵感库、自动化、看板跨区共享。
- 过程面板分层展示思考、工具调用与观察，与最终答案分离。
- `agent_trace` / `worker_metrics` / `session_events` 提供执行轨迹与统计。
- `changeset` 记录文件变更，产物可回溯到具体 run。
- 日历、灵感库、产物预览等辅助模块。

---

## 架构

```
UI (React)  ──invoke──▶  Commands（路由层，无业务逻辑）
                              │
                              ▼
                         Managers（业务编排）
                              │
                              ▼
              Repositories（Repository<Entity, CreatePayload, Query>）
                              │
                              ▼
                  SQLite（DbConnection: Mutex<Connection>）
```

| 层 | 职责 |
|---|---|
| `model` | 领域实体与 DTO，`to_dto()` 转可序列化结构 |
| `manager` | 业务编排（Agent / Group / MCP / Skill / Scheduler / Session） |
| `storage` | `Repository` trait 统一 `create / find_by_id / find_all / delete`，每聚合一个 repo |
| `commands` | Tauri command 纯路由 |
| `lib.rs` | 应用装配（迁移、managed state、调度器启动） |

### 内核纯净度

内核层 `agent` / `group` / `scheduler` **禁止直接依赖 Tauri 运行时**（`use tauri::`、
`<R: Runtime>`、`AppHandle<R>`），仅适配层 `agent/ports.rs` 允许，由 trait 注入事件与观察者。
该约束使内核可在无 GUI 环境下独立编译与测试，由 `scripts/check-kernel-purity.sh`
与 `pre-push` hook 强制守护。

### 模块

| 模块 | 目录 | 说明 |
|---|---|---|
| Agent | `src-tauri/src/agent/` | ReAct 引擎、工具注册、权限、审批、账本、压缩 |
| Group | `src-tauri/src/group/` | 群组、席位、圆桌、任务看板、拓扑、剧本 |
| MCP | `src-tauri/src/mcp/` | Server 模型、JSON-RPC 客户端、管理器 |
| Skill | `src-tauri/src/skill/` | 技能模型、导入、预算 |
| Scheduler | `src-tauri/src/scheduler/` | 调度模型、基于 DB 的 ticker 引擎 |
| Storage | `src-tauri/src/storage/` | 连接、迁移、各聚合 Repository、secrets |
| LLM | `src-tauri/src/llm/` | LLM 客户端与协议类型 |
| A2A | `src-tauri/src/a2a/` | Agent Card 与能力描述模型 |
| Commands | `src-tauri/src/commands/` | Tauri 命令层 |

---

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite |
| 后端 | Rust 2021 + Tauri 2 |
| LLM | `reqwest` 调用 OpenAI / DeepSeek 兼容 API |
| 存储 | SQLite（`rusqlite` bundled，WAL） |
| 调度 | `cron` + `tokio` |
| 日志 | `tracing` + `tracing-appender`（JSON 每日轮转） |

---

## 快速开始

### 平台支持

| 平台 | 状态 |
|---|---|
| **macOS** | 已支持 —— 当前开发与验证环境 |
| Windows / Linux | **未适配，未验证** |

窗口层使用 macOS 专属配置（交通灯重定位、窗口样式），且构建依赖含 macOS-only 的 cocoa 实现，
非 macOS 平台需先完成平台适配才能构建运行。以下步骤仅针对 macOS。

### 环境要求

Node.js ≥ 18、Rust 稳定版（含 `cargo`）；首次编译 Rust 依赖需联网。

```bash
git clone https://github.com/niorw/one-desktop.git
cd one-desktop
npm install
```

```bash
npm run tauri dev      # 开发模式，前端热更新于 http://localhost:1420
npm run tauri build    # 生产构建，产物在 src-tauri/target/release/bundle/
```

---

## 配置

在「设置」页配置 LLM Provider，写入本地 `settings` 表：

| 项 | 说明 |
|---|---|
| Provider | `openai` 或 `deepseek`（默认 `deepseek`） |
| Model | 默认 `deepseek-v4-pro` |
| API Key | 对应服务的密钥，落盘于 `~/.one-desktop/config.json` |
| 其他 | temperature、max_tokens、max_iterations、preamble |

---

## 数据存储

全部状态位于 `~/.one-desktop/`：

```
~/.one-desktop/
├── config.json        # 应用配置与 LLM 凭据（provider / model / api_key）
├── db/onedesktop.db   # SQLite 数据库（WAL）
├── memory/            # USER.md / MEMORY.md，Agent 长期记忆
├── logs/              # 每日轮转 JSON 日志
├── skills/            # 已安装技能，导入时复制为自包含目录
├── mcp/<server_id>/   # 各 MCP Server 运行时目录
├── cache/
└── tmp/               # 临时文件
```

31 张表，按域划分：

| 域 | 表 |
|---|---|
| 会话与消息 | `sessions` `messages` `message_log` `session_summaries` `session_events` |
| Agent 执行 | `agents` `runs` `run_steps` `agent_trace` `blackboard` |
| 群协作 | `groups` `workers` `playbooks` `topology_policies` `worker_metrics` |
| 圆桌 | `roundtable_messages` `roundtable_alternatives` `roundtable_summaries` |
| 任务与自动化 | `tasks` `scheduled_tasks` `calendar_events` |
| 技能与扩展 | `skills` `skill_budgets` `skill_budget_usage` `mcp_servers` |
| 治理 | `tool_permissions` `secrets` `changeset` |
| 其他 | `workspaces` `inspirations` `settings` |

`secrets` 按 `scope` 隔离存放 MCP Server 的环境变量密钥。消息在 Agent 循环中逐条落库，崩溃可恢复。

---

## 开发

```bash
npm run check          # 全量门禁：内核纯净度 + cargo check + tsc + CSS token
npm run check:kernel   # 内核纯净度（禁止内核层依赖 Tauri 运行时）
npm run test:rust      # cargo test --lib
npm run test:e2e       # Playwright E2E
```

规模：约 150 个 Tauri 命令、359 个 Rust 单元测试、16 个 E2E spec
（覆盖 a11y、错误契约、全链路、命令面板、看板日历等）。

### 内核纯净度守护

内核层不得直接依赖 Tauri 运行时，由以下工具强制：

- `scripts/check-kernel-purity.sh`：扫描 `agent` / `group` / `scheduler`，
  断言无 `use tauri::` 与 `<R: Runtime>` / `AppHandle<R>`（仅 `agent/ports.rs` 豁免）。
- `scripts/install-hooks.sh`：安装 git `pre-push` hook，推送前运行 `check:kernel`，
  违反则挂住推送。

```bash
bash scripts/install-hooks.sh
```

---

## 许可证

[MIT](LICENSE) © 2026 niorw
