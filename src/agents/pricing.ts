import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  agentEvents,
  emails as emailsTable,
  humanTasks,
  pricingResponses,
  type AppDatabase,
} from "../db";
import { SERVICE_DISPLAY_LABELS, SERVICE_TYPES, type ServiceType } from "../domain";
import type { LlmClient } from "../llm";
import {
  generateMockPricingClarificationReply,
  type PricingQuoteLaneInput,
} from "../pricing";

export const MIN_SANE_PRICE_PER_TON_USD = 500;
export const MAX_SANE_PRICE_PER_TON_USD = 15_000;
export const PRICING_CONFIDENCE_THRESHOLD = 0.85;

export type PricingIssueType =
  | "MISSING_PRICE"
  | "AMBIGUOUS_PRICE"
  | "OUT_OF_RANGE_PRICE"
  | "UNGROUNDED_QUOTE"
  | "LLM_ERROR";

export type PricingUnit = "PER_TON" | "PER_KG" | "UNKNOWN";

export const PricingParseLaneSchema = z.object({
  laneCode: z.string().min(3),
  pricePerTonUsd: z.number().nullable(),
  rawAmount: z.number().nullable(),
  unit: z.enum(["PER_TON", "PER_KG", "UNKNOWN"]),
  evidenceQuote: z.string().nullable(),
  conditions: z.string(),
  isAmbiguous: z.boolean(),
  confidence: z.number().min(0).max(1),
  notes: z.string(),
});

export const PricingReplyParseSchema = z.object({
  lanes: z.array(PricingParseLaneSchema),
  overallNotes: z.string(),
});

export type PricingReplyParseOutput = z.infer<typeof PricingReplyParseSchema>;

export interface ParsedLanePriceResult {
  lane: PricingQuoteLaneInput;
  status: "VALIDATED" | "FLAGGED";
  pricePerTonUsd: number | null;
  unitDetected: PricingUnit;
  evidenceQuote: string | null;
  conditions: string;
  confidence: number;
  issueType: PricingIssueType | null;
  issueReason: string | null;
  candidatePricesPerTonUsd: number[];
  humanTaskId?: number;
  humanTaskTitle?: string;
}

export interface CreatePricingRequestEmailOptions {
  lanes: readonly PricingQuoteLaneInput[];
  rfpId?: number | null;
  rfpTitle?: string;
  db?: AppDatabase;
  sender?: string;
  recipient?: string;
}

export interface CreatedPricingRequestEmail {
  emailId: number | null;
  direction: "outbound";
  counterparty: "pricing";
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  laneCount: number;
}

export interface ParsePricingReplyOptions {
  emailBody: string;
  requestedLanes: readonly PricingQuoteLaneInput[];
  llm?: LlmClient;
  db?: AppDatabase;
  rfpId?: number | null;
  inboundEmailId?: number | null;
  persistInboundEmail?: {
    subject?: string;
    sender?: string;
    recipient?: string;
  };
}

export interface ParsePricingReplyResult {
  inboundEmailId: number | null;
  validated: ParsedLanePriceResult[];
  flagged: ParsedLanePriceResult[];
  allLanes: ParsedLanePriceResult[];
  humanTasksCreated: Array<{
    id?: number;
    laneCode: string;
    title: string;
    reason: string;
    issueType: PricingIssueType;
  }>;
}

export interface ClarificationRoundTripOptions {
  db?: AppDatabase;
  rfpId?: number | null;
  llm?: LlmClient;
  flaggedLanes: readonly ParsedLanePriceResult[];
  styleVariant?: number;
  sender?: string;
  recipient?: string;
}

export interface ClarificationRoundTripResult {
  outboundClarificationEmail: {
    emailId: number | null;
    subject: string;
    body: string;
  };
  inboundClarificationEmail: {
    emailId: number | null;
    subject: string;
    body: string;
  };
  parsedClarification: ParsePricingReplyResult;
  resolvedTaskIds: number[];
}

