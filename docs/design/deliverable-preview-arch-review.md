# 产出物预览架构 · 评审报告

> 评审对象：`docs/design/deliverable-preview-arch.md`（v0.1）
> 评审人：架构通｜日期：2026-08-12
> 方法：关键断言拉回真实代码逐一验证（trust but verify），非纸面推演
> 结论：**有条件通过**——2 个 P0 必须修正，2 个 P1 建议修正，5 个 P2 可后续。修订版 v0.2 见架构文档。

---

## 一、验证执行记录（本次评审做了什么）

| 断言 | 验证方式 | 结果 |
|---|---|---|
| P0「纯前端零后端改动」 | 查 `package.json` + `node_modules/@tauri-apps/` + 全局 grep 读文件调用 | ❌ **不成立**（见 P0-1） |
| trace_ref 存 run_id 可查 agent_trace | 读 `connection.rs:597` runs 表 + `trace_repo.rs` 查询键 | ❌ **键不匹配**（见 P0-2） |
| `roundtable_messages` 无 session_id | 读 `roundtable_repo.rs:4` 列清单 | ✅ 确认（F6 正确） |
| task 有 batch_id 可反查 | 读 `connection.rs:251` tasks 表 | ✅ 确认 |
| summary 可关联 run | 读 `connection.rs:277` roundtable_summaries 表 | ❌ **无关联列**（见 P1-1） |
| 后端有读文件命令可供 HTML/CSV 渲染 | grep commands 读文件调用 | ❌ **无通用读文件命令**（见 P0-1） |
| assetProtocol scope `$APPDATA/**` 是否过宽 | 对照 app data 目录内容（db/日志/workspaces） | ⚠️ **过宽**（见 P1-2） |
| 默认工作区 path 非空 | 前期 DB 核对记录（`workspaces.path` 为空） | ❌ **可能为空**（见 P1-3） |

---

## 二、P0 · 阻断级（必须修，否则实现被卡）

### P0-1：P0「纯前端零后端改动」不成立——HTML/CSV 渲染没有内容通道

**证据**：
- 前端依赖仅 `plugin-dialog` / `plugin-opener` / `plugin-shell`，**无 `@tauri-apps/plugin-fs`**；
- 全前端 grep `readTextFile|readFile|plugin-fs` 零命中；
- 后端 commands 无「按任意路径读取文件内容」的通用命令（现有 `read_to_string` 均为 workspace 配置/记忆文件的定点读取，`commands/group.rs:294` 是 workspace 配置读取）；
- 而 HTML 渲染（iframe srcDoc）、CSV 渲染（表格化）**必须拿到文件内容**。

**影响**：P0 承诺「HTML 沙箱渲染、CSV 表格化」却无读取通道——实现阶段必然卡死或被迫临时引入未设计的能力。图片/Markdown/Code 不受影响（图片走 `convertFileSrc` 直出 `<img>`，无需读内容；Markdown/Code 走 content 流）。

**建议（已修入 v0.2）**：
- P0 增加**一个**最小后端只读命令 `artifact_read_text(path) -> Result<{content, size}>`；
- 安全：命令内部校验 path 落在 assetProtocol scope 白名单（与 ADR-023 同源），拒绝 scope 外路径——**读文件命令与 asset 访问共用同一 scope 决策，单一事实源**；
- P0 修正为「纯前端 + 1 个只读命令」，其余后端改动仍在 P1/P2。

### P0-2：trace_ref 键不匹配——agent_trace 的查询键是 session_id，不是 run_id

**证据**：
- `agent_trace` 唯一会话键是 `session_id`（`trace_repo.rs` 的 `find_by_session`）；
- `runs` 表**同时有 `session_id` 列**（`connection.rs:599`）——run_id → session_id 的映射天然存在；
- 文档 v0.1 的 `TraceRef { source: "run", key: run_id }` 拿到 run_id 后**无法直接查 agent_trace**，必须先 join runs 表反查 session_id。

**影响**：查询路径变成 `run_id → runs.session_id → agent_trace`，多一跳 join、语义分裂（key 有两种含义）。

**建议（已修入 v0.2）**：
- **trace_ref 的 key 统一收敛为 session_id**（`agent_trace` 唯一查询键）；`source` 只表达溯源语义（"roundtable" / "run"）；
- task_output 经 `tasks.batch_id → runs(batch 的 job 映射) → runs.session_id` 反查，得到的是 **session_id**；
- 前端下钻路径单一：一律 `trace_ref.key → find_by_session`，零 join。

---

## 三、P1 · 重要（建议修，涉及范围与安全边界）

### P1-1：summary 的 trace_ref 是"死路"——表里根本没有关联列

**证据**：`roundtable_summaries` 表只有 `group_id/content/source_seq_*/message_count/created_at`（`connection.rs:277-285`），**无 run_id/session_id 列**。文档 v0.1 写「摘要表有 run_id 则填，否则 None」——实际是恒 None。

