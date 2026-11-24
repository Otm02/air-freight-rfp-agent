import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  agentEvents,
  emails as emailsTable,
  humanTasks,
  proposalLanes,
  proposals,
  rfps,
  type AppDatabase,
} from "../db";
import {
  SERVICE_DISPLAY_LABELS,
  SERVICE_TYPES,
  type LaneAssessment,
  type LegServiceGap,
  type Route,
  type ServiceType,
} from "../domain";
import {
  createNodeSmtpTransport,
  readSmtpConfig,
  type SmtpSendResult,
  type SmtpTransport,
} from "../lib/email/smtp";
import type { LlmClient } from "../llm";

export const QuoteProseSchema = z.object({
  greeting: z.string().min(3),
  summary: z.string().min(10),
  closing: z.string().min(3),
});

export type QuoteProse = z.infer<typeof QuoteProseSchema>;

export type QuoteLaneDisposition =
  | "QUOTE_COMPLIANT"
  | "QUOTE_COMPLIANT_LATE"
  | "QUOTE_PARTIAL_ON_TIME"
  | "DECLINE";

export type ApprovalGateErrorCode =
  | "PROPOSAL_NOT_FOUND"
  | "OPEN_HUMAN_TASKS"
  | "NOT_APPROVED"
  | "MISSING_APPROVAL_METADATA"
  | "ALREADY_SENT";

export interface BlockingHumanTaskSummary {
  id: number;
  laneCode: string | null;
  taskType: string;
  title: string;
  reason: string;
}

export class ApprovalGateError extends Error {
  readonly code: ApprovalGateErrorCode;
  readonly openTasks: BlockingHumanTaskSummary[];

  constructor(
    code: ApprovalGateErrorCode,
    message: string,
    openTasks: BlockingHumanTaskSummary[] = [],
  ) {
    super(message);
    this.name = "ApprovalGateError";
    this.code = code;
    this.openTasks = openTasks;
  }
}

export interface QuoteLaneInput {
  laneId: number;
  assessment: LaneAssessment;
  pricePerTonUsd?: number | null;
  disposition?: QuoteLaneDisposition;
  selectedRoute?: Route | null;
  decisionNote?: string;
}

export interface RenderedQuoteLane {
  laneId: number;
  laneNumber: number;
  laneCode: string;
  origin: string;
  destination: string;
  tons: number;
  maxTransitDays: number;
  disposition: QuoteLaneDisposition;
  routeAirports: string[];
  routeText: string;
  transitDays: number | null;
  transitVsMaxText: string;
  requestedServices: ServiceType[];
  fulfilledServices: ServiceType[];
  missingServices: ServiceType[];
  serviceCoverage: LegServiceGap[];
  servicesText: string;
  pricePerTonUsd: number | null;
  lineTotalUsd: number | null;
  pricePerTonText: string;
  lineTotalText: string;
  decisionNote: string;
}

export interface DraftQuoteOptions {
  db: AppDatabase;
  rfpId: number;
  customerName: string;
  customerEmail: string;
  rfpTitle: string;
  lanes: readonly QuoteLaneInput[];
  llm: LlmClient;
  senderEmail?: string;
  rfpTeamSignature?: string;
}

export interface DraftQuoteResult {
  proposalId: number;
  version: number;
  quoteEmailId: number;
  subject: string;
  markdownBody: string;
  plainTextBody: string;
  prose: QuoteProse;
  renderedLanes: RenderedQuoteLane[];
  totalQuotedLanes: number;
  totalDeclinedLanes: number;
  totalTons: number;
  totalValueUsd: number;
  status: "DRAFT";
}

export interface ApproveQuoteOptions {
  db: AppDatabase;
  proposalId: number;
  approvedBy: string;
  acceptOpenTaskIds?: readonly number[];
  exceptionNote?: string;
}

export interface ApproveQuoteResult {
  proposalId: number;
  quoteEmailId: number | null;
  status: "APPROVED";
  approvedBy: string;
  approvedAt: string;
  acceptedExceptionTaskIds: number[];
}

export interface SendQuoteOptions {
  db: AppDatabase;
  proposalId: number;
  smtpTransport?: SmtpTransport;
  smtpEnv?: Record<string, string | undefined>;
}

export interface SendQuoteResult {
  proposalId: number;
  quoteEmailId: number;
  status: "SENT";
  deliveryChannel: "IN_APP_OUTBOX" | "SMTP";
  sentAt: string;
  recipient: string;
  subject: string;
  smtpResult?: SmtpSendResult;
}

