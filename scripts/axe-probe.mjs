// Quick repro: load home, run axe, dump failing nodes HTML + selector + colors.
import { chromium } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript({ content: `
  // minimal Tauri mock so app boots
  window.__TAURI_INTERNALS__ = { transformCallback: () => 0 };
  window.__TAURI__ = { core: { invoke: async () => ({}), transformCallback: () => 0 } };
`});
await page.goto("http://localhost:1420/");
await page.waitForTimeout(800);

const results = await new AxeBuilder({ page })
  .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
  .analyze();

for (const v of results.violations) {
  if (v.impact !== "critical" && v.impact !== "serious") continue;
  console.log(`\n[${v.id}] ${v.impact} - ${v.help}`);
  for (const node of v.nodes) {
    console.log(`  selector: ${node.target.join(" >> ")}`);
    console.log(`  html: ${node.html.slice(0, 200)}`);
    for (const any_ of node.any) {
      if (any_.data) console.log(`  any.data:`, JSON.stringify(any_.data));
    }
  }
}

await browser.close();
