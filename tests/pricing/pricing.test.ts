import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  createPricingRequestEmail,
  parsePricingReply,
  sendPricingClarificationAndResolve,
} from "../../src/agents";
import {
  agentEvents,
  createDatabase,
  emails as emailsTable,
  humanTasks,
  lanes as lanesTable,
  pricingResponses,
  rfps,
  type DatabaseHandle,
} from "../../src/db";
import { LlmClient, type StructuredTransport } from "../../src/llm";
import {
  computeTrueLanePrice,
  generateMockPricingReply,
  type PricingQuoteLaneInput,
} from "../../src/pricing";

function makeSampleLanes(): PricingQuoteLaneInput[] {
  return [
    {
      laneId: 2,
      laneCode: "MEX-CDG",
      origin: "MEX",
      destination: "CDG",
      tons: 12.3,
      routeAirports: ["MEX", "CDG"],
      transitDays: 11,
      requestedServices: ["DANGEROUS_GOODS"],
      fulfillableServices: ["DANGEROUS_GOODS"],
    },
    {
      laneId: 3,
      laneCode: "DFW-MEX",
      origin: "DFW",
      destination: "MEX",
      tons: 36.2,
      routeAirports: ["DFW", "YYZ", "MEX"],
      transitDays: 15,
      requestedServices: ["HIGH_VALUE_SECURITY"],
      fulfillableServices: ["HIGH_VALUE_SECURITY"],
    },
    {
      laneId: 9,
      laneCode: "GRU-BOG",
      origin: "GRU",
      destination: "BOG",
      tons: 15,
      routeAirports: ["GRU", "BOG"],
      transitDays: 8,
      requestedServices: ["TEMP_CONTROLLED", "FRAGILE"],
      fulfillableServices: ["FRAGILE"],
    },
    {
      laneId: 24,
      laneCode: "JFK-DXB",
      origin: "JFK",
      destination: "DXB",
      tons: 3.3,
      routeAirports: ["JFK", "NRT", "HKG", "DXB"],
      transitDays: 16,
      requestedServices: ["FRAGILE"],
      fulfillableServices: ["FRAGILE"],
    },
    {
      laneId: 49,
      laneCode: "HKG-MIA",
      origin: "HKG",
      destination: "MIA",
      tons: 35,
      routeAirports: ["HKG", "DXB", "MIA"],
      transitDays: 11,
      requestedServices: ["TEMP_CONTROLLED", "FRAGILE"],
      fulfillableServices: ["FRAGILE"],
    },
    {
      laneId: 73,
      laneCode: "BOG-CDG",
      origin: "BOG",
      destination: "CDG",
      tons: 69.9,
      routeAirports: ["BOG", "GRU", "CDG"],
      transitDays: 9,
      requestedServices: ["HIGH_VALUE_SECURITY", "OVERSIZED"],
      fulfillableServices: ["HIGH_VALUE_SECURITY", "OVERSIZED"],
    },
  ];
}

