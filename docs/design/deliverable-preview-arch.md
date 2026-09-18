# 产出物预览功能 · 架构设计

> 文档定位：PRD 的架构实现蓝图（架构通出品）
> 发起：2026-08-12｜状态：待评审｜版本：**v0.2**
> 上游：`docs/design/deliverable-preview-prd.md`（v0.1 待评审）
> 关联：`docs/design/agent-trace-layering.md` · `docs/design/workspace-linkage-plan.md` · `docs/longtask-design.md`
> 评审：`docs/design/deliverable-preview-arch-review.md`（v0.1 → v0.2 修订记录见该报告 §二/§三）

---

## 0. 架构结论（TL;DR）

把「产出物预览」建构成**一个前端聚合视图 + 一个数据完整性补丁**，不新建后端子系统：

- **前端**：`DeliverableDetailDrawer` 升级为 `ArtifactPreview` 统一预览容器，核心是**渲染器注册表**（`rendererFor()` 纯函数分发 + 组件映射）。双通道数据模型：`content` 文本流 / `media` 文件流。
- **安全前置**：全站**首次启用 `convertFileSrc` + asset protocol**，scope 白名单收窄到 `$APPDATA/workspaces/**`，这是本架构唯一的全局配置改动，先窄后宽。
- **后端**：P0 仅新增**一个**只读命令 `artifact_read_text`（HTML/CSV 渲染的内容通道，与 asset scope 共用白名单）；P1/P2 补 `trace_ref / size / mime / mtime`；`attachments` 元素从 `string` 升级为媒体描述对象（**读侧兼容旧 string**，ADDITIVE）。
- **引擎**：写出类工具结果捕获文件路径，治本替代正则兜底（P2）。
- **演进**：P0 纯前端 + 1 个只读命令（零回归）→ P2 附件链路（数据地基）→ P1 轨迹下钻（体验增量）。

**最大架构决策**：预览能力 100% 落在前端渲染层，后端只补数据、不补行为——保持「内核纯净度」纪律（kernel 禁 `use tauri::`）不破，可逆性最高。

---

## 1. 上下文与约束

### 1.1 现状事实（代码锚点，架构决策的输入）

| # | 事实 | 代码位置 | 架构含义 |
|---|---|---|---|
| F1 | 产出物是**实时聚合视图**，非持久化实体（三源：reply / task_output / summary） | `commands/group.rs:1044` `group_list_deliverables` | 「保存到工作区」等写操作不可回写产出物表——它不存在 |
| F2 | `DeliverableMedia` 只有 `type/path/name`，无 `size/mime/mtime` | `commands/group.rs` + `src/types/index.ts:950` | 元信息侧栏缺数据源，需补 |
| F3 | `roundtable_messages` 落库 `attachments: vec![]` 硬编码**共 8 处** | `roundtable.rs:383,1729,1843,1979`、`roundtable_repo.rs:355`、`commands/group.rs:954`、`upgrade.rs:208`、`integration_test.rs:296` | 治本点在引擎侧，读侧正则只是兜底 |
| F4 | `attachments` 列是 TEXT JSON 数组（元素为字符串路径） | `connection.rs:409`（roundtable）、`connection.rs:273`（messages） | 升级元素结构须做 serde 兼容 |
| F5 | `agent_trace` 按 `session_id` 存储，读接口 `find_by_session` | `trace_repo.rs` `TraceRow`/`find_by_session` | 轨迹下钻的关联键是 session_id |
| F6 | `roundtable_messages` **无 session_id 列**（只有 group_id + seq） | `roundtable_repo.rs:4,110` | reply 产出物 → 轨迹存在关联断点，需补列 |
| F7 | 前端**从未使用** `convertFileSrc`，`tauri.conf.json` 无 `assetProtocol` 配置 | `tauri.conf.json` 全文 | 图片内嵌是「零基建 + 首次启用」，scope 安全是首要设计点 |
| F8 | HTML 沙箱有先例：`<iframe sandbox="" srcDoc>` | `src/components/tasks/RunChangesetPanel.tsx:117` | 可复用模式，但 sandbox="" 下**相对路径资源无法加载**（srcDoc 无 base） |
| F9 | 轨迹投影已存在：`traceToItems(trace): Item[]`，`ProcessPanel` 消费 | `src/hooks/agentState.ts:112` | 轨迹视图必须复用，不新写一套 |
| F10 | worker 有独立 session（`scene='worker'`），`mode == "worker"` 分支已存在 | `session/manager.rs:218-226` | worker 会话轨迹已天然落库，只差关联键 |
| F11 | workspace 有 CRUD + `workspace_reveal`，表含 `path` 列 | `commands/workspace.rs`、`commands/group.rs:1169` | 保存到工作区的落盘基础已具备；**path 可能为空**（默认工作区未开文件夹） |
| F12 | `runs` 表**有 `session_id` 列**，run_id → session_id 映射天然存在 | `connection.rs:599` | trace_ref 键应统一收敛 session_id（见 ADR-025） |
| F13 | 前端**无文件读取通道**：无 `plugin-fs`，后端无通用读文件命令 | `package.json`、commands 全文 | HTML/CSV 渲染需 P0 新增 `artifact_read_text`（见 ADR-027） |

