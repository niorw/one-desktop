# OneDesktop 中断任务的「产物 / 变更 / Diff 审阅」架构设计（ADR-021 草案）

> 定位：**单机个人办公助手**（1 人 × N Agent，非多租户 / 非服务端 / 非分布式）。
> 状态：Proposed（待用户拍板后转 Accepted）。
> 竞品锚点：本稿每个关键决策均标注竞品出处（Cursor / Grok Build / 扣子编程 / SuperBuilder / Cloudflare Artifacts / Gumloop / WorkBuddy），**不凭空发明方案**。
> 代码事实均已回源核对（`file:line` 标注）。

---

## 1. 概念与边界（先读这节）

- **产物（Product / Artifact）** = 该 run **新建**的文件（`before_content IS NULL`）。对应 Gumloop/WorkBuddy 的 artifact 语义：agent 生成的文件（报告、HTML、图片、代码等）。
- **变更（Change）** = 该 run **修改**的既有文件（`before_content` 非 NULL）。
- **版本（Version）** = 同一文件被同一 run（或后续 run）多次写入时，每次写盘形成的快照序列。`changeset` 表天然 append-only，**按 `(run_id, file)` 分组即版本历史**，零额外存储（参照 Gumloop 同文件名自动版本化 v1/v2/v3）。
- **回滚（Rollback）** = 把文件恢复到某条变更的 `before_content`（新建文件则删除）。
- **边界**：本稿只做「中断任务（单 run）视图」的产物/变更审阅，复用 IX-10 群级 `changeset` 底座；**不改 `group_changesets` 群视图**；**不引入 git 依赖**（单机产品，工作区未必是 git 仓库；git 底座列为后续演进 §13）。

三层正交：`changeset`（写入事实）⟂ `runs`（执行实例）⟂ 视图（群级 / run 级）。本稿只新增 run 级视图 + 数据增强，不碰编排层。

## 2. 现状事实（缺口依据，均已回源）

- `changeset` 表（`storage/changeset_sqlite.rs:133` INSERT 列）：`id, file, holder, run_id, before_hash, after_hash, before_content, created_at`——**只存 before（改动前），无 after（改动后）**，无法算 diff。
- `ChangesetRecorder::record` trait（`agent/write_gate.rs:19-31`）：**6 个裸参数**，加字段需改签名。
- `WriteGate::commit_write`（`write_gate.rs:76-84`）：`after_hash` 已由调用方传入——**调用方在写盘那一刻知道写了什么**，after_content 应同源传入，而非读磁盘（Cloudflare Artifacts"写入内容即快照"思想）。
- `rollback`（`changeset_sqlite.rs:54-90`）：**无条件写回 before_content**。两条 run 先后改同一文件 → 回滚前一条会静默覆盖后一条的修改（**数据丢失竞态**，见 §7.2 配图）。
- `list_for_run(run_id)`（`changeset_sqlite.rs:23-35`）已实现，**未暴露给前端**。
- 前端 `ChangesetPanel.tsx` 已实现群级变更展示（新建/修改分类 + 回滚），**无 diff**。
- 迁移先例：「PRAGMA table_info → ALTER TABLE ADD COLUMN」幂等模式（`storage/connection.rs:674-716` 同款）→ 复用，不新造。

## 3. 目标与非目标

**目标**：
1. 中断任务视图内，每条 run 可查看该次运行的**产物（新建）与变更（修改）**；
2. 每条变更/产物可展开**行级 diff**（red/green，参照 Cursor）与**变更摘要**（+N/~M/-K，参照 Grok Build）；
3. 产物按**文件卡片 + 内联预览**呈现（参照 Gumloop），支持查看**版本历史**；
4. 回滚升级为**存档式回滚**（参照扣子编程 Auto commit）：不丢任何已存在的修改。

**非目标**：逐 hunk 接受/拒绝（Cursor 是写入前审批，我们是写入后审阅，无需）、git 集成、跨 run 汇总视图、产物分享/导出。

## 4. 竞品调研锚点（决策出处）

| 竞品 | 关键机制 | 本稿采纳点 |
|---|---|---|
| Cursor | IDE 内行级 red/green diff、逐 hunk 接受/拒绝 | 仅采纳**行级 diff 展示形态**；hunk 审批裁剪（事后审阅场景） |
| Grok Build | `grok diff --summary` 语义化摘要（新增/修改/影响面） | diff 上方摘要行 `+N / ~M / -K` |
| 扣子编程 | 版本自动存档 + **回滚前 Auto commit**（未提交改动先存档再回滚） | §7.2 存档式回滚（推翻"校验拒绝"方案） |
| SuperBuilder | per-turn git diff、可视化文件追踪 | 痛点确认：AI 会话 diff 必须**按 run 分组**展示 |
| Cloudflare Artifacts | 写入即强一致快照、git 兼容 | §7.1 after_content 由调用方传入（快照与写入原子同步） |
| Gumloop | 生成文件自动成卡片+预览、同文件名自动版本化 v1/v2/v3 | §8.3 产物卡片+预览；§8.4 版本历史 |
| WorkBuddy | 产物卡片 + 右侧预览面板 | 产物=卡片呈现，不搞文件树 |

