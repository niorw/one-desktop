# 工作区文件夹联动 — 实现计划（PM + 技术方案）

> 发起：2026-08-12｜状态：待评审
> 范围：UI 修复（已完成）+ 打开文件夹关联工作区 + 工作区知识库初始化 + 会话联动 + 空间产品规划

---

## 一、需求拆解

| # | 需求 | 复杂度 | 状态 |
|---|---|---|---|
| 1 | 工作区弹窗图标与文字割裂 → 收紧间距 | 低 | ✅ 已完成（gap 8→6px） |
| 2 | 删除「远程连接」「不在项目中工作」两项 | 低 | ✅ 已完成 |
| 3 | 点击「打开文件夹」→ 原生目录选择 | 低 | 📋 计划中 |
| 4 | 选目录后自动创建工作区 + 初始化 `.one-desktop/` 项目知识库 | 中 | 📋 计划中 |
| 5 | 切换工作区后，会话自动加载该目录的记忆与规则 | 中 | 📋 计划中 |
| 6 | 工作空间功能/模块的产品规划 | — | 📋 本文档 |

---

## 二、技术架构

### 现状
- `workspaces` 表字段：`id, name, icon, created_at, updated_at`（**无 path**）
- 工作区是纯会话/灵感容器，**与文件系统完全解耦**
- 记忆注入已有工作区隔离能力：`read_memory_block(ws_id)` 读 `memory/workspaces/{ws_id}/PROJECT.md`

### 目标态
```
用户目录/
└─ my-project/                  ← 工作区 path
   └─ .one-desktop/             ← 一键初始化的项目知识库
      ├─ config.json            # 工作区元信息（id/name/path/created_at）
      ├─ rules.md               # 项目规则（注入系统提示）
      ├─ memory/
      │  └─ PROJECT.md          # 项目记忆（注入记忆块）
      └─ AGENTS.md              # 联动说明（指向 OneDesktop 约定）
```

---

## 三、实现步骤（建议 3 个提交）

### PR1 · 内核数据层 + 目录初始化（Rust）
- **迁移（ADDITIVE，符合 ADR-006）**：`workspaces` 表加 `path TEXT NULL`
- **新增命令 `create_workspace_with_path(name, path)`**
  - 写库（带 path）
  - 在 `path` 下创建 `.one-desktop/` 目录与子文件（模板见下）
  - 捕获 IO 错误（无写权限/只读）→ 仍创建工作区，仅跳过目录初始化，回传 warning
- **`WorkspaceDto` 增加 `path: Option<String>`** 回传
- **`pick_folder` 放前端**（见 PR2），内核不新增 Tauri dialog 依赖 → 符合「内核纯净度（硬）」约束（仅 `agent/ports.rs` 用 `use tauri::`）
- 模板文件内容：
  - `config.json` → `{ "id": "<uuid>", "name": "...", "path": "...", "created_at": "..." }`
  - `rules.md` → 项目规则占位（约定 AI 行为边界，如「不修改 .env」「改动前先读 README」）
  - `memory/PROJECT.md` → 项目背景占位（技术栈/约定/常见坑）
  - `AGENTS.md` → 一行业务说明，指向 OneDesktop 工作区约定

### PR2 · 前端联动（React/TS）
- `services/workspace.ts`
  - 接口加 `path?: string`
  - 加 `pickFolder(): Promise<string | null>` → `@tauri-apps/api/dialog` 的 `open({ directory: true, multiple: false })`
  - 加 `createWorkspaceWithPath(name, path)` 封装
- `InputBar.handleOpenFolder`
  ```
  1. dir = await pickFolder()          // 取消 → 直接 return
  2. name = basename(dir)              // 目录名作默认工作区名
  3. ws = await createWorkspaceWithPath(name, dir)
  4. onWorkspaceChange(ws.id)          // 切换当前工作区
  5. 刷新 workspaces 列表
  6. toast:「已创建「name」工作区，并初始化 .one-desktop 项目知识库」
  ```
- 下拉项保留「打开文件夹」（已删除远程连接/不在项目中工作）

### PR3 · 会话引擎联动（Rust 引擎）
- 会话启动时，读取当前 `workspace.path`
- 若目录存在：
  - `rules.md` → 注入系统提示 / 约束段
  - `memory/PROJECT.md` → 复用 `read_memory_block` 工作区隔离逻辑注入记忆
- 无 path 的旧工作区 / 默认工作区 → 走现有逻辑，零回归

---

## 四、验证
- `npm run check:ts` + `cargo check --kernel`（内核纯净度门禁）
- E2E：打开文件夹 → 目录出现 `.one-desktop/` → 切换工作区后会话注入项目记忆
- 边界：取消选择、重复目录（已存在 `.one-desktop` 则复用不覆盖）、只读目录（降级不崩）

## 五、已知限制
- 内核无 session 级 context token 查询（环形控件前文已标注为前端估算）
- `.one-desktop` 初始化为模板，后续可由 AI 自动丰富（rules/memory 的自动沉淀是进阶方向）

---

## 六、产品经理视角：工作空间功能与模块规划

### 6.1 定位
工作空间 = **「项目级 AI 上下文隔离 + 持久化记忆」的一等实体**。它把散落的会话、记忆、规则、灵感收敛到一个真实代码目录上，让 AI 真正「懂这个项目」。

### 6.2 模块分层

**L1 · 容器层（已具备）**
- 工作区 CRUD、切换、会话/灵感归属、默认工作区兜底
- 侧栏 `WorkspaceTree` + 顶栏 `WorkspacePills`

**L2 · 知识层（本次建设）**
- `.one-desktop/` 项目知识库：rules（规则）、memory（记忆）、config（元信息）
- AI 自动沉淀：会话结束自动把「关键决策/约定/坑」写入 `memory/PROJECT.md`
- 规则生效：会话注入系统约束

**L3 · 资产层（进阶）**
- 灵感库（inspirations）按工作区隔离
- 变更集（changeset）按工作区归集
- 任务/看板与项目目录绑定（由 `.one-desktop` 描述）

**L4 · 协作层（愿景，单机约束下降级为本地多角色）**
- 同一目录可被多 Agent 角色（规划/执行/审查）共享上下文
- 本地 git 联动：rules 变更提 PR、记忆随分支走

### 6.3 关键交互流
1. **冷启动**：默认工作区 → 通用记忆兜底
2. **接手项目**：打开文件夹 → 一键建工作区 + 知识库 → 立即获得项目上下文
3. **日常沉淀**：每次会话 AI 自动维护 `rules.md`/`PROJECT.md`，越用越懂
4. **跨项目隔离**：切换工作区 = 切换整段上下文，互不污染

### 6.4 与现有约束的对齐
- **单机第一性**：无账号/服务端，`.one-desktop` 直接落用户目录，零同步负担
- **内核纯净度**：目录初始化走 Rust std::fs，dialog 走前端 → 内核零新增 Tauri 依赖
- **ADDITIVE 迁移**：`path` 字段可空，旧数据/无目录工作区全部兼容

### 6.5 风险与对策
| 风险 | 对策 |
|---|---|
| 误删项目目录 | `.one-desktop` 仅追加模板，不碰用户代码 |
| 记忆污染 | 工作区严格隔离，切换即换上下文 |
| 只读/无权限目录 | 降级创建工作区、跳过目录初始化 |
| 巨型仓库记忆膨胀 | 记忆蒸馏（30 天滚动）+ 摘要上限 |
