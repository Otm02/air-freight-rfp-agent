import type { z } from "zod";
import type { AppDatabase } from "../db";

export type LlmProviderName = "gemini" | "openai" | "offline";
export type LlmProviderPreference = LlmProviderName | "auto";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type LlmErrorKind =
  | "INVALID_JSON"
  | "SCHEMA_VALIDATION"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "RATE_LIMIT_EXCEEDED"
  | "COST_CAP_EXCEEDED";

export interface ProviderConfig {
  provider: LlmProviderName;
  model: string;
  apiKey?: string;
}

export interface StructuredTransportRequest {
  provider: LlmProviderName;
  model: string;
  schema: z.ZodTypeAny;
  system: string;
  prompt: string;
  signal: AbortSignal;
}

export interface StructuredTransportResponse {
  rawText?: string;
  rawObject?: unknown;
  usage?: Partial<LlmUsage>;
}

export interface StructuredTransport {
  generateStructured(
    req: StructuredTransportRequest,
  ): Promise<StructuredTransportResponse>;
}

export interface StructuredCallRequest<TSchema extends z.ZodTypeAny> {
  agentName: string;
  operation: string;
  schema: TSchema;
  system: string;
  prompt: string;
  offlineHandler: () => z.input<TSchema> | Promise<z.input<TSchema>>;
  timeoutMs?: number;
  rfpId?: number | null;
  laneId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface StructuredCallSuccess<T> {
  ok: true;
  data: T;
  provider: LlmProviderName;
  model: string;
  latencyMs: number;
  usage: LlmUsage;
  costUsd: number;
  retriesUsed: number;
}

export interface StructuredCallFailure {
  ok: false;
  errorKind: LlmErrorKind;
  errorMessage: string;
  provider: LlmProviderName;
  model: string;
  latencyMs: number;
  usage: LlmUsage;
  costUsd: number;
  retriesUsed: number;
}

export type StructuredCallResult<T> =
  | StructuredCallSuccess<T>
  | StructuredCallFailure;

export interface LlmRunStats {
  callCount: number;
  recentWindowCount: number;
  cumulativeCostUsd: number;
  maxRequestsPerMinute: number;
  maxCostUsdPerRun: number;
}

export interface LlmClientOptions {
  provider?: LlmProviderPreference;
  model?: string;
  env?: Record<string, string | undefined>;
  db?: AppDatabase;
  defaultTimeoutMs?: number;
  maxRequestsPerMinute?: number;
  maxCostUsdPerRun?: number;
  transport?: StructuredTransport;
}
