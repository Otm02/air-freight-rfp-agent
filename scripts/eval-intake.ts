import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { runIntakeBatch, type IntakeLaneResult } from "../src/agents";
import {
  agentEvents,
  createDatabase,
  humanTasks,
  lanes as lanesTable,
  rfps,
} from "../src/db";
import {
  loadDatasetFromFile,
  SERVICE_TYPES,
  type GoldRequirementRecord,
  type ServiceType,
} from "../src/domain";
import { LlmClient, loadEnvLocal, resolveProviderConfig } from "../src/llm";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);
const GOLD_PATH = path.resolve(REPO_ROOT, "data/gold_requirements.json");
const OUT_EVAL_PATH = path.resolve(REPO_ROOT, "out/eval_intake.md");

type EvalMode = "offline" | "llm" | "both";

interface ServiceMetrics {
  service: ServiceType;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

interface ModeReport {
  modeLabel: string;
  provider: string;
  model: string;
  wallTimeMs: number;
  totalLanes: number;
  exactMatches: number;
  standardCargoCorrect: number;
  standardCargoTotal: number;
  microPrecision: number | null;
  microRecall: number | null;
  microF1: number | null;
  perService: ServiceMetrics[];
  llmCallsTotal: number;
  llmRetries: number;
  llmErrors: number;
  avgCallLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  providerGoldDisagreements: Array<{
    laneNumber: number;
    laneCode: string;
    predicted: ServiceType[];
    gold: ServiceType[];
    confidence: number | null;
    rawEmail: string;
  }>;
  llmRuleDisagreements: Array<{
    laneNumber: number;
    laneCode: string;
    llmServices: ServiceType[] | null;
    ruleServices: ServiceType[];
    ungroundedQuotes: string[];
    reason: string;
  }>;
  humanTaskRows: Array<{
    laneCode: string;
    title: string;
    reason: string;
  }>;
}

function parseArgs(argv: readonly string[]): {
  mode: EvalMode;
  concurrency: number;
} {
  let modeArg: EvalMode | null = null;
  let concurrency = 5;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      const val = argv[i + 1]!.toLowerCase();
      if (val === "offline" || val === "llm" || val === "both") {
        modeArg = val;
      } else {
        throw new Error(`Invalid --mode "${val}" (expected offline|llm|both)`);
      }
      i += 1;
    } else if (arg === "--concurrency" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1]!, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        concurrency = parsed;
      }
      i += 1;
    }
  }

  const autoLive = resolveProviderConfig().provider !== "offline";
  return {
    mode: modeArg ?? (autoLive ? "both" : "offline"),
    concurrency,
  };
}

