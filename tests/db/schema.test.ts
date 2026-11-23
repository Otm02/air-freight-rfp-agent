import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import {
  agentEvents,
  createDatabase,
  emails,
  ensureDatabaseSchema,
  flights,
  humanTasks,
  laneAssessments,
  lanes,
  meetings,
  pricingResponses,
  proposalLanes,
  proposals,
  rfps,
  type DatabaseHandle,
} from "../../src/db";

const EXPECTED_TABLES = [
  "agent_events",
  "emails",
  "flights",
  "human_tasks",
  "lane_assessments",
  "lanes",
  "meetings",
  "pricing_responses",
  "proposal_lanes",
  "proposals",
  "rfps",
];

describe("Drizzle SQLite 11-table schema & bootstrap", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it("creates all 11 tables and supports full relational inserts and cascade deletes", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);
    const { db, client } = handle;

    const tableRows = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    );
    const actualTables = tableRows.rows.map((r) => String(r.name));
    assert.deepEqual(actualTables, EXPECTED_TABLES);

    const now = new Date().toISOString();

    const [rfp] = await db
      .insert(rfps)
      .values({
        title: "Demo RFP",
        sourceType: "mock-xlsx",
        status: "INGESTED",
        llmProvider: "offline",
        customerName: "Acme Pharma",
        customerEmail: "maya@acme.example",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    assert.ok(rfp);

    const [flight] = await db
      .insert(flights)
      .values({
        origin: "MEX",
        destination: "CDG",
        transitDays: 11,
        availableServicesJson: JSON.stringify(["DANGEROUS_GOODS"]),
      })
      .returning();
    assert.ok(flight);

    const [lane] = await db
      .insert(lanes)
      .values({
        rfpId: rfp.id,
        laneNumber: 2,
        laneCode: "MEX-CDG",
        origin: "MEX",
        destination: "CDG",
        tons: 12.3,
        maxTransitDays: 11,
        rawEmail: "Please arrange dangerous-goods handling on every leg.",
        requestedServicesJson: JSON.stringify(["DANGEROUS_GOODS"]),
        evidenceJson: JSON.stringify([
          {
            service: "DANGEROUS_GOODS",
            quote: "dangerous-goods handling on every leg",
          },
        ]),
        intakeConfidence: 0.99,
        intakeSource: "MERGED",
        intakeStatus: "CONFIRMED",
      })
      .returning();
    assert.ok(lane);

    await db.insert(laneAssessments).values({
      rfpId: rfp.id,
      laneId: lane.id,
      status: "FULLY_SERVABLE",
      chosenRouteJson: JSON.stringify(["MEX", "CDG"]),
      bestCompliantRouteJson: JSON.stringify(["MEX", "CDG"]),
      fastestUnconstrainedRouteJson: JSON.stringify(["MEX", "LHR", "CDG"]),
      alternativesJson: "[]",
      serviceCoverageJson: "[]",
      daysOverLimit: 0,
      recommendedAction: "AUTO_PROCEED_TO_PRICING",
      needsHumanDecision: 0,
      humanDecisionReason: null,
      disposition: "QUOTE_COMPLIANT",
      createdAt: now,
    });

    const [email] = await db
      .insert(emails)
      .values({
        rfpId: rfp.id,
        threadType: "PRICING",
        direction: "inbound",
        counterparty: "pricing",
        sender: "pricing@carrier.example",
        recipient: "rfp-team@carrier.example",
        subject: "Re: Pricing Request",
        body: "MEX-CDG recommended at $2,100/ton.",
        plainTextBody: "MEX-CDG recommended at $2,100/ton.",
        parsedPayloadJson: null,
        status: "RECEIVED",
        approvedBy: "alice.rfp@carrier.example",
        approvedAt: now,
        sentAt: null,
        createdAt: now,
      })
      .returning();
    assert.ok(email);
    assert.equal(email.counterparty, "pricing");
    assert.equal(email.approvedBy, "alice.rfp@carrier.example");
    assert.equal(email.plainTextBody, "MEX-CDG recommended at $2,100/ton.");

    await db.insert(pricingResponses).values({
      rfpId: rfp.id,
      laneId: lane.id,
      emailId: email.id,
      recommendedPricePerTonUsd: 2100,
      approvedPricePerTonUsd: 2100,
      includedServicesJson: JSON.stringify(["DANGEROUS_GOODS"]),
      notes: "All-in DG rate",
      confidence: 0.96,
      status: "APPROVED",
      createdAt: now,
    });

    const [proposal] = await db
      .insert(proposals)
      .values({
        rfpId: rfp.id,
        version: 1,
        status: "ACCEPTED",
        quoteEmailId: email.id,
        customerReplyEmailId: null,
        totalQuotedLanes: 1,
        totalDeclinedLanes: 0,
        totalTons: 12.3,
        totalValueUsd: 25830,
        approvedBy: "alice.rfp@carrier.example",
        approvedAt: now,
        sentAt: now,
        acceptedAt: now,
        createdAt: now,
      })
      .returning();
    assert.ok(proposal);
    assert.equal(proposal.approvedBy, "alice.rfp@carrier.example");
    assert.equal(proposal.approvedAt, now);
    assert.equal(proposal.sentAt, now);

    await db.insert(proposalLanes).values({
      proposalId: proposal.id,
      laneId: lane.id,
      origin: "MEX",
      destination: "CDG",
      tons: 12.3,
      disposition: "QUOTE_COMPLIANT",
      routeAirportsJson: JSON.stringify(["MEX", "CDG"]),
      transitDays: 11,
      fulfilledServicesJson: JSON.stringify(["DANGEROUS_GOODS"]),
      missingServicesJson: "[]",
      pricePerTonUsd: 2100,
      lineTotalUsd: 25830,
    });

    await db.insert(meetings).values({
      rfpId: rfp.id,
      proposalId: proposal.id,
      title: "Acme Pharma Kickoff",
      scheduledAt: "2026-12-01T15:00:00Z",
      durationMinutes: 45,
      attendeesJson: JSON.stringify(["maya@acme.example"]),
      agenda: "Confirm DG handoff schedule",
      icsUid: "kickoff-1@air-freight-rfp",
      icsContent: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      status: "SCHEDULED",
      createdAt: now,
    });

    await db.insert(agentEvents).values({
      rfpId: rfp.id,
      laneId: lane.id,
      agentName: "IntakeAgent",
      eventType: "LLM_CALL_SUCCESS",
      provider: "offline",
      model: "offline-rule-v1",
      latencyMs: 3,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      retryCount: 0,
      status: "SUCCESS",
      summary: "Parsed MEX-CDG",
      payloadJson: "{}",
      createdAt: now,
    });

    await db.insert(humanTasks).values({
      rfpId: rfp.id,
      laneId: lane.id,
      laneCode: "MEX-CDG",
      taskType: "CONFIRM_REQUIREMENTS",
      title: "Confirm special requirements for lane MEX-CDG",
      reason: "Test task",
      payloadJson: "{}",
      status: "OPEN",
      createdAt: now,
    });

    // Enforce unique laneCode per RFP
    await assert.rejects(
      db.insert(lanes).values({
        rfpId: rfp.id,
        laneNumber: 99,
        laneCode: "MEX-CDG",
        origin: "MEX",
        destination: "CDG",
        tons: 10,
        maxTransitDays: 11,
        rawEmail: "Duplicate",
      }),
    );

    // Deleting RFP cascades to dependent tables
    await db.delete(rfps).where(eq(rfps.id, rfp.id));
    const remainingLanes = await db.select().from(lanes);
    const remainingTasks = await db.select().from(humanTasks);
    assert.equal(remainingLanes.length, 0);
    assert.equal(remainingTasks.length, 0);
  });

  it("adds new approval and plain-text columns when migrating an older database", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute(`
        CREATE TABLE rfps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          source_type TEXT NOT NULL,
          status TEXT NOT NULL,
          llm_provider TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          customer_email TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      await client.execute(`
        CREATE TABLE emails (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
          thread_type TEXT NOT NULL,
          direction TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          parsed_payload_json TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      await client.execute(`
        CREATE TABLE proposals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
          version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          quote_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
          customer_reply_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
          total_quoted_lanes INTEGER NOT NULL,
          total_declined_lanes INTEGER NOT NULL,
          total_tons REAL NOT NULL,
          total_value_usd REAL NOT NULL,
          accepted_at TEXT,
          created_at TEXT NOT NULL
        );
      `);

      await ensureDatabaseSchema(client);

      const emailInfo = await client.execute("PRAGMA table_info(emails);");
      const emailCols = new Set(emailInfo.rows.map((r) => String(r.name)));
      for (const expected of [
        "counterparty",
        "plain_text_body",
        "approved_by",
        "approved_at",
        "sent_at",
      ]) {
        assert.ok(emailCols.has(expected), `emails missing column ${expected}`);
      }

      const proposalInfo = await client.execute("PRAGMA table_info(proposals);");
      const proposalCols = new Set(proposalInfo.rows.map((r) => String(r.name)));
      for (const expected of ["approved_by", "approved_at", "sent_at"]) {
        assert.ok(
          proposalCols.has(expected),
          `proposals missing column ${expected}`,
        );
      }
    } finally {
      client.close();
    }
  });
});
