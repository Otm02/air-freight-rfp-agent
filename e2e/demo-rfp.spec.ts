import path from "node:path";
import { expect, test } from "@playwright/test";

const UPLOAD_FIXTURE_PATH = path.resolve(
  process.cwd(),
  "tests",
  "fixtures",
  "demo_upload_rfp.xlsx",
);

test("walks uploaded RFP workbook from Inbox ingestion to WON kickoff in Offline Mode", async ({
  page,
  request,
}) => {
  await page.goto("/");

  // Verify Offline Mode without any API key
  await expect(page.getByTestId("llm-mode-badge")).toContainText("Offline Mode");

  // Upload real 6-lane .xlsx workbook via RFP Inbox
  await page.getByTestId("ingest-tab-xlsx").click();
  await page.getByTestId("xlsx-file-input").setInputFiles(UPLOAD_FIXTURE_PATH);
  await page.getByRole("button", { name: /Upload & Assess/i }).click();

  await expect(page).toHaveURL(/\/rfps\/\d+$/);

  // Verify 6 lanes loaded and RFP paused for human route decisions
  await expect(page.locator('[data-testid^="lane-row-"]')).toHaveCount(6);
  await expect(page.getByTestId("header-human-tasks-badge")).toBeVisible();

  // Resolve every lane needing a route trade-off decision via the Lane Detail Drawer
  const decisionBadges = page.locator('[data-testid^="needs-decision-"]');
  while ((await decisionBadges.count()) > 0) {
    const initialCount = await decisionBadges.count();
    await decisionBadges.first().locator("xpath=ancestor::tr").click();

    const drawer = page.getByTestId("lane-detail-drawer");
    await expect(drawer).toBeVisible();

    const compliantLateBtn = drawer.getByTestId("decision-btn-compliant-late");
    const partialOnTimeBtn = drawer.getByTestId("decision-btn-partial-on-time");
    const declineBtn = drawer.getByTestId("decision-btn-decline");

    if ((await compliantLateBtn.isVisible()) && (await compliantLateBtn.isEnabled())) {
      await compliantLateBtn.click();
    } else if (
      (await partialOnTimeBtn.isVisible()) &&
      (await partialOnTimeBtn.isEnabled())
    ) {
      await partialOnTimeBtn.click();
    } else {
      await declineBtn.click();
    }

    await expect(decisionBadges).toHaveCount(initialCount - 1);
    await drawer.getByRole("button", { name: "Close drawer" }).click();
    await expect(drawer).toBeHidden();
  }

  // Request Pricing -> Mock Pricing Team intentionally returns missing/ambiguous items
  await expect(page.getByTestId("action-request-pricing")).toBeVisible();
  await page.getByTestId("action-request-pricing").click();

  // Switch to Human Tasks tab and resolve both manual & email-clarification pricing tasks
  await expect(page.getByTestId("action-clarify-pricing-banner")).toBeVisible();
  await page.getByTestId("tab-tasks").click();
  await expect(page.getByTestId("human-tasks-panel")).toBeVisible();

  const manualInputs = page.locator('[data-testid^="manual-price-input-"]');
  const initialPricingCount = await manualInputs.count();
  expect(initialPricingCount).toBeGreaterThanOrEqual(2);

  await manualInputs.first().fill("2650");
  await page.locator('[data-testid^="manual-price-submit-"]').first().click();
  await expect(manualInputs).toHaveCount(initialPricingCount - 1);

  if ((await manualInputs.count()) > 0) {
    await page.getByTestId("clarify-all-pricing-btn").click();
  }
  await expect(manualInputs).toHaveCount(0);

  // Draft Customer Quote -> pauses at approval gate
  await expect(page.getByTestId("action-draft-quote")).toBeVisible();
  await page.getByTestId("action-draft-quote").click();

  await expect(page.getByTestId("approve-send-quote-btn")).toBeVisible();
  await page.getByTestId("approve-send-quote-btn").click();

  // Quote sent -> simulate customer accepting all quoted lanes
  await expect(page.getByTestId("action-open-reply-simulator")).toBeVisible();
  await page.getByTestId("tab-emails").click();
  await expect(page.getByTestId("emails-panel")).toBeVisible();

  await page.getByTestId("sim-customer-accept-all").click();

  // DealAgent marks RFP WON and schedules kickoff meeting + .ics invite
  await expect(page.getByTestId("action-download-ics")).toBeVisible();
  await page.getByTestId("tab-proposal").click();
  await expect(page.getByTestId("proposal-kickoff-panel")).toBeVisible();
  await expect(page.getByTestId("kickoff-meeting-card")).toBeVisible();

  const icsLink = page.getByTestId("download-kickoff-ics-link");
  await expect(icsLink).toBeVisible();
  const icsHref = await icsLink.getAttribute("href");
  expect(icsHref).toBeTruthy();

  const icsResponse = await request.get(icsHref!);
  expect(icsResponse.status()).toBe(200);
  expect(icsResponse.headers()["content-type"]).toContain("text/calendar");
  const icsText = await icsResponse.text();
  const unfoldedIcs = icsText.replace(/\r?\n[ \t]/g, "");
  expect(unfoldedIcs).toContain("BEGIN:VCALENDAR");
  expect(unfoldedIcs).toContain("BEGIN:VEVENT");
  expect(unfoldedIcs).toContain("America/New_York");
  expect(unfoldedIcs).toContain("10:00 ");
  expect(unfoldedIcs).toContain("END:VCALENDAR");
});
