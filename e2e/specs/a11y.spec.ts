import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { installTauriMock } from "../helpers/tauriMock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock);
  await page.goto("/");
});

/**
 * Run axe-core with WCAG 2.1 A/AA rules. We hard-fail only on critical/serious
 * impacts (real blocking issues) and log minor/moderate ones so they can be
 * triaged without breaking the suite on first run.
 */
async function audit(page: Page, label: string) {
  // Let any entry/theme/modal transitions settle before sampling computed
  // colors. axe reads getComputedStyle mid-animation otherwise (e.g. a button
  // caught between background-color keyframes), which yields false contrast
  // failures. 300ms covers the 220ms data-theme-transition and modal fades.
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();

  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    help: v.help,
  }));
  if (summary.length) {
    console.log(`[a11y] ${label}: ${summary.length} violation(s)`, JSON.stringify(summary, null, 2));
  }

  const blocking = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(blocking, `${label} has no critical/serious WCAG AA violations`).toEqual([]);
}

test("chat page — no blocking a11y violations", async ({ page }) => {
  await audit(page, "chat");
});

test("groups page — no blocking a11y violations", async ({ page }) => {
  await page.locator(".sidebar-nav-item[data-nav=\"group\"]").click();
  await expect(page.locator(".groups-page")).toBeVisible();
  await audit(page, "groups");
});

test("create-group dialog — role/aria-modal + no blocking violations", async ({ page }) => {
  await page.locator(".sidebar-nav-item[data-nav=\"group\"]").click();
  await page.locator(".sidebar-create-btn").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await audit(page, "create-group-dialog");
});

test("settings dialog — role/aria-modal + no blocking violations", async ({ page }) => {
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await audit(page, "settings-dialog");
});

test("extensibility page — no blocking a11y violations", async ({ page }) => {
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "MCP 服务器" }).click();
  await expect(page.locator(".ext-page")).toBeVisible();
  await audit(page, "extensibility");
});