**影响**：文档给了不存在的选项，实现者会纠结「要不要给摘要表加列」。

**建议（已修入 v0.2）**：**明确 summary 不下钻轨迹**（P1 范围收窄）。理由：群摘要是聚合产物而非单次工具链的产出，追溯价值低；为它加列不划算。验收标准同步移除 summary 轨迹用例。

### P1-2：assetProtocol scope `$APPDATA/**` 过宽

**证据**：app data 目录（`~/.one-desktop/`）下除 `workspaces/` 外还有 `db/`（SQLite，含全部消息/密钥配置）、`logs/` 等；产出物文件实际只存在于 `workspaces/<group_id>/`（`group_get_workspace` 证实）。

**影响**：`$APPDATA/**` 意味着任何能构造 media.path 的漏洞面都能读到 db 与日志。虽当前无直接注入面（sandbox + 后端返回值），但 scope 白名单的价值在于**最小化**，不应为将来买单。

**建议（已修入 v0.2）**：scope 收窄为 `$APPDATA/workspaces/**`。若未来出现用户自选工作区路径，再按需扩展（ADR-023 已预留运行时扩展点）。

**附加验证项（已补入 v0.2）**：dev 模式下 asset protocol 的 scope 校验行为需**实现前先验证**（已知 Tauri 坑：devUrl 场景下 asset 请求与 scope 的匹配偶有偏差），避免 P0 上线当天翻车。

### P1-3：保存到工作区的空 path 边界未处理

**证据**：前期 DB 核对确认默认工作区 `workspaces.path` **为空**（未打开过文件夹）；`artifact_save_to_workspace` 若按 `{workspace.path}/.one-desktop/artifacts/` 落盘，空 path 会写出错误位置或直接失败。

**建议（已修入 v0.2）**：命令内显式分支——path 为空 → 返回可读错误（前端提示「请先设置工作区路径」并引导到工作区设置），**不静默失败、不自动兜底到 app data**（保持用户可预期）。

---

## 四、P2 · 建议（不阻塞，可排后续）

| # | 问题 | 说明 | 建议 |
|---|---|---|---|
| P2-1 | `group_list_deliverables` 全量聚合无上限 | 三源全量 + 每条 reply 正则抽 media（`extract_media_from_content` 是 O(n×content)），产出物积累后列表会退化 | media 抽取**延迟化**：列表只返回 media 数量，打开预览才取完整 media；或列表分页 |
| P2-2 | CSV 编码未定义 | 中文 CSV 常为 GBK，前端按 UTF-8 读会乱码 | 读文件命令做编码探测（UTF-8/BOM/GBK fallback） |
| P2-3 | 多入口统一未兑现 | PRD 痛点「入口分散」（群/任务/chat 各一套）——P0 只替换群内入口，chat 附件、任务窗口仍是老逻辑 | 文档明示为后续范围，验收不覆盖，避免误判 |
| P2-4 | SVG 归类为 image 的安全说明缺失 | `classify_media` 把 `.svg` 判为 image；`<img>` 加载 SVG 脚本不执行（安全），但应显式声明 | ImageRenderer 注释声明 SVG 安全边界 |
| P2-5 | 轨迹视图的产出文件反显匹配策略未定义 | P1「tool_result 内容与产出文件路径匹配反显」——精确路径 vs 模糊包含？ | 定纯函数 `matchArtifact(trace, media)` 单测两种形态 |

---

## 五、评审通过项（确认无误）

- ✅ ADR-021 纯读聚合视图（不新建持久化实体）——与 `group_list_deliverables` 实时聚合的事实一致，可逆性最优
- ✅ ADR-022 纯函数判定 + 组件注册表——符合项目纪律，新增类型零侵入
- ✅ ADR-024 局部 iframe sandbox 不动全局 CSP——权衡正确，相对资源缺失已显式接受
- ✅ ADR-026 attachments untagged 兼容——新数据完整、旧数据零迁移，方案正确
- ✅ 8 处 `attachments: vec![]` 仅真实落库路径需接入捕获——改动收敛点判断正确
- ✅ `roundtable_messages` 补 session_id 列的必要性（F6 断点）——验证确认存在

---

## 六、结论

| 级别 | 数量 | 处理 |
|---|---|---|
| P0 | 2 | **已修入 v0.2**（P0-1 读文件通道、P0-2 trace_ref 键收敛） |
| P1 | 3 | **已修入 v0.2**（summary 不下钻、scope 收窄、保存工作区空 path） |
| P2 | 5 | 记录在案，排后续迭代 |
| 通过 | 6 | 维持原判 |

**修订后状态**：v0.2 满足「可进入 Plan 拆任务」的门槛。建议下一步：P0 任务拆解时把 `artifact_read_text` 的命令签名、scope 校验单测、dev 模式 asset protocol 验证三项作为**首个验证 spike**，避免 P0 尾段返工。
