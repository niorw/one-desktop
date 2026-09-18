import { browser, $, $$, expect } from "@wdio/globals";

/**
 * Real-app full-chain E2E for OneDesktop, driven through the actual compiled
 * .app window (WebDriver protocol). Mirrors e2e/specs/fullchain.spec.ts but
 * exercises the REAL Rust/Tauri backend (no mock).
 *
 * Requires:
 *  - macOS GUI session
 *  - `tauri-plugin-wdio` registered in the Rust app (see README)
 *  - a built release .app at src-tauri/target/release/bundle/macos/OneDesktop.app
 */
describe("OneDesktop 真实 app 全链路 (tauri-driver)", () => {
  const byText = (s: string) => $(`//*[contains(., "${s}")]`);

  it("建群 → 派活 → 后端完成 → 验收 → 圆桌摘要", async () => {
    // 1) navigate to groups
    await byText("群协作").click();
    await $(".groups-page").waitForDisplayed();

    // 2) create a new group
    await byText("新建群").click();
    const modal = await $(".modal-wide");
    await modal.waitForDisplayed();
    const inputs = await modal.$$("input");
    await inputs[0].setValue("测试群A");
    await inputs[1].setValue("端到端验证用群");
    const select = await modal.$("select");
    await select.selectByVisibleText("Researcher");
    await modal.$(".modal-actions .btn-primary").click();
    await byText("测试群A").waitForDisplayed();

    // 3) dispatch a task on the seeded demo group
    await byText("竞品分析群").click();
    await $(".group-detail").waitForDisplayed();
    await byText("派活").click();
    await $(".group-dispatch").waitForDisplayed();
    await byText("添加子任务").click();
    await $(".dispatch-desc").setValue("撰写竞品对比报告");
    await byText("并行派发").click();
    await $(".batch-card").waitForDisplayed();

    // 4) backend finishes the batch → awaiting banner → owner accepts
    await $(".batch-banner").waitForDisplayed({ timeout: 15_000 });
    await $(".batch-banner .btn-primary").click();
    await $(".batch-accepted").waitForDisplayed();

    // 5) roundtable summarize
    await byText("圆桌").click();
    await $(".roundtable").waitForDisplayed();
    await $(".rt-summarize-btn").click();
    await $(".rt-summary").waitForDisplayed({ timeout: 15_000 });
  });
});
