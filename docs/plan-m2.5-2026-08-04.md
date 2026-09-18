# M2.5 收口实施清单（2026-08-04）

> **上游**：`roadmap-m3-2026-08-04.md` §2 / §5 / §8（决议记录）
> **定位**：M3a 开工前的地基收口。**不加新功能**，只做「修断裂 + 清腐化 + 立守卫」。
> **基线**：`e64fb7f`（M2 全量落地）· cargo 77/77 · E2E 36/36 · tsc 零错误
> **总验收**：全部任务完成后，上述三项测试仍全绿，且新增守卫 `npm run check` 一键通过。

---

## 0. 任务总览与依赖

| ID | 任务 | 优先级 | 依赖 | 预估 |
|----|------|--------|------|------|
| **T0** | 修 MCP × Worker 断裂（能力谓词替代字面量白名单） | 🔴 P0 | — | 1.5d |
| **T0.5** | `SessionKind` 显式化（拆除与 `auto_approve_override` 的耦合） | 🔴 P0 | — | 0.5d |
| **T1** | IX-17 审批快循环（防 T0 引发弹窗地狱） | 🔴 P0 | T0 | 1.5d |
| **T2** | 拆 `<R: Runtime>` 泛型传染链 + 清内核 `use tauri::` | 🟡 P1 | — | 2d |
| **T3** | `npm run check` + `check-kernel-purity.sh` + pre-push hook | 🟡 P1 | T2 | 0.5d |
| **T4** | 成本单价表落 `settings`（去硬编码） | 🟢 P2 | — | 0.5d |

**关键约束**：**T0 与 T1 必须同批次交付**。T0 让 MCP 工具在 Worker 下从「静默不可见」变为「默认 Ask」，审批量会成倍上升（5 Worker × 3 MCP 工具 = 15 次弹窗）。只做 T0 不做 T1，等于把「功能缺失」换成「体验灾难」。

**可并行**：T2/T4 与 T0/T0.5/T1 无耦合，可并行推进。T3 必须在 T2 之后（否则守卫一上来就是红的）。

---

## T0 · 修 MCP × Worker 断裂 🔴

### 问题复述

`WORKER_DEFAULT_ALLOWED = ["read_file","write_file","list_dir","get_weather"]` 被同时用作两件事：

1. `permission::decide()` 的 Worker 默认矩阵 —— 不在名单 → `Deny`；
2. `ToolScope::only(...)` 的**硬边界** —— 不在名单 → 连审批机会都没有（`engine_toolrun.rs:161` 的 `tool_scope.allows()` 前置拦截）。

MCP 工具名形如 `mcp__{server}__{tool}`，**永远不匹配**。结果：用户接好的 MCP Server 在单聊可用，一升级成群，所有 Worker 静默失去全部 MCP 能力，界面无任何提示。**R1 × R7 的组合价值归零。**

### 设计决策：白名单 → 能力谓词

不再枚举「允许哪些工具名」，改为判定「这个工具属于哪一类副作用」。

```
风险分级（新增 permission::risk_class）
├─ Safe      本地只读 / workspace 内读写 / 无鉴权只读查询  → Worker: Allow
│            read_file, list_dir, write_file, get_weather
├─ Mediated  外部能力，副作用取决于对端（MCP 工具全部归此类）→ Worker: Ask（冒泡审批）
│            mcp__*
└─ Dangerous 任意代码执行 / 改宿主状态                       → Worker: Deny（可配置覆盖）
             run_shell, update_memory
```

**为什么 MCP 归 `Mediated` 而非 `Safe`**：MCP Server 是用户自己接的第三方进程，能力边界不可知（可能是只读查天气，也可能是删库）。默认 Allow 违背 fail-closed；默认 Deny 则功能不可用。**`Ask` 是唯一诚实的答案**——把判断权交还给唯一的裁判：人。这与 §单机约束「人始终是唯一裁判」一致。

**为什么不做「首次 Ask，之后记住」**：那是 T1 的职责（`此工具本次会话不再问`），权限层只管判定，不管记忆。职责分离。

