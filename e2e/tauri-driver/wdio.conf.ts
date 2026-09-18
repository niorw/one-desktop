import type { Options } from "@wdio/types";

/**
 * WebdriverIO + @wdio/tauri-service config for TRUE end-to-end testing of the
 * compiled OneDesktop .app on macOS.
 *
 * The `@wdio/tauri-service` uses the *embedded* webdriver provider on macOS,
 * which launches the app and starts the WebDriver server natively — no separate
 * `tauri-driver` binary required.
 *
 * NOTE: option names below follow @wdio/tauri-service v1. If your installed
 * version differs, verify against `npx wdio run wdio.conf.ts --help` / the
 * package README. This config is the documented scaffold; it must be run on a
 * macOS GUI session (it opens a real window), NOT in a headless CI shell.
 */
const APP_PATH =
  process.env.APP_PATH ||
  "../../src-tauri/target/release/bundle/macos/OneDesktop.app";

export const config: Options.Testrunner = {
  runner: "local",
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { project: "./tsconfig.json", transpileOnly: true },
  },
  specs: ["./specs/**/*.e2e.ts"],
  logLevel: "info",
  bail: 0,
  baseUrl: "http://localhost",
  services: [
    [
      "tauri",
      {
        app: APP_PATH,
        driverProvider: "embedded", // macOS native embedded provider
      },
    ],
  ],
  capabilities: [
    {
      browserName: "safari", // Tauri reports its webview as Safari on macOS
      // @ts-expect-error tauri-specific capability namespace
      "tauri:options": { application: APP_PATH },
    },
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },
};