function safeDiv(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function computeF1(p: number | null, r: number | null): number | null {
  if (p === null || r === null) {
    return null;
  }
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function formatPct(val: number | null): string {
  return val === null ? "N/A" : `${(val * 100).toFixed(2)}%`;
}

async function evaluateSingleMode(params: {
  mode: "offline" | "live";
  concurrency: number;
  lanes: Awaited<ReturnType<typeof loadDatasetFromFile>>["lanes"];
  gold: readonly GoldRequirementRecord[];
}): Promise<ModeReport> {
  const handle = await createDatabase(":memory:");
  try {
    const { db } = handle;
    const llm = new LlmClient({
      provider: params.mode === "offline" ? "offline" : "auto",
      db,
    });

    const now = new Date().toISOString();
    const [rfp] = await db
      .insert(rfps)
      .values({
        title: `Intake Eval (${llm.provider}/${llm.model})`,
        sourceType: "eval-intake",
        status: "INGESTED",
        llmProvider: llm.provider,
        customerName: "Mock Shipper",
        customerEmail: "maya@shipper.example",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!rfp) {
      throw new Error("Failed to insert evaluation RFP row.");
    }

    const laneIdByNumber = new Map<number, number>();
    for (const lane of params.lanes) {
      const [inserted] = await db
        .insert(lanesTable)
        .values({
          rfpId: rfp.id,
          laneNumber: lane.laneNumber,
          laneCode: lane.laneCode,
          origin: lane.origin,
          destination: lane.destination,
          tons: lane.tons,
          maxTransitDays: lane.maxTransitDays,
          rawEmail: lane.rawEmail,
        })
        .returning({ id: lanesTable.id });
      if (inserted) {
        laneIdByNumber.set(lane.laneNumber, inserted.id);
      }
    }

    const wallStart = performance.now();
    const results: IntakeLaneResult[] = await runIntakeBatch(params.lanes, {
      llm,
      db,
      rfpId: rfp.id,
      concurrency: params.concurrency,
      resolveLaneDbId: (lane) => laneIdByNumber.get(lane.laneNumber) ?? null,
    });
    const wallTimeMs = Math.round(performance.now() - wallStart);

    const counters = new Map<
      ServiceType,
      { support: number; tp: number; fp: number; fn: number }
    >();
    for (const svc of SERVICE_TYPES) {
      counters.set(svc, { support: 0, tp: 0, fp: 0, fn: 0 });
    }

    let exactMatches = 0;
    let standardCargoTotal = 0;
    let standardCargoCorrect = 0;

    const providerGoldDisagreements: ModeReport["providerGoldDisagreements"] = [];
    const llmRuleDisagreements: ModeReport["llmRuleDisagreements"] = [];

    for (let i = 0; i < results.length; i += 1) {
      const res = results[i]!;
      const exp = params.gold[i]!;
      const predicted = res.llmServices ?? [];
      const predSet = new Set(predicted);
      const goldSet = new Set(exp.requestedServices);

      const isExact =
        res.llmCall.ok &&
        predicted.length === exp.requestedServices.length &&
        predicted.every((svc, idx) => svc === exp.requestedServices[idx]);
      if (isExact) {
        exactMatches += 1;
      } else {
        providerGoldDisagreements.push({
          laneNumber: res.lane.laneNumber,
          laneCode: res.lane.laneCode,
          predicted,
          gold: [...exp.requestedServices],
          confidence: res.llmCall.ok ? res.llmCall.data.confidence : null,
          rawEmail: res.lane.rawEmail,
        });
      }

      if (exp.standardCargo) {
        standardCargoTotal += 1;
        if (res.llmCall.ok && predicted.length === 0) {
          standardCargoCorrect += 1;
        }
      }

      for (const svc of SERVICE_TYPES) {
        const entry = counters.get(svc)!;
        const inGold = goldSet.has(svc);
        const inPred = predSet.has(svc);
        if (inGold) {
          entry.support += 1;
        }
        if (inGold && inPred) {
          entry.tp += 1;
        } else if (!inGold && inPred) {
          entry.fp += 1;
        } else if (inGold && !inPred) {
          entry.fn += 1;
        }
      }

      if (res.disagrees) {
        llmRuleDisagreements.push({
          laneNumber: res.lane.laneNumber,
          laneCode: res.lane.laneCode,
          llmServices: res.llmServices,
          ruleServices: res.ruleReading.requestedServices,
          ungroundedQuotes: res.ungroundedQuotes,
          reason:
            res.humanTask?.reason ??
            "Provider prediction disagreed with rule-based extraction.",
        });
      }
    }

    let totalTp = 0;
    let totalFp = 0;
    let totalFn = 0;
    const perService: ServiceMetrics[] = SERVICE_TYPES.map((svc) => {
      const c = counters.get(svc)!;
      totalTp += c.tp;
      totalFp += c.fp;
      totalFn += c.fn;
      const precision = safeDiv(c.tp, c.tp + c.fp);
      const recall = safeDiv(c.tp, c.tp + c.fn);
      return {
        service: svc,
        support: c.support,
        tp: c.tp,
        fp: c.fp,
        fn: c.fn,
        precision,
        recall,
        f1: computeF1(precision, recall),
      };
    });

    const microPrecision = safeDiv(totalTp, totalTp + totalFp);
    const microRecall = safeDiv(totalTp, totalTp + totalFn);
    const microF1 = computeF1(microPrecision, microRecall);

    const events = await db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.rfpId, rfp.id));

    const finalLlmEvents = events.filter(
      (e) => e.eventType === "LLM_CALL_SUCCESS" || e.eventType === "LLM_CALL_ERROR",
    );
    const retryEvents = events.filter((e) => e.eventType === "LLM_CALL_RETRY");
    const errorEvents = events.filter((e) => e.eventType === "LLM_CALL_ERROR");

    const inputTokens = finalLlmEvents.reduce((acc, e) => acc + e.inputTokens, 0);
    const outputTokens = finalLlmEvents.reduce(
      (acc, e) => acc + e.outputTokens,
      0,
    );
    const totalTokens = finalLlmEvents.reduce((acc, e) => acc + e.totalTokens, 0);
    const estimatedCostUsd = Number(
      finalLlmEvents.reduce((acc, e) => acc + e.costUsd, 0).toFixed(6),
    );
    const sumLatencyMs = finalLlmEvents.reduce((acc, e) => acc + e.latencyMs, 0);
    const avgCallLatencyMs =
      finalLlmEvents.length > 0
        ? Math.round(sumLatencyMs / finalLlmEvents.length)
        : 0;

    const tasks = await db
      .select()
      .from(humanTasks)
      .where(eq(humanTasks.rfpId, rfp.id));

    return {
      modeLabel:
        params.mode === "offline"
          ? "Offline Mode (Rule-Based Provider)"
          : `Live LLM Mode (${llm.provider}: ${llm.model})`,
      provider: llm.provider,
      model: llm.model,
      wallTimeMs,
      totalLanes: results.length,
      exactMatches,
      standardCargoCorrect,
      standardCargoTotal,
      microPrecision,
      microRecall,
      microF1,
      perService,
      llmCallsTotal: finalLlmEvents.length,
      llmRetries: retryEvents.length,
      llmErrors: errorEvents.length,
      avgCallLatencyMs,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
      providerGoldDisagreements,
      llmRuleDisagreements,
      humanTaskRows: tasks.map((t) => ({
        laneCode: t.laneCode ?? "UNKNOWN",
        title: t.title,
        reason: t.reason,
      })),
    };
  } finally {
    handle.close();
  }
}

function renderModeMarkdown(report: ModeReport): string {
  const lines: string[] = [];
  lines.push(`## ${report.modeLabel}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| :--- | :--- |");
  lines.push(`| Provider / Model | \`${report.provider}\` / \`${report.model}\` |`);
  lines.push(`| Lanes Evaluated | ${report.totalLanes} |`);
  lines.push(
    `| Exact-Match Rate (vs Gold) | ${report.exactMatches}/${report.totalLanes} (${formatPct(report.exactMatches / report.totalLanes)}) |`,
  );
  lines.push(
    `| Standard General Cargo Accuracy | ${report.standardCargoCorrect}/${report.standardCargoTotal} (${formatPct(safeDiv(report.standardCargoCorrect, report.standardCargoTotal))}) |`,
  );
  lines.push(
    `| Micro Precision / Recall / F1 | ${formatPct(report.microPrecision)} / ${formatPct(report.microRecall)} / ${formatPct(report.microF1)} |`,
  );
  lines.push(
    `| Logged LLM Calls / Retries / Errors | ${report.llmCallsTotal} / ${report.llmRetries} / ${report.llmErrors} |`,
  );
  lines.push(
    `| Avg Call Latency / Wall Time | ${report.avgCallLatencyMs} ms / ${report.wallTimeMs} ms |`,
  );
  lines.push(
    `| Token Usage (Input / Output / Total) | ${report.inputTokens} / ${report.outputTokens} / ${report.totalTokens} |`,
  );
  lines.push(`| Estimated Cost (USD) | \\$${report.estimatedCostUsd.toFixed(6)} |`);
  lines.push(`| Human Tasks Created | ${report.humanTaskRows.length} |`);
  lines.push("");

  lines.push("### Per-Service Precision & Recall");
  lines.push("");
  lines.push("| Service Type | Support | TP | FP | FN | Precision | Recall | F1 |");
  lines.push("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const s of report.perService) {
    lines.push(
      `| \`${s.service}\` | ${s.support} | ${s.tp} | ${s.fp} | ${s.fn} | ${formatPct(s.precision)} | ${formatPct(s.recall)} | ${formatPct(s.f1)} |`,
    );
  }
  lines.push("");

  const uniqueReasons = [...new Set(report.humanTaskRows.map((t) => t.reason))];
  const hasUniformFatalError =
    report.llmErrors === report.totalLanes &&
    report.totalLanes > 0 &&
    uniqueReasons.length === 1;
  const uniformReason = hasUniformFatalError ? uniqueReasons[0]! : null;

  lines.push(
    `### Disagreements vs. Gold Dataset (${report.providerGoldDisagreements.length})`,
  );
  lines.push("");
  if (report.providerGoldDisagreements.length === 0) {
    lines.push("None — 100/100 exact match against `data/gold_requirements.json`.");
  } else if (uniformReason) {
    lines.push(
      `All ${report.totalLanes} lanes failed before model output due to a uniform provider error: ${uniformReason}`,
    );
  } else {
    lines.push("| Lane # | Lane | Provider Prediction | Gold Label | Confidence | Email |");
    lines.push("| ---: | :--- | :--- | :--- | ---: | :--- |");
    for (const d of report.providerGoldDisagreements) {
      const predStr = d.predicted.length > 0 ? d.predicted.join(", ") : "NONE";
      const goldStr = d.gold.length > 0 ? d.gold.join(", ") : "NONE";
      const confStr = d.confidence === null ? "ERROR" : d.confidence.toFixed(2);
      const emailOneLine = d.rawEmail.replace(/\s+/g, " ").replace(/\|/g, "\\|");
      lines.push(
        `| ${d.laneNumber} | \`${d.laneCode}\` | ${predStr} | ${goldStr} | ${confStr} | ${emailOneLine} |`,
      );
    }
  }
  lines.push("");

  lines.push(
    `### LLM vs. Rule-Based Disagreements (${report.llmRuleDisagreements.length})`,
  );
  lines.push("");
  if (report.llmRuleDisagreements.length === 0) {
    lines.push("None — LLM and rule-based readings agreed on all 100 lanes.");
  } else if (uniformReason) {
    lines.push(
      `All ${report.llmRuleDisagreements.length} lanes escalated as fail-closed disagreements because the provider errored (${uniformReason}). Rule-based readings remain preserved for human review.`,
    );
  } else {
    for (const d of report.llmRuleDisagreements) {
      lines.push(
        `- **Lane #${d.laneNumber} \`${d.laneCode}\`**: LLM=[${d.llmServices?.join(", ") || "ERROR/NONE"}] vs Rule=[${d.ruleServices.join(", ") || "NONE"}] — ${d.reason}`,
      );
    }
  }
  lines.push("");

  lines.push(`### Lanes Escalated to \`human_tasks\` (${report.humanTaskRows.length})`);
  lines.push("");
  if (report.humanTaskRows.length === 0) {
    lines.push("None — all 100 lanes cleared automated intake checks.");
  } else if (uniformReason) {
    const laneCodes = report.humanTaskRows.map((t) => `\`${t.laneCode}\``).join(", ");
    lines.push(
      `All ${report.humanTaskRows.length} lanes generated \`Confirm special requirements for lane <CODE>\` tasks due to the uniform provider error (${uniformReason}): ${laneCodes}`,
    );
  } else {
    for (const t of report.humanTaskRows) {
      lines.push(`- **${t.title}** (\`${t.laneCode}\`): ${t.reason}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  loadEnvLocal(REPO_ROOT);
  const { mode, concurrency } = parseArgs(process.argv.slice(2));

  const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
  const errors = dataset.issues.filter((i) => i.severity === "ERROR");
  if (errors.length > 0) {
    throw new Error(`Workbook load errors: ${JSON.stringify(errors)}`);
  }

  const goldRaw = await fs.readFile(GOLD_PATH, "utf-8");
  const gold = JSON.parse(goldRaw) as GoldRequirementRecord[];

  const reports: ModeReport[] = [];
  if (mode === "offline" || mode === "both") {
    reports.push(
      await evaluateSingleMode({
        mode: "offline",
        concurrency,
        lanes: dataset.lanes,
        gold,
      }),
    );
  }
  if (mode === "llm" || mode === "both") {
    const cfg = resolveProviderConfig();
    if (cfg.provider === "offline") {
      throw new Error(
        "LLM evaluation requested, but neither GEMINI_API_KEY nor OPENAI_API_KEY is configured.",
      );
    }
    reports.push(
      await evaluateSingleMode({
        mode: "live",
        concurrency,
        lanes: dataset.lanes,
        gold,
      }),
    );
  }

  const headerLines = [
    "# Intake Agent Evaluation Report",
    "",
    `- **Generated:** ${new Date().toISOString()}`,
    `- **Dataset:** \`data/Air_Freight_RFP_Mock_Data.xlsx\` (${dataset.lanes.length} lanes)`,
    `- **Gold Labels:** \`data/gold_requirements.json\` (${gold.length} lanes)`,
    `- **Modes Run:** ${reports.map((r) => `\`${r.provider}:${r.model}\``).join(", ")}`,
    "",
  ];

  const markdown = `${headerLines.join("\n")}\n${reports.map(renderModeMarkdown).join("\n")}`;
  await fs.mkdir(path.dirname(OUT_EVAL_PATH), { recursive: true });
  await fs.writeFile(OUT_EVAL_PATH, markdown, "utf-8");

  console.log(`Wrote intake evaluation report to ${OUT_EVAL_PATH}`);
  for (const r of reports) {
    console.log(
      `[${r.modeLabel}] exact=${r.exactMatches}/${r.totalLanes} (${formatPct(r.exactMatches / r.totalLanes)}), ` +
        `microP=${formatPct(r.microPrecision)}, microR=${formatPct(r.microRecall)}, ` +
        `tokens=${r.totalTokens}, cost=$${r.estimatedCostUsd.toFixed(6)}, ` +
        `humanTasks=${r.humanTaskRows.length}, wallTime=${r.wallTimeMs}ms`,
    );
  }
}

await main();
