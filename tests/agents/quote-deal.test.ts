import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  ApprovalGateError,
  approveCustomerQuote,
  draftCustomerQuote,
  handleCustomerReply,
  sendCustomerQuote,
  type QuoteLaneInput,
} from "../../src/agents";
import {
  agentEvents,
  createDatabase,
  emails as emailsTable,
  humanTasks,
  lanes as lanesTable,
  meetings,
  proposalLanes,
  proposals,
  rfps,
  type AppDatabase,
  type DatabaseHandle,
} from "../../src/db";
import {
  computeNextBusinessDay10amET,
  generateKickoffIcs,
  generateMockCustomerReply,
} from "../../src/deal";
import {
  assessLane,
  buildFlightGraph,
  type Flight,
  type Lane,
} from "../../src/domain";
import {
  readSmtpConfig,
  type SmtpMessage,
  type SmtpTransport,
} from "../../src/lib/email/smtp";
import { LlmClient, type StructuredTransport } from "../../src/llm";

interface SeededRfpContext {
  rfpId: number;
  laneInputs: QuoteLaneInput[];
  offlineLlm: LlmClient;
}

function unfoldIcs(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, "");
}

async function seedRfpWithAssessments(
  db: AppDatabase,
  opts?: { createOpenPricingTask?: boolean },
): Promise<SeededRfpContext> {
  const now = new Date().toISOString();
  const [rfpRow] = await db
    .insert(rfps)
    .values({
      title: "Q4 Pharma & Electronics Tender",
      sourceType: "mock-xlsx",
      status: "PRICING_VALIDATED",
      llmProvider: "offline",
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  assert.ok(rfpRow);

  const flights: Flight[] = [
    {
      flightNumber: 1,
      origin: "MEX",
      destination: "CDG",
      transitDays: 10,
      availableServices: ["DANGEROUS_GOODS", "HIGH_VALUE_SECURITY"],
    },
    {
      flightNumber: 2,
      origin: "DFW",
      destination: "YYZ",
      transitDays: 7,
      availableServices: ["HIGH_VALUE_SECURITY"],
    },
    {
      flightNumber: 3,
      origin: "YYZ",
      destination: "MEX",
      transitDays: 6,
      availableServices: ["HIGH_VALUE_SECURITY"],
    },
    {
      flightNumber: 4,
      origin: "GRU",
      destination: "MIA",
      transitDays: 4,
      availableServices: ["FRAGILE"],
    },
    {
      flightNumber: 5,
      origin: "MIA",
      destination: "BOG",
      transitDays: 4,
      availableServices: ["TEMP_CONTROLLED", "FRAGILE"],
    },
  ];

  const laneSpecs: Array<{
    lane: Lane;
    pricePerTonUsd: number | null;
  }> = [
    {
      // Lane 1: FULLY_SERVABLE -> QUOTE_COMPLIANT
      lane: {
        laneNumber: 1,
        laneCode: "MEX-CDG",
        origin: "MEX",
        destination: "CDG",
        tons: 12.5,
        maxTransitDays: 11,
        rawEmail: "Need dangerous-goods handling from MEX to CDG.",
      },
      pricePerTonUsd: 2400,
    },
    {
      // Lane 2: COMPLIANT_BUT_LATE (13d vs 10d max, +3d late) -> QUOTE_COMPLIANT_LATE
      lane: {
        laneNumber: 2,
        laneCode: "DFW-MEX",
        origin: "DFW",
        destination: "MEX",
        tons: 20,
        maxTransitDays: 10,
        rawEmail: "High-value security required from DFW to MEX.",
      },
      pricePerTonUsd: 2550,
    },
    {
      // Lane 3: ON_TIME_BUT_MISSING_SERVICES (8d <= 9d max, TEMP_CONTROLLED fails on GRU->MIA) -> QUOTE_PARTIAL_ON_TIME
      lane: {
        laneNumber: 3,
        laneCode: "GRU-BOG",
        origin: "GRU",
        destination: "BOG",
        tons: 10,
        maxTransitDays: 9,
        rawEmail:
          "Please ship temperature controlled (2-8 C) and fragile cargo from GRU to BOG.",
      },
      pricePerTonUsd: 2100,
    },
    {
      // Lane 4: UNREACHABLE -> DECLINE
      lane: {
        laneNumber: 4,
        laneCode: "FAI-SIN",
        origin: "FAI",
        destination: "SIN",
        tons: 8,
        maxTransitDays: 12,
        rawEmail: "Standard general cargo from FAI to SIN.",
      },
      pricePerTonUsd: null,
    },
  ];

  const graph = buildFlightGraph(flights);
  const laneInputs: QuoteLaneInput[] = [];

  for (const spec of laneSpecs) {
    const assessment = assessLane(spec.lane, graph);
    const [insertedLane] = await db
      .insert(lanesTable)
      .values({
        rfpId: rfpRow.id,
        laneNumber: spec.lane.laneNumber,
        laneCode: spec.lane.laneCode,
        origin: spec.lane.origin,
        destination: spec.lane.destination,
        tons: spec.lane.tons,
        maxTransitDays: spec.lane.maxTransitDays,
        rawEmail: spec.lane.rawEmail,
        requestedServicesJson: JSON.stringify(
          assessment.extraction.requestedServices,
        ),
        evidenceJson: JSON.stringify(assessment.extraction.evidence),
        intakeConfidence: assessment.extraction.confidence,
        intakeSource: "MERGED",
        intakeStatus: "CONFIRMED",
      })
      .returning();
    assert.ok(insertedLane);

    laneInputs.push({
      laneId: insertedLane.id,
      assessment,
      pricePerTonUsd: spec.pricePerTonUsd,
    });
  }

  if (opts?.createOpenPricingTask) {
    await db.insert(humanTasks).values({
      rfpId: rfpRow.id,
      laneId: laneInputs[0]!.laneId,
      laneCode: "MEX-CDG",
      taskType: "CLARIFY_PRICING",
      title: "Pricing unclear for lane MEX-CDG: ask Pricing to clarify or enter manually",
      reason: "Awaiting binding rate confirmation from Pricing.",
      payloadJson: JSON.stringify({ laneCode: "MEX-CDG" }),
      status: "OPEN",
      createdAt: now,
    });
  }

  const offlineLlm = new LlmClient({ provider: "offline", db });
  return { rfpId: rfpRow.id, laneInputs, offlineLlm };
}

describe("Quote Agent, Human Approval Gate, RFC 5545 ICS & Deal Agent", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it("drafts quote with deterministic tables, both Markdown & plain-text versions, and failing leg annotations", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const ctx = await seedRfpWithAssessments(handle.db);

    const draft = await draftCustomerQuote({
      db: handle.db,
      rfpId: ctx.rfpId,
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      rfpTitle: "Q4 Pharma & Electronics Tender",
      lanes: ctx.laneInputs,
      llm: ctx.offlineLlm,
    });

    assert.equal(draft.status, "DRAFT");
    assert.equal(draft.version, 1);
    assert.equal(draft.totalQuotedLanes, 3);
    assert.equal(draft.totalDeclinedLanes, 1);
    // Quoted tons = 12.5 + 20 + 10 = 42.5t
    assert.equal(draft.totalTons, 42.5);
    // Total value = (12.5*2400) + (20*2550) + (10*2100) = 30000 + 51000 + 21000 = 102000
    assert.equal(draft.totalValueUsd, 102000);

    // Check deterministic data inside Markdown AND plain-text bodies
    for (const body of [draft.markdownBody, draft.plainTextBody]) {
      assert.ok(body.includes("MEX -> CDG"));
      assert.ok(body.includes("DFW -> YYZ -> MEX"));
      assert.ok(body.includes("GRU -> MIA -> BOG"));
      assert.ok(body.includes("10d / 11d max (On time)"));
      assert.ok(body.includes("13d / 10d max (+3d late)"));
      assert.ok(body.includes("Dangerous goods: FULFILLED"));
      assert.ok(
        body.includes("Temperature controlled (2-8 C): NOT FULFILLED (fails on GRU->MIA)"),
      );
      assert.ok(body.includes("Fragile handling: FULFILLED"));
      assert.ok(body.includes("$2,400/t"));
      assert.ok(body.includes("$30,000.00"));
      assert.ok(body.includes("$51,000.00"));
      assert.ok(body.includes("$21,000.00"));
      assert.ok(body.includes("$102,000.00"));
      assert.ok(body.includes("FAI-SIN"));
      assert.ok(body.includes("Declined"));
    }

    // LLM failure still preserves 100% deterministic table + fallback prose
    const failingTransport: StructuredTransport = {
      async generateStructured() {
        throw new Error("Simulated LLM prose outage");
      },
    };
    const brokenLlm = new LlmClient({
      provider: "openai",
      env: { OPENAI_API_KEY: "test-key" },
      transport: failingTransport,
      db: handle.db,
    });

    const draftV2 = await draftCustomerQuote({
      db: handle.db,
      rfpId: ctx.rfpId,
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      rfpTitle: "Q4 Pharma & Electronics Tender",
      lanes: ctx.laneInputs,
      llm: brokenLlm,
    });
    assert.equal(draftV2.version, 2);
    assert.equal(draftV2.totalValueUsd, 102000);
    assert.ok(draftV2.plainTextBody.includes("Dear Maya Lin,"));
    assert.ok(draftV2.plainTextBody.includes("$102,000.00"));

    // Stub LLM attempting to smuggle fabricated $999/ton price into narrative prose is blocked
    const leakyTransport: StructuredTransport = {
      async generateStructured() {
        return {
          rawObject: {
            greeting: "Dear Maya Lin,",
            summary:
              "We are delighted to offer a flat discount of $999/ton across 45 tons in 3 days.",
            closing: "Best regards,\nAir Freight RFP Response Team",
          },
          usage: { inputTokens: 80, outputTokens: 25, totalTokens: 105 },
        };
      },
    };
    const leakyLlm = new LlmClient({
      provider: "openai",
      env: { OPENAI_API_KEY: "test-key" },
      transport: leakyTransport,
      db: handle.db,
    });
    const draftV3 = await draftCustomerQuote({
      db: handle.db,
      rfpId: ctx.rfpId,
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      rfpTitle: "Q4 Pharma & Electronics Tender",
      lanes: ctx.laneInputs,
      llm: leakyLlm,
    });
    assert.equal(draftV3.markdownBody.includes("$999"), false);
    assert.equal(draftV3.plainTextBody.includes("45 tons"), false);
    assert.ok(draftV3.plainTextBody.includes("Below is our structured"));
    assert.ok(draftV3.plainTextBody.includes("$102,000.00"));

    const events = await handle.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.rfpId, ctx.rfpId));
    assert.ok(events.some((e) => e.eventType === "QUOTE_PROSE_SANITIZED"));
  });

  it("enforces the hard human approval gate across open human_tasks, approval metadata, outbox, and optional SMTP", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const ctx = await seedRfpWithAssessments(handle.db, {
      createOpenPricingTask: true,
    });

    const draft = await draftCustomerQuote({
      db: handle.db,
      rfpId: ctx.rfpId,
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      rfpTitle: "Q4 Pharma & Electronics Tender",
      lanes: ctx.laneInputs,
      llm: ctx.offlineLlm,
    });

    // 1. Cannot send a DRAFT quote
    await assert.rejects(
      sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId }),
      (err: unknown) =>
        err instanceof ApprovalGateError && err.code === "NOT_APPROVED",
    );

    // 2. Cannot approve while OPEN human_tasks exist
    const openTasksBefore = await handle.db
      .select()
      .from(humanTasks)
      .where(eq(humanTasks.rfpId, ctx.rfpId));
    assert.equal(openTasksBefore.length, 1);

    await assert.rejects(
      approveCustomerQuote({
        db: handle.db,
        proposalId: draft.proposalId,
        approvedBy: "alice.rfp@carrier.example",
      }),
      (err: unknown) =>
        err instanceof ApprovalGateError &&
        err.code === "OPEN_HUMAN_TASKS" &&
        err.openTasks.length === 1,
    );

    // 3. Approve while explicitly accepting the open exception task -> records approvedBy & approvedAt
    const approval = await approveCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
      approvedBy: "alice.rfp@carrier.example",
      acceptOpenTaskIds: [openTasksBefore[0]!.id],
      exceptionNote: "Confirmed rate verbally with Pricing Desk Lead.",
    });
    assert.equal(approval.status, "APPROVED");
    assert.equal(approval.approvedBy, "alice.rfp@carrier.example");
    assert.ok(approval.approvedAt);
    assert.deepEqual(approval.acceptedExceptionTaskIds, [openTasksBefore[0]!.id]);

    const [updatedTask] = await handle.db
      .select()
      .from(humanTasks)
      .where(eq(humanTasks.id, openTasksBefore[0]!.id));
    assert.equal(updatedTask?.status, "ACCEPTED_WITH_EXCEPTION");

    // 4. Even after approval, adding a new OPEN task blocks sending until resolved
    const [lateTask] = await handle.db
      .insert(humanTasks)
      .values({
        rfpId: ctx.rfpId,
        laneId: ctx.laneInputs[1]!.laneId,
        laneCode: "DFW-MEX",
        taskType: "CONFIRM_REQUIREMENTS",
        title: "Verify late delivery note on DFW-MEX",
        reason: "Last-minute check",
        payloadJson: "{}",
        status: "OPEN",
        createdAt: new Date().toISOString(),
      })
      .returning();

    await assert.rejects(
      sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId }),
      (err: unknown) =>
        err instanceof ApprovalGateError && err.code === "OPEN_HUMAN_TASKS",
    );

    // Resolve the late task
    await handle.db
      .update(humanTasks)
      .set({ status: "RESOLVED", resolvedAt: new Date().toISOString() })
      .where(eq(humanTasks.id, lateTask!.id));

    // 5. Send via optional mocked SMTP transport succeeds and updates outbox + DB columns
    const sentMessages: SmtpMessage[] = [];
    const mockSmtp: SmtpTransport = {
      async sendMail(msg) {
        sentMessages.push(msg);
        return {
          accepted: true,
          messageId: "<mock-1@carrier.example>",
          response: "250 2.0.0 OK",
        };
      },
    };

    const sent = await sendCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
      smtpTransport: mockSmtp,
    });
    assert.equal(sent.status, "SENT");
    assert.equal(sent.deliveryChannel, "SMTP");
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.to, "maya.lin@shipper.example");

    const [dbProposal] = await handle.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, draft.proposalId));
    assert.equal(dbProposal?.status, "SENT");
    assert.equal(dbProposal?.approvedBy, "alice.rfp@carrier.example");
    assert.ok(dbProposal?.approvedAt);
    assert.ok(dbProposal?.sentAt);

    const [dbEmail] = await handle.db
      .select()
      .from(emailsTable)
      .where(eq(emailsTable.id, draft.quoteEmailId));
    assert.equal(dbEmail?.status, "SENT");
    assert.equal(dbEmail?.approvedBy, "alice.rfp@carrier.example");
    assert.ok(dbEmail?.sentAt);
    assert.ok(dbEmail?.plainTextBody);

    // 6. Double-send blocked cleanly
    await assert.rejects(
      sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId }),
      (err: unknown) =>
        err instanceof ApprovalGateError && err.code === "ALREADY_SENT",
    );

    // 7. Verify readSmtpConfig behavior
    assert.equal(readSmtpConfig({}), null);
    const parsedCfg = readSmtpConfig({
      SMTP_HOST: "smtp.carrier.example",
      SMTP_PORT: "587",
      SMTP_USER: "rfp-bot",
      SMTP_PASS: "secret",
    });
    assert.equal(parsedCfg?.host, "smtp.carrier.example");
    assert.equal(parsedCfg?.port, 587);
    assert.equal(parsedCfg?.secure, false);
  });

  it("computes next business day 10:00 ET accurately (weekends, EST, EDT) and generates valid RFC 5545 .ics invites", () => {
    // Tuesday Jan 6, 2026 16:00 UTC (11:00 EST) -> Wed Jan 7, 2026 10:00 EST = 15:00 UTC
    const tueEst = computeNextBusinessDay10amET(new Date("2026-01-06T16:00:00Z"));
    assert.equal(tueEst.easternOffsetLabel, "EST");
    assert.deepEqual(tueEst.easternDate, { year: 2026, month: 1, day: 7 });
    assert.equal(tueEst.scheduledAtUtcIso, "2026-01-07T15:00:00.000Z");

    // Friday Jul 10, 2026 14:00 UTC (10:00 EDT) -> Monday Jul 13, 2026 10:00 EDT = 14:00 UTC
    const friEdt = computeNextBusinessDay10amET(new Date("2026-07-10T14:00:00Z"));
    assert.equal(friEdt.easternOffsetLabel, "EDT");
    assert.deepEqual(friEdt.easternDate, { year: 2026, month: 7, day: 13 });
    assert.equal(friEdt.scheduledAtUtcIso, "2026-07-13T14:00:00.000Z");

    // Saturday Jan 10, 2026 -> Monday Jan 12, 2026 10:00 EST
    const satEst = computeNextBusinessDay10amET(new Date("2026-01-10T15:00:00Z"));
    assert.deepEqual(satEst.easternDate, { year: 2026, month: 1, day: 12 });

    // Sunday Jan 11, 2026 -> Monday Jan 12, 2026 10:00 EST
    const sunEst = computeNextBusinessDay10amET(new Date("2026-01-11T15:00:00Z"));
    assert.deepEqual(sunEst.easternDate, { year: 2026, month: 1, day: 12 });

    const { uid, icsContent } = generateKickoffIcs({
      title: "Air Freight Kickoff: Acme, Inc.; Phase 1",
      description: "Line 1\nLine 2: Confirm capacity & cutoffs",
      slot: friEdt,
      organizer: {
        name: "RFP Response Lead",
        email: "rfp-response-team@carrier.example",
      },
      attendees: [
        {
          role: "RFP_TEAM",
          name: "RFP Response Lead",
          email: "rfp-response-team@carrier.example",
        },
        {
          role: "CUSTOMER",
          name: "Maya Lin",
          email: "maya.lin@shipper.example",
        },
        {
          role: "PRICING",
          name: "Air Pricing Desk",
          email: "pricing-desk@carrier.example",
        },
      ],
    });

    assert.ok(icsContent.includes("\r\n"), "ICS must use CRLF line endings");
    const unfolded = unfoldIcs(icsContent);
    assert.ok(unfolded.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(unfolded.includes("VERSION:2.0\r\n"));
    assert.ok(unfolded.includes("METHOD:REQUEST\r\n"));
    assert.ok(unfolded.includes("BEGIN:VEVENT\r\n"));
    assert.ok(unfolded.includes(`UID:${uid}\r\n`));
    assert.ok(unfolded.includes("DTSTART:20260713T140000Z\r\n"));
    assert.ok(unfolded.includes("DTEND:20260713T144500Z\r\n"));
    assert.ok(unfolded.includes("mailto:rfp-response-team@carrier.example"));
    assert.ok(unfolded.includes("mailto:maya.lin@shipper.example"));
    assert.ok(unfolded.includes("mailto:pricing-desk@carrier.example"));
    assert.ok(unfolded.includes("SUMMARY:Air Freight Kickoff: Acme\\, Inc.\\; Phase 1\r\n"));
    assert.ok(unfolded.endsWith("END:VCALENDAR\r\n"));
  });

  it("handles customer acceptance (accept_all), books proposal_lanes & kickoff meeting into SQLite", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const ctx = await seedRfpWithAssessments(handle.db);

    const draft = await draftCustomerQuote({
      db: handle.db,
      rfpId: ctx.rfpId,
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      rfpTitle: "Q4 Pharma & Electronics Tender",
      lanes: ctx.laneInputs,
      llm: ctx.offlineLlm,
    });
    await approveCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
      approvedBy: "bob.director@carrier.example",
    });
    const sent = await sendCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
    });
    assert.equal(sent.deliveryChannel, "IN_APP_OUTBOX");

    const quotedForMock = draft.renderedLanes
      .filter((l) => l.disposition !== "DECLINE")
      .map((l) => ({
        laneCode: l.laneCode,
        origin: l.origin,
        destination: l.destination,
        tons: l.tons,
        pricePerTonUsd: l.pricePerTonUsd!,
        lineTotalUsd: l.lineTotalUsd!,
        transitDays: l.transitDays,
        maxTransitDays: l.maxTransitDays,
      }));

    const mockReply = await generateMockCustomerReply({
      rfpTitle: "Q4 Pharma & Electronics Tender",
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      scenario: "accept_all",
      quotedLanes: quotedForMock,
    });

    const refDate = new Date("2026-11-23T16:00:00Z"); // Monday ET -> Tuesday Nov 24 10:00 EST (15:00Z)
    const outcome = await handleCustomerReply({
      db: handle.db,
      proposalId: draft.proposalId,
      emailBody: mockReply.body,
      emailSubject: mockReply.subject,
      llm: ctx.offlineLlm,
      kickoffReferenceDate: refDate,
    });

    assert.equal(outcome.intent, "ACCEPT_ALL");
    assert.equal(outcome.proposalStatus, "ACCEPTED");
    assert.equal(outcome.rfpStatus, "DEAL_BOOKED");
    assert.deepEqual(outcome.acceptedLaneCodes, ["MEX-CDG", "DFW-MEX", "GRU-BOG"]);
    assert.equal(outcome.humanTaskCreated, null);
    assert.ok(outcome.meetingCreated);
    assert.equal(outcome.meetingCreated.scheduledAt, "2026-11-24T15:00:00.000Z");
    assert.equal(outcome.meetingCreated.attendees.length, 3);

    const [proposalRow] = await handle.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, draft.proposalId));
    assert.equal(proposalRow?.status, "ACCEPTED");
    assert.equal(proposalRow?.totalQuotedLanes, 3);
    assert.equal(proposalRow?.totalDeclinedLanes, 1);
    assert.equal(proposalRow?.totalTons, 42.5);
    assert.equal(proposalRow?.totalValueUsd, 102000);
    assert.ok(proposalRow?.acceptedAt);
    assert.ok(proposalRow?.customerReplyEmailId);

    const pLanes = await handle.db
      .select()
      .from(proposalLanes)
      .where(eq(proposalLanes.proposalId, draft.proposalId));
    assert.equal(pLanes.length, 4);
    assert.equal(
      pLanes.filter((l) => l.disposition === "ACCEPTED").length,
      3,
    );
    assert.equal(
      pLanes.filter((l) => l.disposition === "DECLINE").length,
      1,
    );

    const meetingRows = await handle.db
      .select()
      .from(meetings)
      .where(eq(meetings.proposalId, draft.proposalId));
    assert.equal(meetingRows.length, 1);
    assert.ok(unfoldIcs(meetingRows[0]!.icsContent).includes("BEGIN:VEVENT"));

    const events = await handle.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.rfpId, ctx.rfpId));
    const eventTypes = events.map((e) => e.eventType);
    assert.ok(eventTypes.includes("QUOTE_DRAFTED"));
    assert.ok(eventTypes.includes("QUOTE_APPROVED"));
    assert.ok(eventTypes.includes("QUOTE_SENT"));
    assert.ok(eventTypes.includes("DEAL_ACCEPTED"));
    assert.ok(eventTypes.includes("KICKOFF_SCHEDULED"));
  });

  it("handles partial acceptance (accept_some), recalculating totals and booking only accepted lanes", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const ctx = await seedRfpWithAssessments(handle.db);

    const draft = await draftCustomerQuote({
      db: handle.db,
      rfpId: ctx.rfpId,
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      rfpTitle: "Q4 Pharma & Electronics Tender",
      lanes: ctx.laneInputs,
      llm: ctx.offlineLlm,
    });
    await approveCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
      approvedBy: "alice.rfp@carrier.example",
    });
    await sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId });

    const quotedForMock = draft.renderedLanes
      .filter((l) => l.disposition !== "DECLINE")
      .map((l) => ({
        laneCode: l.laneCode,
        origin: l.origin,
        destination: l.destination,
        tons: l.tons,
        pricePerTonUsd: l.pricePerTonUsd!,
        lineTotalUsd: l.lineTotalUsd!,
        transitDays: l.transitDays,
        maxTransitDays: l.maxTransitDays,
      }));

    const mockPartial = await generateMockCustomerReply({
      rfpTitle: "Q4 Pharma & Electronics Tender",
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      scenario: "accept_some",
      quotedLanes: quotedForMock,
      acceptedLaneCodes: ["MEX-CDG", "GRU-BOG"],
    });

    const outcome = await handleCustomerReply({
      db: handle.db,
      proposalId: draft.proposalId,
      emailBody: mockPartial.body,
      llm: ctx.offlineLlm,
    });

    assert.equal(outcome.intent, "ACCEPT_PARTIAL");
    assert.equal(outcome.proposalStatus, "PARTIALLY_ACCEPTED");
    assert.equal(outcome.rfpStatus, "DEAL_BOOKED");
    assert.deepEqual(outcome.acceptedLaneCodes, ["MEX-CDG", "GRU-BOG"]);
    assert.deepEqual(outcome.rejectedLaneCodes, ["DFW-MEX"]);
    assert.ok(outcome.meetingCreated);

    const [proposalRow] = await handle.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, draft.proposalId));
    assert.equal(proposalRow?.totalQuotedLanes, 2);
    assert.equal(proposalRow?.totalDeclinedLanes, 2); // 1 unreachable + 1 customer declined
    // Accepted tons = 12.5 + 10 = 22.5t; Value = 30000 + 21000 = 51000
    assert.equal(proposalRow?.totalTons, 22.5);
    assert.equal(proposalRow?.totalValueUsd, 51000);
  });

  it("handles reject, question, unclear replies, and LLM provider failures safely without booking a meeting", async () => {
    const scenarios = [
      { scenario: "reject" as const, expectedIntent: "REJECT", expectedProposalStatus: "REJECTED", expectedRfpStatus: "CLOSED_LOST", expectsTask: false },
      { scenario: "question" as const, expectedIntent: "QUESTION", expectedProposalStatus: "SENT", expectedRfpStatus: "QUOTE_SENT", expectsTask: true, expectedTaskType: "CUSTOMER_QUESTION" },
      { scenario: "unclear" as const, expectedIntent: "UNCLEAR", expectedProposalStatus: "SENT", expectedRfpStatus: "QUOTE_SENT", expectsTask: true, expectedTaskType: "CUSTOMER_REPLY_REVIEW" },
    ];

    for (const s of scenarios) {
      const handle = await createDatabase(":memory:");
      handles.push(handle);
      const ctx = await seedRfpWithAssessments(handle.db);
      const draft = await draftCustomerQuote({
        db: handle.db,
        rfpId: ctx.rfpId,
        customerName: "Maya Lin",
        customerEmail: "maya.lin@shipper.example",
        rfpTitle: "Q4 Pharma & Electronics Tender",
        lanes: ctx.laneInputs,
        llm: ctx.offlineLlm,
      });
      await approveCustomerQuote({
        db: handle.db,
        proposalId: draft.proposalId,
        approvedBy: "alice.rfp@carrier.example",
      });
      await sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId });

      const quotedForMock = draft.renderedLanes
        .filter((l) => l.disposition !== "DECLINE")
        .map((l) => ({
          laneCode: l.laneCode,
          origin: l.origin,
          destination: l.destination,
          tons: l.tons,
          pricePerTonUsd: l.pricePerTonUsd!,
          lineTotalUsd: l.lineTotalUsd!,
          transitDays: l.transitDays,
          maxTransitDays: l.maxTransitDays,
        }));

      const reply = await generateMockCustomerReply({
        rfpTitle: "Q4 Pharma & Electronics Tender",
        customerName: "Maya Lin",
        customerEmail: "maya.lin@shipper.example",
        scenario: s.scenario,
        quotedLanes: quotedForMock,
      });

      const res = await handleCustomerReply({
        db: handle.db,
        proposalId: draft.proposalId,
        emailBody: reply.body,
        llm: ctx.offlineLlm,
      });

      assert.equal(res.intent, s.expectedIntent);
      assert.equal(res.proposalStatus, s.expectedProposalStatus);
      assert.equal(res.rfpStatus, s.expectedRfpStatus);
      assert.equal(res.meetingCreated, null);

      const meetingRows = await handle.db.select().from(meetings);
      assert.equal(meetingRows.length, 0);

      if (s.expectsTask) {
        assert.ok(res.humanTaskCreated);
        assert.equal(res.humanTaskCreated.taskType, s.expectedTaskType);
      } else {
        assert.equal(res.humanTaskCreated, null);
      }
    }

    // Fail-closed test on LLM error during customer reply parsing
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const ctx = await seedRfpWithAssessments(handle.db);
    const draft = await draftCustomerQuote({
      db: handle.db,
      rfpId: ctx.rfpId,
      customerName: "Maya Lin",
      customerEmail: "maya.lin@shipper.example",
      rfpTitle: "Q4 Pharma & Electronics Tender",
      lanes: ctx.laneInputs,
      llm: ctx.offlineLlm,
    });
    await approveCustomerQuote({
      db: handle.db,
      proposalId: draft.proposalId,
      approvedBy: "alice.rfp@carrier.example",
    });
    await sendCustomerQuote({ db: handle.db, proposalId: draft.proposalId });

    const brokenLlm = new LlmClient({
      provider: "gemini",
      env: { GEMINI_API_KEY: "test-key" },
      db: handle.db,
      transport: {
        async generateStructured() {
          throw new Error("Simulated Gemini outage");
        },
      },
    });

    const res = await handleCustomerReply({
      db: handle.db,
      proposalId: draft.proposalId,
      emailBody: "We accept all quoted lanes. Please proceed.",
      llm: brokenLlm,
    });
    assert.equal(res.intent, "UNCLEAR");
    assert.equal(res.meetingCreated, null);
    assert.ok(res.humanTaskCreated);
    assert.equal(res.humanTaskCreated.taskType, "CUSTOMER_REPLY_REVIEW");
  });
});
