# OneDesktop

> 基于 Tauri 2 的本地 AI Agent 桌面应用 —— 多轮对话、工具执行、MCP 服务接入、技能管理与定时任务，全部本地运行、SQLite 持久化。

[![Rust](https://img.shields.io/badge/Rust-2021-ed2024)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24c8db)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## ✨ 功能特性

- **多轮对话**：基于 React 18 的 Markdown 渲染对话界面，支持流式输出、思考过程折叠展示、工具调用过程面板。
- **工具系统**：内置 Shell 执行、记忆读写等工具，Agent 以 ReAct 循环自主调用（可插拔 `ExecutableTool`）。
- **MCP 接入**：管理 stdio / sse / http 类型的 MCP Server，通过 JSON-RPC 握手探测能力（tools / resources / prompts）。
- **技能管理**：管理 local / url / builtin 来源技能，支持从 `SKILL.md` frontmatter 导入。
- **定时任务**：以 cron / once / interval 三种调度方式驱动 Agent / Shell / Skill 动作，调度器基于 SQLite 周期性轮询，进程重启可自恢复。
- **会话持久化**：会话、消息、设置全部存入 SQLite，崩溃可恢复。
- **本地优先**：不依赖云端即可工作，数据存于本地应用目录。

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite |
| 后端 | Rust + Tauri 2 |
| LLM | 通过 `reqwest` 调用 OpenAI / DeepSeek 兼容 API（默认 DeepSeek `deepseek-chat`） |
| 存储 | SQLite（`rusqlite` bundled，WAL 模式） |
| 调度 | `cron = "0.12"` + `tokio` 异步运行时 |
| 日志 | `tracing` + `tracing-appender`（JSON 文件每日轮转 + stderr） |

---

## 🏗️ 架构概览

后端采用分层架构，保持高模块化与可扩展性：

```
UI (React)  ──invoke──▶  Commands (薄路由层)
                              │
                              ▼
                         Managers (业务逻辑)
                              │
                              ▼
              Repositories (Repository<Entity, CreatePayload, Query>)
                              │
                              ▼
                  SQLite (DbConnection: Mutex<Connection>)
```

- **model**：领域实体与 DTO（`to_dto()` 转换为可序列化结构）。
- **manager**：业务编排（MCP / Skill / Scheduler / Session / Agent）。
- **storage**：`Repository` trait 统一 `create / find_by_id / find_all / delete`，每个聚合一个 repo。
- **commands**：Tauri command 纯路由，不含业务逻辑。
- **lib.rs**：应用装配（migrations、managed state、调度器启动）。

### 模块一览

| 模块 | 目录 | 说明 |
|---|---|---|
| Agent | `src-tauri/src/agent/` | ReAct 循环引擎、工具注册、记忆工具 |
| MCP | `src-tauri/src/mcp/` | Server 模型、JSON-RPC 握手客户端、管理器 |
| Skill | `src-tauri/src/skill/` | 技能模型、本地/URL 导入、管理器 |
| Scheduler | `src-tauri/src/scheduler/` | 调度模型、基于 DB 的 ticker 引擎 |
| Storage | `src-tauri/src/storage/` | 连接管理、各聚合 Repository、迁移 |
| Commands | `src-tauri/src/commands/` | Tauri 命令层 |

---

## 📁 目录结构

```
onedesktop/
├── src/                      # React 前端
│   ├── App.tsx               # 主布局（Sidebar + ChatArea）
│   ├── App.css               # Apple HIG 设计令牌 + 全局样式
│   ├── types/index.ts        # TS 类型定义
│   ├── hooks/                # useAgent / useScheduledTasks / useTheme / agentState ...
│   ├── services/             # tauri.ts (invoke 封装) / eventBus.ts (事件订阅)
│   ├── i18n/                 # 国际化 Provider + 字典
│   └── components/
│       ├── chat/             # ChatArea / MessageList / ThinkingBlock / ProcessPanel / TurnGroup / InputBar
│       ├── layout/           # Sidebar / TopBar
│       ├── extensibility/    # MCP / Skill 扩展管理页
│       ├── tasks/            # 定时任务页 + 新建任务弹窗
│       ├── settings/         # 设置页
│       └── common/           # Icons 等公共组件
├── src-tauri/                # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── lib.rs            # 应用装配入口
│       ├── error.rs          # 统一错误类型
│       ├── types.rs          # DTO 定义
│       ├── agent/  mcp/  skill/  scheduler/
│       ├── storage/          # connection / *repo / repository trait
│       ├── commands/         # agent / extensibility / scheduler
│       ├── llm/              # LLM 客户端与类型
│       └── session/          # 会话管理
└── docs/                     # 设计系统文档
```

---

## 🚀 快速开始

### 环境要求

- **Node.js** ≥ 18
- **Rust** 稳定版（含 `cargo`）
- **操作系统**：macOS / Linux / Windows（Tauri 2 支持）
- 首次编译 Rust 依赖需联网（如处于内网，可设置代理：`export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890`）

### 克隆与安装依赖

```bash
git clone https://github.com/niorw/one-desktop.git
cd one-desktop
npm install
```

### 开发模式（热更新）

```bash
npm run tauri dev
```

前端 dev server 运行于 `http://localhost:1420`，Rust 后端增量编译并启动桌面窗口。

> 重启提示：重新编译前请确保端口 `1420` 上的旧 vite 进程已退出，否则会因 `EADDRINUSE` 导致 `beforeDevCommand` 失败。

### 生产构建

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`。

---

## ⚙️ 配置

应用通过「设置」页配置 LLM Provider：

- **Provider**：`openai` 或 `deepseek`（默认 `deepseek`）
- **Model**：如 `deepseek-chat`
- **API Key**：调用对应服务所需的密钥
- 其余参数：temperature、max_tokens、max_iterations、preamble 等

配置持久化于本地 SQLite 的 `settings` 表。

---

## 🔌 核心模块说明

### MCP（模型上下文协议）

- 支持 `stdio`（启动子进程，行分隔 JSON-RPC 握手）、`sse`、`http` 三种传输。
- `McpClient::test` 对 sse/http 做 HTTP 连通性探测，对 stdio 执行真实 `initialize → notifications/initialized → tools/list` 握手，reader 线程带超时看门狗，避免坏服务阻塞。
- 能力（tools / resources / prompts）与错误信息写回 `mcp_servers` 表。

### Skill（技能）

- 来源：`local`（本地路径，解析 `SKILL.md` frontmatter）、`url`、`builtin`。
- 状态：enabled / disabled / beta / deprecated / error。
- 导入本地技能会读取 `SKILL.md` 的 `name / description / version / dependencies` 等元信息。

### Scheduler（定时任务）

- 调度类型：`cron`（标准 5 段表达式）、`once`（指定时间单次）、`interval`（如 `30m` / `2h` / `1d`）。
- 动作类型：`agent`（prompt）、`shell`（command）、`skill`（skill_id）。
- 引擎：1 秒 `tokio` ticker，每跳从 DB 拉取活跃任务并触发到期项，无需内存缓存同步即可感知增删改；`run_agent` 复用 `AgentLoopEngine::run` 并新建会话。
- 运行记录（last_run / next_run / run_count）落库，前端通过 `scheduled_task_event` 事件实时更新。

---

## 💾 数据持久化

所有配置、技能、MCP、日志与临时文件统一存放在用户主目录下的隐藏目录 **`~/.one-desktop/`**（类似 Hermes、opencode 等本地 Agent 的约定），结构如下：

```
~/.one-desktop/
├── config.json        # 应用配置（provider / api_key / model 等敏感项）
├── db/onedesktop.db  # SQLite 数据库
├── memory/            # USER.md / MEMORY.md（Agent 长期记忆，可写）
├── logs/              # 每日轮转的 JSON 日志
├── skills/            # 已安装技能（导入时复制进来，自包含）
│   ├── local/<id>/
│   ├── url/<id>/
│   └── builtin/<id>/
├── mcp/<server_id>/  # 各 MCP 服务器的运行时目录
├── cache/            # 通用缓存
└── tmp/              # 临时文件（替代系统 /tmp）
```

- 数据库文件：`~/.one-desktop/db/onedesktop.db`。
- 表：`sessions`、`messages`、`settings`、`mcp_servers`、`skills`、`scheduled_tasks`。
- 每条消息在 Agent 循环中逐条保存，崩溃可恢复。

---

## 📊 构建状态

- **Rust**：`cargo check` 通过，零错误零警告。
- **前端**：`tsc --noEmit` 通过，零错误。
- **内核纯净度**：`npm run check:kernel` 通过——内核层（`agent`/`group`/`scheduler`）禁止直接 `use tauri::` 或 Tauri 运行时泛型 `<R: Runtime>` / `AppHandle<R>`，仅适配层 `agent/ports.rs`（`TauriObserver` / `TauriEventBus`）允许。
- **测试**：`cargo test --lib` 与 Playwright E2E 均通过；一键门禁 `npm run check`（`check:kernel` + `check:rust` + `check:ts`）。

---

## 📝 许可证

[MIT](LICENSE) © 2026 niorw

---

## 🤝 贡献

欢迎提交 Issue 与 PR。提交前请确保 `npm run check`（`check:kernel` + `check:rust` + `check:ts`）均通过。

### 内核纯净度守护（T2 去 Tauri 化）

内核层不得直接依赖 Tauri 运行时。以下工具守护这一约束：

- `scripts/check-kernel-purity.sh`：扫描 `agent`/`group`/`scheduler`，断言内核无 `use tauri::` 与 `<R: Runtime>` / `AppHandle<R>`（仅 `agent/ports.rs` 豁免）。
- `scripts/install-hooks.sh`：一键安装 git `pre-push` hook，每次 `git push` 前跑 `npm run check:kernel`，违反则挂住推送，防止去 Tauri 化成果回潮。

运行 `bash scripts/install-hooks.sh` 即可启用（仅本机生效，不入库）。
