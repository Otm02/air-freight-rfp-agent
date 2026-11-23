import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  approveCustomerQuote,
  draftCustomerQuote,
  handleCustomerReply,
  parsePricingReply,
  runIntakeForLane,
  sendCustomerQuote,
  type QuoteLaneInput,
} from "../../src/agents";
import {
  createDatabase,
  humanTasks,
  lanes as lanesTable,
  meetings,
  proposals,
  rfps,
  type DatabaseHandle,
} from "../../src/db";
import {
  assessLane,
  buildFlightGraph,
  extractRequirementsOffline,
  parseDatasetRows,
  type Flight,
  type Lane,
} from "../../src/domain";
import { LlmClient, type StructuredTransport } from "../../src/llm";
import {
  approveAndSendQuote,
  createRfp,
  decideLaneDisposition,
  draftQuote,
  getRfpWorkspace,
  requestPricing,
} from "../../src/orchestrator";

const SAMPLE_FLIGHTS: Flight[] = [
  {
    flightNumber: 1,
    origin: "MEX",
    destination: "CDG",
    transitDays: 8,
    availableServices: ["DANGEROUS_GOODS", "FRAGILE"],
  },
  {
    flightNumber: 2,
    origin: "JFK",
    destination: "CDG",
    transitDays: 5,
    availableServices: ["TEMP_CONTROLLED", "HIGH_VALUE_SECURITY", "FRAGILE"],
  },
];

