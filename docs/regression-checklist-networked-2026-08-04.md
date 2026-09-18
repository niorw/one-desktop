# 联网回归验证清单（M2.5 收口）

> 用途：在**有 LLM 网络可达**的 macOS 环境，确认 M2.5（T0–T4）全量落地后不回退。
> **本环境实跑（2026-08-04）结果：①④ 离线全绿，⑤ 挂起、⑥ 跑不了——根因是「真实 LLM 对话端点 hanging + Playwright 浏览器 CDN 被出口拦截」，并非纯无网**（DeepSeek 根路径 `curl` 能 401 返回，但 SDK 对话请求挂死）。详见 §6。
> 本清单同时是后续每次大改后的回归 runbook，可复用。

---

## 0. 适用范围与前置条件

### 适用场景
- 当前分支 `onedesktop-20260803`（= `e64fb7f` 之上叠加 M2.5 未提交改动）。
- 工作区有大量未提交改动（T0–T4 + 文档 + 新文件），**先确认 `git status` 干净或可还原**再跑，避免回归失败时无法二分。
- 目标：复跑 ① 内核纯净度 ② 编译零警告 ③ tsc 零错 ④ 全量 `cargo test` (含 integration_test) ⑤ E2E（含 approval-tray）。

### 环境前置
| 项 | 要求 | 说明 |
|---|---|---|
| macOS + 终端 | 必需 | 本机开发机，非 CI |
| LLM API Key | `DEEPSEEK_API_KEY`（默认 Provider `deepseek-chat`）或切 OpenAI | `integration_test` 5 例 + 部分 E2E 路径真实调用 |
| 网络 | 可达 LLM API 与 npm registry | cargo 依赖若已缓存则无需重拉 |
| Node / Rust 工具链 | node 22 + cargo | 与 `package.json`/`Cargo.toml` 匹配 |
| Playwright 浏览器 | `npx playwright install chromium webkit` | E2E 用；首次需装 |
| 端口 1420 空闲 | E2E 前释放 | `lsof -ti :1420 \| xargs kill` |

### 代理注意（踩坑实证）
- **Gitee 操作必须清代理**：`https_proxy= http_proxy= git ...`，否则走 7890 失败。（本清单默认不碰 git，可忽略）
- **首次拉 Rust 依赖需代理**：`https_proxy=http://127.0.0.1:7890 cargo build`。增量编译无需。若依赖已缓存，跳过。
- LLM API 调用**不走** 7890 代理（直连 DeepSeek/OpenAI），无需设代理。

---

## 1. 执行顺序（失败快速暴露）

设计原则：先跑**秒级、无需网络**的廉价检查，再跑**重、需网络**的全量测试。任一前置失败即停，不浪费时间。

```
① npm run check:kernel      (秒级, 无网)  ← 内核纯净度守护
② npx tsc --noEmit          (秒级, 无网)  ← TS 类型
③ cd src-tauri && cargo check --tests   (慢, 无网)  ← Rust 编译零警告
④ cargo test --lib -- --skip integration_test::  (中, 无网, 无头安全)  ← 纯单测 79/79
⑤ cargo test --lib (真机 macOS, 有事件循环)  (慢)  ← 82 run + 2 live ignored；--ignored 再含 2 live(需网+Key)
⑥ npm run test:e2e          (重, Mock Tauri, 无 LLM 网)  ← E2E 36 + approval-tray 3
```

---

## 2. 逐步命令与预期

### ① 内核纯净度（必过，pre-push 也会卡）
```bash
npm run check:kernel
```
- **预期**：`OK: 内核纯净度检查通过 —— 内核层无 Tauri 运行时直接依赖（仅 agent/ports.rs 适配）。` 退出码 0。
- **失败排查**：若 FLAG，看报哪行。内核层（`agent`/`group`/`scheduler` 除 `ports.rs`）出现 `use tauri::` 或 `<R: Runtime>`/`AppHandle<R>` → 某次编辑回潮了泛型。修回端口抽象。
- ⚠️ 文档注释 `/// AppHandle<R>` 已被跳过滤，不应误报。