const QUOTE_PROSE_SYSTEM_PROMPT = `You are a commercial air freight RFP proposal writer composing ONLY the qualitative framing of an outgoing customer quote email.

Rules:
- Return ONLY three concise strings: greeting, summary, and closing.
- Write a warm, executive business tone suitable for an enterprise shipper.
- Do NOT write any table, route list, prices, dollar amounts, tonnages, or transit day numbers — all quantitative quote data and service breakdowns are injected deterministically by code.`;

function sortServicesCanonical(services: Iterable<ServiceType>): ServiceType[] {
  const set = new Set(services);
  return SERVICE_TYPES.filter((s) => set.has(s));
}

function roundMoneyUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundTons(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatUsdWholeOrCents(amount: number): string {
  const hasCents = Math.abs(amount - Math.round(amount)) >= 0.005;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })}`;
}

function formatUsdCents(amount: number): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function deriveDefaultDisposition(assessment: LaneAssessment): QuoteLaneDisposition {
  switch (assessment.status) {
    case "FULLY_SERVABLE":
      return "QUOTE_COMPLIANT";
    case "COMPLIANT_BUT_LATE":
      return assessment.chosenRoute ? "QUOTE_COMPLIANT_LATE" : "DECLINE";
    case "ON_TIME_BUT_MISSING_SERVICES":
      return assessment.chosenRoute ? "QUOTE_PARTIAL_ON_TIME" : "DECLINE";
    case "NO_ROUTE_IN_TIME":
    case "UNREACHABLE":
      return "DECLINE";
  }
}

export function computeRouteServiceCoverage(
  requestedServices: readonly ServiceType[],
  route: Route | null,
): LegServiceGap[] {
  const canonical = sortServicesCanonical(requestedServices);
  return canonical.map((service) => {
    if (!route) {
      return {
        service,
        fulfilled: false,
        missingOnLegs: [],
      };
    }
    const missingOnLegs = route.legs
      .filter((leg) => !leg.availableServices.includes(service))
      .map((leg) => `${leg.origin}->${leg.destination}`);
    return {
      service,
      fulfilled: missingOnLegs.length === 0,
      missingOnLegs,
    };
  });
}

function formatServiceCoverageText(
  coverage: readonly LegServiceGap[],
  hasRoute: boolean,
): string {
  if (coverage.length === 0) {
    return "Standard cargo (none required)";
  }
  return coverage
    .map((gap) => {
      const label = SERVICE_DISPLAY_LABELS[gap.service];
      if (gap.fulfilled) {
        return `${label}: FULFILLED`;
      }
      if (!hasRoute) {
        return `${label}: NOT FULFILLED (no route available)`;
      }
      const legText =
        gap.missingOnLegs.length > 0
          ? gap.missingOnLegs.join(", ")
          : "route legs";
      return `${label}: NOT FULFILLED (fails on ${legText})`;
    })
    .join("; ");
}

function buildDecisionNote(
  assessment: LaneAssessment,
  disposition: QuoteLaneDisposition,
  route: Route | null,
  coverage: readonly LegServiceGap[],
  customNote?: string,
): string {
  if (customNote && customNote.trim().length > 0) {
    return customNote.trim();
  }

  const maxDays = assessment.lane.maxTransitDays;
  const daysOver = route ? route.totalTransitDays - maxDays : null;
  const missingLabels = coverage
    .filter((c) => !c.fulfilled)
    .map(
      (c) =>
        `${SERVICE_DISPLAY_LABELS[c.service]} (${c.missingOnLegs.join(", ") || "no route"})`,
    );

  if (disposition === "DECLINE") {
    if (assessment.status === "UNREACHABLE") {
      return "DECISION: Declined — destination airport unreachable on our flight network.";
    }
    if (assessment.status === "NO_ROUTE_IN_TIME") {
      const fastestDays = assessment.routing.fastestUnconstrainedRoute?.totalTransitDays;
      return fastestDays !== undefined
        ? `DECISION: Declined — fastest route takes ${fastestDays}d vs ${maxDays}d max (no compliant on-time option).`
        : "DECISION: Declined — no compliant route within customer transit deadline.";
    }
    return `DECISION: Declined (${assessment.humanDecisionReason ?? assessment.status}).`;
  }

  if (disposition === "QUOTE_COMPLIANT_LATE" || (daysOver !== null && daysOver > 0)) {
    const extras: string[] = [];
    if (daysOver !== null && daysOver > 0) {
      extras.push(
        `transits in ${route!.totalTransitDays}d vs ${maxDays}d max (+${daysOver}d late)`,
      );
    }
    if (missingLabels.length > 0) {
      extras.push(`missing ${missingLabels.join("; ")}`);
    }
    return `DECISION REQUIRED: Customer transit extension approval needed (${extras.join("; ")}).`;
  }

  if (disposition === "QUOTE_PARTIAL_ON_TIME" || missingLabels.length > 0) {
    return `DECISION REQUIRED: Partial service waiver needed — cannot fulfill ${missingLabels.join("; ")}.`;
  }

  return "Compliant: All transit and service requirements met.";
}

function buildRenderedLane(input: QuoteLaneInput): RenderedQuoteLane {
  const { assessment } = input;
  const { lane } = assessment;
  const disposition = input.disposition ?? deriveDefaultDisposition(assessment);
  const route =
    disposition === "DECLINE"
      ? null
      : input.selectedRoute !== undefined
        ? input.selectedRoute
        : assessment.chosenRoute;

  const requestedServices = sortServicesCanonical(
    assessment.extraction.requestedServices,
  );
  const coverage = computeRouteServiceCoverage(requestedServices, route);
  const fulfilledServices = coverage
    .filter((c) => c.fulfilled)
    .map((c) => c.service);
  const missingServices = coverage
    .filter((c) => !c.fulfilled)
    .map((c) => c.service);

  const routeAirports = route ? [...route.airports] : [];
  const routeText =
    routeAirports.length > 0 ? routeAirports.join(" -> ") : "NO ROUTE (Declined)";
  const transitDays = route ? route.totalTransitDays : null;
  const daysOver = transitDays !== null ? transitDays - lane.maxTransitDays : null;

  const transitVsMaxText =
    transitDays === null
      ? `N/A / ${lane.maxTransitDays}d max`
      : daysOver !== null && daysOver > 0
        ? `${transitDays}d / ${lane.maxTransitDays}d max (+${daysOver}d late)`
        : `${transitDays}d / ${lane.maxTransitDays}d max (On time)`;

  let pricePerTonUsd: number | null = null;
  let lineTotalUsd: number | null = null;

  if (disposition !== "DECLINE") {
    if (
      input.pricePerTonUsd === null ||
      input.pricePerTonUsd === undefined ||
      !Number.isFinite(input.pricePerTonUsd) ||
      input.pricePerTonUsd <= 0
    ) {
      throw new Error(
        `Cannot draft quote for lane ${lane.laneCode} (${disposition}): missing positive validated pricePerTonUsd.`,
      );
    }
    pricePerTonUsd = roundMoneyUsd(input.pricePerTonUsd);
    lineTotalUsd = roundMoneyUsd(lane.tons * pricePerTonUsd);
  }

  return {
    laneId: input.laneId,
    laneNumber: lane.laneNumber,
    laneCode: lane.laneCode,
    origin: lane.origin,
    destination: lane.destination,
    tons: lane.tons,
    maxTransitDays: lane.maxTransitDays,
    disposition,
    routeAirports,
    routeText,
    transitDays,
    transitVsMaxText,
    requestedServices,
    fulfilledServices,
    missingServices,
    serviceCoverage: coverage,
    servicesText: formatServiceCoverageText(coverage, route !== null),
    pricePerTonUsd,
    lineTotalUsd,
    pricePerTonText:
      pricePerTonUsd !== null ? `${formatUsdWholeOrCents(pricePerTonUsd)}/t` : "N/A",
    lineTotalText:
      lineTotalUsd !== null ? formatUsdCents(lineTotalUsd) : "Declined",
    decisionNote: buildDecisionNote(
      assessment,
      disposition,
      route,
      coverage,
      input.decisionNote,
    ),
  };
}

function renderMarkdownQuoteSection(
  rfpTitle: string,
  renderedLanes: readonly RenderedQuoteLane[],
  totals: {
    totalQuotedLanes: number;
    totalDeclinedLanes: number;
    totalTons: number;
    totalValueUsd: number;
  },
): string {
  const header = [
    "| Lane | Route | Tons | Transit vs Max | Special Services (Fulfilled / Missing) | Price / Ton | Lane Total | Decision / Notes |",
    "| --- | --- | ---: | --- | --- | ---: | ---: | --- |",
  ];

  const rows = renderedLanes.map((row) =>
    [
      `| ${escapeMarkdownCell(`${row.laneCode} (#${row.laneNumber})`)}`,
      escapeMarkdownCell(row.routeText),
      `${row.tons.toFixed(1)}t`,
      escapeMarkdownCell(row.transitVsMaxText),
      escapeMarkdownCell(row.servicesText),
      row.pricePerTonText,
      row.lineTotalText,
      `${escapeMarkdownCell(row.decisionNote)} |`,
    ].join(" | "),
  );

  const exceptionLanes = renderedLanes.filter(
    (r) =>
      r.disposition !== "QUOTE_COMPLIANT" ||
      r.missingServices.length > 0 ||
      (r.transitDays !== null && r.transitDays > r.maxTransitDays),
  );

  const lines = [
    `### Proposal Summary: ${rfpTitle}`,
    "",
    ...header,
    ...rows,
    "",
    "### Proposal Totals",
    `- **Quoted Lanes:** ${totals.totalQuotedLanes}`,
    `- **Declined / Non-Servable Lanes:** ${totals.totalDeclinedLanes}`,
    `- **Total Quoted Tonnage:** ${totals.totalTons.toFixed(1)} tons`,
    `- **Total Quoted Value:** ${formatUsdCents(totals.totalValueUsd)} USD`,
  ];

  if (exceptionLanes.length > 0) {
    lines.push("", "### Lanes Requiring Customer Confirmation / Decisions");
    for (const lane of exceptionLanes) {
      lines.push(`- **${lane.laneCode}**: ${lane.decisionNote}`);
    }
  }

  return lines.join("\n");
}

