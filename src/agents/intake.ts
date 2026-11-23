import { eq } from "drizzle-orm";
import { z } from "zod";
import { agentEvents, humanTasks, lanes as lanesTable, type AppDatabase } from "../db";
import {
  CONFIDENCE_THRESHOLD,
  extractRequirementsOffline,
  SERVICE_TYPES,
  type Lane,
  type RequirementExtraction,
  type ServiceType,
} from "../domain";
import type { LlmClient, LlmProviderName, LlmUsage, StructuredCallResult } from "../llm";

export const ServiceTypeZodEnum = z.enum(SERVICE_TYPES);

export const IntakeEvidenceItemSchema = z.object({
  service: ServiceTypeZodEnum,
  quote: z.string().min(1),
});

export const IntakeLlmOutputSchema = z.object({
  requestedServices: z.array(ServiceTypeZodEnum),
  evidence: z.array(IntakeEvidenceItemSchema),
  isStandardCargo: z.boolean(),
  confidence: z.number().min(0).max(1),
  notes: z.string(),
});

export type IntakeLlmOutput = z.infer<typeof IntakeLlmOutputSchema>;

export interface HumanTaskDraft {
  id?: number;
  rfpId: number | null;
  laneId: number | null;
  laneCode: string;
  taskType: "CONFIRM_REQUIREMENTS";
  title: string;
  reason: string;
  payload: Record<string, unknown>;
}

export interface IntakeLaneResult {
  lane: Lane;
  ruleReading: RequirementExtraction;
  llmCall: StructuredCallResult<IntakeLlmOutput>;
  llmServices: ServiceType[] | null;
  mergedServices: ServiceType[];
  mergedConfidence: number;
  disagrees: boolean;
  disagreementServices: ServiceType[];
  ungroundedQuotes: string[];
  needsHumanTask: boolean;
  humanTask: HumanTaskDraft | null;
}

const INTAKE_SYSTEM_PROMPT = `You are an air freight RFP intake analyst extracting requested special handling services from a shipper's email.

Canonical special service enum values (ONLY use these exact codes):
1. TEMP_CONTROLLED: Continuous 2-8 C temperature control / cold chain / refrigerated cargo.
2. DANGEROUS_GOODS: Dangerous goods / hazardous materials / DG approved handling.
3. HIGH_VALUE_SECURITY: High-value cargo security / secure handling throughout.
4. FRAGILE: Fragile cargo / fragile-goods handling.
5. OVERSIZED: Oversized cargo / flights that can accommodate oversized pieces.

Instructions:
- Extract ONLY services explicitly requested for the shipment.
- If the email asks for standard general cargo with no special services / nothing special, return requestedServices: [], evidence: [], and isStandardCargo: true.
- For each requested service, include an evidence item with an exact verbatim substring quote copied from the email text.
- If the email asks for something outside the 5 services above (e.g., dry ice, -20 C frozen, live animals), is ambiguous, contradicts standard cargo, or references a different origin/destination airport pair than the row metadata, lower confidence below 0.80 and explain in notes.`;

function sortServicesCanonical(services: Iterable<ServiceType>): ServiceType[] {
  const set = new Set(services);
  return SERVICE_TYPES.filter((svc) => set.has(svc));
}