### 1.2 架构约束（继承的纪律，不可违反）

| 纪律 | 出处 | 对本架构的硬约束 |
|---|---|---|
| 内核纯净度 | `docs/` 内核约定 | 预览逻辑全前端；后端仅补数据字段与落库，**禁止新增 `use tauri::` 于 kernel** |
| ADDITIVE 迁移（ADR-006） | 既有约定 | 所有表变更只加列/加约束，不动既有数据 |
| 判定逻辑抽纯函数 | 既有约定 | `rendererFor()`/`detectMime()`/`formatBytes()` 全部纯函数，可单测 |
| 复用而非重写 | 既有约定 | 轨迹复用 `traceToItems`/`ProcessPanel`；Markdown 复用 `utils/markdown.tsx`；沙箱复用 `RunChangesetPanel` 模式 |
| 测试基线 | 既有约定 | 新增命令必须补 `e2e/helpers/tauriMock.ts` mock；`rendererFor`/`detectMime` 单测 |
| UI 令牌 | 既有约定 | 全部走 `App.css :root` 令牌，禁裸 hex |

### 1.3 非功能性要求（NFR）

- **安全性**（最高优先）：HTML 无脚本、asset protocol 白名单、不引入任意文件读取面。
- **性能**：图片懒加载；>5MB 提示降级；CSV 数据量阈值保护。
- **可逆性**：P0 不依赖任何后端改动，可独立上线回滚。
- **兼容性**：attachments 旧数据（string 数组）读侧无缝兼容。

---

## 2. 领域模型（Bounded Context）

### 2.1 域划分

```
┌────────────────────────────────────────────────────────────────────┐
│                          OneDesktop 应用                           │
│                                                                    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────┐ │
│  │  群协作域     │  │   轨迹域      │  │   工作区域    │  │ 会话域    │ │
│  │ (Group)     │  │ (Trace)      │  │ (Workspace) │  │(Session) │ │
│  │ 产出物聚合   │  │ agent_trace  │  │ 资产落盘点    │  │ worker   │ │
│  │ roundtable  │  │ 过程回放      │  │ reveal/路径  │  │ 会话      │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘  └────┬─────┘ │
│         │  trace_ref(只读引用)             │                │       │
│         └──────────────┬──────────────────┴────────────────┘       │
│                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │           产出物预览域 ArtifactPreview（本架构新增）            │   │
│  │  聚合视图：只读消费四域数据，不拥有数据，不落库                │   │
│  └────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

**关键建模决策**：产出物预览域是**纯读聚合（Read Model）**，不是新聚合根。它消费四域数据并组合展示，自身不产生持久化状态。这决定了：

- 「保存到工作区」是**复制操作 + 前端状态更新**，不写产出物表（因为不存在）；
- `trace_ref` 是**只读引用**，由 `group_list_deliverables` 聚合时填充，不反向写入 trace 域；
- 预览域与工作区域的耦合仅限「落盘路径」这一个点。

### 2.2 核心关联（trace_ref 关联模型）

```
reply (roundtable_messages) ──session_id──▶ agent_trace (scene='worker')
task_output (tasks.outputs) ──batch→runs.session_id──▶ agent_trace
summary ──✗ 不下钻（roundtable_summaries 无关联列，追溯价值低）
```

| 产出物来源 | 关联键（统一为 session_id） | 现状 | 补丁 |
|---|---|---|---|
| reply | worker 会话 session_id | ❌ roundtable_messages 无该列 | P1：`ALTER TABLE roundtable_messages ADD COLUMN session_id`（ADDITIVE），worker 回合落库时填充 |
| task_output | `tasks.batch_id → runs → runs.session_id` | ✅ tasks 有 batch_id、runs 有 session_id | P1：聚合时反查 **runs.session_id**（不是 run_id，见 ADR-025） |
| summary | **无（恒 None）** | ✅ 表无关联列（`connection.rs:277`） | 明确不下钻——群摘要是聚合产物非单次工具链产出，追溯价值低，不为它加列 |

> **架构权衡**：reply 的精确关联需要一次 additive 迁移 + 落库填充（改动面小，收益是「中途产出过什么」可完整回放）；若不做，只能按 `group_id + worker_id` 粗查轨迹（可能混入多轮会话）。**决策：做精确关联**——因为 PRD US-3 的价值正在于「判断结果是否可信」，粗查会污染判断。

---

## 3. 架构总览

### 3.1 分层结构

```
┌──────────────────────────────────────────────────────────────────────┐
│ 前端（React, 全部预览能力在此层）                                       │
│                                                                      │
│  ArtifactPreview（统一容器）                                           │
│  ├─ ArtifactSidebar（元信息 + 附件缩略图条）                            │
│  ├─ rendererFor(deliverable) → RenderKind（纯函数）                    │
│  └─ Renderer Registry（kind → 组件）                                  │
│     ├─ MarkdownRenderer（复用 utils/markdown）                         │
│     ├─ CodeRenderer / ImageRenderer / HtmlRenderer / CsvRenderer       │
│     └─ FallbackRenderer（文件卡 + 打开）                               │
│  ├─ TracePanel（复用 traceToItems + ProcessPanel 组件）               │
│  └─ SaveToWorkspace（P2，调后端命令）                                  │
│                                                                      │
│  文件访问：convertFileSrc(media.path)（asset protocol，scope 白名单）   │
└──────────────────────────────────────────────────────────────────────┘
                              │ invoke