interface DeterministicLaneScan {
  lane: PricingQuoteLaneInput;
  matchedLines: string[];
  candidatePricesPerTonUsd: number[];
  rawAmounts: Array<{ rawAmount: number; unit: PricingUnit; normalizedPerTon: number; quote: string }>;
  unitDetected: PricingUnit;
  evidenceQuote: string | null;
  conditions: string;
  hasAmbiguityCue: boolean;
  confidence: number;
}

const PREFIX_RATE_RE =
  /(?:USD\s*|\$\s*)(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:\/|\s+per\s+)(metric\s+ton|tonne|ton|t|kg|kilogram)\b/gi;

const BARE_RATE_RE =
  /(?<![\d.,])\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:USD\s*)?(?:\/|\s+per\s+)(metric\s+ton|tonne|ton|t|kg|kilogram)\b/gi;

const AMBIGUITY_CUE_RE =
  /\b(?:between|or\s+(?:\$|usd|\d)|pending|awaiting|no rate|not released|tbd|clarify|conflicting|estimates?|depending on)\b/i;

const CONDITION_SNIPPET_PATTERNS: readonly RegExp[] = [
  /subject to [^|.\n;]+/i,
  /fuel\s*&\s*security surcharge included/i,
  /valid \d+ days(?:,\s*subject to [^|.\n;]+)?/i,
  /main-deck allocation required(?:;\s*subject to [^|.\n;]+)?/i,
  /all-in airport-to-airport(?:,\s*subject to [^|.\n;]+)?/i,
];

const PRICING_PARSE_SYSTEM_PROMPT = `You are a commercial air freight pricing analyst extracting quoted rates per metric ton (USD) from an unstructured Pricing Team reply email.

Instructions:
- Extract an entry for EVERY requested lane code.
- If a quote is given per kg (e.g. "$2.45 per kg" or "2.45 per kg"), set unit="PER_KG", rawAmount=2.45, and convert pricePerTonUsd = rawAmount * 1000 (1 metric ton = 1,000 kg).
- If a quote is given per ton (e.g. "USD 2,450/t" or "$2,450 per ton"), set unit="PER_TON", rawAmount=2450, and pricePerTonUsd=2450.
- Copy evidenceQuote verbatim as a substring from the email.
- If a lane is missing a firm price, gives conflicting/range estimates (e.g. "between 2,200 and 2,750"), or states "pending/awaiting", set pricePerTonUsd=null, isAmbiguous=true, and confidence < 0.50. Never invent or average rates.`;

function sortServicesCanonical(services: Iterable<ServiceType>): ServiceType[] {
  const set = new Set(services);
  return SERVICE_TYPES.filter((s) => set.has(s));
}