function renderPlainTextQuoteSection(
  rfpTitle: string,
  renderedLanes: readonly RenderedQuoteLane[],
  totals: {
    totalQuotedLanes: number;
    totalDeclinedLanes: number;
    totalTons: number;
    totalValueUsd: number;
  },
): string {
  const divider = "=".repeat(78);
  const subDivider = "-".repeat(78);
  const lines: string[] = [
    divider,
    `PROPOSAL SCHEDULE: ${rfpTitle}`,
    divider,
  ];

  for (const row of renderedLanes) {
    lines.push(
      `Lane: ${row.laneCode} (#${row.laneNumber}) | Volume: ${row.tons.toFixed(1)} tons`,
      `  Route:      ${row.routeText}`,
      `  Transit:    ${row.transitVsMaxText}`,
      `  Services:   ${row.servicesText}`,
      `  Rate:       ${row.pricePerTonText} | Line Total: ${row.lineTotalText}`,
      `  Notes:      ${row.decisionNote}`,
      subDivider,
    );
  }

  lines.push(
    `TOTAL QUOTED LANES:   ${totals.totalQuotedLanes}`,
    `TOTAL DECLINED LANES: ${totals.totalDeclinedLanes}`,
    `TOTAL QUOTED TONNAGE: ${totals.totalTons.toFixed(1)} tons`,
    `TOTAL QUOTED VALUE:   ${formatUsdCents(totals.totalValueUsd)} USD`,
    divider,
  );

  return lines.join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Verifies LLM-generated framing prose contains zero fabricated prices,
 * dollar amounts, unit rates, tonnages, or transit day numbers.
 * Allowed occurrences of customerName, rfpTitle, signature, or "vN" tags are
 * stripped before scanning so titles like "100-Lane Mock RFP" do not false-trigger.
 */
export function proseContainsProhibitedNumbers(
  prose: QuoteProse,
  allowedTokens: readonly string[] = [],
): string | null {
  let scrubbed = `${prose.greeting}\n${prose.summary}\n${prose.closing}`;
  for (const token of allowedTokens) {
    const cleaned = token.trim();
    if (cleaned.length > 0) {
      scrubbed = scrubbed.replace(new RegExp(escapeRegExp(cleaned), "gi"), " ");
    }
  }
  scrubbed = scrubbed.replace(/\bv\d+\b/gi, " ");

  const prohibited = scrubbed.match(
    /\$\s*\d[\d,]*(?:\.\d+)?|\bUSD\b|\/\s*(?:t|ton|kg)\b|\bper\s+(?:ton|kg)\b|\b\d+(?:,\d{3})*(?:\.\d+)?\b/i,
  );
  return prohibited ? prohibited[0] : null;
}

function buildOfflineQuoteProse(
  customerName: string,
  rfpTitle: string,
  signature: string,
  hasExceptions: boolean,
): QuoteProse {
  return {
    greeting: `Dear ${customerName},`,
    summary: hasExceptions
      ? `Thank you for inviting our team to bid on ${rfpTitle}. Below is our structured lane-by-lane routing, service-capability matrix, and pricing proposal, with specific exceptions highlighted for your confirmation.`
      : `Thank you for inviting our team to bid on ${rfpTitle}. Please find below our structured lane-by-lane routing, service-capability matrix, and binding per-ton rate proposal.`,
    closing: `Please reply to confirm the quoted lanes or let us know if you would like to review any exception lanes prior to kickoff.\n\nBest regards,\n${signature}`,
  };
}

export async function draftCustomerQuote(
  options: DraftQuoteOptions,
): Promise<DraftQuoteResult> {
  const now = new Date().toISOString();
  const senderEmail = options.senderEmail ?? "rfp-response-team@carrier.example";
  const signature = options.rfpTeamSignature ?? "Air Freight RFP Response Team";

  const renderedLanes = options.lanes.map(buildRenderedLane);
  const quotedLanes = renderedLanes.filter((l) => l.disposition !== "DECLINE");
  const declinedLanes = renderedLanes.filter((l) => l.disposition === "DECLINE");

  const totals = {
    totalQuotedLanes: quotedLanes.length,
    totalDeclinedLanes: declinedLanes.length,
    totalTons: roundTons(
      quotedLanes.reduce((sum, lane) => sum + lane.tons, 0),
    ),
    totalValueUsd: roundMoneyUsd(
      quotedLanes.reduce((sum, lane) => sum + (lane.lineTotalUsd ?? 0), 0),
    ),
  };

  const hasExceptions = renderedLanes.some(
    (l) => l.disposition !== "QUOTE_COMPLIANT",
  );
  const fallbackProse = buildOfflineQuoteProse(
    options.customerName,
    options.rfpTitle,
    signature,
    hasExceptions,
  );

  const llmCall = await options.llm.generateStructured({
    agentName: "QuoteAgent",
    operation: "draft_quote_prose",
    schema: QuoteProseSchema,
    system: QUOTE_PROSE_SYSTEM_PROMPT,
    prompt: [
      `Customer Name: ${options.customerName}`,
      `RFP Title: ${options.rfpTitle}`,
      `Signature Name: ${signature}`,
      `Has trade-off/declined exception lanes needing confirmation: ${hasExceptions ? "Yes" : "No"}`,
      "Write ONLY greeting, summary (1-2 qualitative sentences, zero numbers/prices), and closing.",
    ].join("\n"),
    rfpId: options.rfpId,
    metadata: {
      quotedLaneCount: totals.totalQuotedLanes,
      declinedLaneCount: totals.totalDeclinedLanes,
    },
    offlineHandler: () => fallbackProse,
  });

  let prose: QuoteProse = llmCall.ok ? llmCall.data : fallbackProse;
  if (llmCall.ok) {
    const prohibitedMatch = proseContainsProhibitedNumbers(llmCall.data, [
      options.rfpTitle,
      options.customerName,
      signature,
    ]);
    if (prohibitedMatch) {
      prose = fallbackProse;
      await options.db.insert(agentEvents).values({
        rfpId: options.rfpId,
        laneId: null,
        agentName: "QuoteAgent",
        eventType: "QUOTE_PROSE_SANITIZED",
        provider: llmCall.provider,
        model: llmCall.model,
        latencyMs: llmCall.latencyMs,
        inputTokens: llmCall.usage.inputTokens,
        outputTokens: llmCall.usage.outputTokens,
        totalTokens: llmCall.usage.totalTokens,
        costUsd: llmCall.costUsd,
        retryCount: llmCall.retriesUsed,
        status: "WARNING",
        summary: `Blocked numeric/currency token ("${prohibitedMatch}") from LLM quote prose and reverted to deterministic framing.`,
        payloadJson: JSON.stringify({
          prohibitedMatch,
          rejectedProse: llmCall.data,
        }),
        createdAt: now,
      });
    }
  }

  const markdownTable = renderMarkdownQuoteSection(
    options.rfpTitle,
    renderedLanes,
    totals,
  );
  const plainTable = renderPlainTextQuoteSection(
    options.rfpTitle,
    renderedLanes,
    totals,
  );

  const markdownBody = [prose.greeting, "", prose.summary, "", markdownTable, "", prose.closing].join(
    "\n",
  );
  const plainTextBody = [prose.greeting, "", prose.summary, "", plainTable, "", prose.closing].join(
    "\n",
  );

  const existingProposals = await options.db
    .select({ version: proposals.version })
    .from(proposals)
    .where(eq(proposals.rfpId, options.rfpId))
    .orderBy(desc(proposals.version));
  const version = (existingProposals[0]?.version ?? 0) + 1;

  const subject = `Air Freight Proposal v${version}: ${options.rfpTitle}`;

  const [emailRow] = await options.db
    .insert(emailsTable)
    .values({
      rfpId: options.rfpId,
      threadType: "CUSTOMER_QUOTE",
      direction: "outbound",
      counterparty: "customer",
      sender: senderEmail,
      recipient: options.customerEmail,
      subject,
      body: markdownBody,
      plainTextBody,
      parsedPayloadJson: JSON.stringify({
        version,
        totals,
        lanes: renderedLanes,
      }),
      status: "DRAFT",
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      createdAt: now,
    })
    .returning({ id: emailsTable.id });

  if (!emailRow) {
    throw new Error("Failed to insert draft quote email.");
  }

  const [proposalRow] = await options.db
    .insert(proposals)
    .values({
      rfpId: options.rfpId,
      version,
      status: "DRAFT",
      quoteEmailId: emailRow.id,
      customerReplyEmailId: null,
      totalQuotedLanes: totals.totalQuotedLanes,
      totalDeclinedLanes: totals.totalDeclinedLanes,
      totalTons: totals.totalTons,
      totalValueUsd: totals.totalValueUsd,
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      acceptedAt: null,
      createdAt: now,
    })
    .returning({ id: proposals.id });

  if (!proposalRow) {
    throw new Error("Failed to insert draft proposal row.");
  }

  for (const lane of renderedLanes) {
    await options.db.insert(proposalLanes).values({
      proposalId: proposalRow.id,
      laneId: lane.laneId,
      origin: lane.origin,
      destination: lane.destination,
      tons: lane.tons,
      disposition: lane.disposition,
      routeAirportsJson:
        lane.routeAirports.length > 0 ? JSON.stringify(lane.routeAirports) : null,
      transitDays: lane.transitDays,
      fulfilledServicesJson: JSON.stringify(lane.fulfilledServices),
      missingServicesJson: JSON.stringify(lane.missingServices),
      pricePerTonUsd: lane.pricePerTonUsd,
      lineTotalUsd: lane.lineTotalUsd,
    });
  }

  await options.db
    .update(rfps)
    .set({ status: "QUOTE_DRAFTED", updatedAt: now })
    .where(eq(rfps.id, options.rfpId));

  await options.db.insert(agentEvents).values({
    rfpId: options.rfpId,
    laneId: null,
    agentName: "QuoteAgent",
    eventType: "QUOTE_DRAFTED",
    provider: llmCall.provider,
    model: llmCall.model,
    latencyMs: llmCall.latencyMs,
    inputTokens: llmCall.usage.inputTokens,
    outputTokens: llmCall.usage.outputTokens,
    totalTokens: llmCall.usage.totalTokens,
    costUsd: llmCall.costUsd,
    retryCount: llmCall.retriesUsed,
    status: "SUCCESS",
    summary: `Drafted Proposal v${version} (${totals.totalQuotedLanes} quoted, ${totals.totalDeclinedLanes} declined, ${formatUsdCents(totals.totalValueUsd)})`,
    payloadJson: JSON.stringify({
      proposalId: proposalRow.id,
      quoteEmailId: emailRow.id,
      version,
      totals,
    }),
    createdAt: now,
  });

  return {
    proposalId: proposalRow.id,
    version,
    quoteEmailId: emailRow.id,
    subject,
    markdownBody,
    plainTextBody,
    prose,
    renderedLanes,
    totalQuotedLanes: totals.totalQuotedLanes,
    totalDeclinedLanes: totals.totalDeclinedLanes,
    totalTons: totals.totalTons,
    totalValueUsd: totals.totalValueUsd,
    status: "DRAFT",
  };
}

async function listOpenTasksForRfp(
  db: AppDatabase,
  rfpId: number,
): Promise<BlockingHumanTaskSummary[]> {
  const rows = await db
    .select({
      id: humanTasks.id,
      laneCode: humanTasks.laneCode,
      taskType: humanTasks.taskType,
      title: humanTasks.title,
      reason: humanTasks.reason,
    })
    .from(humanTasks)
    .where(and(eq(humanTasks.rfpId, rfpId), eq(humanTasks.status, "OPEN")));
  return rows;
}

export async function approveCustomerQuote(
  options: ApproveQuoteOptions,
): Promise<ApproveQuoteResult> {
  const approvedBy = options.approvedBy.trim();
  if (!approvedBy) {
    throw new ApprovalGateError(
      "MISSING_APPROVAL_METADATA",
      "Quote approval requires a non-empty reviewer identifier (approvedBy).",
    );
  }

  const [proposal] = await options.db
    .select()
    .from(proposals)
    .where(eq(proposals.id, options.proposalId));

  if (!proposal) {
    throw new ApprovalGateError(
      "PROPOSAL_NOT_FOUND",
      `Proposal #${options.proposalId} was not found.`,
    );
  }

  if (
    proposal.status === "SENT" ||
    proposal.status === "ACCEPTED" ||
    proposal.status === "PARTIALLY_ACCEPTED" ||
    proposal.status === "REJECTED"
  ) {
    throw new ApprovalGateError(
      "ALREADY_SENT",
      `Proposal #${proposal.id} already has status "${proposal.status}" and cannot be re-approved.`,
    );
  }

  const now = new Date().toISOString();
  const acceptedExceptionTaskIds: number[] = [];

  if (options.acceptOpenTaskIds && options.acceptOpenTaskIds.length > 0) {
    const requestedIds = [...new Set(options.acceptOpenTaskIds)];
    const matchingOpen = await options.db
      .select({ id: humanTasks.id })
      .from(humanTasks)
      .where(
        and(
          eq(humanTasks.rfpId, proposal.rfpId),
          eq(humanTasks.status, "OPEN"),
          inArray(humanTasks.id, requestedIds),
        ),
      );

    const matchedIds = matchingOpen.map((row) => row.id);
    if (matchedIds.length > 0) {
      await options.db
        .update(humanTasks)
        .set({
          status: "ACCEPTED_WITH_EXCEPTION",
          resolvedAt: now,
          resolutionJson: JSON.stringify({
            resolvedVia: "QUOTE_APPROVAL_EXCEPTION",
            approvedBy,
            approvedAt: now,
            exceptionNote:
              options.exceptionNote ??
              "Explicitly accepted during human quote approval.",
          }),
        })
        .where(inArray(humanTasks.id, matchedIds));
      acceptedExceptionTaskIds.push(...matchedIds);
    }
  }

  const remainingOpenTasks = await listOpenTasksForRfp(
    options.db,
    proposal.rfpId,
  );
  if (remainingOpenTasks.length > 0) {
    throw new ApprovalGateError(
      "OPEN_HUMAN_TASKS",
      `Cannot approve Proposal #${proposal.id}: ${remainingOpenTasks.length} open human_task(s) remain unresolved for RFP #${proposal.rfpId}.`,
      remainingOpenTasks,
    );
  }

  await options.db
    .update(proposals)
    .set({
      status: "APPROVED",
      approvedBy,
      approvedAt: now,
    })
    .where(eq(proposals.id, proposal.id));

  if (proposal.quoteEmailId !== null) {
    await options.db
      .update(emailsTable)
      .set({
        status: "APPROVED",
        approvedBy,
        approvedAt: now,
      })
      .where(eq(emailsTable.id, proposal.quoteEmailId));
  }

  await options.db
    .update(rfps)
    .set({
      status: "QUOTE_APPROVED",
      updatedAt: now,
    })
    .where(eq(rfps.id, proposal.rfpId));

  await options.db.insert(agentEvents).values({
    rfpId: proposal.rfpId,
    laneId: null,
    agentName: "QuoteAgent",
    eventType: "QUOTE_APPROVED",
    provider: "human-gate",
    model: "rfp-team-approval",
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    retryCount: 0,
    status: "SUCCESS",
    summary: `Proposal #${proposal.id} approved by ${approvedBy}${acceptedExceptionTaskIds.length > 0 ? ` (${acceptedExceptionTaskIds.length} open task(s) accepted with exception)` : ""}`,
    payloadJson: JSON.stringify({
      proposalId: proposal.id,
      quoteEmailId: proposal.quoteEmailId,
      approvedBy,
      approvedAt: now,
      acceptedExceptionTaskIds,
    }),
    createdAt: now,
  });

  return {
    proposalId: proposal.id,
    quoteEmailId: proposal.quoteEmailId,
    status: "APPROVED",
    approvedBy,
    approvedAt: now,
    acceptedExceptionTaskIds,
  };
}

export async function sendCustomerQuote(
  options: SendQuoteOptions,
): Promise<SendQuoteResult> {
  const [proposal] = await options.db
    .select()
    .from(proposals)
    .where(eq(proposals.id, options.proposalId));

  if (!proposal) {
    throw new ApprovalGateError(
      "PROPOSAL_NOT_FOUND",
      `Proposal #${options.proposalId} was not found.`,
    );
  }

  if (
    proposal.status === "SENT" ||
    proposal.status === "ACCEPTED" ||
    proposal.status === "PARTIALLY_ACCEPTED" ||
    proposal.status === "REJECTED"
  ) {
    throw new ApprovalGateError(
      "ALREADY_SENT",
      `Proposal #${proposal.id} has already been sent (status: ${proposal.status}).`,
    );
  }

  if (proposal.status !== "APPROVED") {
    throw new ApprovalGateError(
      "NOT_APPROVED",
      `Approval Gate blocked send: Proposal #${proposal.id} status is "${proposal.status}", expected "APPROVED".`,
    );
  }

  if (!proposal.approvedBy || !proposal.approvedAt) {
    throw new ApprovalGateError(
      "MISSING_APPROVAL_METADATA",
      `Approval Gate blocked send: Proposal #${proposal.id} is missing approvedBy/approvedAt metadata.`,
    );
  }

  if (proposal.quoteEmailId === null) {
    throw new ApprovalGateError(
      "NOT_APPROVED",
      `Proposal #${proposal.id} has no linked quote email.`,
    );
  }

  const [quoteEmail] = await options.db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.id, proposal.quoteEmailId));

  if (!quoteEmail || quoteEmail.status !== "APPROVED") {
    throw new ApprovalGateError(
      "NOT_APPROVED",
      `Approval Gate blocked send: quote email #${proposal.quoteEmailId} is not APPROVED.`,
    );
  }

  const openTasks = await listOpenTasksForRfp(options.db, proposal.rfpId);
  if (openTasks.length > 0) {
    throw new ApprovalGateError(
      "OPEN_HUMAN_TASKS",
      `Approval Gate blocked send: ${openTasks.length} open human_task(s) exist for RFP #${proposal.rfpId}.`,
      openTasks,
    );
  }

  const smtpConfig = readSmtpConfig(options.smtpEnv);
  const smtpTransport =
    options.smtpTransport ??
    (smtpConfig ? createNodeSmtpTransport(smtpConfig) : undefined);

  let deliveryChannel: "IN_APP_OUTBOX" | "SMTP" = "IN_APP_OUTBOX";
  let smtpResult: SmtpSendResult | undefined;

  if (smtpTransport) {
    smtpResult = await smtpTransport.sendMail({
      from: smtpConfig?.from ?? quoteEmail.sender,
      to: quoteEmail.recipient,
      subject: quoteEmail.subject,
      text: quoteEmail.plainTextBody ?? quoteEmail.body,
      markdown: quoteEmail.body,
    });
    deliveryChannel = "SMTP";
  }

  const sentAt = new Date().toISOString();

  await options.db
    .update(emailsTable)
    .set({
      status: "SENT",
      sentAt,
    })
    .where(eq(emailsTable.id, quoteEmail.id));

  await options.db
    .update(proposals)
    .set({
      status: "SENT",
      sentAt,
    })
    .where(eq(proposals.id, proposal.id));

  await options.db
    .update(rfps)
    .set({
      status: "QUOTE_SENT",
      updatedAt: sentAt,
    })
    .where(eq(rfps.id, proposal.rfpId));

  await options.db.insert(agentEvents).values({
    rfpId: proposal.rfpId,
    laneId: null,
    agentName: "QuoteAgent",
    eventType: "QUOTE_SENT",
    provider: deliveryChannel === "SMTP" ? "smtp" : "in-app-outbox",
    model: deliveryChannel,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    retryCount: 0,
    status: "SUCCESS",
    summary: `Sent Proposal #${proposal.id} to ${quoteEmail.recipient} via ${deliveryChannel} (approved by ${proposal.approvedBy})`,
    payloadJson: JSON.stringify({
      proposalId: proposal.id,
      quoteEmailId: quoteEmail.id,
      deliveryChannel,
      approvedBy: proposal.approvedBy,
      approvedAt: proposal.approvedAt,
      sentAt,
      smtpMessageId: smtpResult?.messageId ?? null,
    }),
    createdAt: sentAt,
  });

  return {
    proposalId: proposal.id,
    quoteEmailId: quoteEmail.id,
    status: "SENT",
    deliveryChannel,
    sentAt,
    recipient: quoteEmail.recipient,
    subject: quoteEmail.subject,
    smtpResult,
  };
}
