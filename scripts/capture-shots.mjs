// Regenerates the README screenshots in docs/screenshots/.
//
// Usage: start the app (`npm run dev` or `npm start`), then
//   npm run capture-shots
// Override the target with BASE_URL (default http://127.0.0.1:3000).
//
// Walks the demo workbook from upload to WON in Offline Mode, so it adds one
// RFP to whatever database the running server points at.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const outDir = path.join(root, "docs", "screenshots");
const fixture = path.join(root, "tests", "fixtures", "demo_upload_rfp.xlsx");

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addCookies([
  { name: "rfp_llm_mode", value: "offline", url: baseUrl },
]);
const page = await context.newPage();
page.setDefaultTimeout(30_000);

const capture = async (fileName) => {
  // Let tab underline transitions and streamed log events settle.
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, fileName) });
  console.log(`captured ${fileName}`);
};

const countOf = (selector) =>
  page.evaluate((sel) => document.querySelectorAll(sel).length, selector);

try {
  await page.goto(baseUrl);
  await page.getByTestId("ingest-tab-xlsx").click();
  await page.getByTestId("xlsx-file-input").setInputFiles(fixture);
  await page.getByRole("button", { name: /Upload & Assess/i }).click();
  await page.waitForURL(/\/rfps\/\d+$/);
  await page.locator('[data-testid^="lane-row-"]').first().waitFor();

  await capture("02_workspace.png");

  const drawer = page.getByTestId("lane-detail-drawer");
  const decisionSelector = '[data-testid^="needs-decision-"]';
  while ((await countOf(decisionSelector)) > 0) {
    const remaining = await countOf(decisionSelector);
    await page
      .locator(decisionSelector)
      .first()
      .locator("xpath=ancestor::tr")
      .click();
    await drawer.waitFor();

    const late = drawer.getByTestId("decision-btn-compliant-late");
    const partial = drawer.getByTestId("decision-btn-partial-on-time");
    if ((await late.isVisible()) && (await late.isEnabled())) {
      await late.click();
    } else if ((await partial.isVisible()) && (await partial.isEnabled())) {
      await partial.click();
    } else {
      await drawer.getByTestId("decision-btn-decline").click();
    }

    await page.waitForFunction(
      ([sel, n]) => document.querySelectorAll(sel).length === n - 1,
      [decisionSelector, remaining],
    );
    await drawer.getByRole("button", { name: "Close drawer" }).click();
    await drawer.waitFor({ state: "hidden" });
  }

  await page.getByTestId("action-request-pricing").click();
  await page.getByTestId("action-clarify-pricing-banner").waitFor();
  await page.getByTestId("tab-tasks").click();
  await page.getByTestId("human-tasks-panel").waitFor();

  await capture("04_human_tasks.png");

  const priceSelector = '[data-testid^="manual-price-input-"]';
  const pricesOpen = await countOf(priceSelector);
  await page.locator(priceSelector).first().fill("2650");
  await page.locator('[data-testid^="manual-price-submit-"]').first().click();
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(sel).length === n - 1,
    [priceSelector, pricesOpen],
  );
  if ((await countOf(priceSelector)) > 0) {
    await page.getByTestId("clarify-all-pricing-btn").click();
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length === 0,
      priceSelector,
    );
  }

  await page.getByTestId("action-draft-quote").click();
  await page.getByTestId("approve-send-quote-btn").click();
  await page.getByTestId("action-open-reply-simulator").click();
  await page.getByTestId("sim-customer-accept-all").click();
  await page.getByTestId("action-download-ics").waitFor();
  await page.getByTestId("tab-proposal").click();
  await page.getByTestId("kickoff-meeting-card").waitFor();

  await capture("06_won_kickoff.png");
} finally {
  await browser.close();
}