┌──────────────────────────────────────────────────────────────────────┐
│ 后端命令层（tauri commands，仅补数据）                                  │
│  group_list_deliverables：填充 trace_ref / size / mime / mtime        │
│  artifact_save_to_workspace（P2，新增）                                │
│  artifact_trace（P1，按 trace_ref 查轨迹，或前端直接复用车内已有查询）    │
└──────────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────────┐
│ 存储层（ADDITIVE 迁移）                                                │
│  roundtable_messages：+session_id 列；attachments 元素升级为对象       │
│  agent_trace：不动（已有 session_id / scene / kind / args / result）   │
│  workspaces：不动（已有 path）                                         │
└──────────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────────┐
│ 引擎层（P2）                                                          │
│  executor：写出类工具结果 → 提取产物路径 → 填充 attachments            │
│  agent/tools/*：filesystem / shell 等（识别写出类工具）                 │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 数据流（三条主线）

**主线 A · 内嵌预览（P0）**
```
列表点击 → group_list_deliverables 已返回 media[]
       → rendererFor(判定 content/media 特征)
       → ImageRenderer: convertFileSrc(path) → <img>
       → HtmlRenderer: 读文件内容 → <iframe sandbox="" srcDoc>
       → 未知: FallbackRenderer: 文件卡 + openPath（系统程序）
```

**主线 B · 轨迹下钻（P1）**
```
预览内点「查看产生轨迹」
       → deliverable.trace_ref = { scope, key }
       → 查 agent_trace（按 session_id / run_id，scene='worker'）
       → traceToItems(trace) → ProcessPanel 回放
       → 产出文件路径与 tool_result 内容匹配 → 反显高亮
```

**主线 C · 附件完整可见（P2）**
```
引擎执行工具（filesystem.write_file / shell 落盘 / 截图…）
       → 捕获结果中的产物路径
       → 回合落库时写入 attachments（对象元素：path/size/mime/mtime）
       → group_list_deliverables 直接读 attachments → media[] 完整
       → 正则抽取降级为兜底（仅对存量数据）
```

---

## 4. 前端预览器架构

### 4.1 组件拓扑与文件落地

```
src/components/artifacts/
├── ArtifactPreview.tsx          # 统一容器（替代 DeliverableDetailDrawer 的消费点）
├── ArtifactSidebar.tsx          # 元信息侧栏（类型/大小/路径/来源/时间）
├── ArtifactThumbStrip.tsx       # 附件缩略图条（横向，点击切换主渲染区）
├── renderers/
│   ├── index.ts                 # Renderer Registry：kind → 组件映射
│   ├── rendererFor.ts           # 纯函数：Deliverable → RenderKind
│   ├── MarkdownRenderer.tsx     # 复用 utils/markdown
│   ├── CodeRenderer.tsx         # 代码高亮（复用 Markdown 代码块能力）
│   ├── ImageRenderer.tsx        # convertFileSrc + 懒加载 + 点击放大
│   ├── HtmlRenderer.tsx         # iframe sandbox="" srcDoc（读文件内容）
│   ├── CsvRenderer.tsx          # 表格化 + 行数阈值保护
│   └── FallbackRenderer.tsx     # 文件卡 + 系统程序打开
└── TracePanel.tsx               # 复用 traceToItems + ProcessPanel 组件
```

**兼容策略**：`DeliverableDetailDrawer` 不删除——P0 期间 `ArtifactPreview` 内部可先包住旧组件逐步替换，验收通过后删旧。避免一次性大改的回归面。

### 4.2 渲染器注册表模式（Renderer Registry）

```
// 判定（纯函数，可单测）——只回答"这是什么"，不回答"怎么渲染"
type RenderKind = "markdown" | "code" | "image" | "html" | "csv" | "fallback";
function rendererFor(d: Deliverable): RenderKind {
  // 优先级：media 文件类型（后缀） > content 特征（markdown 语法） > 默认 markdown
  // 未知扩展名 / binary → "fallback"
}

// 注册表（声明式，新增渲染器 = 注册一项）
const REGISTRY: Record<RenderKind, ComponentType<RendererProps>> = {
  markdown: MarkdownRenderer, code: CodeRenderer, /* … */ fallback: FallbackRenderer,
};

