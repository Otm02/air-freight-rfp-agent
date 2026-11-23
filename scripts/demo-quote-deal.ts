import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  ApprovalGateError,
  approveCustomerQuote,
  createPricingRequestEmail,
  draftCustomerQuote,
  handleCustomerReply,
  parsePricingReply,
  runIntakeForLane,
  sendCustomerQuote,
  sendPricingClarificationAndResolve,
  type QuoteLaneInput,
} from "../src/agents";
import {
  agentEvents,
  createDatabase,
  emails as emailsTable,
  flights as flightsTable,
  humanTasks,
  laneAssessments,
  lanes as lanesTable,
  meetings,
  proposalLanes,
  proposals,
  rfps,
} from "../src/db";
import { generateMockCustomerReply } from "../src/deal";
import {
  assessLane,
  buildFlightGraph,
  loadDatasetFromFile,
  type Lane,
  type LaneAssessment,
} from "../src/domain";
import { LlmClient } from "../src/llm";
import { generateMockPricingReply, type PricingQuoteLaneInput } from "../src/pricing";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);
const OUT_DB_SNAPSHOT_PATH = path.resolve(REPO_ROOT, "out/demo_e2e_db_rows.json");
const OUT_ICS_PATH = path.resolve(REPO_ROOT, "out/kickoff_meeting.ics");