## 5. 数据模型（表改动）

**迁移**（additive，复用 PRAGMA+ADD COLUMN 幂等模式，`connection.rs` 迁移尾部追加）：

```sql
ALTER TABLE changeset ADD COLUMN after_content   TEXT;  -- 写盘后的内容快照（NULL=历史行/二进制/不可读）
ALTER TABLE changeset ADD COLUMN snapshot_type  TEXT NOT NULL DEFAULT 'normal';  -- 'normal' | 'auto_snapshot'
CREATE INDEX IF NOT EXISTS idx_changeset_run_file ON changeset(run_id, file);
```

- `after_content`：diff 素材 + 回滚安全锚点（§7.2）。
- `snapshot_type='auto_snapshot'`：存档式回滚自动生成的新记录（扣子 Auto commit 语义），**不参与产物/变更的正常展示**，仅作为"被覆盖修改"的留存。

**`ChangesetRow` 扩展**（`changeset_sqlite.rs:93-104`）：加 `after_content: Option<String>`、`snapshot_type: String`。

## 6. 内核设计

### 6.1 记录端口：`ChangesetRecord` 参数对象

`ChangesetRecorder::record`（`write_gate.rs:19-31`）6 个裸参数 → 改为接收 `ChangesetRecord` struct：

```rust
pub struct ChangesetRecord {
    pub file: String,
    pub holder: String,
    pub run_id: Option<String>,
    pub before_hash: Option<String>,
    pub after_hash: String,
    pub before_content: Option<String>,
    pub after_content: Option<String>,   // 新增：写盘后的内容
}
```

- 理由：接口演进稳定（下次加字段不破坏 trait）；实现者仅 2 个（Sqlite + 测试桩），改动成本可忽略。
- `commit_write` 与 `record` **不读磁盘**：`after_content` 由调用方（filesystem/cli 工具层）与 `after_hash` 同源传入。写入非文本（二进制/非 UTF-8）时传 `None`（§10.3）。
- 代价：调用点（filesystem/cli 等）需多传一个参数——它们本就传 `before_content`，顺手。

### 6.2 存档式回滚（P0 升级，参照扣子编程 Auto commit）

`rollback(change_id)` 升级流程：

```
读 change 行（file, before_content, after_content）
读磁盘当前内容 current
┌─ current == after_content（或历史行按 after_hash 校验）→ 直接回滚（写回 before / 删新建）
└─ current ≠ after_content（被后续 run/用户改过）→
     1. 先把 current 存为一条新 changeset（snapshot_type='auto_snapshot'，holder=当前 change 的 holder 或 'user'）
     2. 再执行回滚
     3. 返回提示："已自动保留被覆盖的修改（run X 的改动），可在版本历史中查看"
```

- 语义：**任何回滚都不丢数据**，且保留"后悔药"（Grok Build 语）。比"校验不通过则拒绝"更贴合单机产品——用户要的就是一键后悔。
- 代价：回滚多一次写库 + 一条记录（可忽略）；`changeset` 查询需过滤 `snapshot_type='auto_snapshot'` 于正常展示。
- 历史行（`after_content IS NULL` 且无法按 hash 校验）→ 退化为直接回滚并提示"该记录为升级前数据，未做覆盖保护"。

### 6.3 命令（tauri 层，`commands/changeset.rs`）

| 命令 | 签名 | 说明 |
|---|---|---|
| `run_changesets`（新增） | `(run_id, limit?) -> Result<Vec<ChangesetRow>, AgentError>` | 复用 `list_for_run`，过滤 `auto_snapshot`，按文件分组排序 |
| `run_changeset_versions`（新增） | `(run_id, file) -> Result<Vec<ChangesetRow>, AgentError>` | 版本历史（同文件多次写入序列） |
| `changeset_rollback`（改造） | 存档式回滚（§6.2） | 群视图继续复用同一命令 |

- 错误契约：新命令一律 `Result<_, AgentError>`（V5.1 契约），不用 `String`。
- `lib.rs` `generate_handler!` 注册两新命令。

## 7. 关键设计决策（ADR 决策表）

| # | 决策 | 竞品出处 | 放弃什么 |
|---|---|---|---|
| D1 | `after_content` 由调用方传入，不读磁盘 | Cloudflare（写入即快照） | 调用点多传一个参数 |
| D2 | 存档式回滚（Auto commit），不拒绝 | 扣子编程 | 回滚多一条记录、实现略复杂 |
| D3 | 新建=产物 / 修改=变更 | Gumloop artifacts 语义 | 无额外标记字段 |
| D4 | 产物=文件卡片+内联预览 | Gumloop / WorkBuddy | 不做文件树/侧栏 |
| D5 | 版本历史 = (run_id,file) 分组 | Gumloop v1/v2/v3 | 无（零额外成本） |
| D6 | 行级 red/green diff 内联展开 | Cursor（展示形态） | 不做逐 hunk 审批 |
| D7 | diff 摘要行 +N/~M/-K | Grok `diff --summary` | 不做语义级影响分析（后续增强） |
| D8 | `record` 收参数对象 + `snapshot_type` | 工程规范（接口演进稳定） | 一次重构成本 |

