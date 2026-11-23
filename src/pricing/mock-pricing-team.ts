import { z } from "zod";
import {
  SERVICE_DISPLAY_LABELS,
  SERVICE_TYPES,
  type AirportCode,
  type ServiceType,
} from "../domain";
import type { LlmClient } from "../llm";

export const SERVICE_SURCHARGE_PER_TON_USD: Readonly<Record<ServiceType, number>> = {
  TEMP_CONTROLLED: 450,
  DANGEROUS_GOODS: 600,
  HIGH_VALUE_SECURITY: 500,
  FRAGILE: 250,
  OVERSIZED: 400,
};

export type CurrencyFormatStyle = "USD_PER_T" | "DOLLAR_PER_TON" | "PER_KG";

export interface PricingQuoteLaneInput {
  laneId: number;
  laneNumber?: number;
  laneCode: string;
  origin: AirportCode;
  destination: AirportCode;
  tons: number;
  routeAirports: readonly AirportCode[];
  transitDays: number;
  requestedServices: readonly ServiceType[];
  fulfillableServices: readonly ServiceType[];
}

export interface TrueLanePriceBreakdown {
  laneId: number;
  laneCode: string;
  legCount: number;
  transitDays: number;
  tons: number;
  fulfillableServices: ServiceType[];
  baseRateUsd: number;
  serviceSurchargeUsd: number;
  volumeDiscountPct: number;
  truePricePerTonUsd: number;
  truePricePerKgUsd: number;
}

export interface PricingEvalGroundTruth {
  truePricesByLaneCode: Record<string, TrueLanePriceBreakdown>;
  formatByLaneCode: Record<string, CurrencyFormatStyle>;
  missingLaneCodes: string[];
  ambiguousLaneCodes: string[];
  outOfRangeLaneCodes: string[];
  expectedCleanLaneCodes: string[];
}

export interface MockPricingReplyResult {
  subject: string;
  body: string;
  _evalOnlyGroundTruth: PricingEvalGroundTruth;
}

export interface GenerateMockPricingReplyOptions {
  lanes: readonly PricingQuoteLaneInput[];
  rfpTitle?: string;
  missingLaneIndex?: number | null;
  ambiguousLaneIndex?: number | null;
  outOfRangeLaneIndex?: number | null;
  outOfRangePriceUsd?: number;
  styleVariant?: number;
  llm?: LlmClient;
}

const CONDITIONS_CATALOG = [
  "subject to capacity",
  "fuel & security surcharge included",
  "valid 14 days, subject to space allotment",
  "main-deck allocation required; subject to capacity",
  "all-in airport-to-airport, subject to DG/cold-chain check-in cutoff",
] as const;

const ANALYST_SIGNATURES = [
  "Marcus Vance, Global Air Pricing Desk",
  "Elena Rostova, Network Revenue & Capacity",
  "Devon Patel, Special Cargo Desk",
  "Claire Moreau, Interline & Charter Pricing",
] as const;

const LlmRewriteSchema = z.object({
  body: z.string().min(40),
});

function sortServicesCanonical(services: Iterable<ServiceType>): ServiceType[] {
  const set = new Set(services);
  return SERVICE_TYPES.filter((s) => set.has(s));
}

export function computeTrueLanePrice(
  lane: PricingQuoteLaneInput,
): TrueLanePriceBreakdown {
  const legCount = Math.max(1, lane.routeAirports.length - 1);
  const fulfillable = sortServicesCanonical(lane.fulfillableServices);

  const baseRateUsd = 1200 + 350 * legCount + 60 * lane.transitDays;
  const serviceSurchargeUsd = fulfillable.reduce(
    (sum, svc) => sum + SERVICE_SURCHARGE_PER_TON_USD[svc],
    0,
  );
  const volumeDiscountPct =
    lane.tons >= 50 ? 0.1 : lane.tons >= 20 ? 0.05 : 0;

  const discounted =
    (baseRateUsd + serviceSurchargeUsd) * (1 - volumeDiscountPct);
  const truePricePerTonUsd = Math.round(discounted / 10) * 10;
  const truePricePerKgUsd = Number((truePricePerTonUsd / 1000).toFixed(2));

  return {
    laneId: lane.laneId,
    laneCode: lane.laneCode,
    legCount,
    transitDays: lane.transitDays,
    tons: lane.tons,
    fulfillableServices: fulfillable,
    baseRateUsd,
    serviceSurchargeUsd,
    volumeDiscountPct,
    truePricePerTonUsd,
    truePricePerKgUsd,
  };
}

