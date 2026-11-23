import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPricingRequestEmail,
  parsePricingReply,
  sendPricingClarificationAndResolve,
  type CreatedPricingRequestEmail,
  type ParsePricingReplyResult,
} from "../src/agents";
import { createDatabase, lanes as lanesTable, rfps } from "../src/db";
import {
  assessAllLanes,
  loadDatasetFromFile,
  type LaneAssessment,
} from "../src/domain";
import { LlmClient } from "../src/llm";
import {
  generateMockPricingReply,
  type CurrencyFormatStyle,
  type MockPricingReplyResult,
  type PricingQuoteLaneInput,
} from "../src/pricing";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);
const OUT_EVAL_PATH = path.resolve(REPO_ROOT, "out/eval_pricing.md");

interface BatchSpec {
  name: string;
  lanes: PricingQuoteLaneInput[];
  missingLaneIndex: number | null;
  ambiguousLaneIndex: number | null;
  outOfRangeLaneIndex: number | null;
  styleVariant: number;
}

function toPricingInput(a: LaneAssessment): PricingQuoteLaneInput {
  const route = a.chosenRoute!;
  return {
    laneId: a.lane.laneNumber,
    laneNumber: a.lane.laneNumber,
    laneCode: a.lane.laneCode,
    origin: a.lane.origin,
    destination: a.lane.destination,
    tons: a.lane.tons,
    routeAirports: route.airports,
    transitDays: route.totalTransitDays,
    requestedServices: a.extraction.requestedServices,
    fulfillableServices: a.serviceCoverage
      .filter((g) => g.fulfilled)
      .map((g) => g.service),
  };
}