## 8. 前端设计

### 8.1 组件结构

```
InterruptionRecovery（中断任务视图，每条 run 卡片）
  └─ [查看产物 / 查看变更] → 就地展开 <RunChangesetPanel runId={...} />
       ├─ 产物组（新建文件）：文件卡片（名/类型图标/大小）+ [回滚] + ▸预览 + ▸diff
       ├─ 变更组（修改文件）：文件名 + [回滚] + ▸版本历史 + ▸diff（摘要行 + 行级 red/green）
       └─ 空态：该 run 无文件改动
```

- `RunChangesetPanel.tsx`（新）：数据加载（`runChangesets`）、分组、版本历史、回滚。
- `DiffView.tsx`（新，**共享组件**）：行级 LCS diff + 摘要行 + 大文件退化。`ChangesetPanel`（群视图）后续可接入同一组件，**不复制逻辑**。
- 产物预览：文本/HTML 内联渲染（`<pre>` / iframe sandbox），图片 `<img>`，其余显示"不支持预览，可下载查看"。

### 8.2 状态流

- `InterruptionRecovery` 本地 state `expandedRunId: string | null`，点击切换展开/收起。
- 回滚/版本操作后刷新该 run 的 `runChangesets`；无自动刷新依赖（单机、低频操作）。

### 8.3 样式与 i18n

- `tasks.css`：diff 行着色 `.diff-add` / `.diff-del` / `.diff-ctx`（**dark 用主题 rgba 透明白，禁写死浅色**，防对比度坑）、分组标题、卡片、展开动画。
- `dict.ts`：`tasks.runChangeset.*`、`changeset.diff.*`、`changeset.version.*` 键。

## 9. 交互流程

```
中断任务视图 → 某 run 卡片 → [查看产物/变更]
  → RunChangesetPanel
     ├─ 产物组：文件卡片 [预览] [回滚] [▸ 版本历史]
     ├─ 变更组：文件名 摘要行(+N/~M/-K) [回滚] [▸ 版本历史]
     └─ ▸diff：内联展开 行级 red/green（超 2000 行/500KB 显示"文件过大"）
回滚 → 若文件已被后续修改 → 自动存档当前内容 → 写回 before → 提示已保留被覆盖修改
```

## 10. 退化与边界

1. **历史行**（`after_content IS NULL`）：diff 只显示 before + 标注"升级前数据无改动后快照"；**不读磁盘冒充**（run 后续可能又改过，会失真）。
2. **二进制/非 UTF-8**：`after_content=None`，UI 显示"二进制文件，不支持 diff"。
3. **大文件**：>2000 行或 >500KB → 退化"文件过大，请在编辑器中查看"（LCS 内存 O(n×m) 风险）。
4. **存储膨胀**：同 run 反复写同文件 → N 份全量快照。MVP 接受（单机 SQLite）；后续可 `(run_id, file)` 聚合只留首 before + 终 after。
5. **回滚竞态**：存档式回滚已覆盖"跨 run 覆盖"；存档本身若失败 → 拒绝回滚并提示（fail-closed）。

## 11. 测试策略

- 内核：`record` 签名更新波及单测（`changeset_sqlite.rs` / `write_gate.rs` 测试桩）；新增：
  - `rollback_saves_current_content_before_overwrite`（A 改 → B 改 → 回滚 A → B 的修改以 auto_snapshot 留存）；
  - `rollback_direct_when_current_matches_after`；
  - `list_for_run_filters_auto_snapshot`；
  - `history_row_without_after_falls_back_to_hash_check`。
- 门禁：`cargo test --lib`（现有 250 → 预期 254+）；`npm run check:ts` 0 错；`npm run check:kernel`（内核纯净度：新代码零 tauri 依赖，仅 `commands/` 层可用 tauri）。
- 手工：造一条含文件写盘的 run → 中断 → 查看产物/变更 → diff 展开 → 回滚（含被后续修改场景）。

## 12. 改动文件清单

**内核**：`storage/connection.rs`（迁移）、`storage/changeset_sqlite.rs`（行结构/方法/回滚）、`agent/write_gate.rs`（record 签名+参数对象）、`agent/tools/filesystem.rs`（及 cli 等调用点传 after_content）、`commands/changeset.rs`（新命令+回滚改造）、`lib.rs`（注册）。
**前端**：`types/index.ts`、`services/tauri.ts`、`components/tasks/RunChangesetPanel.tsx`（新）、`components/common/DiffView.tsx`（新）、`components/tasks/InterruptionRecovery.tsx`、`components/tasks/tasks.css`、`i18n/dict.ts`。

## 13. 后续演进（不在本稿范围）

- git 底座（Cloudflare 思路）：工作区为 git 仓库时，快照/回滚走 git，`changeset` 表退化为索引；
- Grok 语义级摘要（影响调用方标注）；
- Cursor 式 hunk 审批（若未来需要"写入前审批"场景，如群任务）；
- 产物导出/分享（WorkBuddy 式二维码/链接——单机可先做本地导出）。