### ② TypeScript 类型检查
```bash
npx tsc --noEmit
```
- **预期**：零错误，无输出。
- **失败排查**：前端新增 `ApprovalTray`/`useApprovalTray`/`store/` 等若类型不全会在此爆。按报错修。

### ③ Rust 编译零警告（含 test target）
```bash
cd src-tauri && cargo check --tests
```
- **预期**：**零警告**，退出码 0。`--tests` 才会暴露 `compaction.rs` 类 test-only 未用变量。
- **失败排查**：
  - `unused variable` / `unused_must_use`：补 `_` 或 `let _ =`。
  - `cannot move out of ... Arc` (E0507)：`.state::<Arc<T>>().clone()` 只克隆 State 包装，需 `.inner().clone()` 取独立 Arc。
  - **capability 编译阻断**：若改了 `capabilities/default.json` 引用未装插件权限集（如曾误写 `wdio:default`），报 `Permission wdio:default not found`。窗口拖动需 `core:window:allow-start-dragging`。

### ④ 纯单测（离线子集，先隔离跑）
```bash
# 临时注释 src-tauri/src/lib.rs 的 `mod integration_test;`（若尚未注释）
# 跑纯单测
cd src-tauri && cargo test --lib
# 跑完恢复 mod integration_test;
```
- **预期**：**79 passed / 0 failed**（覆盖所有 M2.5 改动模块：group::roundtable 7/7、agent::insight 2/2、agent::compaction 1/1 等）。
- **目的**：先确认纯逻辑不回退，再跑需网的全量，便于二分"是网络问题还是代码回退"。

### ⑤ 全量 cargo test（含 integration_test）

> **2026-08-05 三次纠偏（推翻前两次归因）**：挂起根因**既不是 LLM 端点，也不是 mock_builder**。
> 逐段打点实证：`mock_builder().build()` 与 `wire_states` 在沙箱**均正常返回**；挂死在
> `InsightQueries::group_summary/seat_summary` —— F8 清雷时把 cost 折算移进 `with_conn`
> 闭包内调 `cost_table()`（内部再次 `with_conn`），**std Mutex 非重入 → 自死锁**。
> 已修复（cost_table 移到闭包外）+ 2 项 watchdog 回归测试。**结论：integration_test 在沙箱可跑**，
> 3 个纯 DB + 2 个 live（`--ignored` + key）全部通过；live 测试须 `--test-threads=1` 串行
> （HOME 重定向是进程级，并发互相污染）。

```bash
# 任意环境（含无头沙箱，无需网）：
cd src-tauri && cargo test --lib
#   → 187 纯单测（+2 死锁回归）+ 3 纯 DB integration = 190 run；2 个 live LLM 默认 #[ignore] 跳过

# 跑 live 测试（需网+Key）：串行执行，避免 HOME 重定向互相污染
DEEPSEEK_API_KEY=sk-xxx ONDESKTOP_LIVE_INTEGRATION=1 \
  cargo test --lib integration_test:: -- --ignored --test-threads=1
```

- **预期**：`cargo test --lib` → **187 passed**（唯一失败 `seed::tests::seed_populates_from_workbuddy` 为预存在环境问题）+ 3 纯 DB integration；`--ignored --test-threads=1` + key → 2 个 live 真实 LLM 通过（≈7s）。
- ⚠️ **勿临时注释 `mod integration_test`**：现用 `--skip integration_test::` 或直接全跑均可，无需改 `lib.rs`。

### ⑥ E2E（Mock Tauri，无需 LLM 网）
```bash
lsof -ti :1420 | xargs kill          # 释放 Vite 端口
npm run test:e2e
```
- **预期**：**36 + approval-tray 3 = 39 passed**（chromium + webkit）。
- ⚠️ **mock 必须覆盖全部命令**：E2E 走 `e2e/helpers/tauriMock.ts`，漏实现命令以 `TypeError` 炸页面。M2.5 新增 `ApprovalTray` 相关命令若未在 mock 注册 → 直接崩。报 `group_list_worker_metrics` 类缺失就补 mock。
- ⚠️ **主题驱动 React 状态**：点侧栏切换按钮，禁直接改 `data-theme`（`useTheme` passive effect 异步写回会整页翻转）。
- ⚠️ **截图前等侧栏落定**：`waitForFunction(() => sidebar.getBoundingClientRect().width > 200)`。

