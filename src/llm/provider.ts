import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  APICallError,
  generateObject,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";
import type { z } from "zod";
import { agentEvents, type AppDatabase } from "../db";
import { publishAgentEvent } from "../orchestrator/event-bus";
import { estimateCostUsd } from "./pricing";
import type {
  LlmClientOptions,
  LlmErrorKind,
  LlmProviderName,
  LlmUsage,
  ProviderConfig,
  StructuredCallRequest,
  StructuredCallResult,
  StructuredTransport,
  StructuredTransportRequest,
  StructuredTransportResponse,
} from "./types";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OFFLINE_MODEL = "offline-rule-v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const RATE_LIMIT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;

function sanitizeUsage(raw?: Partial<LlmUsage>): LlmUsage {
  const inputTokens = Math.max(0, Math.round(raw?.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.round(raw?.outputTokens ?? 0));
  const totalTokens = Math.max(
    inputTokens + outputTokens,
    Math.round(raw?.totalTokens ?? inputTokens + outputTokens),
  );
  return { inputTokens, outputTokens, totalTokens };
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error("Aborted during rate-limit backoff"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted during rate-limit backoff"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRateLimitError(err: unknown): boolean {
  if (APICallError.isInstance(err) && err.statusCode === 429) {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("quota")
  );
}

function classifyTransportError(
  err: unknown,
  timedOut: boolean,
): { errorKind: LlmErrorKind; errorMessage: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (
    timedOut ||
    (err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError"))
  ) {
    return { errorKind: "TIMEOUT", errorMessage: message };
  }
  if (JSONParseError.isInstance(err)) {
    return { errorKind: "INVALID_JSON", errorMessage: message };
  }
  if (TypeValidationError.isInstance(err)) {
    return { errorKind: "SCHEMA_VALIDATION", errorMessage: message };
  }
  if (NoObjectGeneratedError.isInstance(err)) {
    if (err.cause && TypeValidationError.isInstance(err.cause)) {
      return { errorKind: "SCHEMA_VALIDATION", errorMessage: message };
    }
    return { errorKind: "INVALID_JSON", errorMessage: message };
  }
  return { errorKind: "PROVIDER_ERROR", errorMessage: message };
}

export function resolveProviderConfig(
  options?: Pick<LlmClientOptions, "provider" | "model" | "env">,
): ProviderConfig {
  const env = options?.env ?? process.env;
  const requested = (
    options?.provider ??
    env.LLM_PROVIDER ??
    "auto"
  )
    .trim()
    .toLowerCase();

  const geminiKey =
    env.GEMINI_API_KEY?.trim() || env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();

  if (requested === "offline") {
    return {
      provider: "offline",
      model: options?.model ?? DEFAULT_OFFLINE_MODEL,
    };
  }

  if (requested === "gemini") {
    if (!geminiKey) {
      throw new Error(
        'GEMINI_API_KEY is required when LLM provider is explicitly set to "gemini".',
      );
    }
    return {
      provider: "gemini",
      model: options?.model ?? env.GEMINI_MODEL?.trim() ?? DEFAULT_GEMINI_MODEL,
      apiKey: geminiKey,
    };
  }

  if (requested === "openai") {
    if (!openaiKey) {
      throw new Error(
        'OPENAI_API_KEY is required when LLM provider is explicitly set to "openai".',
      );
    }
    return {
      provider: "openai",
      model: options?.model ?? env.OPENAI_MODEL?.trim() ?? DEFAULT_OPENAI_MODEL,
      apiKey: openaiKey,
    };
  }

  // Auto-selection: Gemini default -> OpenAI fallback -> Offline deterministic mode
  if (geminiKey) {
    return {
      provider: "gemini",
      model: options?.model ?? env.GEMINI_MODEL?.trim() ?? DEFAULT_GEMINI_MODEL,
      apiKey: geminiKey,
    };
  }

  if (openaiKey) {
    return {
      provider: "openai",
      model: options?.model ?? env.OPENAI_MODEL?.trim() ?? DEFAULT_OPENAI_MODEL,
      apiKey: openaiKey,
    };
  }

  return {
    provider: "offline",
    model: options?.model ?? DEFAULT_OFFLINE_MODEL,
  };
}

export function createVercelAiTransport(apiKey: string): StructuredTransport {
  return {
    async generateStructured(
      req: StructuredTransportRequest,
    ): Promise<StructuredTransportResponse> {
      const modelInstance =
        req.provider === "gemini"
          ? createGoogleGenerativeAI({ apiKey })(req.model)
          : createOpenAI({ apiKey })(req.model);

      const providerOptions =
        req.provider === "gemini" && req.model.includes("2.5")
          ? { google: { thinkingConfig: { thinkingBudget: 0 } } }
          : undefined;

      for (let rlAttempt = 0; rlAttempt <= RATE_LIMIT_DELAYS_MS.length; rlAttempt += 1) {
        try {
          const result = await generateObject({
            model: modelInstance,
            schema: req.schema,
            system: req.system,
            prompt: req.prompt,
            abortSignal: req.signal,
            maxRetries: 0,
            temperature: 0,
            providerOptions,
          });
          return {
            rawObject: result.object,
            usage: {
              inputTokens: result.usage?.promptTokens ?? 0,
              outputTokens: result.usage?.completionTokens ?? 0,
              totalTokens: result.usage?.totalTokens ?? 0,
            },
          };
        } catch (err) {
          if (
            !req.signal.aborted &&
            isRateLimitError(err) &&
            rlAttempt < RATE_LIMIT_DELAYS_MS.length
          ) {
            await sleepWithSignal(
              RATE_LIMIT_DELAYS_MS[rlAttempt]!,
              req.signal,
            );
            continue;
          }
          throw err;
        }
      }

      throw new Error("Exhausted rate-limit backoff attempts.");
    },
  };
}

export class LlmClient {
  readonly config: ProviderConfig;
  private readonly db?: AppDatabase;
  private readonly defaultTimeoutMs: number;
  private readonly transport?: StructuredTransport;

  constructor(options?: LlmClientOptions) {
    this.config = resolveProviderConfig(options);
    this.db = options?.db;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options?.transport) {
      this.transport = options.transport;
    } else if (this.config.provider !== "offline" && this.config.apiKey) {
      this.transport = createVercelAiTransport(this.config.apiKey);
    }
  }

  get provider(): LlmProviderName {
    return this.config.provider;
  }

  get model(): string {
    return this.config.model;
  }

  private async logAgentEvent(params: {
    rfpId?: number | null;
    laneId?: number | null;
    agentName: string;
    eventType: string;
    latencyMs: number;
    usage: LlmUsage;
    costUsd: number;
    retryCount: number;
    status: "SUCCESS" | "RETRYING" | "ERROR";
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.db) {
      return;
    }
    const executionMode =
      this.config.provider === "offline" ? "DETERMINISTIC" : "LLM";
    const [inserted] = await this.db
      .insert(agentEvents)
      .values({
        rfpId: params.rfpId ?? null,
        laneId: params.laneId ?? null,
        agentName: params.agentName,
        eventType: params.eventType,
        provider: this.config.provider,
        model: this.config.model,
        latencyMs: Math.max(0, Math.round(params.latencyMs)),
        inputTokens: params.usage.inputTokens,
        outputTokens: params.usage.outputTokens,
        totalTokens: params.usage.totalTokens,
        costUsd: params.costUsd,
        retryCount: params.retryCount,
        status: params.status,
        summary: params.summary,
        payloadJson: JSON.stringify({
          executionMode,
          step: String(params.payload.operation ?? params.eventType),
          ...params.payload,
        }),
        createdAt: new Date().toISOString(),
      })
      .returning();
    if (inserted) {
      publishAgentEvent(inserted);
    }
  }

  async generateStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredCallRequest<TSchema>,
  ): Promise<StructuredCallResult<z.infer<TSchema>>> {
    if (this.config.provider === "offline") {
      const start = performance.now();
      try {
        const candidate = await request.offlineHandler();
        const parsed = request.schema.safeParse(candidate);
        const latencyMs = Math.round(performance.now() - start);
        const zeroUsage: LlmUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };

        if (!parsed.success) {
          const message = parsed.error.issues
            .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
            .join("; ");
          await this.logAgentEvent({
            rfpId: request.rfpId,
            laneId: request.laneId,
            agentName: request.agentName,
            eventType: "LLM_CALL_ERROR",
            latencyMs,
            usage: zeroUsage,
            costUsd: 0,
            retryCount: 0,
            status: "ERROR",
            summary: `${request.operation} offline schema validation failed`,
            payload: {
              operation: request.operation,
              errorKind: "SCHEMA_VALIDATION",
              errorMessage: message,
              ...request.metadata,
            },
          });
          return {
            ok: false,
            errorKind: "SCHEMA_VALIDATION",
            errorMessage: message,
            provider: this.config.provider,
            model: this.config.model,
            latencyMs,
            usage: zeroUsage,
            costUsd: 0,
            retriesUsed: 0,
          };
        }

        await this.logAgentEvent({
          rfpId: request.rfpId,
          laneId: request.laneId,
          agentName: request.agentName,
          eventType: "LLM_CALL_SUCCESS",
          latencyMs,
          usage: zeroUsage,
          costUsd: 0,
          retryCount: 0,
          status: "SUCCESS",
          summary: `${request.operation} completed in offline mode`,
          payload: {
            operation: request.operation,
            ...request.metadata,
          },
        });

        return {
          ok: true,
          data: parsed.data,
          provider: this.config.provider,
          model: this.config.model,
          latencyMs,
          usage: zeroUsage,
          costUsd: 0,
          retriesUsed: 0,
        };
      } catch (err) {
        const latencyMs = Math.round(performance.now() - start);
        const zeroUsage: LlmUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        const msg = err instanceof Error ? err.message : String(err);
        await this.logAgentEvent({
          rfpId: request.rfpId,
          laneId: request.laneId,
          agentName: request.agentName,
          eventType: "LLM_CALL_ERROR",
          latencyMs,
          usage: zeroUsage,
          costUsd: 0,
          retryCount: 0,
          status: "ERROR",
          summary: `${request.operation} offline handler threw error`,
          payload: {
            operation: request.operation,
            errorKind: "PROVIDER_ERROR",
            errorMessage: msg,
            ...request.metadata,
          },
        });
        return {
          ok: false,
          errorKind: "PROVIDER_ERROR",
          errorMessage: msg,
          provider: this.config.provider,
          model: this.config.model,
          latencyMs,
          usage: zeroUsage,
          costUsd: 0,
          retriesUsed: 0,
        };
      }
    }

    if (!this.transport) {
      throw new Error(
        `No LLM transport available for provider "${this.config.provider}".`,
      );
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    let totalUsage: LlmUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let totalLatencyMs = 0;
    let currentPrompt = request.prompt;

    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const attemptStart = performance.now();
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let attemptErrorKind: LlmErrorKind | null = null;
      let attemptErrorMessage = "";

      try {
        const response = await this.transport.generateStructured({
          provider: this.config.provider,
          model: this.config.model,
          schema: request.schema,
          system: request.system,
          prompt: currentPrompt,
          signal: controller.signal,
        });

        const attemptUsage = sanitizeUsage(response.usage);
        totalUsage = addUsage(totalUsage, attemptUsage);

        let candidateObject: unknown = response.rawObject;
        if (candidateObject === undefined && response.rawText !== undefined) {
          try {
            candidateObject = JSON.parse(response.rawText);
          } catch (parseErr) {
            attemptErrorKind = "INVALID_JSON";
            attemptErrorMessage =
              parseErr instanceof Error ? parseErr.message : String(parseErr);
          }
        }

        if (attemptErrorKind === null) {
          const parsed = request.schema.safeParse(candidateObject);
          if (parsed.success) {
            const attemptLatency = Math.round(performance.now() - attemptStart);
            totalLatencyMs += attemptLatency;
            const totalCost = estimateCostUsd(
              this.config.model,
              totalUsage.inputTokens,
              totalUsage.outputTokens,
            );

            await this.logAgentEvent({
              rfpId: request.rfpId,
              laneId: request.laneId,
              agentName: request.agentName,
              eventType: "LLM_CALL_SUCCESS",
              latencyMs: totalLatencyMs,
              usage: totalUsage,
              costUsd: totalCost,
              retryCount: attempt,
              status: "SUCCESS",
              summary: `${request.operation} succeeded (${this.config.model}, retries=${attempt})`,
              payload: {
                operation: request.operation,
                ...request.metadata,
              },
            });

            return {
              ok: true,
              data: parsed.data,
              provider: this.config.provider,
              model: this.config.model,
              latencyMs: totalLatencyMs,
              usage: totalUsage,
              costUsd: totalCost,
              retriesUsed: attempt,
            };
          }

          attemptErrorKind = "SCHEMA_VALIDATION";
          attemptErrorMessage = parsed.error.issues
            .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
            .join("; ");
        }
      } catch (err) {
        const classified = classifyTransportError(err, timedOut);
        attemptErrorKind = classified.errorKind;
        attemptErrorMessage = classified.errorMessage;
      } finally {
        clearTimeout(timer);
      }

      const attemptLatency = Math.round(performance.now() - attemptStart);
      totalLatencyMs += attemptLatency;

      const canRetry =
        attempt === 0 &&
        (attemptErrorKind === "INVALID_JSON" ||
          attemptErrorKind === "SCHEMA_VALIDATION");

      if (canRetry) {
        const interimCost = estimateCostUsd(
          this.config.model,
          totalUsage.inputTokens,
          totalUsage.outputTokens,
        );
        await this.logAgentEvent({
          rfpId: request.rfpId,
          laneId: request.laneId,
          agentName: request.agentName,
          eventType: "LLM_CALL_RETRY",
          latencyMs: attemptLatency,
          usage: totalUsage,
          costUsd: interimCost,
          retryCount: 1,
          status: "RETRYING",
          summary: `${request.operation} retrying after ${attemptErrorKind}`,
          payload: {
            operation: request.operation,
            errorKind: attemptErrorKind,
            errorMessage: attemptErrorMessage,
            ...request.metadata,
          },
        });
        currentPrompt =
          `${request.prompt}\n\nPrevious output failed JSON/schema validation (${attemptErrorKind}: ${attemptErrorMessage}). ` +
          "Return ONLY valid JSON strictly matching the schema.";
        continue;
      }

      const totalCost = estimateCostUsd(
        this.config.model,
        totalUsage.inputTokens,
        totalUsage.outputTokens,
      );
      const finalKind = attemptErrorKind ?? "PROVIDER_ERROR";
      await this.logAgentEvent({
        rfpId: request.rfpId,
        laneId: request.laneId,
        agentName: request.agentName,
        eventType: "LLM_CALL_ERROR",
        latencyMs: totalLatencyMs,
        usage: totalUsage,
        costUsd: totalCost,
        retryCount: attempt,
        status: "ERROR",
        summary: `${request.operation} failed (${finalKind}, retries=${attempt})`,
        payload: {
          operation: request.operation,
          errorKind: finalKind,
          errorMessage: attemptErrorMessage,
          ...request.metadata,
        },
      });

      return {
        ok: false,
        errorKind: finalKind,
        errorMessage: attemptErrorMessage,
        provider: this.config.provider,
        model: this.config.model,
        latencyMs: totalLatencyMs,
        usage: totalUsage,
        costUsd: totalCost,
        retriesUsed: attempt,
      };
    }

    throw new Error("Unreachable retry loop termination.");
  }
}
