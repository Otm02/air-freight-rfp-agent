import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessAllLanes, loadDatasetFromFile } from "../src/domain";
import type { GoldRequirementRecord, LaneAssessment } from "../src/domain/types";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);
const GOLD_PATH = path.resolve(REPO_ROOT, "data/gold_requirements.json");
const OUT_CSV_PATH = path.resolve(REPO_ROOT, "out/lane_assessments.csv");

const INTERESTING_LANE_CODES = [
  "MEX-CDG",
  "BOG-CDG",
  "LHR-ATL",
  "HKG-LAX",
  "JFK-LAX",
  "NRT-SIN",
  "GRU-BOG",
  "HKG-MIA",
  "DXB-HKG",
  "FAI-SIN",
] as const;

function csvEscape(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatMissingServicesAndLegs(a: LaneAssessment): string {
  const missing = a.serviceCoverage.filter((g) => !g.fulfilled);
  if (missing.length === 0) {
    return "NONE";
  }
  return missing
    .map((g) => `${g.service}@[${g.missingOnLegs.join(",")}]`)
    .join("; ");
}

function formatAlternativesSummary(a: LaneAssessment): string {
  if (a.routing.alternatives.length === 0) {
    return "NONE";
  }
  return a.routing.alternatives
    .map(
      (alt) =>
        `${alt.kind}: ${alt.route.airports.join("->")} (${alt.route.totalTransitDays}d, fulfilled=${alt.fulfilledServices.join("+") || "NONE"})`,
    )
    .join(" | ");
}

async function main(): Promise<void> {
  const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
  const errors = dataset.issues.filter((i) => i.severity === "ERROR");
  if (errors.length > 0) {
    console.error("Workbook load errors:", errors);
    process.exitCode = 1;
    return;
  }

  const { assessments, summary } = assessAllLanes(
    dataset.lanes,
    dataset.flights,
  );

  const goldRaw = await fs.readFile(GOLD_PATH, "utf-8");
  const gold = JSON.parse(goldRaw) as GoldRequirementRecord[];
  let goldExactMatches = 0;
  for (let i = 0; i < assessments.length; i += 1) {
    const pred = assessments[i]!.extraction.requestedServices;
    const exp = gold[i]?.requestedServices ?? [];
    if (
      pred.length === exp.length &&
      pred.every((svc, idx) => svc === exp[idx])
    ) {
      goldExactMatches += 1;
    }
  }

  const headers = [
    "lane_number",
    "lane_code",
    "origin",
    "destination",
    "tons",
    "max_transit_days",
    "requested_services",
    "intake_confidence",
    "status",
    "chosen_route",
    "chosen_transit_days",
    "days_over_limit",
    "fulfilled_services",
    "missing_services_and_legs",
    "alternatives_summary",
    "recommended_action",
    "needs_human_decision",
    "human_decision_reason",
  ];

  const rows: string[] = [headers.map(csvEscape).join(",")];
  for (const a of assessments) {
    const fulfilled = a.serviceCoverage
      .filter((g) => g.fulfilled)
      .map((g) => g.service);

    const fields = [
      a.lane.laneNumber,
      a.lane.laneCode,
      a.lane.origin,
      a.lane.destination,
      a.lane.tons,
      a.lane.maxTransitDays,
      a.extraction.requestedServices.length > 0
        ? a.extraction.requestedServices.join("; ")
        : "NONE (STANDARD)",
      a.extraction.confidence.toFixed(2),
      a.status,
      a.chosenRoute ? a.chosenRoute.airports.join(" -> ") : "NONE",
      a.chosenRoute ? a.chosenRoute.totalTransitDays : "",
      a.daysOverLimit ?? "",
      a.extraction.requestedServices.length === 0
        ? "N/A (STANDARD)"
        : fulfilled.length > 0
          ? fulfilled.join("; ")
          : "NONE",
      formatMissingServicesAndLegs(a),
      formatAlternativesSummary(a),
      a.recommendedAction,
      a.needsHumanDecision ? "yes" : "no",
      a.humanDecisionReason ?? "",
    ];
    rows.push(fields.map(csvEscape).join(","));
  }

  await fs.mkdir(path.dirname(OUT_CSV_PATH), { recursive: true });
  await fs.writeFile(OUT_CSV_PATH, `${rows.join("\n")}\n`, "utf-8");

  console.log("=== DOMAIN CORE ASSESSMENT EXPORT ===");
  console.log(`CSV written: ${OUT_CSV_PATH} (${assessments.length} lanes)`);
  console.log(
    `Offline parser vs gold_requirements.json: ${goldExactMatches}/${gold.length} (${((goldExactMatches / gold.length) * 100).toFixed(1)}%)`,
  );
  console.log("\nCategory Counts:");
  for (const [status, count] of Object.entries(summary.statusCounts)) {
    const extra =
      status === "COMPLIANT_BUT_LATE"
        ? ` (${summary.compliantButLateWithOnTimeFallbackCount} with on-time non-compliant alternative, ${summary.compliantButLateNoOnTimeCount} with no on-time route)`
        : "";
    console.log(`  - ${status}: ${count}${extra}`);
  }
  console.log(
    `  - needsHumanDecision: yes=${summary.needsHumanDecisionCount}, no=${summary.autoProceedCount}`,
  );

  console.log("\n10 Interesting Rows:");
  const byCode = new Map(assessments.map((a) => [a.lane.laneCode, a]));
  for (const code of INTERESTING_LANE_CODES) {
    const a = byCode.get(code);
    if (!a) {
      continue;
    }
    const routeStr = a.chosenRoute
      ? `${a.chosenRoute.airports.join(" -> ")} (${a.chosenRoute.totalTransitDays}d/${a.lane.maxTransitDays}d)`
      : `NONE (max ${a.lane.maxTransitDays}d)`;
    const fulfilled = a.serviceCoverage
      .filter((g) => g.fulfilled)
      .map((g) => g.service);
    console.log(
      `  * #${a.lane.laneNumber} ${a.lane.laneCode} | ${a.status} | route=${routeStr} | over=${a.daysOverLimit ?? "N/A"} | fulfilled=[${fulfilled.join(",") || "none"}] | missing=${formatMissingServicesAndLegs(a)} | action=${a.recommendedAction} | human=${a.needsHumanDecision ? "yes" : "no"}${a.humanDecisionReason ? ` (${a.humanDecisionReason})` : ""}`,
    );
  }
}

await main();
