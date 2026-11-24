import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createDatabase, type DatabaseHandle } from "../../src/db";
import {
  approveAndSendQuote,
  clarifyPricing,
  confirmLaneRequirements,
  createRfp,
  decideLaneDisposition,
  draftQuote,
  ensureDemoSeeded,
  getRfpWorkspace,
  listRfps,
  processCustomerReply,
  requestPricing,
  resolveFollowUpTask,
  setManualLanePrice,
  subscribeToRfpEvents,
} from "../../src/orchestrator";

describe("RFP Orchestrator state machine, SSE event bus & seeder", () => {
  const handles: DatabaseHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.close();
    }
  });

  it("seeds the demo showcase RFP idempotently and walks the complete state machine to WON", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const demoId = await ensureDemoSeeded(handle.db);
    const secondCallId = await ensureDemoSeeded(handle.db);
    assert.equal(secondCallId, demoId);

    const rfpList = await listRfps(handle.db, "offline");
    assert.equal(rfpList.length, 1);
    assert.equal(rfpList[0]?.laneCount, 10);

    const streamedEventTypes: string[] = [];
    const unsubscribe = subscribeToRfpEvents(demoId, (row) => {
      streamedEventTypes.push(row.eventType);
    });

    try {
      const initialSnap = await getRfpWorkspace(handle.db, demoId, "offline");
      assert.ok(initialSnap);
      assert.equal(initialSnap.rfp.status, "AWAITING_REQUIREMENT_CONFIRMATION");
      assert.equal(initialSnap.rfp.isWaitingForHuman, true);
      assert.equal(initialSnap.summary.servableCount, 3);
      assert.equal(initialSnap.summary.lateCount, 3);
      assert.equal(initialSnap.summary.missingServicesCount, 2);
      assert.equal(initialSnap.summary.noRouteInTimeCount, 1);
      assert.equal(initialSnap.summary.unreachableCount, 1);
      assert.equal(initialSnap.summary.openHumanTasksCount, 7);

      // Gate check: cannot request pricing while human route tasks remain open
      await assert.rejects(requestPricing(handle.db, demoId, { llmMode: "offline" }));

      // Resolve all 7 open route decisions with mixed dispositions
      for (const lane of initialSnap.lanes) {
        if (!lane.needsDecision || !lane.assessment) continue;
        if (lane.assessment.status === "COMPLIANT_BUT_LATE") {
          await decideLaneDisposition(handle.db, demoId, lane.id, {
            disposition: "QUOTE_COMPLIANT_LATE",
            reviewer: "alice.rfp@carrier.example",
          });
        } else if (lane.assessment.status === "ON_TIME_BUT_MISSING_SERVICES") {
          await decideLaneDisposition(handle.db, demoId, lane.id, {
            disposition: "QUOTE_PARTIAL_ON_TIME",
            alternativeIndex: 0,
            reviewer: "alice.rfp@carrier.example",
          });
        } else {
          await decideLaneDisposition(handle.db, demoId, lane.id, {
            disposition: "DECLINE",
            reviewer: "alice.rfp@carrier.example",
          });
        }
      }

      const afterDecisions = await getRfpWorkspace(handle.db, demoId, "offline");
      assert.ok(afterDecisions);
      assert.equal(afterDecisions.rfp.status, "ROUTING");
      assert.equal(afterDecisions.summary.openHumanTasksCount, 0);

      // Request pricing -> pauses at AWAITING_PRICING_FIXES due to intentional anomalies
      await requestPricing(handle.db, demoId, { llmMode: "offline" });
      const awaitingPricing = await getRfpWorkspace(handle.db, demoId, "offline");
      assert.ok(awaitingPricing);
      assert.equal(awaitingPricing.rfp.status, "AWAITING_PRICING_FIXES");
      assert.equal(awaitingPricing.rfp.isWaitingForHuman, true);

      const pricingTasks = awaitingPricing.humanTasks.filter(
        (t) => t.status === "OPEN" && t.taskType === "CLARIFY_PRICING",
      );
      assert.equal(pricingTasks.length, 2);

      // Resolve first task via manual price entry and second via Pricing clarification email round trip
      await setManualLanePrice(handle.db, demoId, pricingTasks[0]!.laneId!, {
        pricePerTonUsd: 2650,
        reviewer: "alice.rfp@carrier.example",
        note: "Spot rate approved via phone",
      });
      await clarifyPricing(handle.db, demoId, {
        taskId: pricingTasks[1]!.id,
        llmMode: "offline",
      });

      const pricingReady = await getRfpWorkspace(handle.db, demoId, "offline");
      assert.ok(pricingReady);
      assert.equal(pricingReady.rfp.status, "PRICING_RECEIVED");
      assert.equal(pricingReady.summary.openHumanTasksCount, 0);

      // Draft customer quote -> pauses at AWAITING_APPROVAL
      const proposalId = await draftQuote(handle.db, demoId, {
        llmMode: "offline",
      });
      const awaitingApproval = await getRfpWorkspace(handle.db, demoId, "offline");
      assert.ok(awaitingApproval);
      assert.equal(awaitingApproval.rfp.status, "AWAITING_APPROVAL");
      assert.ok(awaitingApproval.proposal);
      assert.equal(awaitingApproval.proposal.status, "DRAFT");

      // Approve and send quote -> transitions to SENT
      await approveAndSendQuote(handle.db, demoId, proposalId, {
        approvedBy: "alice.rfp@carrier.example",
      });
      const sentSnap = await getRfpWorkspace(handle.db, demoId, "offline");
      assert.ok(sentSnap);
      assert.equal(sentSnap.rfp.status, "SENT");
      assert.equal(sentSnap.proposal?.status, "SENT");

      // Customer accepts -> transitions to WON & books kickoff meeting
      const replyOutcome = await processCustomerReply(handle.db, demoId, proposalId, {
        scenario: "accept_all",
        llmMode: "offline",
      });
      assert.equal(replyOutcome.finalState, "WON");

      const finalSnap = await getRfpWorkspace(handle.db, demoId, "offline");
      assert.ok(finalSnap);
      assert.equal(finalSnap.rfp.status, "WON");
      assert.equal(finalSnap.rfp.isWaitingForHuman, false);
      assert.equal(finalSnap.proposal?.status, "ACCEPTED");
      assert.ok(finalSnap.meeting);
      assert.ok(finalSnap.meeting.icsContent.includes("BEGIN:VCALENDAR"));

      // Verify state transitions & SSE stream captured the lifecycle
      const eventTypes = finalSnap.events.map((e) => e.eventType);
      assert.ok(eventTypes.includes("STATE_TRANSITION"));
      assert.ok(eventTypes.includes("WAITING_FOR_HUMAN"));
      assert.ok(eventTypes.includes("LANE_DECISION_APPLIED"));
      assert.ok(eventTypes.includes("DEAL_ACCEPTED"));
      assert.ok(streamedEventTypes.includes("QUOTE_SENT"));
      assert.ok(streamedEventTypes.includes("KICKOFF_SCHEDULED"));
    } finally {
      unsubscribe();
    }
  });

  it("handles custom RFP intake ambiguity confirmation, NEEDS_FOLLOW_UP, and LOST branches", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const customId = await createRfp(handle.db, {
      mode: "custom",
      title: "Biologics Urgent Trial",
      customerName: "Dr. Samira Khan",
      customerEmail: "samira@bio.example",
      llmMode: "offline",
      lanes: [
        {
          origin: "MEX",
          destination: "CDG",
          tons: 10,
          maxTransitDays: 11,
          rawEmail:
            "Need dangerous goods handling plus dry ice at -20 C from MEX to CDG.",
        },
      ],
    });

    const snap1 = await getRfpWorkspace(handle.db, customId, "offline");
    assert.ok(snap1);
    assert.equal(snap1.rfp.status, "AWAITING_REQUIREMENT_CONFIRMATION");
    const reqTask = snap1.humanTasks.find(
      (t) => t.taskType === "CONFIRM_REQUIREMENTS" && t.status === "OPEN",
    );
    assert.ok(reqTask);

    // Human confirms canonical service [DANGEROUS_GOODS]
    await confirmLaneRequirements(handle.db, customId, snap1.lanes[0]!.id, {
      requestedServices: ["DANGEROUS_GOODS"],
      reviewer: "alice.rfp@carrier.example",
      note: "Shipper confirmed dry ice omitted.",
    });

    const snap2 = await getRfpWorkspace(handle.db, customId, "offline");
    assert.ok(snap2);
    assert.equal(snap2.rfp.status, "ROUTING");
    assert.equal(snap2.summary.openHumanTasksCount, 0);

    await requestPricing(handle.db, customId, { llmMode: "offline" });
    const propId = await draftQuote(handle.db, customId, { llmMode: "offline" });
    await approveAndSendQuote(handle.db, customId, propId, {
      approvedBy: "alice.rfp@carrier.example",
    });

    // Customer asks a question -> NEEDS_FOLLOW_UP
    const qRes = await processCustomerReply(handle.db, customId, propId, {
      scenario: "question",
      llmMode: "offline",
    });
    assert.equal(qRes.finalState, "NEEDS_FOLLOW_UP");

    const snapQ = await getRfpWorkspace(handle.db, customId, "offline");
    const qTask = snapQ?.humanTasks.find(
      (t) => t.taskType === "CUSTOMER_QUESTION" && t.status === "OPEN",
    );
    assert.ok(qTask);

    await resolveFollowUpTask(handle.db, customId, qTask.id, {
      reviewer: "alice.rfp@carrier.example",
      responseNote: "Answered uplift priority question; awaiting decision.",
      outcome: "RETURN_TO_SENT",
    });

    // Customer rejects -> LOST
    const rejRes = await processCustomerReply(handle.db, customId, propId, {
      scenario: "reject",
      llmMode: "offline",
    });
    assert.equal(rejRes.finalState, "LOST");

    const snapLost = await getRfpWorkspace(handle.db, customId, "offline");
    assert.equal(snapLost?.rfp.status, "LOST");
    assert.equal(snapLost?.meeting, null);
  });

  it("rejects out-of-range manual pricing and non-compliant QUOTE_COMPLIANT_LATE overrides", async () => {
    const handle = await createDatabase(":memory:");
    handles.push(handle);

    const demoId = await ensureDemoSeeded(handle.db);
    const snap = await getRfpWorkspace(handle.db, demoId, "offline");
    assert.ok(snap);

    const gruBog = snap.lanes.find((l) => l.laneCode === "GRU-BOG");
    assert.ok(gruBog);

    // GRU-BOG is ON_TIME_BUT_MISSING_SERVICES and has no compliant route -> must reject QUOTE_COMPLIANT_LATE
    await assert.rejects(
      decideLaneDisposition(handle.db, demoId, gruBog.id, {
        disposition: "QUOTE_COMPLIANT_LATE",
        reviewer: "alice.rfp@carrier.example",
      }),
      /no compliant route/i,
    );

    // Manual price sanity bounds [$500, $15,000]/t enforced cleanly
    const mexCdg = snap.lanes.find((l) => l.laneCode === "MEX-CDG");
    assert.ok(mexCdg);
    await assert.rejects(
      setManualLanePrice(handle.db, demoId, mexCdg.id, {
        pricePerTonUsd: 50,
        reviewer: "alice.rfp@carrier.example",
      }),
      /between \$500 and \$15000\/t/i,
    );
    await assert.rejects(
      setManualLanePrice(handle.db, demoId, mexCdg.id, {
        pricePerTonUsd: 50_000,
        reviewer: "alice.rfp@carrier.example",
      }),
      /between \$500 and \$15000\/t/i,
    );
  });
});