---

## 3. 通过判定（Definition of Done）

全部满足才算 M2.5 回归通过：

- [ ] ① `npm run check:kernel` → OK
- [ ] ② `tsc --noEmit` → 零错误
- [ ] ③ `cargo check --tests` → 零警告
- [ ] ④ `cargo test --lib -- --skip integration_test::` → 79/79（无头安全；真机可直接 `cargo test --lib`）
- [ ] ⑤ `cargo test --lib`（真机 macOS）→ 82 run + 2 live ignored；`--ignored` + env+key 含 2 live 真实 LLM
- [ ] ⑥ `npm run test:e2e` → 39/39（36 + approval-tray 3）

---

## 4. 收尾动作（回归通过后）

1. **提交 M2.5 改动**：`git add -A -- . ':!.workbuddy' ':!.test-evidence' ':!generated-images'`（排除私有目录，含 MEMORY.md 不入库）。
2. **pre-push 已守护**：push 时 `check:kernel` 自动卡，违反则挂住推送。
3. **同步 master**：确认无回退后 `git checkout master && git merge --ff-only onedesktop-20260803`（master 落后 4 提交）。
4. **更新 handoff**：`bash docs/handoff/_collect.sh` 生成当日交接快照。
5. **进入 M3a**：M2.5 收口无误后，开始 F7 黑板 / F5 Worker 通信 / F6 心跳（见 `docs/roadmap-m3-2026-08-04.md`）。

---

## 5. 已知陷阱速查（踩坑实证）

| 现象 | 根因 | 对策 |
|---|---|---|
| `integration_test` 挂起 20min | 无网/Key 错，真实调 LLM 超时 | 先跑 ④ 隔离；⑤ 超 3min 检查 Key/网 |
| E0507 cannot move out of Arc | `.state::<Arc<T>>().clone()` 克隆的是 State 包装 | 改 `.inner().clone()` 取独立 Arc |
| E2E 页面 TypeError 炸 | tauriMock 漏实现新命令 | 补 `e2e/helpers/tauriMock.ts` 命令桩 |
| capability 编译失败 | 引用未装插件权限集 | 核对 `capabilities/default.json`，放行 `core:window:allow-start-dragging` |
| `check-kernel-purity.sh` 误报 unbound | 与沙箱 safe-bin `-u` 交互 | 脚本已用 `set -eo pipefail`（去 nounset），勿改回 `-euo` |
| 整页主题翻转（E2E 截图） | 直接改 `data-theme` | 点切换按钮驱动 React 状态 |
| 1420 端口占用 | 上次 Vite 未回收 | `lsof -ti :1420 \| xargs kill` |
| `playwright install` 静默失败 | 浏览器 CDN 出口被拦，`RC=0` 但 `~/.cache/ms-playwright` 不生成 | 需到真正的联网 mac 跑；本环境装不了 |

---

## 6. 本环境实跑记录（2026-08-04）

在「当前对话沙箱」实跑，用于交叉验证 M2.5 不回退。**结论：能验的离线项全绿，卡住的两项是环境依赖不是代码**。

### 6.1 实测结果表

| 步 | 命令 | 结果 | 说明 |
|---|---|---|---|
| ① 内核纯净度 | `npm run check:kernel` | ✅ OK（退出 0） | 守卫有效 |
| ② TS 类型 | `npx tsc --noEmit` | ✅ 零错误 | — |
| ③ 编译零警告 | `cd src-tauri && cargo check --tests` | ✅ 零警告 | 增量编译，1.57s |
| ④ 纯单测 | `cargo test --lib`（临时注释 `mod integration_test`） | ✅ **79 passed / 0 failed** | 18s，覆盖 M2.5 全部模块 |
| ⑤ 全量（含 integration_test） | ✅ 沙箱可跑：187 纯单测 + 3 纯 DB + 2 live（--ignored --test-threads=1 + key） | 2026-08-05 修复 F8 嵌套自锁（with_conn 内调 cost_table）后全通 | 见 6.2 |
| ⑥ E2E | `npm run test:e2e` | ⚠️ **跑不了** | 见 6.3 |

