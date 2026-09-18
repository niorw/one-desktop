import { defineConfig, devices } from "@playwright/test";

/**
 * Headless UI E2E for OneDesktop frontend.
 *
 * This runs the Vite dev server and drives the real React UI with Playwright,
 * using an injected Tauri mock backend (e2e/helpers/tauriMock.ts) so flows that
 * depend on the Rust/Tauri runtime still work without a native window.
 *
 * Two projects: chromium (fast CI baseline) + webkit (parity with the macOS
 * WKWebView the real Tauri app ships). For TRUE end-to-end against the compiled
 * binary, see e2e/tauri-driver/ (tauri-driver + WebDriverIO).
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 30_000,
  expect: { timeout: 6_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