const SHOWCASE_LANE_CODES = [
  "MEX-CDG", // FULLY_SERVABLE
  "JFK-LAX", // FULLY_SERVABLE
  "DFW-MEX", // COMPLIANT_BUT_LATE
  "HKG-LAX", // COMPLIANT_BUT_LATE
  "GRU-BOG", // ON_TIME_BUT_MISSING_SERVICES
  "FAI-SIN", // UNREACHABLE
] as const;

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(OUT_ICS_PATH), { recursive: true });
  await fs.rm(path.resolve(REPO_ROOT, "out/demo_e2e.db"), { force: true });

  const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
  const flightGraph = buildFlightGraph(dataset.flights);

  const laneByCode = new Map<string, Lane>();
  for (const lane of dataset.lanes) {
    laneByCode.set(lane.laneCode, lane);
  }

  const selectedLanes = SHOWCASE_LANE_CODES.map((code) => {
    const lane = laneByCode.get(code);
    if (!lane) {
      throw new Error(`Showcase lane ${code} not found in mock workbook.`);
    }
    return lane;
  });

  // Note: On Windows UNC mounts (\\wsl.localhost\...), libsql POSIX file locking raises
  // SQLITE_BUSY for file-backed DBs over 9p; default to ":memory:" (overridable via DEMO_DB_URL).
  const dbUrl = process.env.DEMO_DB_URL ?? ":memory:";
  const handle = await createDatabase(dbUrl);
  try {
    const { db } = handle;
    const llm = new LlmClient({ provider: "offline", db });
    const now = new Date().toISOString();

    // 1. Seed RFP & Flight Network
    const [rfpRow] = await db
      .insert(rfps)
      .values({
        title: "FY26 Global Priority Air Freight Showcase RFP",
        sourceType: "mock-xlsx",
        status: "INGESTED",
        llmProvider: llm.provider,
        customerName: "Elena Vance (GlobalPharma Procurement)",
        customerEmail: "elena.vance@globalpharma.example",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!rfpRow) {
      throw new Error("Failed to insert RFP row.");
    }

    for (const f of dataset.flights) {
      await db
        .insert(flightsTable)
        .values({
          origin: f.origin,
          destination: f.destination,
          transitDays: f.transitDays,
          availableServicesJson: JSON.stringify(f.availableServices),
        })
        .onConflictDoNothing();
    }

    // 2. Intake + Routing Assessment for 6 showcase lanes
    const laneRecords: Array<{
      dbLaneId: number;
      lane: Lane;
      assessment: LaneAssessment;
    }> = [];

    for (const lane of selectedLanes) {
      const [insertedLane] = await db
        .insert(lanesTable)
        .values({
          rfpId: rfpRow.id,
          laneNumber: lane.laneNumber,
          laneCode: lane.laneCode,
          origin: lane.origin,
          destination: lane.destination,
          tons: lane.tons,
          maxTransitDays: lane.maxTransitDays,
          rawEmail: lane.rawEmail,
        })
        .returning();
      if (!insertedLane) {
        throw new Error(`Failed to insert lane ${lane.laneCode}`);
      }

      const intake = await runIntakeForLane(lane, {
        llm,
        db,
        rfpId: rfpRow.id,
        laneId: insertedLane.id,
      });

      const assessment = assessLane(lane, flightGraph, {
        ...intake.ruleReading,
        requestedServices: intake.mergedServices,
        confidence: intake.mergedConfidence,
        needsHumanReview: intake.needsHumanTask,
        reviewReason: intake.humanTask?.reason ?? null,
      });

      await db.insert(laneAssessments).values({
        rfpId: rfpRow.id,
        laneId: insertedLane.id,
        status: assessment.status,
        chosenRouteJson: assessment.chosenRoute
          ? JSON.stringify(assessment.chosenRoute.airports)
          : null,
        bestCompliantRouteJson: assessment.routing.bestCompliantRoute
          ? JSON.stringify(assessment.routing.bestCompliantRoute.airports)
          : null,
        fastestUnconstrainedRouteJson: assessment.routing
          .fastestUnconstrainedRoute
          ? JSON.stringify(assessment.routing.fastestUnconstrainedRoute.airports)
          : null,
        alternativesJson: JSON.stringify(assessment.routing.alternatives),
        serviceCoverageJson: JSON.stringify(assessment.serviceCoverage),
        daysOverLimit: assessment.daysOverLimit,
        recommendedAction: assessment.recommendedAction,
        needsHumanDecision: assessment.needsHumanDecision ? 1 : 0,
        humanDecisionReason: assessment.humanDecisionReason,
        disposition: assessment.chosenRoute ? "QUOTE_CANDIDATE" : "DECLINE",
        createdAt: new Date().toISOString(),
      });

      laneRecords.push({
        dbLaneId: insertedLane.id,
        lane,
        assessment,
      });
    }

    // 3. Pricing Agent Round Trip + Clarification on Intentional Anomalies
    const routableInputs: PricingQuoteLaneInput[] = laneRecords
      .filter((r) => r.assessment.chosenRoute !== null)
      .map((r) => ({
        laneId: r.dbLaneId,
        laneNumber: r.lane.laneNumber,
        laneCode: r.lane.laneCode,
        origin: r.lane.origin,
        destination: r.lane.destination,
        tons: r.lane.tons,
        routeAirports: r.assessment.chosenRoute!.airports,
        transitDays: r.assessment.chosenRoute!.totalTransitDays,
        requestedServices: r.assessment.extraction.requestedServices,
        fulfillableServices: r.assessment.serviceCoverage
          .filter((g) => g.fulfilled)
          .map((g) => g.service),
      }));

    await createPricingRequestEmail({
      lanes: routableInputs,
      rfpId: rfpRow.id,
      rfpTitle: rfpRow.title,
      db,
    });

    const mockPricingReply = await generateMockPricingReply({
      lanes: routableInputs,
      rfpTitle: rfpRow.title,
      missingLaneIndex: 2, // DFW-MEX missing
      ambiguousLaneIndex: 4, // GRU-BOG ambiguous range
      styleVariant: 0,
      llm,
    });

    const parsedInitial = await parsePricingReply({
      emailBody: mockPricingReply.body,
      requestedLanes: routableInputs,
      llm,
      db,
      rfpId: rfpRow.id,
      persistInboundEmail: {
        subject: mockPricingReply.subject,
        sender: "pricing-desk@carrier.example",
        recipient: "rfp-response-team@carrier.example",
      },
    });

    const priceByLaneCode = new Map<string, number>();
    for (const v of parsedInitial.validated) {
      if (v.pricePerTonUsd !== null) {
        priceByLaneCode.set(v.lane.laneCode, v.pricePerTonUsd);
      }
    }

    if (parsedInitial.flagged.length > 0) {
      const clarification = await sendPricingClarificationAndResolve({
        db,
        rfpId: rfpRow.id,
        llm,
        flaggedLanes: parsedInitial.flagged,
        styleVariant: 0,
      });
      for (const v of clarification.parsedClarification.validated) {
        if (v.pricePerTonUsd !== null) {
          priceByLaneCode.set(v.lane.laneCode, v.pricePerTonUsd);
        }
      }
    }

    // 4. Draft Customer Quote
    const quoteInputs: QuoteLaneInput[] = laneRecords.map((r) => ({
      laneId: r.dbLaneId,
      assessment: r.assessment,
      pricePerTonUsd:
        r.assessment.chosenRoute !== null
          ? (priceByLaneCode.get(r.lane.laneCode) ?? null)
          : null,
    }));

    const draft = await draftCustomerQuote({
      db,
      rfpId: rfpRow.id,
      customerName: rfpRow.customerName,
      customerEmail: rfpRow.customerEmail,
      rfpTitle: rfpRow.title,
      lanes: quoteInputs,
      llm,
    });

    // 5. Prove Approval Gate blocks unapproved send
    let blockedGateError = "";
    try {
      await sendCustomerQuote({ db, proposalId: draft.proposalId });
    } catch (err) {
      if (err instanceof ApprovalGateError) {
        blockedGateError = `${err.code}: ${err.message}`;
      } else {
        throw err;
      }
    }

    // 6. Approve as human reviewer & Send to outbox
    const approval = await approveCustomerQuote({
      db,
      proposalId: draft.proposalId,
      approvedBy: "alice.rfp@carrier.example",
    });

    const sentQuote = await sendCustomerQuote({
      db,
      proposalId: draft.proposalId,
    });

    // 7. Customer Accept-All Reply + Deal Agent Kickoff Booking
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

    const mockCustomerReply = await generateMockCustomerReply({
      rfpTitle: rfpRow.title,
      customerName: rfpRow.customerName,
      customerEmail: rfpRow.customerEmail,
      scenario: "accept_all",
      quotedLanes: quotedForMock,
      llm,
    });

    const dealResult = await handleCustomerReply({
      db,
      proposalId: draft.proposalId,
      emailBody: mockCustomerReply.body,
      emailSubject: mockCustomerReply.subject,
      llm,
    });

    if (!dealResult.meetingCreated) {
      throw new Error("Expected Deal Agent to schedule a kickoff meeting.");
    }

    await fs.writeFile(OUT_ICS_PATH, dealResult.meetingCreated.icsContent, "utf8");

    // 8. Query & Print Created Database State
    const [finalRfp] = await db
      .select()
      .from(rfps)
      .where(eq(rfps.id, rfpRow.id));
    const [finalProposal] = await db
      .select()
      .from(proposals)
      .where(eq(proposals.id, draft.proposalId));
    const finalProposalLanes = await db
      .select()
      .from(proposalLanes)
      .where(eq(proposalLanes.proposalId, draft.proposalId));
    const finalMeetings = await db
      .select()
      .from(meetings)
      .where(eq(meetings.proposalId, draft.proposalId));
    const finalEmails = await db
      .select({
        id: emailsTable.id,
        threadType: emailsTable.threadType,
        direction: emailsTable.direction,
        counterparty: emailsTable.counterparty,
        status: emailsTable.status,
        approvedBy: emailsTable.approvedBy,
        sentAt: emailsTable.sentAt,
        subject: emailsTable.subject,
      })
      .from(emailsTable)
      .where(eq(emailsTable.rfpId, rfpRow.id));
    const finalTasks = await db
      .select({
        id: humanTasks.id,
        laneCode: humanTasks.laneCode,
        taskType: humanTasks.taskType,
        status: humanTasks.status,
        title: humanTasks.title,
      })
      .from(humanTasks)
      .where(eq(humanTasks.rfpId, rfpRow.id));
    const finalEvents = await db
      .select({
        id: agentEvents.id,
        agentName: agentEvents.agentName,
        eventType: agentEvents.eventType,
        status: agentEvents.status,
        summary: agentEvents.summary,
      })
      .from(agentEvents)
      .where(eq(agentEvents.rfpId, rfpRow.id));

    await fs.writeFile(
      OUT_DB_SNAPSHOT_PATH,
      JSON.stringify(
        {
          dbUrl,
          rfp: finalRfp,
          proposal: finalProposal,
          proposalLanes: finalProposalLanes,
          meetings: finalMeetings.map(({ icsContent: _ics, ...rest }) => rest),
          emails: finalEmails,
          humanTasks: finalTasks,
          agentEvents: finalEvents,
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log("========================================================================");
    console.log("AIR FREIGHT RFP AUTOMATION — END-TO-END CHECKPOINT RUN");
    console.log("========================================================================");
    console.log(`Database URL:  ${dbUrl}`);
    console.log(`DB Snapshot:   ${OUT_DB_SNAPSHOT_PATH}`);
    console.log(`Kickoff ICS:   ${OUT_ICS_PATH}`);
    console.log(`Gate Check:    ${blockedGateError}`);
    console.log(`Approval:      by ${approval.approvedBy} at ${approval.approvedAt}`);
    console.log(`Send Channel:  ${sentQuote.deliveryChannel} at ${sentQuote.sentAt}`);
    console.log(`Deal Outcome:  intent=${dealResult.intent} | rfp=${finalRfp?.status}`);

    console.log("\n--- TABLE: rfps ---");
    console.log(JSON.stringify(finalRfp, null, 2));

    console.log("\n--- TABLE: proposals ---");
    console.log(JSON.stringify(finalProposal, null, 2));

    console.log("\n--- TABLE: proposal_lanes ---");
    console.log(JSON.stringify(finalProposalLanes, null, 2));

    console.log("\n--- TABLE: meetings (omitting duplicated raw icsContent) ---");
    console.log(
      JSON.stringify(
        finalMeetings.map(({ icsContent: _ics, ...rest }) => rest),
        null,
        2,
      ),
    );

    console.log("\n--- TABLE: emails (metadata) ---");
    console.log(JSON.stringify(finalEmails, null, 2));

    console.log("\n--- TABLE: human_tasks ---");
    console.log(JSON.stringify(finalTasks, null, 2));

    console.log(`\n--- TABLE: agent_events (${finalEvents.length} rows) ---`);
    for (const ev of finalEvents) {
      console.log(`#${ev.id} [${ev.agentName}/${ev.eventType}] (${ev.status}) ${ev.summary}`);
    }

    console.log("\n--- OUTGOING CUSTOMER QUOTE (PLAIN-TEXT PREVIEW) ---");
    console.log(draft.plainTextBody);

    console.log("\n--- GENERATED FILE: out/kickoff_meeting.ics ---");
    console.log(dealResult.meetingCreated.icsContent);
  } finally {
    handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