### 落点

| 文件 | 改动 |
|------|------|
| `src-tauri/src/agent/permission.rs` | 新增 `pub enum RiskClass { Safe, Mediated, Dangerous }` + `pub fn risk_class(tool: &str) -> RiskClass`；`decide()` 的 Worker 分支改用 `risk_class` 而非 `WORKER_DEFAULT_ALLOWED.contains()`；`WORKER_DEFAULT_ALLOWED` 标 `#[deprecated]` 保留一个版本（外部可能引用） |
| `src-tauri/src/group/roundtable.rs:675` | `ToolScope::only(WORKER_DEFAULT_ALLOWED)` → `ToolScope::all_except(DANGEROUS_TOOLS)` |
| `src-tauri/src/scheduler/engine.rs:235` | 同上。**注意**：定时任务无人值守，`Ask` 会走超时 fail-closed → 建议此处保持 `Only(Safe 集)`，见下方「差异化」 |
| `src-tauri/src/agent/executor.rs:143` | 同上（A2A 任务，同样无人值守） |
| `src-tauri/src/agent/toolplane.rs` | 补 `ToolScope::all_except()` 构造器（`ToolAllow::AllExcept` 变体已存在，只缺便捷构造） |

### 差异化：三种 Worker 场景不该一刀切

当前三处调用点用了同一个白名单，但**它们的「人在不在场」是不同的**：

| 场景 | 人在场？ | MCP 工具策略 | 理由 |
|------|---------|-------------|------|
| 群协作 Worker（`roundtable.rs`） | ✅ 用户正看着群 | **Ask**（冒泡审批） | 人能立刻响应，Ask 是最优解 |
| 定时任务（`scheduler/engine.rs`） | ❌ 可能凌晨跑 | **Deny**（可显式配置放行） | Ask 必然超时 fail-closed，等于 Deny 还白等 30s |
| A2A 任务（`executor.rs`） | ❌ 无人值守 | **Deny**（同上） | 同上 |

> **这是 T0 的真正设计要点**：不是「放开 MCP」，是**按「人是否在场」区分策略**。群协作放开是因为人在，定时任务不放开是因为人不在——单机产品里，「人在不在场」才是权限的第一分界线，不是「是不是 Worker」。

**实现**：`SessionKind` 从 2 态扩为 3 态 —— `User` / `AttendedWorker`（群协作，人在场）/ `UnattendedWorker`（定时/A2A）。与 T0.5 合并实施。

### 验收

- [ ] 单测：`risk_class("mcp__github__create_issue") == Mediated`；`decide(mcp 工具, AttendedWorker, ..) == Ask`；`decide(mcp 工具, UnattendedWorker, ..) == Deny`
- [ ] 单测：`run_shell` 在三种 kind 下均为 `Deny`（除非 override）
- [ ] 集成：群内 Worker 调 MCP 工具 → 前端收到 `ApprovalRequest` 事件（而非静默 `not allowed in this scope`）
- [ ] 回归：cargo 77/77 全绿（现有 `worker_matrix_fail_closed` 等测试需相应更新，**更新时逐条确认语义变化是预期的**）

---

## T0.5 · `SessionKind` 显式化 🔴

### 潜伏 bug

`engine_toolrun.rs:154-158`：

```rust
let session_kind = if deps.auto_approve_override == Some(true) {
    SessionKind::Worker
} else {
    SessionKind::User
};
```

**会话类型是从「是否跳过审批」这个开关反推出来的**。这两件事被绑死了：

- 想要「Worker 但不跳审批」→ 做不到，一传 `Some(false)` 就退化成 `User`，会尝试弹 HITL 对话框，而前端不处理 Worker 会话的审批 → **回到挂死老路**（项目记忆里记录过的坑）。
- T0 要引入三态 `SessionKind`，靠一个 bool 反推**根本表达不了**。

### 落点

