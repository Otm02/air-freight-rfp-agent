import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { agentEvents, createDatabase, type DatabaseHandle } from "../../src/db";
import {
  estimateCostUsd,
  LlmClient,
  resolveProviderConfig,
  type StructuredTransport,
} from "../../src/llm";

const TestSchema = z.object({
  services: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

describe("resolveProviderConfig & pricing", () => {
  it("selects offline when no keys exist, Gemini by default when GEMINI_API_KEY is set, and OpenAI as fallback", () => {
    assert.equal(resolveProviderConfig({ env: {} }).provider, "offline");
    assert.equal(
      resolveProviderConfig({
        env: { GEMINI_API_KEY: "gem-test", OPENAI_API_KEY: "oa-test" },
      }).provider,
      "gemini",
    );
    assert.equal(
      resolveProviderConfig({
        env: { OPENAI_API_KEY: "oa-test" },
      }).provider,
      "openai",
    );
    assert.equal(
      resolveProviderConfig({
        provider: "offline",
        env: { GEMINI_API_KEY: "gem-test" },
      }).provider,
      "offline",
    );
  });

  it("estimates zero cost for offline models and positive cost for live models", () => {
    assert.equal(estimateCostUsd("offline-rule-v1", 500, 100), 0);
    const geminiCost = estimateCostUsd("gemini-2.5-flash", 1000, 200);
    assert.ok(geminiCost > 0);
  });
});

describe("LlmClient structured output, retry, timeout, and agent_events logging", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it("executes offline handler, validates with Zod, and logs to agent_events", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const client = new LlmClient({
      provider: "offline",
      db: handle.db,
    });

    const result = await client.generateStructured({
      agentName: "IntakeAgent",
      operation: "extract_requirements",
      schema: TestSchema,
      system: "Extract services",
      prompt: "Test prompt",
      offlineHandler: () => ({
        services: ["FRAGILE"],
        confidence: 0.99,
      }),
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.data, { services: ["FRAGILE"], confidence: 0.99 });
      assert.equal(result.provider, "offline");
      assert.equal(result.model, "offline-rule-v1");
      assert.equal(result.costUsd, 0);
      assert.equal(result.retriesUsed, 0);
    }

    const events = await handle.db.select().from(agentEvents);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "LLM_CALL_SUCCESS");
    assert.equal(events[0]?.model, "offline-rule-v1");
    assert.equal(events[0]?.status, "SUCCESS");
  });

  it("retries once on invalid JSON and succeeds on second attempt while logging token usage and cost", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    let calls = 0;
    const transport: StructuredTransport = {
      async generateStructured(req) {
        calls += 1;
        if (calls === 1) {
          return {
            rawText: "{not valid json",
            usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
          };
        }
        assert.ok(req.prompt.includes("INVALID_JSON"));
        return {
          rawText: JSON.stringify({ services: ["OVERSIZED"], confidence: 0.94 }),
          usage: { inputTokens: 180, outputTokens: 25, totalTokens: 205 },
        };
      },
    };

    const client = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport,
      db: handle.db,
    });

    const result = await client.generateStructured({
      agentName: "IntakeAgent",
      operation: "extract_requirements",
      schema: TestSchema,
      system: "Extract services",
      prompt: "Lane prompt",
      offlineHandler: () => ({ services: [], confidence: 0 }),
    });

    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.retriesUsed, 1);
      assert.deepEqual(result.data.services, ["OVERSIZED"]);
      assert.equal(result.usage.inputTokens, 300);
      assert.equal(result.usage.outputTokens, 40);
      assert.equal(result.usage.totalTokens, 340);
      assert.ok(result.costUsd > 0);
    }

    const events = await handle.db.select().from(agentEvents);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventType, "LLM_CALL_RETRY");
    assert.equal(events[1]?.eventType, "LLM_CALL_SUCCESS");
    assert.equal(events[1]?.retryCount, 1);
    assert.equal(events[1]?.totalTokens, 340);
    assert.ok((events[1]?.costUsd ?? 0) > 0);
  });

  it("fails gracefully after one retry when schema validation fails twice", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    let calls = 0;
    const transport: StructuredTransport = {
      async generateStructured() {
        calls += 1;
        return {
          rawObject: { services: ["FRAGILE"], confidence: 99 }, // confidence > 1 fails Zod
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        };
      },
    };

    const client = new LlmClient({
      provider: "openai",
      env: { OPENAI_API_KEY: "test-key" },
      transport,
      db: handle.db,
    });

    const result = await client.generateStructured({
      agentName: "IntakeAgent",
      operation: "extract_requirements",
      schema: TestSchema,
      system: "Extract",
      prompt: "Prompt",
      offlineHandler: () => ({ services: [], confidence: 0 }),
    });

    assert.equal(calls, 2);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "SCHEMA_VALIDATION");
      assert.equal(result.retriesUsed, 1);
    }

    const events = await handle.db.select().from(agentEvents);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.eventType, "LLM_CALL_ERROR");
    assert.equal(events[1]?.status, "ERROR");
  });

  it("enforces request timeout without retrying and logs TIMEOUT error", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    let calls = 0;
    const transport: StructuredTransport = {
      generateStructured(req) {
        calls += 1;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({ rawObject: { services: [], confidence: 1 } });
          }, 500);
          req.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
      },
    };

    const client = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport,
      db: handle.db,
      defaultTimeoutMs: 40,
    });

    const result = await client.generateStructured({
      agentName: "IntakeAgent",
      operation: "extract_requirements",
      schema: TestSchema,
      system: "Extract",
      prompt: "Prompt",
      offlineHandler: () => ({ services: [], confidence: 0 }),
    });

    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorKind, "TIMEOUT");
      assert.equal(result.retriesUsed, 0);
    }

    const events = await handle.db.select().from(agentEvents);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "LLM_CALL_ERROR");
  });
});