### 6.2 ⑤ 为什么挂起（**二次纠偏：根因是 Tauri mock 脚手架，不是 LLM**）

- 初判（错）：`curl` 根路径 401 → 以为是「chat 端点 hanging」。
- **实判（对）**：给 2 个 live 测试加 `#[ignore]` 后重跑 `cargo test --lib`，**仍挂**（test 二进制 4min CPU 0%、无 deepseek 连接）。说明挂起与 LLM 无关——是 `tauri::test::mock_builder().build()` 在**本无头沙箱卡死**（缺事件循环/display 基础设施）。
- **影响范围**：全部 5 个 integration 测试（含 3 个纯 DB 测试）都先 boot mock App → **只要 `integration_test` 模块活跃，`cargo test` 在无头环境必挂**。真机 macOS（有事件循环）不受影响，3 个纯 DB 测试秒过。
- **结论**：本沙箱可验证上限 = 79 纯单测（用 `--skip integration_test::`）；5 个 integration 属真机验收项。这与「沙箱限制」定性一致，只是根因从「LLM 端点」更正为「Tauri mock 无头挂死」。
- 处置：kill 挂起 run；`cargo check --tests` 零警告（确认 `#[ignore = "..."]` 语法编译通过）；`cargo test --lib -- --skip integration_test::` → **79 passed; 0 failed; 5 filtered out; 1.77s**，无挂。

### 6.3 ⑥ 为什么跑不了

- `npx playwright install chromium`（及 chromium+webkit）多次实跑：`RC=0`、**空日志**、`~/.cache/ms-playwright` 目录**始终不存在** → 浏览器 CDN（不同于 DeepSeek API 域）在本环境被**出口拦截**，包装层让失败静默退出 0。
- 后果：E2E 无法启动（缺浏览器二进制），「39/39」项无法在本环境验证。

### 6.4 对清单 §5 的修正

- 「`integration_test` 挂起」根因**三次修正（最终定论）**：第一次误判「LLM 端点 hanging」、第二次误判「`mock_builder()` 无头卡死」——**2026-08-05 逐段打点实证**：`mock_builder().build()` 与 `wire_states` 均正常返回，真正挂死在 `InsightQueries::group_summary/seat_summary` 的 **F8 嵌套自锁**（`with_conn` 闭包内调 `cost_table()` → 内部再次 `with_conn`，std Mutex 非重入）。诊断法：在命令/查询层逐段打点（`eprintln`）确认挂点。**已修复 + 2 项 watchdog 回归测试，integration_test 在沙箱全通**。
- live 集成测试须 `--test-threads=1` 串行（HOME 重定向为进程级，并发互相污染）。
- 新增陷阱「`playwright install` 静默失败」入 §5 速查表（见上）。
- 离线 4 项（①②③④）已交叉验证 M2.5 代码不回退；纯单测 79 例覆盖：approval 批决 + `high_risk_pending_ids` 护栏、permission `attended/unattended_worker` 风险矩阵、insight T4 成本表、roundtable 去泛型 `seed_*` 4 例、mcp 往返等。

### 6.5 仍需你联网 mac 复跑的项

- **⑤ `cargo test --lib`（真机 macOS）**：默认 82 run（79 lib + 3 纯 DB）+ 2 live `#[ignore]`；`--ignored` + `ONDESKTOP_LIVE_INTEGRATION=1` + `DEEPSEEK_API_KEY` 再跑 2 live 真实 LLM。无头环境用 `--skip integration_test::` 拿 79/79。
- **⑥ `npm run test:e2e`（39/39）**：Playwright 浏览器已装（或能装）的联网 mac 跑。
- 跑通后按 §4 收尾：提交（排除 `.workbuddy`）→ pre-push 卡 `check:kernel` → 同步 master（落后 4 提交）→ 进 M3a。
