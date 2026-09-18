# DeepSeek 思考开关 — 技术架构与落地总结

> ArchitectUX 交付物：思考模式（thinking）请求级开关已从内核一路接通到前端「思考深度」设置。

## 1. 架构决策

- **思考是请求级参数开关，不是模型选择**。DeepSeek V4 默认 `thinking` 已 enabled；缺口不在"开思考"，而在"能关省 token / 可调深浅"。
- **承载位置**：`thinking` 参数放在 `DeepSeekProvider` 内部按模式推导，**不改 `LlmProvider` trait 签名**，规避穿透 7 个 `create_provider` 调用点。`create_provider` 保持零改动（默认 `ServerDefault`），兼容所有既有调用方。
- **OpenAI 分支**：忽略该参数（其推理开关走另一套字段，硬塞会 400）。

## 2. 设计令牌（语义映射）

| UI 值 | 存储键 `thinking_mode` | `ThinkingMode` | 请求体效果 |
|---|---|---|---|
| 跟随默认 | `default` | `ServerDefault` | 不落字段，跟随服务端默认 |
| 关闭 | `off` | `Disabled` | `{"thinking":{"type":"disabled"}}` |
| 标准 | `on` | `Enabled{None}` | `{"thinking":{"type":"enabled"}}` |
| 深度 | `high` | `Enabled{Some("high")}` | 上述 + 顶层 `reasoning_effort:"high"` |

> UI 值直存 `default/off/on/high`，与 `ThinkingMode::from_setting` 严格对齐；脏值（如 `standard`/`turbo-ultra`）安全降级 `ServerDefault`，绝不构造会 400 的请求。

## 3. 文件落点

| 层 | 文件 | 改动 |
|---|---|---|
| 内核 · Provider | `src-tauri/src/llm/providers/deepseek.rs` | `ThinkingMode` 枚举 + `with_thinking()` + `build_request_body` 注入 `thinking.apply()` + 6 单测 |
| 内核 · 工厂 | `src-tauri/src/llm/mod.rs` | `create_provider_with_thinking(name, api_key, model, thinking)` 薄封装 |
| 命令 · chat 主路径 | `src-tauri/src/commands/agent.rs` | 读 `get_setting("thinking_mode")` → `create_provider_with_thinking(...)`；trace 增 `thinking` |
| 前端 · 类型 | `src/types/index.ts` | 新增 `ThinkMode` 类型 + `Settings.thinkingMode` 字段 |
| 前端 · 状态 | `src/hooks/useSettings.ts` | DEFAULT + load（`thinking_mode` 键）+ save |
| 前端 · 设置 UI | `src/components/settings/SettingsPage.tsx` | 模型卡新增「思考深度」SegmentedControl（跟随默认/关闭/标准/深度，标注"影响所有对话"） |

> `ThinkMode`（模型推理开关）区别于既有 `ThinkDensity`（UX 展示密度，仅圆桌生效）——两者职责隔离，不混淆。

## 4. 实测契约（Python + 代理 127.0.0.1:7890，已联网核实）

- 无 `thinking` 字段 → reasoning_len ≈180；`enabled` →172；`disabled` →0（completion 仅 2 token，答案仍对，≈40× 省 token）；`enabled+high` →217
- `reasoning_effort` 是**顶层**字段（非 `thinking` 内嵌）；白名单 `none/minimal/low/medium/high/xhigh/max`，非法值直接 400 回吐合法集合
- legacy alias（`deepseek-chat`/`deepseek-reasoner`）+ `thinking` 不 400；`flash+disabled` →0

## 5. 校验结果（全绿）

- `cargo test --lib llm::providers::deepseek` → **8 passed**（含 6 新增）
- `npm run check:ts` → **0 错误**
- `npm run check:kernel` → 内核纯净度通过（`llm/` 属内核无 tauri；`commands/agent.rs` 本就允许 tauri）

## 6. 未提交 & 下一步

- 当前 HEAD 停 08-07，本轮 6 文件改动全未入库。
- **明天第一件事**：拆提交（Rust 思考开关内核 + 前端设置）→ 跑全量 `cargo test --lib`。注意 `insight.rs` watchdog 是**无条件** `sleep(10s)→process::exit(99)`，全量测试必被击杀，需先改 watchdog 或单独跑非 insight 测试。
- 顺带确认 `engine_toolrun.rs:147` 并行 tool_calls 仅 `i==0` 塞 reasoning 在 V4 严格校验下是否安全。