// 消费
const Kind = rendererFor(deliverable);
const Renderer = REGISTRY[Kind];
<Renderer content={deliverable.content} media={activeMedia} />
```

**为什么要注册表而非 if/else 链**：
- 新增类型 = 加一个组件 + 注册一项 + 加一条判定，**互不触碰**（开闭原则）；
- 渲染器之间无共享可变状态，天然可独立测试；
- 与 PRD「判定逻辑抽纯函数」纪律一致：`rendererFor` 是唯一判定入口。

### 4.3 双通道数据模型（content 流 / file 流）

渲染器的输入有两个通道，**渲染器需声明自己消费哪个**：

| 通道 | 数据 | 典型渲染器 | 说明 |
|---|---|---|---|
| content 流 | `deliverable.content` 字符串 | markdown / code / csv（内嵌数据） | 无文件也可渲染（群摘要、文本产出） |
| file 流 | `deliverable.media[]` 中的文件 | image / html / fallback | 依赖本地文件存在，需懒加载 + 存在性检查 |

**判定优先级**：file 流优先（有真实文件按文件渲染）→ content 流兜底（无文件按内容特征渲染）。
**存在性检查**：file 流渲染前 `exists` 检查（P0 可先做失败降级：`<img onError>` / 文件读失败 → Fallback），文件被删除时明示「文件已移动或删除」。

### 4.4 文件访问：convertFileSrc + asset protocol（全站首次启用）

这是本架构**唯一触碰全局配置**的改动，也是最高安全关注点。详见 §7。

---

## 5. 后端数据完整性

### 5.1 Deliverable / DeliverableMedia 扩展（前后端同步）

```rust
// 后端 commands/group.rs
pub struct DeliverableMedia {
    pub r#type: String,          // "image" | "file"（保留）
    pub path: String,            // 本地绝对路径（保留）
    pub name: String,            // 文件名（保留）
    pub size: Option<u64>,       // 新增：字节数（P2 起有值；P0 缺省 None）
    pub mime: Option<String>,    // 新增：判定类型（image/png、text/html…）（P2）
    pub mtime: Option<i64>,      // 新增：毫秒时间戳（P2）
}

