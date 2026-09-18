# 多模型家族思考能力 + 自定义端点 token 配置

落地日期：2026-08-09
关联：`docs/thinking-mode-foundation.md`（DeepSeek 思考开关地基）

## 一句话

把「思考深度」这个统一开关，翻译成 DeepSeek / Qwen / GLM / Kimi / MiniMax 五家各自的请求参数方言；
把五家各不相同的推理响应字段归一成一个 `reasoning_content`；
并允许任意 OpenAI 兼容端点自定义 usage 字段映射。

## 一、核心判断：不做五个 Provider

五家全是 OpenAI 兼容线格式（`POST /chat/completions` + SSE），差异只有三处：

| 家族 | 思考请求参数 | 推理响应字段 |
|---|---|---|
| DeepSeek V4 | `thinking.type` + 顶层 `reasoning_effort` | `reasoning_content` |
| Qwen3.x（通义） | `enable_thinking` + `thinking_budget`（可限长） | `reasoning_content` |
| GLM-5.x（智谱） | `thinking.type` | `reasoning_content` |
| Kimi K2.x | 顶层 `reasoning_effort` | `reasoning_content` |
| MiniMax-M2.x | `reasoning_split: true` | ⚠️ `reasoning_details[]` 数组 |
| OpenAI | 无（o-series 另一套，本期不做） | 无 |

所以做成 **一个 `OpenAICompatibleProvider` + 一个 `ReasoningDialect` 枚举**，
而不是复制五份请求构造/SSE 解析逻辑。

顺带修掉一个既有 bug：老的 `create_provider` 只认 `"openai"`，
**其余任何名字都静默当 DeepSeek 处理**——包括拼错的名字。现在是显式映射表。

## 二、改了什么

### 内核（Rust）

| 文件 | 改动 |
|---|---|
| `llm/providers/openai.rs` | 新增 `ReasoningDialect` / `TokenConfig` / `OpenAICompatibleProvider`；`emit_thinking` 按方言发参；MiniMax `reasoning_details[]` 聚合为 `reasoning_content`；`normalize_chat_url` 自动补 `/chat/completions`。**新增 18 个单测** |
| `llm/providers/deepseek.rs` | 退化为薄封装（保留类型名 + 原 6 个测试不动），思考逻辑全部搬走 |
| `llm/mod.rs` | `create_provider_full(...)` 七参完整体；`CustomProviderDefaults` 全局兜底 |
| `llm/types.rs` / `client.rs` | `DeltaEvent.reasoning_tokens` + `LlmResponse` 两个变体带上该字段 |
| `agent/engine/engine_loop.rs` | 返回值 4 元组 → 5 元组（多带 `reasoning_tokens`） |
| `agent/ledger.rs` / `ledger_sqlite.rs` | `RunFinish.reasoning_tokens` + UPDATE 落库 |
| `storage/connection.rs` | additive 迁移：`runs.reasoning_tokens INTEGER NOT NULL DEFAULT 0` |
| `commands/agent.rs` | chat 路径读 `custom_base_url` / `token_config` / `reasoning_dialect` |
| `lib.rs` | 启动时同步把自定义端点配置灌进全局兜底 |

### 前端（TS/React）

- `types/index.ts`：`ProviderId`（7 项）、`ReasoningDialect`、`TokenConfig`；`Settings` 加三个字段
- `hooks/useSettings.ts`：`PROVIDERS` / `PROVIDER_DEFAULT_MODEL` / camelCase↔snake_case 转换 / 脏值回落
- `SettingsPage.tsx`：Provider 改下拉（7 项横排必挤爆）；Model 支持预设+自由输入；
  `provider === "custom"` 时出现「自定义端点」卡片（Base URL + 思考方言 + 4 个 token 键名）

## 三、两个容易踩的真实契约

**1. `reasoning_tokens` 不在 usage 顶层。**
OpenAI 兼容规范把它放在 `usage.completion_tokens_details.reasoning_tokens`。
只读顶层会永远拿到 0。现在两处都认（部分网关会拍平）。

**2. 它是 `completion_tokens` 的细分，不是附加量。**
所以成本折算 **仍然只用 `prompt + output`**，把 reasoning 再加一遍等于凭空多算钱。
独立列的价值是「这轮里有多少输出是花在思考上的」这种归因，不是加总。

## 四、自定义端点怎么用

设置 → Model → Provider 选「自定义（OpenAI 兼容）」：

- **Base URL**：填到 `/v1` 即可，自动补 `/chat/completions`；有反代自定义路径就填完整地址
- **思考方言**：决定「思考深度」开关发哪种参数。不确定就选 OpenAI（不发任何思考参数，最安全）
- **token 字段**：对应响应 `usage` 里的键名，留空 = 该端点没有此字段，跳过统计
  （典型场景：Anthropic 风格网关用 `input_tokens` / `output_tokens`）

关于「按 OpenAI 协议还是 Anthropic 协议」——本期确认走 **仅 OpenAI 兼容**：
Anthropic 原生协议（`/v1/messages` + `system` 独立字段 + `content` 块数组）
是另一套线格式，不是加几个字段能兼容的，需要独立 Client。
但 Anthropic 风格的 **token 字段命名**已经能通过 `TokenConfig` 映射覆盖，
这也是绝大多数网关的实际形态。

## 五、验证

```
cargo test --lib        289 passed / 0 failed
cargo check             clean
npm run check:ts        clean
npm run check:kernel    OK（内核零 tauri 依赖）
```

关键回归测试：`server_default_emits_nothing_for_every_dialect`——
默认模式下任何方言都不得往请求体塞思考字段，否则等于偷改所有既有调用点的线上行为。

## 六、已知边界 / 后续

- `reasoning_tokens` 已落库，但 Insight UI 尚未展示（需扩 `InsightQueries` + 前端类型）
- GLM 只实现了智谱口径的 `thinking.type`；百炼的 `enable_thinking` 变体可选 Qwen 方言绕过
- Anthropic 原生协议客户端未实现（本期用户明确择后）
- 各家族的预设模型列表是快捷入口，型号迭代快，列表外的直接在输入框填
