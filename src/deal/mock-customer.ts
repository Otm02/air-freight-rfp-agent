import { z } from "zod";
import type { LlmClient } from "../llm";

export type CustomerReplyScenario =
  | "accept_all"
  | "accept_some"
  | "reject"
  | "question"
  | "unclear";

export interface MockCustomerLaneSummary {
  laneCode: string;
  origin: string;
  destination: string;
  tons: number;
  pricePerTonUsd: number;
  lineTotalUsd: number;
  transitDays: number | null;
  maxTransitDays: number;
  missingServices?: readonly string[];
}

export interface GenerateMockCustomerReplyOptions {
  rfpTitle: string;
  customerName: string;
  customerEmail: string;
  scenario: CustomerReplyScenario;
  quotedLanes: readonly MockCustomerLaneSummary[];
  acceptedLaneCodes?: readonly string[];
  llm?: LlmClient;
}

export interface MockCustomerReplyResult {
  scenario: CustomerReplyScenario;
  subject: string;
  body: string;
  expectedAcceptedLaneCodes: string[];
  expectedRejectedLaneCodes: string[];
}

const CustomerRewriteSchema = z.object({
  body: z.string().min(20),
});

function buildDeterministicCustomerReply(
  options: GenerateMockCustomerReplyOptions,
): Omit<MockCustomerReplyResult, "scenario"> {
  const subject = `Re: Air Freight Proposal: ${options.rfpTitle}`;
  const allCodes = options.quotedLanes.map((l) => l.laneCode);

  switch (options.scenario) {
    case "accept_all": {
      const laneList = allCodes.join(", ");
      const body = [
        "Hi RFP Response Team,",
        "",
        `Thank you for the structured proposal for ${options.rfpTitle}.`,
        `We accept the proposal in full for all quoted lanes (${laneList}), including the transit schedules and per-ton rates presented.`,
        "",
        "Please proceed to book the capacity and send over the kickoff meeting invite for tomorrow morning ET.",
        "",
        `Best regards,`,
        options.customerName,
      ].join("\n");
      return {
        subject,
        body,
        expectedAcceptedLaneCodes: allCodes,
        expectedRejectedLaneCodes: [],
      };
    }

    case "accept_some": {
      const requestedAcceptSet = options.acceptedLaneCodes
        ? new Set(options.acceptedLaneCodes.map((c) => c.toUpperCase()))
        : null;
      const accepted = requestedAcceptSet
        ? allCodes.filter((c) => requestedAcceptSet.has(c.toUpperCase()))
        : allCodes.slice(0, Math.max(1, Math.ceil(allCodes.length / 2)));
      const acceptedSet = new Set(accepted);
      const rejected = allCodes.filter((c) => !acceptedSet.has(c));

      const body = [
        "Hi RFP Response Team,",
        "",
        `Thanks for putting together the bid for ${options.rfpTitle}.`,
        `We accept and award ONLY the following lanes: ${accepted.join(", ")}.`,
        rejected.length > 0
          ? `We must decline the remaining lanes (${rejected.join(", ")}) due to internal routing and budget thresholds.`
          : "",
        "",
        "Please book the accepted lanes above and schedule a kickoff meeting with your Pricing and Operations leads.",
        "",
        "Regards,",
        options.customerName,
      ]
        .filter((line) => line !== "")
        .join("\n");

      return {
        subject,
        body,
        expectedAcceptedLaneCodes: accepted,
        expectedRejectedLaneCodes: rejected,
      };
    }

    case "reject": {
      const body = [
        "Hi RFP Response Team,",
        "",
        `Thank you for your work on ${options.rfpTitle}. After reviewing the overall landed rates and transit windows, we regret that we must reject the proposal and will not be proceeding at this time.`,
        "",
        "Thank you again for quoting, and we will keep your team in mind for future tenders.",
        "",
        "Sincerely,",
        options.customerName,
      ].join("\n");
      return {
        subject,
        body,
        expectedAcceptedLaneCodes: [],
        expectedRejectedLaneCodes: allCodes,
      };
    }

    case "question": {
      const focusLane = options.quotedLanes[0]?.laneCode ?? "our primary lane";
      const body = [
        "Hi RFP Response Team,",
        "",
        `Before we sign off on ${options.rfpTitle}, we have two quick clarification questions:`,
        `1. On lane ${focusLane}, can your Operations team guarantee uplift priority during peak mid-week departures?`,
        "2. Are fuel and security surcharges locked for the full 90-day tender period?",
        "",
        "Once you clarify those two points, we can finalize our award decision.",
        "",
        "Thanks,",
        options.customerName,
      ].join("\n");
      return {
        subject,
        body,
        expectedAcceptedLaneCodes: [],
        expectedRejectedLaneCodes: [],
      };
    }

    case "unclear": {
      const firstLane = allCodes[0] ?? "the main lane";
      const body = [
        "Hi Team,",
        "",
        `Our leadership reviewed ${options.rfpTitle}. We tentatively like the setup for ${firstLane}, maybe let's circle back once legal and finance complete their internal sign-off next week — not sure yet on final lane allocation.`,
        "",
        "Best,",
        options.customerName,
      ].join("\n");
      return {
        subject,
        body,
        expectedAcceptedLaneCodes: [],
        expectedRejectedLaneCodes: [],
      };
    }
  }
}

export async function generateMockCustomerReply(
  options: GenerateMockCustomerReplyOptions,
): Promise<MockCustomerReplyResult> {
  const deterministic = buildDeterministicCustomerReply(options);

  if (!options.llm || options.llm.provider === "offline") {
    return {
      scenario: options.scenario,
      ...deterministic,
    };
  }

  const rewritten = await options.llm.generateStructured({
    agentName: "CustomerSimulator",
    operation: `mock_customer_reply_${options.scenario}`,
    schema: CustomerRewriteSchema,
    system:
      "You rewrite a realistic B2B shipper email reply preserving the exact decision intent, exact lane codes mentioned, and tone without altering which lanes are accepted vs declined.",
    prompt: [
      `Scenario: ${options.scenario}`,
      `Accepted lane codes (must stay exact if listed): ${deterministic.expectedAcceptedLaneCodes.join(", ") || "NONE"}`,
      `Declined lane codes (must stay exact if listed): ${deterministic.expectedRejectedLaneCodes.join(", ") || "NONE"}`,
      "",
      "Draft email to polish cleanly:",
      deterministic.body,
    ].join("\n"),
    offlineHandler: () => ({ body: deterministic.body }),
  });

  return {
    scenario: options.scenario,
    subject: deterministic.subject,
    body: rewritten.ok ? rewritten.data.body : deterministic.body,
    expectedAcceptedLaneCodes: deterministic.expectedAcceptedLaneCodes,
    expectedRejectedLaneCodes: deterministic.expectedRejectedLaneCodes,
  };
}