export function formatPriceToken(
  pricePerTonUsd: number,
  style: CurrencyFormatStyle,
  includeDollarPrefixOnKg = false,
): string {
  switch (style) {
    case "USD_PER_T":
      return `USD ${pricePerTonUsd.toLocaleString("en-US")}/t`;
    case "DOLLAR_PER_TON":
      return `$${pricePerTonUsd.toLocaleString("en-US")} per ton`;
    case "PER_KG": {
      const perKg = (pricePerTonUsd / 1000).toFixed(2);
      return includeDollarPrefixOnKg ? `$${perKg} per kg` : `${perKg} per kg`;
    }
  }
}

function selectFormatStyle(index: number, variant: number): CurrencyFormatStyle {
  const styles: readonly CurrencyFormatStyle[] = [
    "USD_PER_T",
    "DOLLAR_PER_TON",
    "PER_KG",
  ];
  return styles[(index + variant) % styles.length]!;
}

export async function generateMockPricingReply(
  options: GenerateMockPricingReplyOptions,
): Promise<MockPricingReplyResult> {
  const { lanes } = options;
  const variant = Math.abs(options.styleVariant ?? 0);

  const missingIdx =
    options.missingLaneIndex === undefined
      ? lanes.length >= 3
        ? Math.min(1, lanes.length - 1)
        : null
      : options.missingLaneIndex;

  const ambiguousIdx =
    options.ambiguousLaneIndex === undefined
      ? lanes.length >= 3
        ? Math.min(2, lanes.length - 1) === missingIdx
          ? 0
          : Math.min(2, lanes.length - 1)
        : null
      : options.ambiguousLaneIndex;

  const outOfRangeIdx = options.outOfRangeLaneIndex ?? null;
  const outOfRangePriceUsd = options.outOfRangePriceUsd ?? 45_000;

  const truePricesByLaneCode: Record<string, TrueLanePriceBreakdown> = {};
  const formatByLaneCode: Record<string, CurrencyFormatStyle> = {};
  const missingLaneCodes: string[] = [];
  const ambiguousLaneCodes: string[] = [];
  const outOfRangeLaneCodes: string[] = [];
  const expectedCleanLaneCodes: string[] = [];

  const tableRows: string[] = [];
  const proseParagraphs: string[] = [];
  const exceptionNotes: string[] = [];
  const cleanQuotedTokens: string[] = [];

  lanes.forEach((lane, idx) => {
    const truth = computeTrueLanePrice(lane);
    truePricesByLaneCode[lane.laneCode] = truth;

    const condition =
      CONDITIONS_CATALOG[(idx + variant) % CONDITIONS_CATALOG.length]!;
    const routeStr = lane.routeAirports.join(" -> ");
    const svcList =
      truth.fulfillableServices.length > 0
        ? truth.fulfillableServices
            .map((s) => SERVICE_DISPLAY_LABELS[s])
            .join(", ")
        : "Standard General Cargo";

    if (idx === missingIdx) {
      missingLaneCodes.push(lane.laneCode);
      exceptionNotes.push(
        variant % 2 === 0
          ? `- Lane #${lane.laneId} (${lane.laneCode}, ${routeStr}): still awaiting interline hub slot confirmation — no rate released yet.`
          : `Regarding Lane #${lane.laneId} (${lane.laneCode}): partner carrier desk has not returned tariff confirmation yet, so please hold off quoting this sector.`,
      );
      return;
    }

    if (idx === ambiguousIdx) {
      ambiguousLaneCodes.push(lane.laneCode);
      const low = Math.max(500, truth.truePricePerTonUsd - 200);
      const high = truth.truePricePerTonUsd + 350;
      exceptionNotes.push(
        variant % 2 === 0
          ? `- Lane #${lane.laneId} (${lane.laneCode}, ${routeStr}): preliminary range is between USD ${low.toLocaleString("en-US")}/t and USD ${high.toLocaleString("en-US")}/t depending on charter vs scheduled uplift (${condition}).`
          : `For Lane #${lane.laneId} (${lane.laneCode}), ops gave conflicting estimates of $${low.toLocaleString("en-US")} per ton or $${high.toLocaleString("en-US")} per ton pending pallet confirmation — please clarify before locking.`,
      );
      return;
    }

    if (idx === outOfRangeIdx) {
      outOfRangeLaneCodes.push(lane.laneCode);
      const badToken = `USD ${outOfRangePriceUsd.toLocaleString("en-US")}/t`;
      proseParagraphs.push(
        `Lane #${lane.laneId} (${lane.laneCode}, ${routeStr}, ${lane.transitDays}d, ${svcList}): desk keyed in ${badToken} (${condition}).`,
      );
      return;
    }

    expectedCleanLaneCodes.push(lane.laneCode);
    const style = selectFormatStyle(idx, variant);
    formatByLaneCode[lane.laneCode] = style;
    const priceToken = formatPriceToken(
      truth.truePricePerTonUsd,
      style,
      (idx + variant) % 2 === 1,
    );
    cleanQuotedTokens.push(priceToken);

    const putInTable = (idx + variant) % 2 === 0;
    if (putInTable) {
      tableRows.push(
        `| #${lane.laneId} | ${lane.laneCode} | ${routeStr} (${lane.transitDays}d) | ${priceToken} | ${condition}; ${svcList} |`,
      );
    } else {
      const proseTemplates = [
        `For Lane #${lane.laneId} (${lane.laneCode} via ${routeStr}, ${lane.transitDays}d, ${lane.tons}t), we can offer ${priceToken} covering ${svcList} — ${condition}.`,
        `Lane #${lane.laneId} ${lane.origin} to ${lane.destination}: quoted at ${priceToken} (${condition}; services: ${svcList}).`,
        `On ${lane.laneCode} (Lane #${lane.laneId}, routing ${routeStr}), rate comes in at ${priceToken} including ${svcList}, ${condition}.`,
      ];
      proseParagraphs.push(
        proseTemplates[(idx + variant) % proseTemplates.length]!,
      );
    }
  });

  const sections: string[] = [
    "Hi RFP Response Team,",
    "",
    `Thanks for sending over the routing specs${options.rfpTitle ? ` for "${options.rfpTitle}"` : ""}. Here is our desk pricing breakdown across the requested sectors:`,
  ];

  if (tableRows.length > 0) {
    sections.push(
      "",
      "| Lane ID | Lane | Routing | Recommended Rate | Conditions & Scope |",
      "| :--- | :--- | :--- | :--- | :--- |",
      ...tableRows,
    );
  }

  if (proseParagraphs.length > 0) {
    sections.push("", "Additional sector quotes (prose notes):", ...proseParagraphs);
  }

  if (exceptionNotes.length > 0) {
    sections.push("", "Open items requiring follow-up:", ...exceptionNotes);
  }

  const signature = ANALYST_SIGNATURES[variant % ANALYST_SIGNATURES.length]!;
  sections.push("", "Best regards,", signature);

  let body = sections.join("\n");
  const subject = `Re: Air Freight Pricing Request${options.rfpTitle ? ` — ${options.rfpTitle}` : ""} (${lanes.length} lanes)`;

  if (options.llm && options.llm.provider !== "offline") {
    const rewriteResult = await options.llm.generateStructured({
      agentName: "MockPricingTeam",
      operation: "polish_mock_pricing_reply",
      schema: LlmRewriteSchema,
      system:
        "You are an air cargo pricing analyst replying to an internal RFP pricing request. " +
        "Rewrite the email body slightly for realistic conversational flow while preserving EVERY lane code, lane ID, exact price string (including currency and unit), and any missing/ambiguous remarks verbatim.",
      prompt: `Draft reply to polish:\n\n${body}`,
      offlineHandler: () => ({ body }),
    });

    if (
      rewriteResult.ok &&
      cleanQuotedTokens.every((token) => rewriteResult.data.body.includes(token)) &&
      lanes.every((l) => rewriteResult.data.body.includes(l.laneCode))
    ) {
      body = rewriteResult.data.body;
    }
  }

  return {
    subject,
    body,
    _evalOnlyGroundTruth: {
      truePricesByLaneCode,
      formatByLaneCode,
      missingLaneCodes,
      ambiguousLaneCodes,
      outOfRangeLaneCodes,
      expectedCleanLaneCodes,
    },
  };
}

export async function generateMockPricingClarificationReply(params: {
  lanes: readonly PricingQuoteLaneInput[];
  styleVariant?: number;
  llm?: LlmClient;
}): Promise<MockPricingReplyResult> {
  return generateMockPricingReply({
    lanes: params.lanes,
    rfpTitle: "Clarification Follow-Up",
    missingLaneIndex: null,
    ambiguousLaneIndex: null,
    outOfRangeLaneIndex: null,
    styleVariant: (params.styleVariant ?? 0) + 1,
    llm: params.llm,
  });
}