pub struct Deliverable {
    // …既有字段…
    pub trace_ref: Option<TraceRef>, // 新增：产出物 → 轨迹定位键
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TraceRef {
    pub source: String,          // "roundtable" | "run"（溯源语义，仅展示用）
    pub key: String,             // 恒为 session_id（agent_trace 唯一查询键，F5/F12）
}
```

前端 `src/types/index.ts` 同步镜像（`DeliverableMedia` 加可选字段、`Deliverable` 加 `trace_ref`）。

**类型设计要点**：
- `size/mime/mtime` 为 `Option`，P0 阶段后端尚未捕获元信息时返回 `None`，前端显示「—」——**P0 后端改动面最小**，P2 填充后侧栏自动丰满；
- **`trace_ref.key` 恒为 session_id**（不是 run_id）：`agent_trace` 的唯一会话键是 `session_id`（`trace_repo.rs` 的 `find_by_session`），`runs.session_id` 列（F12）保证了 run → session 的可反查性，前端下钻路径单一（一律 `key → find_by_session`，零 join）。

### 5.2 attachments 元素升级（string → 对象，读侧兼容）

现状：`attachments` TEXT JSON 数组，元素为字符串路径。

升级策略（**不新建表**，保持 JSON 数组形态）：

```jsonc
// 旧：["/abs/path/a.png", "/abs/path/b.html"]
// 新：[{"path":"/abs/path/a.png","size":1234,"mime":"image/png","mtime":1755000000000}]
```

**读侧兼容**（架构关键点）：`serde` 反序列化时用 `#[serde(untagged)]` 枚举同时接受 `String` 与对象——存量数据零迁移、零丢失：

```rust
#[derive(Deserialize)]
#[serde(untagged)]
enum AttachmentEntry { Path(String), Media(DeliverableMedia) }
```

写入侧：引擎捕获成功后写对象；未捕获时维持 `vec![]` 语义不变。**不需要一次性数据回填**——旧数据读侧照常显示（正则兜底仍在），新数据质量逐步提升。

### 5.3 group_list_deliverables 改造（P1/P2）

| 来源 | P0（现状） | P1（+trace_ref） | P2（+元信息） |
|---|---|---|---|
| reply | `merge_media(attachments, extract_media_from_content)` | 填充 `trace_ref = {source:"roundtable", key: session_id}`（读新列） | 读 attachments 对象元素直接映射 size/mime/mtime |
| task_output | `classify_media(out)` | 经 `tasks.batch_id → runs → runs.session_id` 反查，填充 `{source:"run", key: session_id}` | 同上 |
| summary | 空 media | **恒 `None`，不下钻**（表无关联列，见 §2.2） | — |

---

## 6. 引擎附件捕获（P2）

### 6.1 捕获点与写出类工具识别

```
executor（工具执行层）
  └─ 工具结果归一化（tool_result 生成）
      └─ 写出类工具白名单命中
          ├─ filesystem.write_file / save_*      → result 含绝对路径
          ├─ shell 执行（重定向落盘 / 脚本产出）   → 扫描 stdout 中的路径信号
          └─ 截图 / 图片生成工具                    → result 含图片路径
          ↓
      extract_artifact_paths(result)（纯函数）
          → Vec<AttachmentEntry 对象>（stat 取 size/mtime，后缀判 mime）
```

**实现原则**：
- 先做**白名单**（写出类工具显式声明「本工具可能产出文件」），不搞全量扫描——避免把 `read_file` 等工具结果误判为产出；
- `extract_artifact_paths` 是纯函数（输入 result 字符串，输出路径列表），可单测；
- 捕获时机在**工具结果归一化**处（一次改动覆盖所有工具），而非每个工具单独改。

### 6.2 落库链路

```
工具执行 → executor 捕获产物路径
        → worker 回合结束（AgentRunOutcome）
        → roundtable/任务落库时 attachments = 捕获结果（替代 8 处 vec![] 中的写路径）
        → roundtable_messages.session_id 同步填充（P1）
```

**改动收敛点**：8 处 `attachments: vec![]` 中，仅**真实落库路径**（`roundtable.rs` 的 worker 回合落库 + 任务产出落库）需要接入捕获结果；其余（upgrade 迁移、integration_test、其他占位）保持不动。

---

## 7. 安全架构（首要设计点）

### 7.1 asset protocol scope 白名单（全站首次启用）

**现状**：`tauri.conf.json` 无 `assetProtocol` 配置，前端无 `convertFileSrc` 使用。

**决策**：启用 asset protocol，scope 收窄：

```jsonc
// tauri.conf.json（唯一全局改动）
"app": {
  "security": {
    "assetProtocol": {
      "enable": true,
      "scope": [
        "$APPDATA/workspaces/**"   // 产出物文件实际所在：<app_data>/workspaces/<group_id>/
      ]
    }
  }
}
```

**为什么收窄到 `$APPDATA/workspaces/**`**：
- 群/worker 隔离工作目录在 `<app_data>/workspaces/<group_id>/`（`group_get_workspace` 证实）；
- 任务 sandbox、chat 附件均在 app data 的 workspaces 之下；
- **不用 `$APPDATA/**`**：app data 下还有 `db/`（SQLite，含全部消息/密钥配置）与日志——scope 白名单的价值在于最小化，不为将来的漏洞面买单；
- **杜绝任意绝对路径读取**（如 `/etc/passwd`、`~/Documents/机密`）——这是 asset protocol 最大的攻击面。

**扩展点（先窄后宽）**：若未来支持「打开用户任意文件夹作为工作区」（`create_workspace_with_path` 已有雏形），运行时按需扩展 scope——Tauri 支持运行时注入/重建，架构上预留 `fs` 插件权限与 `assetProtocol` scope 的同步机制，不在本次实现。

**前端配合**：所有 `convertFileSrc` 调用只接受**后端返回的 media.path**，不接受用户输入拼接的路径；路径不在 scope 内时 `convertFileSrc` 返回空 → 前端降级 Fallback。

**⚠️ 实现前验证项（P0 首个 spike）**：dev 模式下（`devUrl: localhost:1420`）asset protocol 的 scope 校验行为必须先验证——Tauri 已知坑：dev 场景 asset 请求与 scope 匹配偶有偏差，`convertFileSrc` 可能返回空。验证通过后再铺开渲染器开发，避免 P0 尾段返工。

### 7.2 HTML 沙箱与 CSP 策略

**决策**：复用 `RunChangesetPanel` 先例 `<iframe sandbox="" srcDoc>`，**保持全局 `csp: null` 不动**。

理由（权衡）：
- `sandbox=""`（无 `allow-scripts` / `allow-same-origin`）已构成隔离边界：脚本不执行、无法访问 tauri API、无法读写本地文件；
- 全局 CSP 是横切改动，会波及所有现有页面与内联样式，**收益被 sandbox 覆盖，风险却全局扩散**——架构上取「局部隔离优先于全局策略」。

**已知限制（架构显式接受）**：
- `sandbox=""` 的 srcDoc iframe 无 base URL → HTML 内相对路径资源（`<img src="./x.png">`）无法加载；
- **P0 接受**：仅渲染自包含 HTML（内联样式/内联图片），相对资源缺失是 PRD 非目标内的已知降级；
- **P1 可选增强**：HTML 渲染器先读文件文本，用 `convertFileSrc` 把相对资源重写为绝对 asset URL（前置：HTML 文件须在 scope 内）。

### 7.3 纵深防御清单

| 层 | 措施 |
|---|---|
| asset protocol | scope 白名单 `$APPDATA/workspaces/**`；路径仅接受后端返回值 |
| 文件内容读取 | `artifact_read_text` 内部校验路径与 asset scope 同源，拒绝 scope 外路径（单一事实源） |
| iframe | `sandbox=""` 无脚本无同源；title 明示 |
| 渲染输入 | HTML 内容来自文件读取命令返回，不接受任意 URL fetch |
| 降级 | scope 外/文件缺失 → FallbackRenderer 明示，不静默失败 |
| 大文件 | >5MB 内嵌前提示「建议系统程序打开」（懒加载 + 提示） |
| 复制 | 复制内容走 `navigator.clipboard` 既有路径，图片复制走媒体文件复制 |

---

## 8. ADR 决策记录

### ADR-021: 产出物预览域为纯读聚合视图

- **Status**：Proposed
- **Context**：PRD 要求预览/追溯/落盘能力；产出物现状是 `group_list_deliverables` 实时聚合，无持久化表。
- **Decision**：新建前端聚合视图 `ArtifactPreview`，只读消费四域（群协作/轨迹/工作区/会话），不引入新持久化实体。
- **Consequences**：✅ 零后端子系统、可逆、无迁移；✅ 保存到工作区仅复制不落库（产出物无主键可回写）；⚠️ 聚合查询复杂度留在 `group_list_deliverables` 单点（当前三源 + trace_ref，尚可）。

### ADR-022: 渲染分发用「纯函数判定 + 组件注册表」

- **Status**：Proposed
- **Context**：PRD 要求类型化渲染，且项目纪律要求判定逻辑抽纯函数。
- **Decision**：`rendererFor()` 纯函数产出 `RenderKind`；`REGISTRY` 声明式映射到组件。
- **Consequences**：✅ 新增类型零侵入；✅ 判定可单测；✅ 渲染器独立。⚠️ 多一层间接（一个 10 行的 Map，复杂度可接受）。

### ADR-023: 首次启用 asset protocol，scope 收窄 $APPDATA/workspaces/**

- **Status**：Proposed
- **Context**：图片内嵌（US-1）必须 `convertFileSrc`；全站零基建；安全是首要约束；app data 下混有 db/日志，scope 必须最小化。
- **Decision**：启用 `assetProtocol.enable`，scope 仅 `$APPDATA/workspaces/**`（v0.1 曾写 `$APPDATA/**`，评审 P1-2 收窄），路径只接受后端返回值；未来用户工作区路径按需运行时扩展。dev 模式 scope 校验行为列入 P0 首个验证 spike。
- **Consequences**：✅ 图片可内嵌（G1）；✅ 无任意文件读取面，且不波及 db/日志；⚠️ 用户自选目录的产出物图片暂不可内嵌（当前不存在该场景）；⚠️ 首次全局配置改动，须回归验证 dev/prod。

### ADR-024: HTML 渲染用局部 sandbox，不动全局 CSP

- **Status**：Proposed
- **Context**：HTML 产出物须站内沙箱渲染；全局 `csp: null`。
- **Decision**：复用 `<iframe sandbox="" srcDoc>`；保持 `csp: null`。
- **Consequences**：✅ 隔离充分且零横切风险；✅ 复用既有先例；⚠️ 相对资源不可加载（P0 接受，P1 资源重写可选）；⚠️ 若未来引入任意 HTML 预览需重估。

### ADR-025: trace_ref 键统一收敛为 session_id

- **Status**：Proposed
- **Context**：三源产出物到 `agent_trace` 的关联键各不相同；`agent_trace` 唯一查询键是 session_id；`runs` 表有 session_id 列（F12）；v0.1 曾以 run_id 为键（评审 P0-2 发现键不匹配）。
- **Decision**：`TraceRef { source, key }` 的 **key 恒为 session_id**；roundtable_messages 加 `session_id` 列（ADDITIVE）并落库填充；task_output 经 `tasks.batch_id → runs → runs.session_id` 反查；summary 恒 None 不下钻（表无关联列）。
- **Consequences**：✅ 前端下钻路径单一（一律 `key → find_by_session`，零 join）；✅ 一次 additive 迁移代价小；⚠️ 落库链路需在 P1 触碰（与 P2 引擎捕获同区域，合并改动省一次回归）。

### ADR-026: attachments 元素升级为对象，读侧 untagged 兼容

- **Status**：Proposed
- **Context**：P2 需 size/mime/mtime；存量 attachments 是 string 数组；不允许破坏性迁移。
- **Decision**：元素升级为 `{path,size,mime,mtime}` 对象；`#[serde(untagged)]` 兼容旧 string；不一次性回填。
- **Consequences**：✅ 新数据质量完整、旧数据零丢失零迁移；✅ 正则兜底渐进退场；⚠️ 序列化层多一个 untagged 分支（易测）。

### ADR-027: 新增只读命令 artifact_read_text，与 asset scope 共用白名单

- **Status**：Proposed
- **Context**：评审 P0-1 发现 HTML/CSV 渲染需要文件内容，但前端无 `plugin-fs`、后端无通用读文件命令——「P0 纯前端」不成立。
- **Decision**：P0 新增 `artifact_read_text(path) -> Result<{content, size}>`：内部校验 path 落在 `$APPDATA/workspaces/**`（与 ADR-023 同一 scope 决策，单一事实源），scope 外拒绝；返回内容供 iframe srcDoc / CSV 解析；Markdown/Code 继续走 content 流（不读文件）。
- **Consequences**：✅ P0 的 HTML/CSV 渲染获得受控内容通道；✅ 读文件命令与 asset 访问同源校验，不新增第二套安全逻辑；⚠️ P0 不再是「零后端改动」，而是「1 个只读命令」（回归面 = 一个命令，可控）。

---

## 9. 模块落地映射（文件级）

### P0 · 预览器骨架（前端 + 1 只读命令 + 1 处全局配置）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src-tauri/tauri.conf.json` | 改 | `security.assetProtocol`（enable + scope `$APPDATA/workspaces/**`） |
| `src-tauri/src/commands/artifact.rs` | 新增 | `artifact_read_text(path)`：scope 校验 + 读内容（ADR-027，首个 spike 验证 dev 模式） |
| `src/types/index.ts` | 改 | `DeliverableMedia` 加 `size/mime/mtime?`；`Deliverable` 加 `trace_ref?` |
| `src/components/artifacts/` | 新增 | 容器/侧栏/缩略图条/renderers 全家桶 |
| `src/components/groups/parts/GroupDeliverables.tsx` | 改 | 打开入口切到 `ArtifactPreview` |
| `src/components/groups/parts/DeliverableDetailDrawer.tsx` | 暂留 | P0 内部兼容，验收后删 |
| `src/utils/` | 新增 | `detectMime.ts` / `formatBytes.ts` 纯函数 |
| `src/hooks/useDialogA11y.ts` | 复用 | 键盘可达（Esc/方向键） |

### P1 · 轨迹下钻

| 文件 | 动作 | 说明 |
|---|---|---|
| `src-tauri/src/storage/connection.rs` | 改 | ADDITIVE：`roundtable_messages ADD COLUMN session_id` |
| `src-tauri/src/group/roundtable.rs` | 改 | worker 回合落库填充 session_id（复用已有 session 上下文） |
| `src-tauri/src/commands/group.rs` | 改 | `group_list_deliverables` 填充 `trace_ref`（reply/task_output 两源；**summary 恒 None**） |
| `src/components/artifacts/TracePanel.tsx` | 新增 | 复用 `traceToItems` + `ProcessPanel` 组件 |
| `src/hooks/agentState.ts` | 复用 | `traceToItems`（不新写） |

### P2 · 附件链路 + 工作区

| 文件 | 动作 | 说明 |
|---|---|---|
| `src-tauri/src/agent/executor/*` | 改 | 工具结果归一化处捕获写出类产物路径 |
| `src-tauri/src/agent/tools/*` | 改 | 写出类工具声明（白名单标记） |
| `src-tauri/src/commands/group.rs` | 改 | attachments 读对象元素映射 media；`extract_media_from_content` 降级兜底 |
| `src-tauri/src/commands/artifact.rs` | 改 | 增 `artifact_save_to_workspace`：复制到 `{ws}/.one-desktop/artifacts/{date}/`，幂等命名；**`workspaces.path` 为空 → 返回可读错误**（前端引导设置工作区），不静默兜底 |
| `e2e/helpers/tauriMock.ts` | 改 | 新命令 mock（`group_list_deliverables` 返回结构同步） |
| `src-tauri/src/group/roundtable.rs` | 改 | 落库 attachments 用捕获结果（替换真实落库路径的 `vec![]`） |

---

## 10. 演进路径（P0 → P2）

```
P0 预览器骨架 ──────────────► P1 轨迹下钻 ────────────────► P2 附件链路 + 工作区
前端 + artifact_read_text      roundtable +session_id        引擎捕获 + attachments 对象
+ assetProtocol 配置            + trace_ref 填充 + TracePanel   + artifact_save_to_workspace
（1 只读命令，零回归）                  ▲                            │
                                        └──────── 可并行（P2 数据地基）┘
```

**依赖关系**：
- P1 依赖 P0（下钻入口在预览面板内）；
- P2 的附件捕获不依赖 P0/P1，可并行推进（PRD 也建议 P2 提前）；
- P1 的 session_id 落库与 P2 的 attachments 落库**同处 roundtable 落库链路**——合并开发，减少一次回归面（ADR-025 已注明）。

**回滚策略**：P0 可独立回滚（撤 assetProtocol + `artifact_read_text` + 前端组件）；P1/P2 的迁移全部 additive，无回滚代价。

---

## 11. 风险与对策（架构层面）

| 风险 | 等级 | 架构对策 |
|---|---|---|
| asset protocol scope 配置错误导致任意文件可读 | **高** | scope 只写 `$APPDATA/**`；convertFileSrc 只接受后端 media.path；验收加「scope 外路径返回空」用例 |
| 图片内嵌性能（超大图） | 中 | 懒加载 + >5MB 提示降级；缩略图条只取前 3 |
| 引擎捕获引入回归（executor 是热路径） | 中 | 捕获为独立纯函数 + 白名单声明；先灰度观察（开关默认关，P2 稳定后开） |
| TracePanel 复用加深耦合 | 中 | 只复用 `traceToItems`/`ProcessPanel` 组件，不 fork；TracePanel 仅做装配 |
| 相对资源无法加载致 HTML 显示不全 | 低 | P0 接受并明示；P1 资源重写为可选增强（ADR-024） |
| attachments 新旧结构并存混乱 | 低 | untagged 兼容 + 单元测试覆盖两种形态 |
| 保存到工作区路径冲突 | 低 | 幂等命名（`name` → `name-1` → `name-2`）；不覆盖 |

---

## 12. 验收对齐（架构侧）

- [ ] `convertFileSrc` 仅用于后端返回的 media.path，scope 外路径返回空并降级
- [ ] `artifact_read_text` 拒绝 scope 外路径（与 asset scope 同源校验），单测覆盖允许/拒绝两种
- [ ] dev 模式下 asset protocol scope 校验验证通过（P0 首个 spike）
- [ ] `<iframe sandbox="" srcDoc>` 无 allow-scripts；HTML 仅来自 `artifact_read_text` 返回内容
- [ ] `roundtable_messages` 迁移为 ADDITIVE（+session_id），旧数据可读
- [ ] attachments 反序列化 untagged 兼容 string/对象，单测覆盖两种
- [ ] `trace_ref.key` 恒为 session_id；task_output 经 batch→runs→session 反查可追溯；**summary 恒 None 不下钻**
- [ ] `artifact_save_to_workspace`：`workspaces.path` 为空 → 返回可读错误不崩溃；幂等命名不覆盖
- [ ] `rendererFor`/`detectMime`/`formatBytes`/`extract_artifact_paths` 为纯函数且有单测
- [ ] `tauriMock.ts` 同步 `group_list_deliverables` 新返回结构（含 trace_ref/media 元信息）
- [ ] P0 可独立上线/回滚，后端依赖仅 `artifact_read_text` 一个只读命令
- [ ] `npm run check:ts` / `check:rust` / `check:kernel` 通过；E2E 新用例（图片内嵌/HTML 沙箱/轨迹下钻/保存工作区）全绿
