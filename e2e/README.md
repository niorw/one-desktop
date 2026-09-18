# OneDesktop 端到端测试（E2E）

两层测试策略，覆盖「能跑在 CI 的无头 UI 测试」与「真机窗口级别的端到端测试」。

| 层 | 工具 | 跑在哪 | 后端 | 用途 |
|---|---|---|---|---|
| **① 无头 UI E2E** | Playwright + WebKit/Chromium | 任意环境（含本沙箱） | 注入式 mock（`helpers/tauriMock.ts`） | 可访问性审计、视觉回归基线、UI 全链路走查（真实 React 组件代码路径） |
| **② 真机 E2E** | tauri-driver + WebDriverIO | **macOS GUI session**（需真实窗口） | 真实 Rust/Tauri 后端 | 在编译后的 `.app` 里脚本化跑完整业务闭环 |

> 后端「建群→派活→Worker 执行→落库→摘要」的真实逻辑已由 `src-tauri/src/integration_test.rs` 的 Rust 集成测试覆盖并 PASS（门控真实 LLM）。
> 层 ① 用 mock 后端补的是「UI 层 + 组件交互」这一环，且可在无头环境跑，适合 CI；层 ② 补的是「真实 app 窗口」这一环。

---

## ① 无头 UI E2E（现在就能跑）

```bash
# 安装浏览器（首次）
npx playwright install chromium webkit

# 跑全部（a11y + 视觉 + 全链路）
npm run test:e2e

# 仅某一项
npx playwright test --config e2e/playwright.config.ts e2e/specs/a11y.spec.ts
npx playwright test --config e2e/playwright.config.ts e2e/specs/fullchain.spec.ts

# 首次生成视觉基线（之后 toHaveScreenshot 自动对比）
npm run test:e2e:update
```

- 配置：`e2e/playwright.config.ts`（自动起 vite dev server，baseURL `http://localhost:1420`）
- mock 后端：`e2e/helpers/tauriMock.ts` —— 通过 `page.addInitScript` 注入 `window.__TAURI_INTERNALS__`，内存态模拟群组/Worker/任务/消息/摘要，并在 `group_assign_tasks` / `group_roundtable_summarize` 后异步推送 `group-event(batch_completed)` / `roundtable-summary` 事件，驱动真实 UI 状态流转。
- 视觉基线存于：`e2e/specs/**/__screenshots__/`（按 chromium / webkit 分目录）

### 已知边界
- 扩展页（MCP/Skill/插件）在 mock 下返回空列表，故可视化基线捕获的是空状态；详情抽屉（DetailDrawer）复用与弹窗同一套 `useDialogA11y` hook，已被代码覆盖 + a11y 审计同一机制验证。
- 视觉回归对字体/渲染像素敏感，首次 `test:e2e:update` 建立基线后，跨平台（chromium vs webkit）会有差异，建议以单一项目（如 chromium）作为基线基准。

---

## ② 真机 E2E（tauri-driver，需 macOS GUI）

真实 app 跑在 WKWebView 上，需要真实窗口与 GUI session，**无法在无头沙箱运行**。详见 `e2e/tauri-driver/README.md`。

```bash
cd e2e/tauri-driver
# 1) 安装 tauri-driver（需 Rust 工具链）
cargo install tauri-driver
# 2) 在 tauri.conf.json 开启 webdriver（见 tauri-driver/README.md，注意你的 Tauri 2.x 小版本语法）
# 3) 安装 WebdriverIO 依赖
npm install
# 4) 构建带 webdriver 的 app，启动 tauri-driver（默认 4444 端口），另开终端跑：
npx wdio run wdio.conf.ts
```

---

## 目录结构

```
e2e/
├── playwright.config.ts        # 层①配置（dev server + chromium/webkit）
├── helpers/tauriMock.ts        # 注入式 Tauri mock 后端
├── specs/
│   ├── a11y.spec.ts            # axe-core WCAG 2.1 AA 审计
│   ├── visual.spec.ts          # 视觉回归基线（亮/暗）
│   └── fullchain.spec.ts       # mock 后端 UI 全链路：建群/派活/验收/摘要
├── tauri-driver/               # 层②真机 harness
│   ├── README.md
│   ├── wdio.conf.ts
│   ├── package.json
│   └── specs/fullchain.e2e.ts
└── README.md                   # 本文件
```