function normalizeWhitespace(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatServicesList(services: readonly ServiceType[]): string {
  const ordered = sortServicesCanonical(services);
  if (ordered.length === 0) {
    return "Standard general cargo (none)";
  }
  return ordered.map((s) => `${s} (${SERVICE_DISPLAY_LABELS[s]})`).join(", ");
}

export async function createPricingRequestEmail(
  options: CreatePricingRequestEmailOptions,
): Promise<CreatedPricingRequestEmail> {
  const sender = options.sender ?? "rfp-response-team@carrier.example";
  const recipient = options.recipient ?? "pricing-desk@carrier.example";
  const subject = `Pricing Request${options.rfpTitle ? `: ${options.rfpTitle}` : ""} (${options.lanes.length} lanes)`;

  const headerRows = [
    "| Lane ID | Origin | Dest | Tons | Route (Airports) | Transit Days | Requested Services | Fulfillable Services |",
    "| :--- | :--- | :--- | ---: | :--- | ---: | :--- | :--- |",
  ];

  const detailBullets: string[] = [];
  for (const lane of options.lanes) {
    const routeStr = lane.routeAirports.join(" -> ");
    const reqStr = formatServicesList(lane.requestedServices);
    const fulfStr = formatServicesList(lane.fulfillableServices);
    const fulfSet = new Set(lane.fulfillableServices);
    const missing = lane.requestedServices.filter((s) => !fulfSet.has(s));
    const missingNote =
      missing.length > 0 ? ` | Unfulfilled: ${missing.join(", ")}` : "";

    headerRows.push(
      `| #${lane.laneId} (${lane.laneCode}) | ${lane.origin} | ${lane.destination} | ${lane.tons.toFixed(1)}t | ${routeStr} | ${lane.transitDays}d | ${reqStr} | ${fulfStr} |`,
    );
    detailBullets.push(
      `- Lane #${lane.laneId} (${lane.laneCode}): ${lane.origin} -> ${lane.destination}, ${lane.tons.toFixed(1)} tons, Route: ${routeStr} (${lane.transitDays} days). Requested: ${reqStr}. Fulfillable: ${fulfStr}${missingNote}.`,
    );
  }

  const body = [
    "Hi Pricing Team,",
    "",
    `Please provide your recommended USD rate per metric ton (including applicable special handling surcharges and capacity/validity notes) for the ${options.lanes.length} lane(s) below:`,
    "",
    ...headerRows,
    "",
    "Lane breakdown:",
    ...detailBullets,
    "",
    "Thank you,",
    "RFP Response Team",
  ].join("\n");

  const now = new Date().toISOString();
  let emailId: number | null = null;

  if (options.db && options.rfpId) {
    const [inserted] = await options.db
      .insert(emailsTable)
      .values({
        rfpId: options.rfpId,
        threadType: "PRICING",
        direction: "outbound",
        counterparty: "pricing",
        sender,
        recipient,
        subject,
        body,
        parsedPayloadJson: JSON.stringify({
          requestedLaneIds: options.lanes.map((l) => l.laneId),
          requestedLaneCodes: options.lanes.map((l) => l.laneCode),
        }),
        status: "SENT",
        createdAt: now,
      })
      .returning({ id: emailsTable.id });
    emailId = inserted?.id ?? null;

    await options.db.insert(agentEvents).values({
      rfpId: options.rfpId,
      laneId: null,
      agentName: "PricingAgent",
      eventType: "PRICING_REQUEST_SENT",
      provider: "deterministic",
      model: "template-v1",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      retryCount: 0,
      status: "SUCCESS",
      summary: `Sent pricing request email for ${options.lanes.length} lanes`,
      payloadJson: JSON.stringify({
        emailId,
        direction: "outbound",
        counterparty: "pricing",
        laneCodes: options.lanes.map((l) => l.laneCode),
      }),
      createdAt: now,
    });
  }

  return {
    emailId,
    direction: "outbound",
    counterparty: "pricing",
    sender,
    recipient,
    subject,
    body,
    laneCount: options.lanes.length,
  };
}

function lineMatchesLane(line: string, lane: PricingQuoteLaneInput): boolean {
  const codeRe = new RegExp(`\\b${lane.origin}\\s*-\\s*${lane.destination}\\b`, "i");
  const toRe = new RegExp(`\\b${lane.origin}\\s+to\\s+${lane.destination}\\b`, "i");
  const idRe = new RegExp(`(?:Lane\\s*)?#${lane.laneId}\\b`, "i");
  return codeRe.test(line) || toRe.test(line) || idRe.test(line);
}

function extractRatesFromSegment(
  segment: string,
): Array<{ rawAmount: number; unit: PricingUnit; normalizedPerTon: number; quote: string }> {
  const spans: Array<{
    start: number;
    end: number;
    rawAmount: number;
    unit: PricingUnit;
    normalizedPerTon: number;
    quote: string;
  }> = [];

  const collect = (regex: RegExp) => {
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (spans.some((s) => !(end <= s.start || start >= s.end))) {
        continue;
      }
      const numericText = m[1]!.replace(/,/g, "");
      const rawAmount = Number.parseFloat(numericText);
      if (!Number.isFinite(rawAmount)) {
        continue;
      }
      const unitToken = (m[2] ?? "").trim().toLowerCase();
      const unit: PricingUnit = unitToken.startsWith("kg") || unitToken.startsWith("kilogram")
        ? "PER_KG"
        : "PER_TON";
      const normalizedPerTon =
        unit === "PER_KG"
          ? Math.round(rawAmount * 1000 * 100) / 100
          : Math.round(rawAmount * 100) / 100;
      spans.push({
        start,
        end,
        rawAmount,
        unit,
        normalizedPerTon,
        quote: m[0],
      });
    }
  };

  collect(PREFIX_RATE_RE);
  collect(BARE_RATE_RE);
  spans.sort((a, b) => a.start - b.start);

  return spans.map(({ rawAmount, unit, normalizedPerTon, quote }) => ({
    rawAmount,
    unit,
    normalizedPerTon,
    quote,
  }));
}