| 文件 | 改动 |
|------|------|
| `src-tauri/src/agent/engine.rs`（`RunDeps` 定义处） | 新增显式字段 `session_kind: SessionKind`；`auto_approve_override` 保留但**只管审批开关**，不再兼任类型标识 |
| `engine_toolrun.rs:154-158` | 删除反推逻辑，直接 `deps.session_kind` |
| `roundtable.rs` / `scheduler/engine.rs` / `executor.rs` / `commands/agent.rs` | 各调用点显式传 `session_kind`（分别为 `AttendedWorker` / `UnattendedWorker` / `UnattendedWorker` / `User`） |

> **顺带收益**：`RunDeps` 多一个字段而非多一个参数——这正是 ADR-010 里承诺「MessageBus 加字段不加参数」的前提，M3a 会直接受益。

### 验收

- [ ] `grep -rn "auto_approve_override == Some(true)"` 结果为空
- [ ] 单测：构造 `session_kind: AttendedWorker` + `auto_approve_override: Some(false)` 不会退化为 `User`
- [ ] 回归：cargo 全绿 + E2E 36/36

---

## T1 · IX-17 审批快循环 🔴

### 为什么必须与 T0 同批

T0 之后，一个 5 Worker 的群、每 Worker 调 3 个 MCP 工具 = **15 次审批弹窗**。当前 UI 是逐个弹、逐个点，用户会在第 4 个就关掉整个应用。

### 三件套（按价值排序）

1. **键盘快循环**：审批面板聚焦时 `Y` 批准 / `N` 拒绝 / `E` 改参 / `↓` 下一条。目标 **3 次击键消化 5 条审批**。
2. **「本轮全部批准」**：按 `run_id` 聚合本轮所有 pending 审批，一键 Accept。**风险控制**：仅对同一 `RiskLevel` 生效，`Dangerous` 类不参与批量。
3. **「此工具本次会话不再问」**：写入内存态 session-scoped 豁免表（**不落库** —— 落库等于永久授权，超出用户当次意图）。

### 落点

| 层 | 文件 | 改动 |
|----|------|------|
| 内核 | `src-tauri/src/agent/approval.rs` | 新增 `pending_by_run(run_id) -> Vec<ApprovalRequest>`；新增 `decide_batch(ids, decision)`；新增 session 级豁免表 `session_exemptions: HashMap<sid, HashSet<tool>>` |
| 命令 | `src-tauri/src/commands/agent.rs` | 暴露 `decide_approval_batch` / `exempt_tool_for_session` |
| 前端 | `src/components/` 审批面板 | 聚合展示 + 键盘绑定 + 两个批量按钮 |

**样式约束**（项目硬规范）：只用 `App.css` 语义令牌，禁写死 hex/rgba；状态徽章用「中性底 + `--status-*-strong` 文字 + color-mix 35% 边框」；图标只从 `common/Icons.tsx` 取单色 SVG，禁 emoji。

### 验收

- [x] 5 条并发审批可在数击键内消化（键盘 Y/N/E/↓ 快循环 + 自动顺移；「本轮全部批准」按钮 = 聚焦后 1 击清空全部非高危项）
- [x] 「全部批准」不作用于 `Dangerous` 类（纯函数 `high_risk_pending_ids` 服务端护栏 + 单测断言）
- [x] 会话豁免不落库（内存态 `exemptions` 表，重启应用后恢复询问）
- [x] 新增 E2E 用例覆盖批量审批路径（`e2e/specs/approval-tray.spec.ts` 3 例，chromium 全绿）

---

## T2 · 拆泛型传染链 + 清内核 Tauri 引用 🟡

### 现状（实测订正）

`use tauri::` 全仓 16 处，其中**内核层仅 4 个文件**（`agent/executor.rs`、`group/roundtable.rs`、`group/scheduler.rs`、`scheduler/engine.rs`）。
**真正的成本在泛型传染**：`<R: Runtime>` / `AppHandle<R>` 全仓 62 处 —— `group/roundtable.rs` 20、`group/scheduler.rs` 12、`scheduler/engine.rs` 6、`agent/executor.rs` 5。