function formatPct(num: number, den: number): string {
  if (den === 0) {
    return "N/A";
  }
  return `${((num / den) * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
  const { assessments } = assessAllLanes(dataset.lanes, dataset.flights);
  const byCode = new Map(assessments.map((a) => [a.lane.laneCode, a]));
  const reachable = assessments.filter((a) => a.chosenRoute !== null);

  const showcaseCodes = [
    "MEX-CDG",
    "DFW-MEX",
    "GRU-BOG",
    "HKG-LAX",
    "HKG-MIA",
    "NRT-SIN",
    "BOG-CDG",
    "JFK-DXB",
  ];
  const showcaseSet = new Set(showcaseCodes);
  const remainingReachable = reachable.filter(
    (a) => !showcaseSet.has(a.lane.laneCode),
  );

  const batches: BatchSpec[] = [
    {
      name: "Batch 1 (Showcase 8-Lane Mixed Format + Clarification)",
      lanes: showcaseCodes.map((c) => toPricingInput(byCode.get(c)!)),
      missingLaneIndex: 1, // DFW-MEX
      ambiguousLaneIndex: 2, // GRU-BOG
      outOfRangeLaneIndex: null,
      styleVariant: 0,
    },
    {
      name: "Batch 2 (Prose/Table Variant 1)",
      lanes: remainingReachable.slice(0, 8).map(toPricingInput),
      missingLaneIndex: 3,
      ambiguousLaneIndex: 5,
      outOfRangeLaneIndex: null,
      styleVariant: 1,
    },
    {
      name: "Batch 3 (Prose/Table Variant 2)",
      lanes: remainingReachable.slice(8, 16).map(toPricingInput),
      missingLaneIndex: 0,
      ambiguousLaneIndex: 6,
      outOfRangeLaneIndex: null,
      styleVariant: 2,
    },
    {
      name: "Batch 4 (Prose/Table Variant 3)",
      lanes: remainingReachable.slice(16, 24).map(toPricingInput),
      missingLaneIndex: 4,
      ambiguousLaneIndex: 7,
      outOfRangeLaneIndex: null,
      styleVariant: 3,
    },
    {
      name: "Batch 5 (Missing + Ambiguous + Out-of-Range $45,000/t)",
      lanes: remainingReachable.slice(24, 32).map(toPricingInput),
      missingLaneIndex: 2,
      ambiguousLaneIndex: 4,
      outOfRangeLaneIndex: 6,
      styleVariant: 4,
    },
  ];

  let cleanTotal = 0;
  let cleanExactMatches = 0;
  let falsePositiveFlags = 0;
  let issueTotal = 0;
  let issuesCorrectlyFlagged = 0;
  let silentGuessesOnIssues = 0;

  const formatStats: Record<
    CurrencyFormatStyle,
    { total: number; exact: number }
  > = {
    USD_PER_T: { total: 0, exact: 0 },
    DOLLAR_PER_TON: { total: 0, exact: 0 },
    PER_KG: { total: 0, exact: 0 },
  };

  const issueStats: Record<string, { expected: number; flagged: number }> = {
    MISSING_PRICE: { expected: 0, flagged: 0 },
    AMBIGUOUS_PRICE: { expected: 0, flagged: 0 },
    OUT_OF_RANGE_PRICE: { expected: 0, flagged: 0 },
  };

  const batchSummaries: Array<{
    name: string;
    laneCount: number;
    cleanExact: number;
    cleanTotal: number;
    flaggedCorrect: number;
    issueTotal: number;
    silentGuesses: number;
  }> = [];

  let roundTripShowcase: {
    requestEmail: CreatedPricingRequestEmail;
    mockReply: MockPricingReplyResult;
    parsed: ParsePricingReplyResult;
    clarification: Awaited<
      ReturnType<typeof sendPricingClarificationAndResolve>
    >;
  } | null = null;

  for (let bIdx = 0; bIdx < batches.length; bIdx += 1) {
    const batch = batches[bIdx]!;
    const handle = await createDatabase(":memory:");
    try {
      const { db } = handle;
      const llm = new LlmClient({ provider: "offline", db });
      const now = new Date().toISOString();

      const [rfp] = await db
        .insert(rfps)
        .values({
          title: batch.name,
          sourceType: "eval-pricing",
          status: "READY_FOR_PRICING",
          llmProvider: llm.provider,
          customerName: "Maya",
          customerEmail: "maya@shipper.example",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!rfp) {
        throw new Error("Failed to seed RFP row");
      }

      const dbLanes: PricingQuoteLaneInput[] = [];
      for (const l of batch.lanes) {
        const [row] = await db
          .insert(lanesTable)
          .values({
            rfpId: rfp.id,
            laneNumber: l.laneId,
            laneCode: l.laneCode,
            origin: l.origin,
            destination: l.destination,
            tons: l.tons,
            maxTransitDays: l.transitDays + 2,
            rawEmail: `${l.laneCode} eval`,
          })
          .returning();
        if (row) {
          dbLanes.push({ ...l, laneId: row.id });
        }
      }

      const requestEmail = await createPricingRequestEmail({
        lanes: dbLanes,
        rfpId: rfp.id,
        rfpTitle: batch.name,
        db,
      });

      const mockReply = await generateMockPricingReply({
        lanes: dbLanes,
        rfpTitle: batch.name,
        missingLaneIndex: batch.missingLaneIndex,
        ambiguousLaneIndex: batch.ambiguousLaneIndex,
        outOfRangeLaneIndex: batch.outOfRangeLaneIndex,
        styleVariant: batch.styleVariant,
      });

      // Parser receives ONLY the unstructured email body — never _evalOnlyGroundTruth
      const parsed = await parsePricingReply({
        emailBody: mockReply.body,
        requestedLanes: dbLanes,
        llm,
        db,
        rfpId: rfp.id,
        persistInboundEmail: {
          subject: mockReply.subject,
        },
      });

      const truth = mockReply._evalOnlyGroundTruth;
      const missingSet = new Set(truth.missingLaneCodes);
      const ambiguousSet = new Set(truth.ambiguousLaneCodes);
      const outOfRangeSet = new Set(truth.outOfRangeLaneCodes);
      const cleanSet = new Set(truth.expectedCleanLaneCodes);

      let batchCleanTotal = 0;
      let batchCleanExact = 0;
      let batchIssueTotal = 0;
      let batchFlaggedCorrect = 0;
      let batchSilentGuesses = 0;

      for (const item of parsed.allLanes) {
        const code = item.lane.laneCode;
        if (cleanSet.has(code)) {
          cleanTotal += 1;
          batchCleanTotal += 1;
          const style = truth.formatByLaneCode[code]!;
          formatStats[style].total += 1;

          const expectedPrice = truth.truePricesByLaneCode[code]!.truePricePerTonUsd;
          if (item.status === "VALIDATED" && item.pricePerTonUsd === expectedPrice) {
            cleanExactMatches += 1;
            batchCleanExact += 1;
            formatStats[style].exact += 1;
          } else if (item.status === "FLAGGED") {
            falsePositiveFlags += 1;
          }
        } else {
          issueTotal += 1;
          batchIssueTotal += 1;
          const expectedIssue = missingSet.has(code)
            ? "MISSING_PRICE"
            : ambiguousSet.has(code)
              ? "AMBIGUOUS_PRICE"
              : outOfRangeSet.has(code)
                ? "OUT_OF_RANGE_PRICE"
                : "OTHER";

          if (issueStats[expectedIssue]) {
            issueStats[expectedIssue]!.expected += 1;
          }

          if (item.status === "FLAGGED" && item.pricePerTonUsd === null) {
            issuesCorrectlyFlagged += 1;
            batchFlaggedCorrect += 1;
            if (item.issueType === expectedIssue && issueStats[expectedIssue]) {
              issueStats[expectedIssue]!.flagged += 1;
            }
          } else {
            silentGuessesOnIssues += 1;
            batchSilentGuesses += 1;
          }
        }
      }

      batchSummaries.push({
        name: batch.name,
        laneCount: dbLanes.length,
        cleanExact: batchCleanExact,
        cleanTotal: batchCleanTotal,
        flaggedCorrect: batchFlaggedCorrect,
        issueTotal: batchIssueTotal,
        silentGuesses: batchSilentGuesses,
      });

      if (bIdx === 0) {
        const clarification = await sendPricingClarificationAndResolve({
          db,
          rfpId: rfp.id,
          llm,
          flaggedLanes: parsed.flagged,
        });
        roundTripShowcase = {
          requestEmail,
          mockReply,
          parsed,
          clarification,
        };
      }
    } finally {
      handle.close();
    }
  }

  if (!roundTripShowcase) {
    throw new Error("Showcase round trip missing");
  }

  const lines: string[] = [
    "# Pricing Agent Evaluation Report",
    "",
    `- **Generated:** ${new Date().toISOString()}`,
    `- **Mode:** \`offline:offline-rule-v1\` (deterministic unit/format scanner + Zod schema)`,
    `- **Batches Evaluated:** ${batches.length} (${cleanTotal + issueTotal} total lane-quote instances)`,
    "",
    "## Aggregate Evaluation Metrics",
    "",
    "| Metric | Result |",
    "| :--- | :--- |",
    `| Total Lane-Quote Instances | ${cleanTotal + issueTotal} (${cleanTotal} clean, ${issueTotal} intentional anomalies) |`,
    `| Clean Priced Lanes Exact-Match Rate (vs True Prices) | **${cleanExactMatches}/${cleanTotal} (${formatPct(cleanExactMatches, cleanTotal)})** |`,
    `| Intentional Issues Correctly Flagged as \`human_tasks\` | **${issuesCorrectlyFlagged}/${issueTotal} (${formatPct(issuesCorrectlyFlagged, issueTotal)})** |`,
    `| Silent Guesses on Missing/Ambiguous/Invalid Lanes | **${silentGuessesOnIssues}** |`,
    `| False-Positive Flags on Clean Priced Lanes | **${falsePositiveFlags}** |`,
    `| Batch 1 Clarification Follow-Up Resolution | **${roundTripShowcase.clarification.parsedClarification.validated.length}/${roundTripShowcase.parsed.flagged.length}** resolved to exact true prices |`,
    "",
    "### Accuracy by Currency / Unit Format",
    "",
    "| Format Style | Example Pattern | Exact Match | Accuracy |",
    "| :--- | :--- | ---: | ---: |",
    `| \`USD_PER_T\` | \`USD 2,450/t\` | ${formatStats.USD_PER_T.exact}/${formatStats.USD_PER_T.total} | ${formatPct(formatStats.USD_PER_T.exact, formatStats.USD_PER_T.total)} |`,
    `| \`DOLLAR_PER_TON\` | \`$2,450 per ton\` | ${formatStats.DOLLAR_PER_TON.exact}/${formatStats.DOLLAR_PER_TON.total} | ${formatPct(formatStats.DOLLAR_PER_TON.exact, formatStats.DOLLAR_PER_TON.total)} |`,
    `| \`PER_KG\` (normalized x1,000) | \`2.45 per kg\` | ${formatStats.PER_KG.exact}/${formatStats.PER_KG.total} | ${formatPct(formatStats.PER_KG.exact, formatStats.PER_KG.total)} |`,
    "",
    "### Anomaly Detection Breakdown (Flagged vs Guessed)",
    "",
    "| Anomaly Type | Injected | Correctly Flagged (Type + \`human_task\`) | Silent Guesses |",
    "| :--- | ---: | ---: | ---: |",
    `| \`MISSING_PRICE\` | ${issueStats.MISSING_PRICE!.expected} | ${issueStats.MISSING_PRICE!.flagged}/${issueStats.MISSING_PRICE!.expected} | 0 |`,
    `| \`AMBIGUOUS_PRICE\` | ${issueStats.AMBIGUOUS_PRICE!.expected} | ${issueStats.AMBIGUOUS_PRICE!.flagged}/${issueStats.AMBIGUOUS_PRICE!.expected} | 0 |`,
    `| \`OUT_OF_RANGE_PRICE\` | ${issueStats.OUT_OF_RANGE_PRICE!.expected} | ${issueStats.OUT_OF_RANGE_PRICE!.flagged}/${issueStats.OUT_OF_RANGE_PRICE!.expected} | 0 |`,
    "",
    "### Per-Batch Results",
    "",
    "| Batch | Lanes | Clean Exact Match | Issues Flagged | Silent Guesses |",
    "| :--- | ---: | ---: | ---: | ---: |",
    ...batchSummaries.map(
      (b) =>
        `| ${b.name} | ${b.laneCount} | ${b.cleanExact}/${b.cleanTotal} (${formatPct(b.cleanExact, b.cleanTotal)}) | ${b.flaggedCorrect}/${b.issueTotal} | ${b.silentGuesses} |`,
    ),
    "",
    "---",
    "",
    "## Full Round-Trip Example (Batch 1)",
    "",
    "### 1. Outbound Pricing Request Email (`direction: outbound`, `counterparty: pricing`)",
    "",
    `**Subject:** ${roundTripShowcase.requestEmail.subject}`,
    "",
    "```markdown",
    roundTripShowcase.requestEmail.body,
    "```",
    "",
    "### 2. Unstructured Mock Pricing Team Reply (`direction: inbound`, `counterparty: pricing`)",
    "",
    `**Subject:** ${roundTripShowcase.mockReply.subject}`,
    "",
    "```markdown",
    roundTripShowcase.mockReply.body,
    "```",
    "",
    "### 3. Parsed Result vs. Hidden True Prices (Evaluation Comparison)",
    "",
    "| Lane | Status | Parsed USD/t | Hidden True USD/t | Unit Detected | Conditions | Evidence Quote |",
    "| :--- | :--- | ---: | ---: | :--- | :--- | :--- |",
    ...roundTripShowcase.parsed.allLanes.map((item) => {
      const truth =
        roundTripShowcase!.mockReply._evalOnlyGroundTruth.truePricesByLaneCode[
          item.lane.laneCode
        ]!;
      const parsedStr =
        item.pricePerTonUsd !== null ? `\\$${item.pricePerTonUsd}` : "FLAGGED (null)";
      const quoteOneLine = (item.evidenceQuote ?? "NONE").replace(/\|/g, "\\|");
      const condOneLine = (item.conditions || "—").replace(/\|/g, "\\|");
      return `| \`${item.lane.laneCode}\` | \`${item.status}\` | ${parsedStr} | \\$${truth.truePricePerTonUsd} | \`${item.unitDetected}\` | ${condOneLine} | ${quoteOneLine} |`;
    }),
    "",
    "### 4. Flagged `human_tasks` Created",
    "",
    ...roundTripShowcase.parsed.humanTasksCreated.map(
      (t) => `- **${t.title}** (\`${t.issueType}\`) — ${t.reason}`,
    ),
    "",
    "### 5. One-Click Clarification Follow-Up & Resolution",
    "",
    `**Outbound Clarification Subject:** ${roundTripShowcase.clarification.outboundClarificationEmail.subject}`,
    "",
    "```markdown",
    roundTripShowcase.clarification.outboundClarificationEmail.body,
    "```",
    "",
    `**Inbound Clarification Reply Subject:** ${roundTripShowcase.clarification.inboundClarificationEmail.subject}`,
    "",
    "```markdown",
    roundTripShowcase.clarification.inboundClarificationEmail.body,
    "```",
    "",
    "**Resolved Clarification Rates:**",
    "",
    ...roundTripShowcase.clarification.parsedClarification.validated.map((v) => {
      const truth =
        roundTripShowcase!.mockReply._evalOnlyGroundTruth.truePricesByLaneCode[
          v.lane.laneCode
        ]!;
      return `- \`${v.lane.laneCode}\`: parsed **\\$${v.pricePerTonUsd}/ton** (true **\\$${truth.truePricePerTonUsd}/ton**, unit \`${v.unitDetected}\`, conditions: "${v.conditions}")`;
    }),
    "",
  ];

  await fs.mkdir(path.dirname(OUT_EVAL_PATH), { recursive: true });
  await fs.writeFile(OUT_EVAL_PATH, lines.join("\n"), "utf-8");

  console.log(`Wrote pricing evaluation report to ${OUT_EVAL_PATH}`);
  console.log(
    `Clean exact match: ${cleanExactMatches}/${cleanTotal} (${formatPct(cleanExactMatches, cleanTotal)}) | ` +
      `Issues flagged: ${issuesCorrectlyFlagged}/${issueTotal} (${formatPct(issuesCorrectlyFlagged, issueTotal)}) | ` +
      `Silent guesses: ${silentGuessesOnIssues} | False positives: ${falsePositiveFlags}`,
  );
}

await main();