function extractConditionsFromSegment(segment: string): string {
  const found: string[] = [];
  for (const pat of CONDITION_SNIPPET_PATTERNS) {
    const m = pat.exec(segment);
    if (m) {
      const candidate = m[0].trim().replace(/[.)]+$/, "");
      if (
        !found.some((existing) =>
          existing.toLowerCase().includes(candidate.toLowerCase()),
        )
      ) {
        found.push(candidate);
      }
    }
  }
  if (found.length > 0) {
    return found.join("; ");
  }
  if (segment.includes("|")) {
    const cols = segment
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const lastCol = cols[cols.length - 1];
    if (lastCol && !lastCol.includes("Conditions")) {
      return lastCol;
    }
  }
  return "";
}

function scanPricingReplyDeterministic(
  emailBody: string,
  requestedLanes: readonly PricingQuoteLaneInput[],
): DeterministicLaneScan[] {
  const lines = emailBody.split(/\r?\n/);

  return requestedLanes.map((lane) => {
    const matchedLines = lines.filter((line) => lineMatchesLane(line, lane));
    const joined = matchedLines.join("\n");
    const rawAmounts = joined ? extractRatesFromSegment(joined) : [];
    const candidatePricesPerTonUsd = [
      ...new Set(rawAmounts.map((r) => r.normalizedPerTon)),
    ];
    const hasAmbiguityCue = joined ? AMBIGUITY_CUE_RE.test(joined) : false;
    const conditions = joined ? extractConditionsFromSegment(joined) : "";
    const evidenceQuote =
      matchedLines.length > 0
        ? matchedLines[0]!.trim()
        : rawAmounts[0]?.quote ?? null;
    const unitDetected: PricingUnit = rawAmounts[0]?.unit ?? "UNKNOWN";

    let confidence = 0.96;
    if (candidatePricesPerTonUsd.length === 0) {
      confidence = 0.1;
    } else if (candidatePricesPerTonUsd.length > 1 || hasAmbiguityCue) {
      confidence = 0.4;
    }

    return {
      lane,
      matchedLines,
      candidatePricesPerTonUsd,
      rawAmounts,
      unitDetected,
      evidenceQuote,
      conditions,
      hasAmbiguityCue,
      confidence,
    };
  });
}

function buildParsePrompt(
  emailBody: string,
  requestedLanes: readonly PricingQuoteLaneInput[],
): string {
  const laneList = requestedLanes
    .map(
      (l) =>
        `- #${l.laneId} ${l.laneCode} (${l.routeAirports.join(" -> ")}, ${l.transitDays}d, ${l.tons}t)`,
    )
    .join("\n");
  return [
    "Requested Lanes:",
    laneList,
    "",
    "Pricing Team Email Body:",
    '"""',
    emailBody,
    '"""',
  ].join("\n");
}

function isQuoteGrounded(emailBody: string, quote: string | null): boolean {
  if (!quote || !quote.trim()) {
    return false;
  }
  return normalizeWhitespace(emailBody).includes(normalizeWhitespace(quote));
}

