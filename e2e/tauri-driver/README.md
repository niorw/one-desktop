# OneDesktop 真机 E2E（tauri-driver / WebdriverIO）

在**编译后的真实 `.app`** 里用 WebDriver 协议脚本化跑完整业务闭环
（建群 → 派活 → Worker 执行 → 落库 → 群主验收 → 圆桌摘要），后端是**真实的 Rust/Tauri**，不经过 mock。

> ⚠️ 必须运行在 **macOS GUI session**（会真实拉起窗口）。本沙箱是无头环境，跑不了这一步——请在你的 Mac 上执行。
> 无头环境可跑的等价 UI 测试见上层 `../README.md`（Playwright + 注入式 mock）。

底层方案：`@wdio/tauri-service` 的 **embedded provider**（macOS 原生，无需单独安装 `tauri-driver` 二进制）+ `tauri-plugin-wdio`（Rust 侧插件，提供 execute / mock / 日志转发）。

---

## 0. 前置（一次性）

- Node.js 18+
- Rust 工具链：`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- 已 `npm install`（根目录）

## 1. 在 Rust 侧接入 `tauri-plugin-wdio`

### a) `src-tauri/Cargo.toml` 增加依赖
```toml
[dependencies]
tauri-plugin-wdio = "1"
# 其它既有依赖保持不变
```

### b) `src-tauri/src/lib.rs` 注册插件（现有插件链在 143-145 行附近）
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_wdio::init())   // ← 新增这一行
```

### c) 已完成的配置（无需再改）
- `src-tauri/tauri.conf.json` 已加 `"withGlobalTauri": true`
- `src-tauri/capabilities/default.json` 已加 `"wdio:default"` 权限

> 安全提示：`tauri-plugin-wdio` 主要服务于测试。若不想让它进入 release 产物，可将其设为
> `optional = true` 并用 cargo feature 门控（`.plugin()` 处加 `#[cfg(feature = "webdriver")]`），
> 测试构建时 `cargo tauri build --features webdriver`。当前为简单起见直接编译进应用。

## 2. 安装 WebdriverIO 依赖（本目录）
```bash
cd e2e/tauri-driver
npm install
```

## 3. 构建带插件的 app
```bash
# 回到仓库根
npm run tauri build
# 产物：src-tauri/target/release/bundle/macos/OneDesktop.app
```

## 4. 运行真机 E2E
```bash
cd e2e/tauri-driver
npm test
# 或自定义 app 路径：
APP_PATH=/abs/path/OneDesktop.app npm test
```

`@wdio/tauri-service` 会自动启动 `.app` 并拉起 WebDriver 服务，测试脚本（`specs/fullchain.e2e.ts`）
通过真实窗口点击/填写，断言各步骤 UI 正确刷新。

---

## 故障排查

- **`Error: Tauri plugin not available`** → 第 1 步的 Rust 插件没编译进 app，确认 `cargo build` 成功且插件已注册。
- **窗口没起来 / 连不上 WebDriver** → 确认是在 macOS GUI session 跑（不是 SSH / 无头 shell）；首次构建需联网拉取 `tauri-plugin-wdio` crate（可用 `https_proxy`）。
- **`wdio:default` 权限报错** → 确认 `capabilities/default.json` 已包含该权限且 rebuild 了 app。
- **选项名不匹配** → `@wdio/tauri-service` 跨版本配置项可能变化，以你安装的版本 README 为准（`npm view @wdio/tauri-service` 看版本）。
