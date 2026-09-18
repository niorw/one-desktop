# 已知问题与待完善（Known Issues & Pending）

> 本文件记录 OneDesktop 中**待完善（to-be-improved）**的功能与**非理想 / 临时（hacky）**实现。
> 目的是让维护者一眼看清"哪些还没做、哪些是暂时绕过的"，避免在"能跑"的假象下踩坑。
> 凡标注为"临时 / 妥协"的项，皆为当前为赶进度或受架构约束而采用的方案，应择机偿还。

---

## 一、未完成功能（待完善）

### 1.1 看板任务 `outputs` 未接预览入口（#25）
- **现状**：`Task.outputs: string[]` 已存在（`src/types/index.ts:765`），数据通路就绪。
  `KanbanCard` 仅在页脚渲染一个计数徽标（`KanbanCard.tsx:72` `outN = task.outputs?.length ?? 0`，`:177` 渲染 `${outN} outputs`）。
- **待做**：把每条 `output` 路径渲染成可点击 chip，点击 `openPreview({ filePath })`（沿用 `chat/ProcessPanel` 与全局浏览器的同一套 `PreviewProvider` 入口）。
- **风险**：低。`Task.outputs` 仍是用户环境相关绝对路径，依赖 `artifact_read_*` 的动态 scope 校验（已含默认 + 用户自选 workspace 根），越界会被拒。

### 1.2 P2 媒体捕获：attachments 链路漏洞（治本未做）
- **现状**：圆桌消息落库时 `attachments` 硬编码为空（`src-tauri/src/group/roundtable.rs:383/1731/1847/1984`、`roundtable_repo.rs:360`、`commands/group.rs:966` 等均为 `attachments: vec![]`）。
  `AgentRunOutcome` 仅含 `final_text`，**工具写出的文件不会进附件**，导致预览侧看不到"工具产物"。
- **临时兜底**：读取侧有 `extract_media_from_content` + `merge_media` 从消息正文中正则抽取（能兜一部分）。
- **待做（治本）**：引擎侧在工具写盘时捕获产物路径，回填 `attachments`。`ImageRenderer` 已支持 `base64` 内嵌（`artifact_read_base64`），缺的是"写→读"闭环。
- **风险**：中。当前群产出物预览对"工具直接写出文件"覆盖不全，仅靠正文文本兜底。

### 1.3 真实后端运行时端到端验证（尚未做）
- **现状**：文件预览特性目前仅靠 `tsc --noEmit`、`cargo check`、`cargo test --lib`（artifact:: / storage:: / workspace::）验证，**从未以真实 App 启动跑过一次"模型写文件 → 点击预览"的端到端路径**。
- **待做**：启动 App，建 chat session 让模型写盘一个文件，验证：① chat chip 可点；② 全局"产出文件"浏览器列出该文件；③ 用户自选 workspace 内文件可预览（动态 scope）；④ 越界路径被拒。
- **风险**：低—中。逻辑已单测覆盖，但浏览器/渲染器在真机上的边界（大文件、二进制、非 UTF-8）未实测。

---

## 二、当前实现的临时 / 妥协面

### 2.1 `workspaces.path` 不做自动重定位（按设计取舍，非 bug）
- **背景**：库内 `workspaces.path` 在用户自选**外部目录**时为绝对路径（如 `/Users/旧账号/Documents/项目`）；默认工作区 `path = NULL`，运行时经 `paths` 动态解析（`data_dir()/workspaces`）。
- **取舍**：用户在"建表语句重组"时明确选择"仅版本化 + 去路径化"（Option A），**未**选"启动时按 home 变化自动 rebase"。
- **后果**：把 `~/.one-desktop/db/onedesktop.db` 整体迁移到另一台机器时，DB 文件位置可移植（基于 `dirs::home_dir()`），但**库内用户自选外部目录的绝对路径属环境相关**，需随对应文件夹一起搬移、或手动改库。
- **性质**：设计取舍，非临时。但若将来要"开箱即迁移"，需补一个 `home_rebase` 步骤（记录首次 home + 启动时对齐所有存储路径）。

### 2.2 迁移 backfill 留在 Rust 代码而非纯 SQL（被迫）
- **背景**：新版 `src-tauri/src/storage/migrations.rs` 的 `MIGRATIONS` 里，`0001` 之后那些**增量 `ALTER` 回填**（calendar v2/kind/notified_at、scheduled_tasks、runs 续跑列 + 索引、changeset、sessions.workspace_id、workspaces.path、模型默认值）无法实现成静态 `.sql`，因为它们依赖：
  - 运行时常量 `crate::defaults::DEFAULT_MODEL`（不能写死进 schema）；
  - `PRAGMA table_info` 守卫（列存在才 ALTER，保证幂等）。
- **说明**：理想迁移是"纯 SQL 文件 + 版本号"，但为兼顾幂等与默认值注入，这部分留在 Rust `up()` 闭包里。
- **代价**：`0001_init.sql` 是"一次性幂等大块"，不是逐表独立迁移；后续增量务必 additive（`0002_*.sql` / `0003_*.sql`），**绝不回头改 `0001_init.sql`**（additive 约定，对应 ADR-006）。

### 2.3 `assert_no_absolute_path` 守卫先剥离 `--` 注释再扫描（防御性妥协）
- **背景**：迁移系统带开发期守卫，扫描 SQL 命中 `/Users/`、`/home/`、`C:\`、`/Volumes/`、`/private/` 直接 panic，固化"schema 不得写死本地路径"不变量。
- **说明**：`0001_init.sql` 头部注释**本身就要举例说明"禁止这些路径字面量"**，若不先剥 `--` 注释会被自己的说明文字误报。故守卫在扫描前用正则去掉 `--` 行注释。
- **代价**：单行内联注释（`--` 同行后缀）也被剥掉，理论上可能漏掉"注释里藏路径"的真违规——但 schema 正文（非注释）仍被完整扫描，正文零路径是硬保证。

### 2.4 `artifact_read_*` 动态 scope 依赖运行期 `workspaces` 表查询
- **背景**：预览读取命令校验路径是否落在"默认 workspace 根 + 用户自选 workspace `path`"之内（见 `commands/artifact.rs::allowed_roots`）。
- **说明**：越界判断依赖运行期查库得到的 root 列表；若 `workspaces` 表为空或路径字段异常，会退化为"仅默认根"。非崩溃，但边界行为依赖数据完整性。
- **代价**：属可接受设计；仅记录以防将来误以为"scope 是纯配置项"。

---

## 三、已偿还 / 已固化
- 建表语句从 `connection.rs` 内联 920 行无版本 blob → 版本化 `migrations` 系统 + `user_version`（`src-tauri/migrations/0001_init.sql` + `src-tauri/src/storage/migrations.rs`）。已完成 `cargo check` 0 警告、`cargo test --lib storage::` 21/0 通过。
- 文件预览能力（动态 scope + base64 内嵌 + 全局浏览器 + chat/群入口）已提交 `4a8348d`。

---

*最后更新：2026-08-13（架构视角整理）*