export async function parsePricingReply(
  options: ParsePricingReplyOptions,
): Promise<ParsePricingReplyResult> {
  const scans = scanPricingReplyDeterministic(
    options.emailBody,
    options.requestedLanes,
  );
  const scanByCode = new Map(scans.map((s) => [s.lane.laneCode, s]));

  let inboundEmailId = options.inboundEmailId ?? null;
  const now = new Date().toISOString();

  if (options.db && options.rfpId && inboundEmailId === null && options.persistInboundEmail) {
    const [insertedEmail] = await options.db
      .insert(emailsTable)
      .values({
        rfpId: options.rfpId,
        threadType: "PRICING",
        direction: "inbound",
        counterparty: "pricing",
        sender: options.persistInboundEmail.sender ?? "pricing-desk@carrier.example",
        recipient:
          options.persistInboundEmail.recipient ??
          "rfp-response-team@carrier.example",
        subject:
          options.persistInboundEmail.subject ?? "Re: Air Freight Pricing Request",
        body: options.emailBody,
        parsedPayloadJson: null,
        status: "RECEIVED",
        createdAt: now,
      })
      .returning({ id: emailsTable.id });
    inboundEmailId = insertedEmail?.id ?? null;
  }

  let llmData: PricingReplyParseOutput | null = null;
  let llmErrorReason: string | null = null;

  if (options.llm) {
    const llmCall = await options.llm.generateStructured({
      agentName: "PricingAgent",
      operation: `parse_pricing_reply_${options.requestedLanes.length}_lanes`,
      schema: PricingReplyParseSchema,
      system: PRICING_PARSE_SYSTEM_PROMPT,
      prompt: buildParsePrompt(options.emailBody, options.requestedLanes),
      rfpId: options.rfpId ?? null,
      offlineHandler: () => ({
        lanes: scans.map((scan) => {
          const singlePrice =
            scan.candidatePricesPerTonUsd.length === 1 && !scan.hasAmbiguityCue
              ? scan.candidatePricesPerTonUsd[0]!
              : null;
          return {
            laneCode: scan.lane.laneCode,
            pricePerTonUsd: singlePrice,
            rawAmount:
              singlePrice !== null && scan.rawAmounts[0]
                ? scan.rawAmounts[0].rawAmount
                : null,
            unit: scan.unitDetected,
            evidenceQuote: scan.evidenceQuote,
            conditions: scan.conditions,
            isAmbiguous:
              scan.candidatePricesPerTonUsd.length > 1 || scan.hasAmbiguityCue,
            confidence: scan.confidence,
            notes:
              scan.candidatePricesPerTonUsd.length === 0
                ? "No rate figure present in reply."
                : scan.candidatePricesPerTonUsd.length > 1 || scan.hasAmbiguityCue
                  ? `Multiple or conditional estimates found: ${scan.candidatePricesPerTonUsd.join(", ")}`
                  : "Clean single rate extracted.",
          };
        }),
        overallNotes: "Deterministic pricing reply scan completed.",
      }),
    });

    if (llmCall.ok) {
      llmData = llmCall.data;
    } else {
      llmErrorReason = `LLM pricing parser failed (${llmCall.errorKind}: ${llmCall.errorMessage}).`;
    }
  }

  const llmLaneByCode = new Map(
    (llmData?.lanes ?? []).map((item) => [item.laneCode.trim().toUpperCase(), item]),
  );

  const allLanes: ParsedLanePriceResult[] = [];
  const validated: ParsedLanePriceResult[] = [];
  const flagged: ParsedLanePriceResult[] = [];
  const humanTasksCreated: ParsePricingReplyResult["humanTasksCreated"] = [];

  for (const lane of options.requestedLanes) {
    const scan = scanByCode.get(lane.laneCode)!;
    const llmItem = llmLaneByCode.get(lane.laneCode.toUpperCase()) ?? null;

    let issueType: PricingIssueType | null = null;
    let issueReason: string | null = null;
    let finalPrice: number | null = null;
    const evidenceQuote =
      llmItem?.evidenceQuote && isQuoteGrounded(options.emailBody, llmItem.evidenceQuote)
        ? llmItem.evidenceQuote
        : scan.evidenceQuote;
    const conditions = scan.conditions || llmItem?.conditions || "";
    let confidence = scan.confidence;

    if (llmErrorReason) {
      issueType = "LLM_ERROR";
      issueReason = llmErrorReason;
      confidence = 0.2;
    } else if (scan.candidatePricesPerTonUsd.length === 0 && (llmItem?.pricePerTonUsd ?? null) === null) {
      issueType = "MISSING_PRICE";
      issueReason = `No quoted price found in Pricing Team reply for lane ${lane.laneCode}.`;
      confidence = 0.1;
    } else if (
      scan.candidatePricesPerTonUsd.length > 1 ||
      scan.hasAmbiguityCue ||
      llmItem?.isAmbiguous
    ) {
      issueType = "AMBIGUOUS_PRICE";
      const candidates =
        scan.candidatePricesPerTonUsd.length > 0
          ? scan.candidatePricesPerTonUsd.map((p) => `$${p}/t`).join(" vs ")
          : String(llmItem?.pricePerTonUsd ?? "unclear");
      issueReason = `Ambiguous or conditional pricing for lane ${lane.laneCode} (${candidates}).`;
      confidence = Math.min(scan.confidence, llmItem?.confidence ?? 0.4);
    } else {
      const rulePrice = scan.candidatePricesPerTonUsd[0] ?? null;
      const llmPrice = llmItem?.pricePerTonUsd ?? rulePrice;

      if (rulePrice === null || llmPrice === null) {
        issueType = "MISSING_PRICE";
        issueReason = `Missing extracted price for lane ${lane.laneCode} (LLM=${llmPrice}, Rule=${rulePrice}).`;
        confidence = 0.2;
      } else if (Math.abs(rulePrice - llmPrice) > 1) {
        issueType = "AMBIGUOUS_PRICE";
        issueReason = `LLM extracted $${llmPrice}/t while deterministic parser extracted $${rulePrice}/t for lane ${lane.laneCode}.`;
        confidence = 0.35;
      } else if (
        !Number.isFinite(rulePrice) ||
        rulePrice <= 0 ||
        rulePrice < MIN_SANE_PRICE_PER_TON_USD ||
        rulePrice > MAX_SANE_PRICE_PER_TON_USD
      ) {
        issueType = "OUT_OF_RANGE_PRICE";
        issueReason = `Extracted rate $${rulePrice}/t for lane ${lane.laneCode} is outside sane bounds [$${MIN_SANE_PRICE_PER_TON_USD}, $${MAX_SANE_PRICE_PER_TON_USD}]/ton.`;
        confidence = 0.25;
      } else if (!isQuoteGrounded(options.emailBody, evidenceQuote)) {
        issueType = "UNGROUNDED_QUOTE";
        issueReason = `Evidence quote for lane ${lane.laneCode} could not be grounded verbatim in email body.`;
        confidence = 0.3;
      } else if ((llmItem?.confidence ?? 1) < PRICING_CONFIDENCE_THRESHOLD) {
        issueType = "AMBIGUOUS_PRICE";
        issueReason = `Low parser confidence (${(llmItem?.confidence ?? 0).toFixed(2)}) for lane ${lane.laneCode}.`;
        confidence = llmItem?.confidence ?? 0.5;
      } else {
        finalPrice = rulePrice;
        confidence = Number(
          Math.min(scan.confidence, llmItem?.confidence ?? scan.confidence).toFixed(2),
        );
      }
    }

    if (issueType === null && finalPrice !== null) {
      const item: ParsedLanePriceResult = {
        lane,
        status: "VALIDATED",
        pricePerTonUsd: finalPrice,
        unitDetected: scan.unitDetected,
        evidenceQuote,
        conditions,
        confidence,
        issueType: null,
        issueReason: null,
        candidatePricesPerTonUsd: scan.candidatePricesPerTonUsd,
      };
      allLanes.push(item);
      validated.push(item);

      if (options.db && options.rfpId) {
        await options.db.insert(pricingResponses).values({
          rfpId: options.rfpId,
          laneId: lane.laneId,
          emailId: inboundEmailId,
          recommendedPricePerTonUsd: finalPrice,
          approvedPricePerTonUsd: null,
          includedServicesJson: JSON.stringify(
            sortServicesCanonical(lane.fulfillableServices),
          ),
          notes: conditions,
          confidence,
          status: "VALIDATED",
          createdAt: now,
        });
      }
    } else {
      const resolvedIssueType = issueType ?? "AMBIGUOUS_PRICE";
      const resolvedReason =
        issueReason ?? `Pricing could not be validated for lane ${lane.laneCode}.`;
      const taskTitle = `Pricing unclear for lane ${lane.laneCode}: ask Pricing to clarify or enter manually`;

      let taskId: number | undefined;
      if (options.db) {
        const [insertedTask] = await options.db
          .insert(humanTasks)
          .values({
            rfpId: options.rfpId ?? null,
            laneId: lane.laneId,
            laneCode: lane.laneCode,
            taskType: "CLARIFY_PRICING",
            title: taskTitle,
            reason: resolvedReason,
            payloadJson: JSON.stringify({
              laneId: lane.laneId,
              laneCode: lane.laneCode,
              issueType: resolvedIssueType,
              candidatePricesPerTonUsd: scan.candidatePricesPerTonUsd,
              evidenceQuote,
              conditions,
              llmReading: llmItem,
              ruleReading: {
                candidatePricesPerTonUsd: scan.candidatePricesPerTonUsd,
                unitDetected: scan.unitDetected,
                hasAmbiguityCue: scan.hasAmbiguityCue,
              },
              actions: ["SEND_CLARIFICATION_EMAIL", "ENTER_MANUALLY"],
            }),
            status: "OPEN",
            createdAt: now,
          })
          .returning({ id: humanTasks.id });
        taskId = insertedTask?.id;
      }

      const item: ParsedLanePriceResult = {
        lane,
        status: "FLAGGED",
        pricePerTonUsd: null,
        unitDetected: scan.unitDetected,
        evidenceQuote,
        conditions,
        confidence,
        issueType: resolvedIssueType,
        issueReason: resolvedReason,
        candidatePricesPerTonUsd: scan.candidatePricesPerTonUsd,
        humanTaskId: taskId,
        humanTaskTitle: taskTitle,
      };
      allLanes.push(item);
      flagged.push(item);
      humanTasksCreated.push({
        id: taskId,
        laneCode: lane.laneCode,
        title: taskTitle,
        reason: resolvedReason,
        issueType: resolvedIssueType,
      });
    }
  }

  if (options.db && inboundEmailId !== null) {
    await options.db
      .update(emailsTable)
      .set({
        parsedPayloadJson: JSON.stringify({
          validatedCount: validated.length,
          flaggedCount: flagged.length,
          validated: validated.map((v) => ({
            laneCode: v.lane.laneCode,
            pricePerTonUsd: v.pricePerTonUsd,
            unitDetected: v.unitDetected,
            conditions: v.conditions,
          })),
          flagged: flagged.map((f) => ({
            laneCode: f.lane.laneCode,
            issueType: f.issueType,
            issueReason: f.issueReason,
          })),
        }),
        status: flagged.length > 0 ? "NEEDS_CLARIFICATION" : "PARSED",
      })
      .where(eq(emailsTable.id, inboundEmailId));
  }

  if (options.db) {
    await options.db.insert(agentEvents).values({
      rfpId: options.rfpId ?? null,
      laneId: null,
      agentName: "PricingAgent",
      eventType: "PRICING_REPLY_PARSED",
      provider: options.llm?.provider ?? "offline",
      model: options.llm?.model ?? "deterministic-scanner-v1",
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      retryCount: 0,
      status: flagged.length > 0 ? "NEEDS_REVIEW" : "SUCCESS",
      summary: `Parsed pricing reply: ${validated.length} validated, ${flagged.length} flagged as human_tasks`,
      payloadJson: JSON.stringify({
        inboundEmailId,
        validatedLaneCodes: validated.map((v) => v.lane.laneCode),
        flaggedLaneCodes: flagged.map((f) => f.lane.laneCode),
      }),
      createdAt: now,
    });
  }

  return {
    inboundEmailId,
    validated,
    flagged,
    allLanes,
    humanTasksCreated,
  };
}