> `agent/ports.rs` 的 `use tauri::` **不清**。它是 ADR-001 明文指定的适配器（`TauriObserver` = 唯一知道 Tauri 的地方）。清它就是拆掉自己的承重墙。

### 手法：泛型上移，内核收窄到端口

内核函数不再接 `AppHandle<R>`，改接 `Arc<dyn RunObserver>`（已有端口）。泛型 `<R>` 上移到 `commands/` 层，在那里完成 `AppHandle<R>` → `Arc<TauriObserver<R>>` 的装配。

**推进顺序（从易到难，每步单独可编译可测）**：
1. `scheduler/engine.rs`（6 处）—— 最小，先趟通手法
2. `agent/executor.rs`（5 处）
3. `group/scheduler.rs`（12 处）
4. `group/roundtable.rs`（20 处，998 行）—— 最后打，前三步的模式已验证

> **风险**：`roundtable.rs` 是全仓最大文件且是群协作主流程。**要求**：每步完成后立即跑 `cargo test` + E2E，**不允许攒着一起验**。若第 4 步发现需要大改结构，**停下来先拆文件**再继续，不要在 998 行里做泛型手术。

### 验收

- [ ] `grep -rn "use tauri::" src-tauri/src/{agent,group,scheduler}/ --include="*.rs" | grep -v ports.rs` 为空
- [ ] `grep -rn "R: Runtime\|AppHandle<R>" src-tauri/src/{group,scheduler}/ src-tauri/src/agent/executor.rs` 为空
- [ ] 内核模块可在无 `MockRuntime` 的情况下单测（至少 `roundtable` 的一个核心函数做到）
- [ ] 回归：cargo 77/77 + E2E 36/36 + tsc 零错误

---

## T3 · 立守卫（ADR-001 落地载体）🟡

### 决策：pre-**push** hook，不是 pre-commit

单机开发高频小提交，pre-commit 跑 `cargo check` 会把每次提交拖到 30s+，开发者必然 `--no-verify` 绕过 —— **守卫被绕过就等于不存在**。pre-push 频率低、可承受，且拦得住真实风险（污染远端）。
**代价**：本地可攒脏提交。**可接受** —— 单机单人，本地脏不影响他人。

### 落点

**`scripts/check-kernel-purity.sh`**（新建，`chmod +x`）：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
KERNEL="src-tauri/src/agent src-tauri/src/group src-tauri/src/scheduler"
FAIL=0

# 规则 1：内核层禁止 use tauri::（ports.rs 是 ADR-001 指定适配器，豁免）
if HITS=$(grep -rn "use tauri::" ${KERNEL} --include="*.rs" | grep -v "agent/ports.rs" || true); [ -n "${HITS}" ]; then
  echo "❌ ADR-001 违规：内核层出现 Tauri 引用"; echo "${HITS}"; FAIL=1
fi

# 规则 2：内核层禁止 Runtime 泛型传染（ports.rs 同样豁免）
if HITS=$(grep -rn "R: Runtime\|AppHandle<R>" ${KERNEL} --include="*.rs" | grep -v "agent/ports.rs" || true); [ -n "${HITS}" ]; then
  echo "❌ ADR-001 违规：内核层出现 Runtime 泛型"; echo "${HITS}"; FAIL=1
fi

