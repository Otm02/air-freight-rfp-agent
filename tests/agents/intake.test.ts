import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { runIntakeForLane } from "../../src/agents/intake";
import {
  agentEvents,
  createDatabase,
  humanTasks,
  lanes as lanesTable,
  rfps,
  type DatabaseHandle,
} from "../../src/db";
import type { Lane } from "../../src/domain";
import { LlmClient, type StructuredTransport } from "../../src/llm";

function makeLane(overrides?: Partial<Lane>): Lane {
  return {
    laneNumber: 2,
    laneCode: "MEX-CDG",
    origin: "MEX",
    destination: "CDG",
    tons: 12.3,
    maxTransitDays: 11,
    rawEmail:
      "MEX to CDG shipment: please arrange dangerous-goods handling on every leg. Can you confirm? Thanks!",
    ...overrides,
  };
}

async function seedRfpAndLane(handle: DatabaseHandle, lane: Lane) {
  const now = new Date().toISOString();
  const [rfp] = await handle.db
    .insert(rfps)
    .values({
      title: "Test RFP",
      sourceType: "unit-test",
      status: "INGESTED",
      llmProvider: "offline",
      customerName: "Maya",
      customerEmail: "maya@shipper.example",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  assert.ok(rfp);

  const [dbLane] = await handle.db
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
    .returning();
  assert.ok(dbLane);
  return { rfpId: rfp.id, laneId: dbLane.id };
}

describe("Intake agent dual-reading merge and human task escalation", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it("confirms clean special-service lanes without creating a human task in offline mode", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const lane = makeLane();
    const { rfpId, laneId } = await seedRfpAndLane(handle, lane);
    const llm = new LlmClient({ provider: "offline", db: handle.db });

    const res = await runIntakeForLane(lane, { llm, db: handle.db, rfpId, laneId });

    assert.equal(res.disagrees, false);
    assert.equal(res.needsHumanTask, false);
    assert.equal(res.humanTask, null);
    assert.deepEqual(res.mergedServices, ["DANGEROUS_GOODS"]);
    assert.ok(res.mergedConfidence >= 0.95);

    const tasks = await handle.db.select().from(humanTasks);
    assert.equal(tasks.length, 0);

    const [updatedLane] = await handle.db
      .select()
      .from(lanesTable)
      .where(eq(lanesTable.id, laneId));
    assert.equal(updatedLane?.intakeStatus, "CONFIRMED");
    assert.equal(updatedLane?.intakeSource, "OFFLINE_RULE");

    const events = await handle.db.select().from(agentEvents);
    assert.equal(events.length, 2);
  });

  it("handles standard general cargo with empty requestedServices and high confidence", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const lane = makeLane({
      laneNumber: 1,
      laneCode: "FAI-SIN",
      origin: "FAI",
      destination: "SIN",
      rawEmail:
        "Hi team, for FAI to SIN, standard general cargo is fine; no special services needed. Thanks, Maya",
    });
    const { rfpId, laneId } = await seedRfpAndLane(handle, lane);
    const llm = new LlmClient({ provider: "offline", db: handle.db });

    const res = await runIntakeForLane(lane, { llm, db: handle.db, rfpId, laneId });

    assert.deepEqual(res.mergedServices, []);
    assert.ok(res.mergedConfidence >= 0.95);
    assert.equal(res.needsHumanTask, false);
    assert.equal(res.humanTask, null);
  });

  it("creates human_task for out-of-catalog / low-confidence emails in offline mode", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const lane = makeLane({
      laneNumber: 6,
      laneCode: "HKG-LAX",
      origin: "HKG",
      destination: "LAX",
      rawEmail: "Hi, HKG to LAX needs dry ice at -20 C throughout. Best, Maya",
    });
    const { rfpId, laneId } = await seedRfpAndLane(handle, lane);
    const llm = new LlmClient({ provider: "offline", db: handle.db });

    const res = await runIntakeForLane(lane, { llm, db: handle.db, rfpId, laneId });

    assert.equal(res.needsHumanTask, true);
    assert.equal(res.humanTask?.title, "Confirm special requirements for lane HKG-LAX");

    const tasks = await handle.db.select().from(humanTasks);
    assert.equal(tasks.length, 1);
    const payload = JSON.parse(tasks[0]!.payloadJson) as Record<string, unknown>;
    assert.ok("llmReading" in payload);
    assert.ok("ruleReading" in payload);
  });

  it("creates human_task showing both readings when LLM and rule parser disagree", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const lane = makeLane();
    const { rfpId, laneId } = await seedRfpAndLane(handle, lane);

    const transport: StructuredTransport = {
      async generateStructured() {
        return {
          rawObject: {
            requestedServices: ["FRAGILE"],
            evidence: [
              {
                service: "FRAGILE",
                quote: "dangerous-goods handling on every leg",
              },
            ],
            isStandardCargo: false,
            confidence: 0.95,
            notes: "Simulated mismatch",
          },
          usage: { inputTokens: 90, outputTokens: 25, totalTokens: 115 },
        };
      },
    };
    const llm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport,
      db: handle.db,
    });

    const res = await runIntakeForLane(lane, { llm, db: handle.db, rfpId, laneId });

    assert.equal(res.disagrees, true);
    assert.deepEqual(res.disagreementServices, ["DANGEROUS_GOODS", "FRAGILE"]);
    assert.equal(res.needsHumanTask, true);

    const tasks = await handle.db.select().from(humanTasks);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, "Confirm special requirements for lane MEX-CDG");
    const payload = JSON.parse(tasks[0]!.payloadJson) as {
      llmReading: { requestedServices: string[] };
      ruleReading: { requestedServices: string[] };
    };
    assert.deepEqual(payload.llmReading.requestedServices, ["FRAGILE"]);
    assert.deepEqual(payload.ruleReading.requestedServices, ["DANGEROUS_GOODS"]);
  });

  it("escalates to human_task when LLM agrees on services but reports low confidence", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const lane = makeLane();
    const { rfpId, laneId } = await seedRfpAndLane(handle, lane);

    const transport: StructuredTransport = {
      async generateStructured() {
        return {
          rawObject: {
            requestedServices: ["DANGEROUS_GOODS"],
            evidence: [
              {
                service: "DANGEROUS_GOODS",
                quote: "dangerous-goods handling on every leg",
              },
            ],
            isStandardCargo: false,
            confidence: 0.6,
            notes: "Uncertain shipper wording",
          },
        };
      },
    };
    const llm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport,
      db: handle.db,
    });

    const res = await runIntakeForLane(lane, { llm, db: handle.db, rfpId, laneId });

    assert.equal(res.disagrees, false);
    assert.equal(res.needsHumanTask, true);
    const tasks = await handle.db.select().from(humanTasks);
    assert.equal(tasks.length, 1);
  });

  it("escalates to human_task when LLM cites an ungrounded evidence quote", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const lane = makeLane();
    const { rfpId, laneId } = await seedRfpAndLane(handle, lane);

    const transport: StructuredTransport = {
      async generateStructured() {
        return {
          rawObject: {
            requestedServices: ["DANGEROUS_GOODS"],
            evidence: [
              {
                service: "DANGEROUS_GOODS",
                quote: "this fabricated quote does not exist in email",
              },
            ],
            isStandardCargo: false,
            confidence: 0.96,
            notes: "Hallucinated quote",
          },
        };
      },
    };
    const llm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport,
      db: handle.db,
    });

    const res = await runIntakeForLane(lane, { llm, db: handle.db, rfpId, laneId });

    assert.equal(res.disagrees, false);
    assert.equal(res.ungroundedQuotes.length, 1);
    assert.equal(res.needsHumanTask, true);
  });

  it("gracefully falls back and creates human_task if LLM fails after retry", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const lane = makeLane();
    const { rfpId, laneId } = await seedRfpAndLane(handle, lane);

    const transport: StructuredTransport = {
      async generateStructured() {
        return { rawText: "{bad json" };
      },
    };
    const llm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport,
      db: handle.db,
    });

    const res = await runIntakeForLane(lane, { llm, db: handle.db, rfpId, laneId });

    assert.equal(res.llmCall.ok, false);
    assert.equal(res.disagrees, true);
    assert.equal(res.needsHumanTask, true);
    assert.deepEqual(res.mergedServices, ["DANGEROUS_GOODS"]);

    const tasks = await handle.db.select().from(humanTasks);
    assert.equal(tasks.length, 1);
    const payload = JSON.parse(tasks[0]!.payloadJson) as {
      llmReading: { errorKind: string };
      ruleReading: { requestedServices: string[] };
    };
    assert.equal(payload.llmReading.errorKind, "INVALID_JSON");
    assert.deepEqual(payload.ruleReading.requestedServices, ["DANGEROUS_GOODS"]);
  });
});