function normalizeWhitespace(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function symmetricServiceDiff(
  a: readonly ServiceType[],
  b: readonly ServiceType[],
): ServiceType[] {
  const setA = new Set(a);
  const setB = new Set(b);
  return SERVICE_TYPES.filter((s) => setA.has(s) !== setB.has(s));
}

function buildIntakePrompt(lane: Lane): string {
  return [
    `Lane Metadata: ${lane.origin}-${lane.destination} (Lane #${lane.laneNumber})`,
    `Volume: ${lane.tons} tons | Max transit: ${lane.maxTransitDays} days`,
    "",
    "Shipper Email Text:",
    '"""',
    lane.rawEmail,
    '"""',
  ].join("\n");
}

export interface RunIntakeDeps {
  llm: LlmClient;
  db?: AppDatabase;
  rfpId?: number | null;
  laneId?: number | null;
  timeoutMs?: number;
}

export async function runIntakeForLane(
  lane: Lane,
  deps: RunIntakeDeps,
): Promise<IntakeLaneResult> {
  const start = performance.now();
  const ruleReading = extractRequirementsOffline(lane.rawEmail, {
    origin: lane.origin,
    destination: lane.destination,
  });

  const llmCall = await deps.llm.generateStructured({
    agentName: "IntakeAgent",
    operation: `intake_lane_${lane.laneCode}`,
    schema: IntakeLlmOutputSchema,
    system: INTAKE_SYSTEM_PROMPT,
    prompt: buildIntakePrompt(lane),
    timeoutMs: deps.timeoutMs,
    rfpId: deps.rfpId ?? null,
    laneId: deps.laneId ?? null,
    metadata: {
      laneNumber: lane.laneNumber,
      laneCode: lane.laneCode,
    },
    offlineHandler: () => ({
      requestedServices: [...ruleReading.requestedServices],
      evidence: ruleReading.evidence.map((ev) => ({
        service: ev.service,
        quote: ev.quote,
      })),
      isStandardCargo:
        ruleReading.requestedServices.length === 0 &&
        ruleReading.standardCargoQuote !== null,
      confidence: ruleReading.confidence,
      notes:
        ruleReading.reviewReason ??
        (ruleReading.standardCargoQuote
          ? `Standard general cargo (${ruleReading.standardCargoQuote})`
          : "Extracted canonical special services via rule engine."),
    }),
  });

  const normalizedEmail = normalizeWhitespace(lane.rawEmail);
  let llmServices: ServiceType[] | null = null;
  const ungroundedQuotes: string[] = [];

  if (llmCall.ok) {
    llmServices = sortServicesCanonical(llmCall.data.requestedServices);
    for (const ev of llmCall.data.evidence) {
      const normalizedQuote = normalizeWhitespace(ev.quote);
      if (!normalizedQuote || !normalizedEmail.includes(normalizedQuote)) {
        ungroundedQuotes.push(`${ev.service}: "${ev.quote}"`);
      }
    }
  }

  const ruleServices = sortServicesCanonical(ruleReading.requestedServices);
  const disagreementServices =
    llmServices === null
      ? [...ruleServices]
      : symmetricServiceDiff(llmServices, ruleServices);
  const disagrees = llmServices === null || disagreementServices.length > 0;

  const reasons: string[] = [];
  if (!llmCall.ok) {
    reasons.push(
      `LLM intake failed (${llmCall.errorKind}: ${llmCall.errorMessage}).`,
    );
  } else if (disagrees) {
    reasons.push(
      `LLM reading [${llmServices?.join(", ") || "NONE"}] disagrees with rule-based reading [${ruleServices.join(", ") || "NONE"}].`,
    );
  }

  if (llmCall.ok && llmCall.data.confidence < CONFIDENCE_THRESHOLD) {
    reasons.push(
      `LLM confidence ${llmCall.data.confidence.toFixed(2)} is below threshold ${CONFIDENCE_THRESHOLD.toFixed(2)}.`,
    );
  }

  if (ruleReading.needsHumanReview) {
    reasons.push(
      ruleReading.reviewReason ??
        `Rule-based parser flagged low confidence (${ruleReading.confidence.toFixed(2)}).`,
    );
  }

  if (ungroundedQuotes.length > 0) {
    reasons.push(
      `LLM cited quote(s) not found verbatim in email: ${ungroundedQuotes.join("; ")}.`,
    );
  }

  const needsHumanTask = reasons.length > 0;
  const mergedServices = ruleServices;
  const mergedConfidence = llmCall.ok
    ? Number(Math.min(llmCall.data.confidence, ruleReading.confidence).toFixed(2))
    : Number(Math.min(0.4, ruleReading.confidence).toFixed(2));

  const mergedEvidence =
    !disagrees && llmCall.ok && llmCall.data.evidence.length > 0
      ? llmCall.data.evidence
      : ruleReading.evidence.map((ev) => ({
          service: ev.service,
          quote: ev.quote,
        }));

  let humanTask: HumanTaskDraft | null = null;
  const now = new Date().toISOString();

  if (needsHumanTask) {
    const reasonText = reasons.join(" ");
    const payload: Record<string, unknown> = {
      laneNumber: lane.laneNumber,
      laneCode: lane.laneCode,
      origin: lane.origin,
      destination: lane.destination,
      rawEmail: lane.rawEmail,
      disagreementServices,
      ungroundedQuotes,
      llmReading: llmCall.ok
        ? {
            provider: llmCall.provider,
            model: llmCall.model,
            requestedServices: llmServices,
            evidence: llmCall.data.evidence,
            isStandardCargo: llmCall.data.isStandardCargo,
            confidence: llmCall.data.confidence,
            notes: llmCall.data.notes,
          }
        : {
            provider: llmCall.provider,
            model: llmCall.model,
            errorKind: llmCall.errorKind,
            errorMessage: llmCall.errorMessage,
          },
      ruleReading: {
        requestedServices: ruleReading.requestedServices,
        evidence: ruleReading.evidence,
        standardCargoQuote: ruleReading.standardCargoQuote,
        unmappedPhrases: ruleReading.unmappedPhrases,
        warnings: ruleReading.warnings,
        confidence: ruleReading.confidence,
        needsHumanReview: ruleReading.needsHumanReview,
        reviewReason: ruleReading.reviewReason,
      },
    };

    humanTask = {
      rfpId: deps.rfpId ?? null,
      laneId: deps.laneId ?? null,
      laneCode: lane.laneCode,
      taskType: "CONFIRM_REQUIREMENTS",
      title: `Confirm special requirements for lane ${lane.laneCode}`,
      reason: reasonText,
      payload,
    };

    if (deps.db) {
      const [inserted] = await deps.db
        .insert(humanTasks)
        .values({
          rfpId: humanTask.rfpId,
          laneId: humanTask.laneId,
          laneCode: humanTask.laneCode,
          taskType: humanTask.taskType,
          title: humanTask.title,
          reason: humanTask.reason,
          payloadJson: JSON.stringify(humanTask.payload),
          status: "OPEN",
          createdAt: now,
        })
        .returning({ id: humanTasks.id });
      if (inserted) {
        humanTask.id = inserted.id;
      }
    }
  }

  if (deps.db && deps.laneId) {
    const intakeSource =
      deps.llm.provider === "offline"
        ? "OFFLINE_RULE"
        : needsHumanTask
          ? "DISPUTED"
          : "MERGED_AGREED";
    await deps.db
      .update(lanesTable)
      .set({
        requestedServicesJson: JSON.stringify(mergedServices),
        evidenceJson: JSON.stringify(mergedEvidence),
        intakeConfidence: mergedConfidence,
        intakeSource,
        intakeStatus: needsHumanTask ? "NEEDS_HUMAN_CONFIRMATION" : "CONFIRMED",
      })
      .where(eq(lanesTable.id, deps.laneId));
  }

  if (deps.db) {
    const totalLatency = Math.round(performance.now() - start);
    const provider: LlmProviderName = deps.llm.provider;
    const usage: LlmUsage = llmCall.usage;
    await deps.db.insert(agentEvents).values({
      rfpId: deps.rfpId ?? null,
      laneId: deps.laneId ?? null,
      agentName: "IntakeAgent",
      eventType: "INTAKE_MERGED",
      provider,
      model: llmCall.model,
      latencyMs: totalLatency,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUsd: llmCall.costUsd,
      retryCount: llmCall.retriesUsed,
      status: needsHumanTask ? "NEEDS_REVIEW" : "SUCCESS",
      summary: needsHumanTask
        ? `Lane ${lane.laneCode} flagged for human review: ${humanTask?.reason}`
        : `Lane ${lane.laneCode} intake confirmed (${mergedServices.join(", ") || "STANDARD"})`,
      payloadJson: JSON.stringify({
        laneCode: lane.laneCode,
        llmServices,
        ruleServices,
        disagrees,
        needsHumanTask,
      }),
      createdAt: now,
    });
  }

  return {
    lane,
    ruleReading,
    llmCall,
    llmServices,
    mergedServices,
    mergedConfidence,
    disagrees,
    disagreementServices,
    ungroundedQuotes,
    needsHumanTask,
    humanTask,
  };
}

export interface RunIntakeBatchDeps extends Omit<RunIntakeDeps, "laneId"> {
  concurrency?: number;
  resolveLaneDbId?: (lane: Lane, index: number) => number | null | undefined;
}

export async function runIntakeBatch(
  lanes: readonly Lane[],
  deps: RunIntakeBatchDeps,
): Promise<IntakeLaneResult[]> {
  const concurrency = Math.max(1, deps.concurrency ?? 5);
  const results = new Array<IntakeLaneResult>(lanes.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= lanes.length) {
        return;
      }
      const lane = lanes[idx]!;
      const laneId = deps.resolveLaneDbId?.(lane, idx) ?? null;
      results[idx] = await runIntakeForLane(lane, {
        llm: deps.llm,
        db: deps.db,
        rfpId: deps.rfpId ?? null,
        laneId,
        timeoutMs: deps.timeoutMs,
      });
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, lanes.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