async function seedRfpAndLanes(
  handle: DatabaseHandle,
  sampleLanes: readonly PricingQuoteLaneInput[],
) {
  const now = new Date().toISOString();
  const [rfp] = await handle.db
    .insert(rfps)
    .values({
      title: "Q4 Showcase Pricing Batch",
      sourceType: "unit-test",
      status: "READY_FOR_PRICING",
      llmProvider: "offline",
      customerName: "Maya",
      customerEmail: "maya@shipper.example",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  assert.ok(rfp);

  const insertedLanes: PricingQuoteLaneInput[] = [];
  for (const lane of sampleLanes) {
    const [row] = await handle.db
      .insert(lanesTable)
      .values({
        rfpId: rfp.id,
        laneNumber: lane.laneId,
        laneCode: lane.laneCode,
        origin: lane.origin,
        destination: lane.destination,
        tons: lane.tons,
        maxTransitDays: lane.transitDays + 2,
        rawEmail: `${lane.laneCode} test`,
      })
      .returning();
    assert.ok(row);
    insertedLanes.push({ ...lane, laneId: row.id });
  }

  return { rfpId: rfp.id, lanes: insertedLanes };
}

describe("Mock Pricing Team true price model", () => {
  it("computes deterministic base rate, surcharges, volume discounts, and nearest-$10 rounding", () => {
    // 1 leg, 11d -> base 1200 + 350 + 660 = 2210; + DG 600 = 2810; 12.3t (<20t) -> 0% -> 2810
    const mexCdg = computeTrueLanePrice(makeSampleLanes()[0]!);
    assert.equal(mexCdg.baseRateUsd, 2210);
    assert.equal(mexCdg.serviceSurchargeUsd, 600);
    assert.equal(mexCdg.volumeDiscountPct, 0);
    assert.equal(mexCdg.truePricePerTonUsd, 2810);
    assert.equal(mexCdg.truePricePerKgUsd, 2.81);

    // 2 legs, 15d -> base 1200 + 700 + 900 = 2800; + HV 500 = 3300; 36.2t (20-50t -> 5%) -> 3135 -> rounds to 3140
    const dfwMex = computeTrueLanePrice(makeSampleLanes()[1]!);
    assert.equal(dfwMex.baseRateUsd, 2800);
    assert.equal(dfwMex.serviceSurchargeUsd, 500);
    assert.equal(dfwMex.volumeDiscountPct, 0.05);
    assert.equal(dfwMex.truePricePerTonUsd, 3140);
    assert.equal(dfwMex.truePricePerKgUsd, 3.14);

    // 2 legs, 9d -> base 1200 + 700 + 540 = 2440; + HV 500 + OV 400 = 3340; 69.9t (>=50t -> 10%) -> 3006 -> rounds to 3010
    const bogCdg = computeTrueLanePrice(makeSampleLanes()[5]!);
    assert.equal(bogCdg.baseRateUsd, 2440);
    assert.equal(bogCdg.serviceSurchargeUsd, 900);
    assert.equal(bogCdg.volumeDiscountPct, 0.1);
    assert.equal(bogCdg.truePricePerTonUsd, 3010);
    assert.equal(bogCdg.truePricePerKgUsd, 3.01);
  });
});

describe("Pricing Agent outbound request, reply parser, and clarification flow", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it("persists outbound pricing request email with route, transit days, tons, and services", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const { rfpId, lanes } = await seedRfpAndLanes(handle, makeSampleLanes());

    const req = await createPricingRequestEmail({
      lanes,
      rfpId,
      rfpTitle: "Q4 Showcase",
      db: handle.db,
    });

    assert.equal(req.direction, "outbound");
    assert.equal(req.counterparty, "pricing");
    assert.ok(req.emailId !== null);
    assert.ok(req.body.includes("MEX -> CDG"));
    assert.ok(req.body.includes("11d"));
    assert.ok(req.body.includes("12.3t"));
    assert.ok(req.body.includes("DANGEROUS_GOODS"));
    assert.ok(req.body.includes("Unfulfilled: TEMP_CONTROLLED"));

    const savedEmails = await handle.db.select().from(emailsTable);
    assert.equal(savedEmails.length, 1);
    assert.equal(savedEmails[0]?.direction, "outbound");
    assert.equal(savedEmails[0]?.counterparty, "pricing");

    const events = await handle.db.select().from(agentEvents);
    assert.equal(events[0]?.eventType, "PRICING_REQUEST_SENT");
  });

  it("extracts mixed-unit rates, flags missing/ambiguous lanes into human_tasks, and resolves via clarification round trip", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const { rfpId, lanes } = await seedRfpAndLanes(handle, makeSampleLanes());
    const llm = new LlmClient({ provider: "offline", db: handle.db });

    await createPricingRequestEmail({
      lanes,
      rfpId,
      rfpTitle: "Q4 Showcase",
      db: handle.db,
    });

    // Generate unstructured mock reply (index 1 missing, index 2 ambiguous)
    const mockReply = await generateMockPricingReply({
      lanes,
      rfpTitle: "Q4 Showcase",
      missingLaneIndex: 1,
      ambiguousLaneIndex: 2,
      styleVariant: 0,
    });

    const parsed = await parsePricingReply({
      emailBody: mockReply.body,
      requestedLanes: lanes,
      llm,
      db: handle.db,
      rfpId,
      persistInboundEmail: {
        subject: mockReply.subject,
      },
    });

    assert.equal(parsed.validated.length, 4);
    assert.equal(parsed.flagged.length, 2);

    // Clean lanes match exact ground truth regardless of USD/t, $/ton, or per kg format
    for (const clean of parsed.validated) {
      const truth =
        mockReply._evalOnlyGroundTruth.truePricesByLaneCode[clean.lane.laneCode];
      assert.ok(truth);
      assert.equal(clean.pricePerTonUsd, truth.truePricePerTonUsd);
      assert.ok(clean.evidenceQuote);
      assert.ok(mockReply.body.includes(clean.evidenceQuote!));
      assert.ok(clean.conditions.length > 0);
    }

    // Flagged lanes become human_tasks instead of silent guesses
    assert.deepEqual(
      parsed.flagged.map((f) => [f.lane.laneCode, f.issueType]),
      [
        ["DFW-MEX", "MISSING_PRICE"],
        ["GRU-BOG", "AMBIGUOUS_PRICE"],
      ],
    );

    const openTasks = await handle.db.select().from(humanTasks);
    assert.equal(openTasks.length, 2);
    assert.equal(
      openTasks[0]?.title,
      "Pricing unclear for lane DFW-MEX: ask Pricing to clarify or enter manually",
    );
    assert.equal(
      openTasks[1]?.title,
      "Pricing unclear for lane GRU-BOG: ask Pricing to clarify or enter manually",
    );
    assert.equal(openTasks[0]?.status, "OPEN");

    // Only 4 validated rows persisted initially
    const initialResponses = await handle.db.select().from(pricingResponses);
    assert.equal(initialResponses.length, 4);

    // One-click clarification flow
    const clarified = await sendPricingClarificationAndResolve({
      db: handle.db,
      rfpId,
      llm,
      flaggedLanes: parsed.flagged,
    });

    assert.equal(clarified.parsedClarification.validated.length, 2);
    assert.equal(clarified.parsedClarification.flagged.length, 0);
    assert.equal(clarified.resolvedTaskIds.length, 2);

    for (const v of clarified.parsedClarification.validated) {
      const truth =
        mockReply._evalOnlyGroundTruth.truePricesByLaneCode[v.lane.laneCode]!;
      assert.equal(v.pricePerTonUsd, truth.truePricePerTonUsd);
    }

    const finalTasks = await handle.db.select().from(humanTasks);
    assert.ok(finalTasks.every((t) => t.status === "RESOLVED"));

    const finalResponses = await handle.db.select().from(pricingResponses);
    assert.equal(finalResponses.length, 6);

    const allEmails = await handle.db.select().from(emailsTable);
    assert.equal(allEmails.length, 4); // initial req + reply + clarification req + clarification reply
    assert.ok(allEmails.every((e) => e.counterparty === "pricing"));
  });

  it("flags out-of-range prices and LLM disagreements instead of accepting invalid quotes", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const { rfpId, lanes } = await seedRfpAndLanes(
      handle,
      makeSampleLanes().slice(0, 2),
    );

    // Out-of-range test ($45,000/t)
    const badRangeReply = await generateMockPricingReply({
      lanes,
      missingLaneIndex: null,
      ambiguousLaneIndex: null,
      outOfRangeLaneIndex: 0,
      outOfRangePriceUsd: 45_000,
    });

    const outOfRangeRes = await parsePricingReply({
      emailBody: badRangeReply.body,
      requestedLanes: lanes,
      db: handle.db,
      rfpId,
    });

    assert.equal(outOfRangeRes.validated.length, 1);
    assert.equal(outOfRangeRes.flagged.length, 1);
    assert.equal(outOfRangeRes.flagged[0]?.issueType, "OUT_OF_RANGE_PRICE");
    assert.equal(outOfRangeRes.flagged[0]?.pricePerTonUsd, null);

    // Simulated LLM disagreement against deterministic scanner
    const disagreeTransport: StructuredTransport = {
      async generateStructured() {
        return {
          rawObject: {
            lanes: [
              {
                laneCode: "MEX-CDG",
                pricePerTonUsd: 2810,
                rawAmount: 2810,
                unit: "PER_TON",
                evidenceQuote: "MEX-CDG",
                conditions: "subject to capacity",
                isAmbiguous: false,
                confidence: 0.95,
                notes: "Clean",
              },
              {
                laneCode: "DFW-MEX",
                pricePerTonUsd: 9999, // disagrees with deterministic parse
                rawAmount: 9999,
                unit: "PER_TON",
                evidenceQuote: "DFW-MEX",
                conditions: "",
                isAmbiguous: false,
                confidence: 0.95,
                notes: "Wrong rate",
              },
            ],
            overallNotes: "Parsed",
          },
        };
      },
    };
    const llm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport: disagreeTransport,
      db: handle.db,
    });

    const cleanReply = await generateMockPricingReply({
      lanes,
      missingLaneIndex: null,
      ambiguousLaneIndex: null,
    });
    const disagreeRes = await parsePricingReply({
      emailBody: cleanReply.body,
      requestedLanes: lanes,
      llm,
      db: handle.db,
      rfpId,
    });

    assert.equal(disagreeRes.validated.length, 1);
    assert.equal(disagreeRes.flagged.length, 1);
    assert.equal(disagreeRes.flagged[0]?.lane.laneCode, "DFW-MEX");
    assert.equal(disagreeRes.flagged[0]?.issueType, "AMBIGUOUS_PRICE");

    const rows = await handle.db
      .select()
      .from(pricingResponses)
      .where(eq(pricingResponses.rfpId, rfpId));
    // Only the 1 clean lane from each parse call was saved (total 2)
    assert.equal(rows.length, 2);
  });
});