describe("Edge cases: malformed inputs, unreachable networks, LLM failures, missing pricing, and French replies", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it("handles empty email text without crashing and flags human confirmation", async () => {
    const extraction = extractRequirementsOffline("   \n\t  ");
    assert.deepEqual(extraction.requestedServices, []);
    assert.ok(extraction.confidence < 0.85);

    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const llm = new LlmClient({ provider: "offline", db: handle.db });
    const lane: Lane = {
      laneNumber: 1,
      laneCode: "MEX-CDG",
      origin: "MEX",
      destination: "CDG",
      tons: 10,
      maxTransitDays: 12,
      rawEmail: "   ",
    };

    const intake = await runIntakeForLane(lane, { llm, db: handle.db });
    assert.deepEqual(intake.mergedServices, []);
    assert.equal(intake.needsHumanTask, true);
    assert.equal(intake.humanTask?.taskType, "CONFIRM_REQUIREMENTS");
  });

  it("collects unknown/invalid airport codes without crashing and marks unserved airports UNREACHABLE", () => {
    const dataset = parseDatasetRows(
      [
        {
          rowNumber: 2,
          origin: "XX1",
          destination: "CDG",
          tons: 10,
          maxTransitDays: 7,
          rawEmail: "Standard general cargo",
        },
        {
          rowNumber: 3,
          origin: "QQQ",
          destination: "ZZZ",
          tons: 10,
          maxTransitDays: 7,
          rawEmail: "Standard general cargo",
        },
      ],
      SAMPLE_FLIGHTS.map((f, idx) => ({
        rowNumber: idx + 2,
        origin: f.origin,
        destination: f.destination,
        transitDays: f.transitDays,
        availableServices: f.availableServices.join(", "),
      })),
    );

    assert.ok(
      dataset.issues.some(
        (i) => i.severity === "ERROR" && i.field === "origin" && i.rowNumber === 2,
      ),
    );
    // 3-letter unknown airport passes format check and is safely assessed as UNREACHABLE
    assert.equal(dataset.lanes.length, 1);
    const graph = buildFlightGraph(dataset.flights);
    const assessment = assessLane(dataset.lanes[0]!, graph);
    assert.equal(assessment.status, "UNREACHABLE");
    assert.match(assessment.humanDecisionReason ?? "", /no directed flight path/i);
  });

  it("detects duplicate origin-destination lanes cleanly without throwing", () => {
    const dataset = parseDatasetRows(
      [
        {
          rowNumber: 2,
          origin: "MEX",
          destination: "CDG",
          tons: 12,
          maxTransitDays: 10,
          rawEmail: "Fragile handling needed",
        },
        {
          rowNumber: 3,
          origin: "MEX",
          destination: "CDG",
          tons: 15,
          maxTransitDays: 10,
          rawEmail: "Fragile handling needed",
        },
      ],
      SAMPLE_FLIGHTS.map((f, idx) => ({
        rowNumber: idx + 2,
        origin: f.origin,
        destination: f.destination,
        transitDays: f.transitDays,
        availableServices: f.availableServices.join(", "),
      })),
    );

    assert.equal(dataset.lanes.length, 1);
    assert.ok(
      dataset.issues.some(
        (i) => i.severity === "WARNING" && /duplicate/i.test(i.message),
      ),
    );
  });

  it("rejects zero or negative tons cleanly with validation issues and descriptive error", async () => {
    const dataset = parseDatasetRows(
      [
        {
          rowNumber: 2,
          origin: "MEX",
          destination: "CDG",
          tons: 0,
          maxTransitDays: 10,
          rawEmail: "Standard cargo",
        },
        {
          rowNumber: 3,
          origin: "JFK",
          destination: "CDG",
          tons: -5,
          maxTransitDays: 10,
          rawEmail: "Standard cargo",
        },
      ],
      SAMPLE_FLIGHTS.map((f, idx) => ({
        rowNumber: idx + 2,
        origin: f.origin,
        destination: f.destination,
        transitDays: f.transitDays,
        availableServices: f.availableServices.join(", "),
      })),
    );

    assert.equal(dataset.lanes.length, 0);
    const tonErrors = dataset.issues.filter(
      (i) => i.severity === "ERROR" && i.field === "tons",
    );
    assert.equal(tonErrors.length, 2);

    const handle = await createDatabase(":memory:");
    handles.push(handle);

    await assert.rejects(
      createRfp(handle.db, {
        mode: "custom",
        title: "Invalid Zero Tons RFP",
        customerName: "Test Shipper",
        customerEmail: "test@shipper.example",
        llmMode: "offline",
        lanes: [
          {
            origin: "MEX",
            destination: "CDG",
            tons: 0,
            maxTransitDays: 10,
            rawEmail: "Standard cargo",
          },
        ],
      }),
      /positive number/i,
    );
  });

  it("handles an RFP where every lane is UNREACHABLE through decline, skip pricing, quote, and send", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const rfpId = await createRfp(handle.db, {
      mode: "custom",
      title: "All-Unreachable Islands RFP",
      customerName: "Isolated Cargo Ltd",
      customerEmail: "ops@isolated.example",
      llmMode: "offline",
      lanes: [
        {
          origin: "QQQ",
          destination: "ZZZ",
          tons: 10,
          maxTransitDays: 5,
          rawEmail: "Standard general cargo",
        },
        {
          origin: "YYY",
          destination: "XXX",
          tons: 20,
          maxTransitDays: 8,
          rawEmail: "Fragile equipment",
        },
      ],
    });

    const initial = await getRfpWorkspace(handle.db, rfpId, "offline");
    assert.ok(initial);
    assert.equal(initial.rfp.status, "AWAITING_REQUIREMENT_CONFIRMATION");
    assert.equal(initial.summary.unreachableCount, 2);
    assert.equal(initial.summary.openHumanTasksCount, 2);

    for (const lane of initial.lanes) {
      await decideLaneDisposition(handle.db, rfpId, lane.id, {
        disposition: "DECLINE",
        reviewer: "alice@carrier.example",
      });
    }

    await requestPricing(handle.db, rfpId, { llmMode: "offline" });
    const afterPricing = await getRfpWorkspace(handle.db, rfpId, "offline");
    assert.equal(afterPricing?.rfp.status, "PRICING_RECEIVED");

    const proposalId = await draftQuote(handle.db, rfpId, { llmMode: "offline" });
    const afterDraft = await getRfpWorkspace(handle.db, rfpId, "offline");
    assert.equal(afterDraft?.rfp.status, "AWAITING_APPROVAL");
    assert.equal(afterDraft?.proposal?.totalQuotedLanes, 0);
    assert.equal(afterDraft?.proposal?.totalDeclinedLanes, 2);
    assert.equal(afterDraft?.proposal?.totalValueUsd, 0);

    await approveAndSendQuote(handle.db, rfpId, proposalId, {
      approvedBy: "alice@carrier.example",
    });
    const afterSend = await getRfpWorkspace(handle.db, rfpId, "offline");
    assert.equal(afterSend?.rfp.status, "SENT");
  });

  it("handles LLM timeouts and invalid JSON across Intake, Pricing, and Deal agents by creating human tasks", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const timeoutTransport: StructuredTransport = {
      generateStructured(req) {
        return new Promise((_resolve, reject) => {
          req.signal.addEventListener(
            "abort",
            () => {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
      },
    };

    const invalidJsonTransport: StructuredTransport = {
      async generateStructured() {
        return {
          rawText: "definitely not valid json {",
          usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
        };
      },
    };

    const timeoutLlm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport: timeoutTransport,
      db: handle.db,
      defaultTimeoutMs: 25,
    });

    const invalidJsonLlm = new LlmClient({
      provider: "openai",
      env: { OPENAI_API_KEY: "test-key" },
      transport: invalidJsonTransport,
      db: handle.db,
    });

    // 1. Intake timeout -> creates CONFIRM_REQUIREMENTS human task
    const intakeRes = await runIntakeForLane(
      {
        laneNumber: 1,
        laneCode: "MEX-CDG",
        origin: "MEX",
        destination: "CDG",
        tons: 10,
        maxTransitDays: 10,
        rawEmail: "Need fragile handling please.",
      },
      { llm: timeoutLlm, db: handle.db },
    );
    assert.equal(intakeRes.needsHumanTask, true);
    assert.equal(intakeRes.humanTask?.taskType, "CONFIRM_REQUIREMENTS");

    // 2. Pricing invalid JSON -> creates CLARIFY_PRICING task for lane without crashing
    const pricingLlm = new LlmClient({ provider: "offline", db: handle.db });
    const now = new Date().toISOString();
    const [edgeRfp] = await handle.db
      .insert(rfps)
      .values({
        title: "LLM Failure Resilience RFP",
        sourceType: "custom",
        status: "PRICING_REQUESTED",
        llmProvider: "openai",
        customerName: "Shipper",
        customerEmail: "shipper@example.com",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    assert.ok(edgeRfp);
    const [edgeLane] = await handle.db
      .insert(lanesTable)
      .values({
        rfpId: edgeRfp.id,
        laneNumber: 1,
        laneCode: "MEX-CDG",
        origin: "MEX",
        destination: "CDG",
        tons: 10,
        maxTransitDays: 10,
        rawEmail: "Fragile cargo",
        requestedServicesJson: JSON.stringify(["FRAGILE"]),
        evidenceJson: JSON.stringify([]),
        intakeConfidence: 0.99,
        intakeSource: "RULE",
        intakeStatus: "CONFIRMED",
      })
      .returning();
    assert.ok(edgeLane);

    const pricingRes = await parsePricingReply({
      emailBody: "MEX-CDG: $2,100 per ton",
      requestedLanes: [
        {
          laneId: edgeLane.id,
          laneNumber: 1,
          laneCode: "MEX-CDG",
          origin: "MEX",
          destination: "CDG",
          tons: 10,
          routeAirports: ["MEX", "CDG"],
          transitDays: 8,
          requestedServices: ["FRAGILE"],
          fulfillableServices: ["FRAGILE"],
        },
      ],
      llm: invalidJsonLlm,
      db: handle.db,
      rfpId: edgeRfp.id,
    });
    assert.equal(pricingRes.validated.length, 0);
    assert.equal(pricingRes.flagged.length, 1);
    assert.equal(pricingRes.flagged[0]?.issueType, "LLM_ERROR");
    assert.equal(pricingRes.humanTasksCreated.length, 1);

    // 3. Deal agent invalid JSON -> creates CUSTOMER_REPLY_REVIEW task instead of crashing
    const graph = buildFlightGraph(SAMPLE_FLIGHTS);
    const assessment = assessLane(
      {
        laneNumber: 1,
        laneCode: "MEX-CDG",
        origin: "MEX",
        destination: "CDG",
        tons: 10,
        maxTransitDays: 10,
        rawEmail: "Fragile cargo",
      },
      graph,
    );
    const draft = await draftCustomerQuote({
      db: handle.db,
      rfpId: edgeRfp.id,
      customerName: "Shipper",
      customerEmail: "shipper@example.com",
      rfpTitle: "LLM Failure Resilience RFP",
      lanes: [{ laneId: edgeLane.id, assessment, pricePerTonUsd: 2100 }],
      llm: pricingLlm,
    });
    await handle.db
      .update(humanTasks)
      .set({ status: "RESOLVED", resolvedAt: now })
      .where(eq(humanTasks.rfpId, edgeRfp.id));
    await approveCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
      approvedBy: "alice@carrier.example",
    });
    await sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId });
    const dealFail = await handleCustomerReply({
      db: handle.db,
      proposalId: draft.proposalId,
      emailBody: "Please accept all quoted lanes.",
      llm: invalidJsonLlm,
    });
    assert.equal(dealFail.intent, "UNCLEAR");
    assert.equal(dealFail.humanTaskCreated?.taskType, "CUSTOMER_REPLY_REVIEW");
    assert.equal(dealFail.meetingCreated, null);
  });

  it("flags every requested lane when a pricing reply omits all lane rates", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const offlineLlm = new LlmClient({ provider: "offline", db: handle.db });
    const now = new Date().toISOString();
    const [rfpRow] = await handle.db
      .insert(rfps)
      .values({
        title: "Missing All Pricing RFP",
        sourceType: "custom",
        status: "PRICING_REQUESTED",
        llmProvider: "offline",
        customerName: "Shipper",
        customerEmail: "shipper@example.com",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    assert.ok(rfpRow);

    const [laneRow] = await handle.db
      .insert(lanesTable)
      .values({
        rfpId: rfpRow.id,
        laneNumber: 1,
        laneCode: "MEX-CDG",
        origin: "MEX",
        destination: "CDG",
        tons: 10,
        maxTransitDays: 10,
        rawEmail: "Fragile cargo",
        requestedServicesJson: JSON.stringify(["FRAGILE"]),
        evidenceJson: JSON.stringify([]),
        intakeConfidence: 0.99,
        intakeSource: "RULE",
        intakeStatus: "CONFIRMED",
      })
      .returning();
    assert.ok(laneRow);

    const result = await parsePricingReply({
      emailBody:
        "Hi team, our pricing analysts are offline for quarterly training and cannot quote any lanes yet.",
      requestedLanes: [
        {
          laneId: laneRow.id,
          laneNumber: 1,
          laneCode: "MEX-CDG",
          origin: "MEX",
          destination: "CDG",
          tons: 10,
          routeAirports: ["MEX", "CDG"],
          transitDays: 8,
          requestedServices: ["FRAGILE"],
          fulfillableServices: ["FRAGILE"],
        },
      ],
      llm: offlineLlm,
      db: handle.db,
      rfpId: rfpRow.id,
      persistInboundEmail: { subject: "Re: Pricing Request" },
    });

    assert.equal(result.validated.length, 0);
    assert.equal(result.flagged.length, 1);
    assert.equal(result.flagged[0]?.issueType, "MISSING_PRICE");
    assert.ok(result.humanTasksCreated.length === 1);
  });

  it("escalates French customer replies in Offline Mode instead of guessing, and parses bilingual French in Live LLM Mode", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const now = new Date().toISOString();
    const [rfpRow] = await handle.db
      .insert(rfps)
      .values({
        title: "Montreal Bilingual Biopharma RFP",
        sourceType: "custom",
        status: "SENT",
        llmProvider: "offline",
        customerName: "Claire Dubois",
        customerEmail: "claire.dubois@montrealbio.example",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    assert.ok(rfpRow);

    const graph = buildFlightGraph(SAMPLE_FLIGHTS);
    const lane: Lane = {
      laneNumber: 1,
      laneCode: "MEX-CDG",
      origin: "MEX",
      destination: "CDG",
      tons: 15,
      maxTransitDays: 10,
      rawEmail: "Need fragile handling on MEX-CDG.",
    };
    const assessment = assessLane(lane, graph);
    const [laneRow] = await handle.db
      .insert(lanesTable)
      .values({
        rfpId: rfpRow.id,
        laneNumber: 1,
        laneCode: lane.laneCode,
        origin: lane.origin,
        destination: lane.destination,
        tons: lane.tons,
        maxTransitDays: lane.maxTransitDays,
        rawEmail: lane.rawEmail,
        requestedServicesJson: JSON.stringify(assessment.extraction.requestedServices),
        evidenceJson: JSON.stringify(assessment.extraction.evidence),
        intakeConfidence: assessment.extraction.confidence,
        intakeSource: "MERGED",
        intakeStatus: "CONFIRMED",
      })
      .returning();
    assert.ok(laneRow);

    const quoteInput: QuoteLaneInput = {
      laneId: laneRow.id,
      assessment,
      pricePerTonUsd: 2400,
    };
    const offlineLlm = new LlmClient({ provider: "offline", db: handle.db });

    const draft = await draftCustomerQuote({
      db: handle.db,
      rfpId: rfpRow.id,
      customerName: "Claire Dubois",
      customerEmail: "claire.dubois@montrealbio.example",
      rfpTitle: "Montreal Bilingual Biopharma RFP",
      lanes: [quoteInput],
      llm: offlineLlm,
    });
    await approveCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
      approvedBy: "alice.rfp@carrier.example",
    });
    await sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId });

    // Offline French affirmative MUST NOT auto-book WON; must escalate to human review
    const frenchOffline = await handleCustomerReply({
      db: handle.db,
      proposalId: draft.proposalId,
      emailBody:
        "Bonjour l'équipe, nous acceptons toutes les liaisons proposées dans votre devis. Merci et cordialement, Claire",
      llm: offlineLlm,
    });
    assert.equal(frenchOffline.intent, "UNCLEAR");
    assert.equal(frenchOffline.rfpStatus, "QUOTE_SENT");
    assert.ok(frenchOffline.humanTaskCreated);
    assert.equal(frenchOffline.humanTaskCreated.taskType, "CUSTOMER_REPLY_REVIEW");
    assert.equal(frenchOffline.meetingCreated, null);

    // Offline French refusal also escalates safely instead of guessing
    const frenchRejectOffline = await handleCustomerReply({
      db: handle.db,
      proposalId: draft.proposalId,
      emailBody:
        "Bonjour, nous n'acceptons pas la proposition pour MEX-CDG. Cordialement, Claire",
      llm: offlineLlm,
    });
    assert.equal(frenchRejectOffline.intent, "UNCLEAR");
    assert.equal(frenchRejectOffline.humanTaskCreated?.taskType, "CUSTOMER_REPLY_REVIEW");
    assert.equal(frenchRejectOffline.meetingCreated, null);

    const openTasks = await handle.db
      .select()
      .from(humanTasks)
      .where(eq(humanTasks.rfpId, rfpRow.id));
    assert.equal(openTasks[0]?.taskType, "CUSTOMER_REPLY_REVIEW");

    // Bilingual Live LLM mode with grounded French acceptance -> WON + kickoff meeting
    const frenchBilingualTransport: StructuredTransport = {
      async generateStructured() {
        return {
          rawObject: {
            intent: "ACCEPT_ALL",
            acceptedLaneCodes: ["MEX-CDG"],
            rejectedLaneCodes: [],
            questions: [],
            evidenceQuote: "nous acceptons toutes les liaisons proposées",
            confidence: 0.96,
            summary: "Customer unambiguously accepted all quoted lanes in French.",
          },
          usage: { inputTokens: 90, outputTokens: 35, totalTokens: 125 },
        };
      },
    };
    const liveLlm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      transport: frenchBilingualTransport,
      db: handle.db,
    });

    const frenchLive = await handleCustomerReply({
      db: handle.db,
      proposalId: draft.proposalId,
      emailBody:
        "Bonjour l'équipe, nous acceptons toutes les liaisons proposées pour MEX-CDG. Cordialement, Claire",
      llm: liveLlm,
    });
    assert.equal(frenchLive.intent, "ACCEPT_ALL");
    assert.equal(frenchLive.rfpStatus, "DEAL_BOOKED");
    assert.ok(frenchLive.meetingCreated);

    const [updatedProposal] = await handle.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, draft.proposalId));
    assert.equal(updatedProposal?.status, "ACCEPTED");

    const bookedMeetings = await handle.db
      .select()
      .from(meetings)
      .where(eq(meetings.proposalId, draft.proposalId));
    assert.equal(bookedMeetings.length, 1);
  });
});