[ "${FAIL}" -eq 0 ] && echo "✅ 内核纯净度检查通过"
exit "${FAIL}"
```

> **注意**：变量一律 `${VAR}` 界定 —— `_collect.sh` 踩过全角括号并入变量名导致 `unbound variable` 的坑。

**`package.json`** 新增：

```json
"check:kernel": "bash scripts/check-kernel-purity.sh",
"check:rust":   "cd src-tauri && cargo check --all-targets && cargo test",
"check:ts":     "tsc --noEmit",
"check":        "npm run check:kernel && npm run check:ts && npm run check:rust"
```

**`.git/hooks/pre-push`**（新建，`chmod +x`）：跑 `npm run check:kernel`（秒级）。
> **只跑纯净度检查，不跑 cargo test** —— push 前等 2 分钟同样会被绕过。完整 `npm run check` 由开发者按需手动跑 / 未来接 CI。

### 验收

- [ ] `npm run check` 一键通过
- [ ] 故意在 `group/manager.rs` 加一行 `use tauri::Manager;` → `npm run check:kernel` 报错退出码非 0 → 删除后恢复
- [ ] `git push` 触发 hook（可用空提交验证）
- [ ] hook 与脚本纳入版本控制（hook 本体在 `.git/` 不入库 → **需在 `scripts/install-hooks.sh` 里提供一键安装**，并在 README 记一笔）

---

## T4 · 成本单价表去硬编码 🟢

### 现状

`agent/insight.rs:285 cost_yuan()` 硬编码 match：`deepseek (2,8)` / `gpt-4 (10,30)` / 其余 fallback deepseek 档。
ADR-005（查询期折算不固化）✅ 已遵守；但**表本身硬编码** → 用户换 Kimi / 通义 / Claude，成本显示全错且无从修改。

### 落点

- 存储：`settings` 表新增键 `cost_table`，值为 JSON `{"model_pattern": {"in": 2.0, "out": 8.0}}`。
  **不新建表** —— ADR-006 说「只加新表」是针对**领域实体**；单价表是配置，复用既有 KV 更轻，且避免为 3 行数据造一张表。
- 读取：`cost_yuan()` 签名改为接收 `&CostTable`，由 `insight` 查询入口一次性载入（避免逐行查 DB）。
- 兜底：内置 `CostTable::builtin_default()` 保持当前三档，`settings` 无值时使用 —— **零行为变更**。
- UI：设置弹窗「通用」页加入口（可选，不阻塞 T4 验收）。

### 验收

- [ ] 单测：`settings` 无 `cost_table` 时，折算结果与改动前**逐位一致**（现有 `cost_uses_deepseek_default` 测试不改也应通过）
- [ ] 单测：写入自定义单价后，折算按新值生效
- [ ] 回归：cargo 全绿

---

## 3. 完成定义（DoD）

M2.5 收口的标志，全部满足才可开 M3a：

1. ✅ 群内 Worker 能调 MCP 工具（走审批），定时/A2A 任务不能（fail-closed）
2. ✅ 5 条并发审批 3 次击键消化完
3. ✅ `npm run check` 一键通过，pre-push hook 已装
4. ✅ 内核层 `use tauri::` = 0（`ports.rs` 除外）、`<R: Runtime>` = 0
5. ✅ 换 provider 后成本显示正确
6. ✅ cargo 77+/77+ · E2E 36+/36+ · tsc 零错误
7. ✅ 本清单涉及的 ADR 增补写回 `architecture-collab-agent-m2-2026-08-03.md`：
   - **ADR-002 增补**：`SessionKind` 三态化 + 风险分级谓词（替代字面量白名单）
   - **ADR-005 增补**：单价表存储位置定为 `settings.cost_table`

---

## 4. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| T2 在 `roundtable.rs`（998 行）翻车 | 中 | 高 | 分 4 步走、由小到大、每步独立验；若需大改则**先拆文件再动泛型** |
| T0 改权限矩阵破坏现有测试语义 | 高 | 中 | 测试**必然要改**；要求逐条 review 确认语义变化是预期的，**禁止批量改断言值凑绿** |
| T1 前端改动引发视觉快照大面积失败 | 中 | 低 | 沿用 `maxDiffPixelRatio: 0.015`；截图前 blur activeElement（既有惯例） |
| pre-push hook 被 `--no-verify` 绕过 | 低 | 中 | 只跑秒级检查降低绕过动机；`npm run check` 保留为手动完整闸门 |
| M2.5 拖长挤压 M3 | 中 | 中 | T4 可延后至 M3a 并行；T0/T0.5/T1 是硬门槛不可砍 |
