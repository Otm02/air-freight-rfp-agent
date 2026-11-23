import { EventEmitter } from "node:events";
import { and, asc, eq, gt } from "drizzle-orm";
import { agentEvents, type AppDatabase } from "../db";
import type { AgentEventView } from "./types";

export type ExecutionMode = "DETERMINISTIC" | "LLM" | "HUMAN_GATE" | "SYSTEM";

export type AgentEventRow = typeof agentEvents.$inferSelect;

export function toAgentEventView(row: AgentEventRow): AgentEventView {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = { raw: row.payloadJson };
  }

  const rawMode = String(payload.executionMode ?? "");
  let executionMode: ExecutionMode;
  if (
    rawMode === "DETERMINISTIC" ||
    rawMode === "LLM" ||
    rawMode === "HUMAN_GATE" ||
    rawMode === "SYSTEM"
  ) {
    executionMode = rawMode;
  } else if (
    row.status === "WAITING_FOR_HUMAN" ||
    row.provider === "human-gate" ||
    row.eventType.includes("WAITING") ||
    row.eventType.includes("NEEDS_HUMAN")
  ) {
    executionMode = "HUMAN_GATE";
  } else if (row.provider === "gemini" || row.provider === "openai") {
    executionMode = "LLM";
  } else if (
    row.provider === "deterministic" ||
    row.provider === "deterministic-scheduler" ||
    row.provider === "offline"
  ) {
    executionMode = "DETERMINISTIC";
  } else {
    executionMode = "SYSTEM";
  }

  return {
    id: row.id,
    rfpId: row.rfpId,
    laneId: row.laneId,
    agentName: row.agentName,
    eventType: row.eventType,
    step: String(payload.step ?? payload.operation ?? row.eventType),
    executionMode,
    provider: row.provider,
    model: row.model,
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    retryCount: row.retryCount,
    status: row.status,
    summary: row.summary,
    inputSummary:
      typeof payload.inputSummary === "string" ? payload.inputSummary : null,
    outputSummary:
      typeof payload.outputSummary === "string" ? payload.outputSummary : null,
    fromState: typeof payload.fromState === "string" ? payload.fromState : null,
    toState: typeof payload.toState === "string" ? payload.toState : null,
    payload,
    createdAt: row.createdAt,
  };
}

export interface EmitAgentEventInput {
  rfpId: number | null;
  laneId?: number | null;
  agentName: string;
  eventType: string;
  step: string;
  executionMode: ExecutionMode;
  provider?: string;
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  retryCount?: number;
  status: string;
  summary: string;
  inputSummary?: string;
  outputSummary?: string;
  fromState?: string | null;
  toState?: string | null;
  details?: Record<string, unknown>;
}

const globalForBus = globalThis as typeof globalThis & {
  __airFreightRfpEventBus?: EventEmitter;
  __airFreightPublishedEventIds?: Set<number>;
};

function getEventBus(): EventEmitter {
  if (!globalForBus.__airFreightRfpEventBus) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100);
    globalForBus.__airFreightRfpEventBus = emitter;
  }
  return globalForBus.__airFreightRfpEventBus;
}

function getPublishedSet(): Set<number> {
  if (!globalForBus.__airFreightPublishedEventIds) {
    globalForBus.__airFreightPublishedEventIds = new Set<number>();
  }
  const set = globalForBus.__airFreightPublishedEventIds;
  if (set.size > 2000) {
    const recent = Array.from(set).slice(-500);
    set.clear();
    for (const id of recent) set.add(id);
  }
  return set;
}

export function publishAgentEvent(row: AgentEventRow): void {
  const published = getPublishedSet();
  if (published.has(row.id)) {
    return;
  }
  published.add(row.id);

  const bus = getEventBus();
  if (row.rfpId !== null) {
    bus.emit(`rfp:${row.rfpId}`, row);
  }
  bus.emit("rfp:*", row);
}

export function subscribeToRfpEvents(
  rfpId: number,
  listener: (row: AgentEventRow) => void,
): () => void {
  const bus = getEventBus();
  const channel = `rfp:${rfpId}`;
  bus.on(channel, listener);
  return () => {
    bus.off(channel, listener);
  };
}

export async function emitAgentEvent(
  db: AppDatabase,
  input: EmitAgentEventInput,
): Promise<AgentEventRow> {
  const payload = {
    step: input.step,
    executionMode: input.executionMode,
    inputSummary: input.inputSummary ?? null,
    outputSummary: input.outputSummary ?? input.summary,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    ...(input.details ?? {}),
  };

  const [inserted] = await db
    .insert(agentEvents)
    .values({
      rfpId: input.rfpId,
      laneId: input.laneId ?? null,
      agentName: input.agentName,
      eventType: input.eventType,
      provider:
        input.provider ??
        (input.executionMode === "DETERMINISTIC"
          ? "deterministic"
          : input.executionMode === "HUMAN_GATE"
            ? "human-gate"
            : "orchestrator"),
      model:
        input.model ??
        (input.executionMode === "DETERMINISTIC"
          ? "rule-engine-v1"
          : input.executionMode === "HUMAN_GATE"
            ? "hitl-gate"
            : "state-machine-v1"),
      latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      totalTokens: input.totalTokens ?? 0,
      costUsd: input.costUsd ?? 0,
      retryCount: input.retryCount ?? 0,
      status: input.status,
      summary: input.summary,
      payloadJson: JSON.stringify(payload),
      createdAt: new Date().toISOString(),
    })
    .returning();

  if (!inserted) {
    throw new Error("Failed to insert agent_events row.");
  }

  publishAgentEvent(inserted);
  return inserted;
}

export async function getEventsAfter(
  db: AppDatabase,
  rfpId: number,
  afterId: number = 0,
): Promise<AgentEventRow[]> {
  return db
    .select()
    .from(agentEvents)
    .where(and(eq(agentEvents.rfpId, rfpId), gt(agentEvents.id, afterId)))
    .orderBy(asc(agentEvents.id));
}

export async function publishUnseenEventsAfter(
  db: AppDatabase,
  rfpId: number,
  afterId: number,
): Promise<number> {
  const unseen = await getEventsAfter(db, rfpId, afterId);
  let maxId = afterId;
  for (const row of unseen) {
    publishAgentEvent(row);
    if (row.id > maxId) {
      maxId = row.id;
    }
  }
  return maxId;
}