export async function sendPricingClarificationAndResolve(
  options: ClarificationRoundTripOptions,
): Promise<ClarificationRoundTripResult> {
  const sender = options.sender ?? "rfp-response-team@carrier.example";
  const recipient = options.recipient ?? "pricing-desk@carrier.example";
  const now = new Date().toISOString();

  const laneQuestions = options.flaggedLanes.map(
    (item) =>
      `- Lane #${item.lane.laneId} (${item.lane.laneCode}, ${item.lane.routeAirports.join(" -> ")}, ${item.lane.transitDays}d, ${item.lane.tons}t): ${item.issueReason ?? "Please provide one firm USD rate per metric ton."}`,
  );
  const outboundSubject = `Clarification Needed: Pricing for ${options.flaggedLanes.map((f) => f.lane.laneCode).join(", ")}`;
  const outboundBody = [
    "Hi Pricing Team,",
    "",
    "Thanks for the initial pricing sheet. Before we build our shipper proposal, could you confirm one firm USD rate per metric ton for the lane(s) flagged below?",
    "",
    ...laneQuestions,
    "",
    "Please reply with a single binding rate per ton and any applicable conditions.",
    "",
    "Thanks,",
    "RFP Response Team",
  ].join("\n");

  let outboundEmailId: number | null = null;
  if (options.db && options.rfpId) {
    const [outRow] = await options.db
      .insert(emailsTable)
      .values({
        rfpId: options.rfpId,
        threadType: "PRICING_CLARIFICATION",
        direction: "outbound",
        counterparty: "pricing",
        sender,
        recipient,
        subject: outboundSubject,
        body: outboundBody,
        parsedPayloadJson: JSON.stringify({
          clarifiedLaneCodes: options.flaggedLanes.map((f) => f.lane.laneCode),
        }),
        status: "SENT",
        createdAt: now,
      })
      .returning({ id: emailsTable.id });
    outboundEmailId = outRow?.id ?? null;
  }

  const clarificationLanes = options.flaggedLanes.map((f) => f.lane);
  const mockClarification = await generateMockPricingClarificationReply({
    lanes: clarificationLanes,
    styleVariant: options.styleVariant ?? 0,
    llm: options.llm,
  });

  let inboundEmailId: number | null = null;
  if (options.db && options.rfpId) {
    const [inRow] = await options.db
      .insert(emailsTable)
      .values({
        rfpId: options.rfpId,
        threadType: "PRICING_CLARIFICATION",
        direction: "inbound",
        counterparty: "pricing",
        sender: recipient,
        recipient: sender,
        subject: mockClarification.subject,
        body: mockClarification.body,
        parsedPayloadJson: null,
        status: "RECEIVED",
        createdAt: now,
      })
      .returning({ id: emailsTable.id });
    inboundEmailId = inRow?.id ?? null;
  }

  const parsedClarification = await parsePricingReply({
    emailBody: mockClarification.body,
    requestedLanes: clarificationLanes,
    llm: options.llm,
    db: options.db,
    rfpId: options.rfpId ?? null,
    inboundEmailId,
  });

  const resolvedTaskIds: number[] = [];
  if (options.db) {
    const validatedCodes = new Set(
      parsedClarification.validated.map((v) => v.lane.laneCode),
    );
    const taskIdsToResolve = options.flaggedLanes
      .filter((f) => f.humanTaskId !== undefined && validatedCodes.has(f.lane.laneCode))
      .map((f) => f.humanTaskId!);

    if (taskIdsToResolve.length > 0) {
      await options.db
        .update(humanTasks)
        .set({
          status: "RESOLVED",
          resolvedAt: new Date().toISOString(),
          resolutionJson: JSON.stringify({
            resolvedVia: "PRICING_CLARIFICATION_EMAIL",
            outboundEmailId,
            inboundEmailId,
            validatedPrices: parsedClarification.validated.map((v) => ({
              laneCode: v.lane.laneCode,
              pricePerTonUsd: v.pricePerTonUsd,
              conditions: v.conditions,
            })),
          }),
        })
        .where(
          and(
            inArray(humanTasks.id, taskIdsToResolve),
            eq(humanTasks.taskType, "CLARIFY_PRICING"),
          ),
        );
      resolvedTaskIds.push(...taskIdsToResolve);
    }
  }

  return {
    outboundClarificationEmail: {
      emailId: outboundEmailId,
      subject: outboundSubject,
      body: outboundBody,
    },
    inboundClarificationEmail: {
      emailId: inboundEmailId,
      subject: mockClarification.subject,
      body: mockClarification.body,
    },
    parsedClarification,
    resolvedTaskIds,
  };
}
