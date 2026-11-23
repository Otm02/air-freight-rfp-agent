import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  agentEvents,
  emails as emailsTable,
  humanTasks,
  lanes as lanesTable,
  meetings,
  proposalLanes,
  proposals,
  rfps,
  type AppDatabase,
} from "../db";
import {
  computeNextBusinessDay10amET,
  generateKickoffIcs,
  type MeetingAttendee,
} from "../deal";
import type { LlmClient } from "../llm";

export const DEAL_CONFIDENCE_THRESHOLD = 0.85;

export const CustomerReplyIntentSchema = z.enum([
  "ACCEPT_ALL",
  "ACCEPT_PARTIAL",
  "REJECT",
  "QUESTION",
  "UNCLEAR",
]);

export type CustomerReplyIntent = z.infer<typeof CustomerReplyIntentSchema>;

export const CustomerReplyParseSchema = z.object({
  intent: CustomerReplyIntentSchema,
  acceptedLaneCodes: z.array(z.string()),
  rejectedLaneCodes: z.array(z.string()),
  questions: z.array(z.string()),
  evidenceQuote: z.string(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
});

export type CustomerReplyParseOutput = z.infer<typeof CustomerReplyParseSchema>;

export interface HandleCustomerReplyOptions {
  db: AppDatabase;
  proposalId: number;
  emailBody: string;
  emailSubject?: string;
  senderEmail?: string;
  llm: LlmClient;
  inboundEmailId?: number;
  rfpTeamContact?: { name: string; email: string };
  pricingTeamContact?: { name: string; email: string };
  extraAttendees?: readonly MeetingAttendee[];
  kickoffReferenceDate?: Date;
  meetingDurationMinutes?: number;
}

export interface HandleCustomerReplyResult {
  proposalId: number;
  inboundEmailId: number;
  intent: CustomerReplyIntent;
  confidence: number;
  proposalStatus: string;
  rfpStatus: string;
  acceptedLaneCodes: string[];
  rejectedLaneCodes: string[];
  humanTaskCreated: {
    id: number;
    taskType: string;
    title: string;
    reason: string;
  } | null;
  meetingCreated: {
    id: number;
    title: string;
    scheduledAt: string;
    scheduledAtEtDisplay: string;
    durationMinutes: number;
    attendees: MeetingAttendee[];
    icsUid: string;
    icsContent: string;
  } | null;
}

const DEAL_PARSE_SYSTEM_PROMPT = `You are a commercial air freight Deal Desk analyst reading a customer's reply to a formal RFP quote email. The reply may be in English or French (especially for Montreal/Quebec or France lanes).

Instructions:
- Classify intent as EXACTLY one of:
  - ACCEPT_ALL: customer clearly and unconditionally accepts all quoted lanes in the proposal.
  - ACCEPT_PARTIAL: customer clearly accepts a specific subset of quoted lane codes (e.g., "MEX-CDG", "GRU-BOG") and excludes or declines the rest.
  - REJECT: customer declines/rejects the entire proposal.
  - QUESTION: customer asks questions or requests clarifications before deciding (no binding acceptance yet).
  - UNCLEAR: tentative, hedged, non-committal ("maybe", "tentatively", "pending legal", "circle back", or French equivalents like "sous réserve"), or contradictory reply.
- If the reply is in French and contains any ambiguity, condition, or partial scope, classify as UNCLEAR or QUESTION and keep confidence below 0.80 so a human reviewer verifies.
- Return uppercase lane codes (e.g. "MEX-CDG") in acceptedLaneCodes and rejectedLaneCodes matching the quoted lanes.
- Copy evidenceQuote verbatim as a substring from the customer email.
- Lower confidence below 0.80 whenever there is ambiguity, hedging, or mixed signals.`;

function roundMoneyUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundTons(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeWhitespace(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractSentencesWithQuestions(body: string): string[] {
  return body
    .split(/\r?\n|(?<=[.?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.includes("?") || /\b(?:clarify|explain|confirm whether|question)\b/i.test(s));
}

function extractClauseSplitLanes(
  body: string,
  quotedCodesUpper: readonly string[],
): {
  accepted: string[];
  rejected: string[];
} {
  const quotedSet = new Set(quotedCodesUpper);
  const accepted: string[] = [];
  const rejected: string[] = [];

  const clauses = body.split(/[\r\n.!;]+/).filter((c) => c.trim().length > 0);
  for (const clause of clauses) {
    const matches = [...clause.matchAll(/\b([A-Z]{3}-[A-Z]{3})\b/gi)].map((m) =>
      m[1]!.toUpperCase(),
    );
    const validMatches = matches.filter((c) => quotedSet.has(c));
    if (validMatches.length === 0) {
      continue;
    }

    const isDeclineClause =
      /\b(?:decline|reject|drop|skip|exclude|excluding|hold off|not proceeding|cannot proceed)\b/i.test(
        clause,
      );
    const isAcceptClause =
      /\b(?:accept|award|approve|proceed with|confirm|book)\b/i.test(clause);

    if (isAcceptClause && !isDeclineClause) {
      for (const code of validMatches) {
        if (!accepted.includes(code)) accepted.push(code);
      }
    } else if (isDeclineClause && !isAcceptClause) {
      for (const code of validMatches) {
        if (!rejected.includes(code)) rejected.push(code);
      }
    }
  }

  // Fill complementary rejected lanes if only accepted subset was named cleanly
  if (accepted.length > 0 && accepted.length < quotedCodesUpper.length) {
    const acceptedSet = new Set(accepted);
    for (const code of quotedCodesUpper) {
      if (!acceptedSet.has(code) && !rejected.includes(code)) {
        rejected.push(code);
      }
    }
  }

  return { accepted, rejected };
}

const FRENCH_CUE_REGEX =
  /\b(?:bonjour|bonsoir|merci(?:\s+beaucoup|\s+pour|\s+d'avance)?|cordialement|bien\s+[àa]\s+vous|nous\s+(?:acceptons|n'acceptons|refusons|d[ée]clinons|souhaitons|avons|voudrions)|vous\s+(?:pouvez|pourriez|remercions)|pourriez-vous|veuillez|s'il\s+vous\s+pla[îi]t|d'accord|sous\s+r[ée]serve|tarif|devis|d[ée]lai|liaisons?|marchandise)\b/i;
const FRENCH_ACCENT_REGEX = /[àéèêëîïôùûüçœæ]/i;
const FRENCH_FUNCTION_WORD_REGEX =
  /\b(?:nous|vous|le|la|les|des|pour|avec|dans|sur|est|sont|pas)\b/i;

function isLikelyFrenchText(text: string): boolean {
  if (FRENCH_CUE_REGEX.test(text)) {
    return true;
  }
  return FRENCH_ACCENT_REGEX.test(text) && FRENCH_FUNCTION_WORD_REGEX.test(text);
}

export function parseCustomerReplyDeterministic(
  emailBody: string,
  quotedLaneCodes: readonly string[],
): CustomerReplyParseOutput {
  const trimmed = emailBody.trim();
  if (trimmed.length === 0) {
    return {
      intent: "UNCLEAR",
      acceptedLaneCodes: [],
      rejectedLaneCodes: [],
      questions: [],
      evidenceQuote: "",
      confidence: 0.2,
      summary: "Customer reply body was empty; escalated for human review.",
    };
  }

  const quotedUpper = quotedLaneCodes.map((c) => c.toUpperCase());
  const firstSentence =
    trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l.length > 10 &&
          !/^(?:hi|hello|dear|thanks|thank you|best|regards|sincerely)/i.test(l),
      ) ?? trimmed.slice(0, 120);

  if (isLikelyFrenchText(trimmed)) {
    return {
      intent: "UNCLEAR",
      acceptedLaneCodes: [],
      rejectedLaneCodes: [],
      questions: extractSentencesWithQuestions(trimmed),
      evidenceQuote: firstSentence,
      confidence: 0.4,
      summary:
        "French-language customer reply detected in offline mode; escalated for bilingual human review instead of guessing.",
    };
  }

  const hasUnclearCues =
    /\b(?:tentative|tentatively|maybe|not sure|circle back|pending legal|pending board|internal sign-?off|under review|cannot confirm yet)\b/i.test(
      trimmed,
    );
  if (hasUnclearCues) {
    return {
      intent: "UNCLEAR",
      acceptedLaneCodes: [],
      rejectedLaneCodes: [],
      questions: extractSentencesWithQuestions(trimmed),
      evidenceQuote: firstSentence,
      confidence: 0.45,
      summary: "Customer reply contains hedging or non-committal language; human review required.",
    };
  }

  const split = extractClauseSplitLanes(trimmed, quotedUpper);
  const hasExplicitAcceptWord =
    /\b(?:accept|accepted|approve|approved|award|awarded|proceed|confirmed|confirm)\b/i.test(
      trimmed,
    );
  const hasExplicitRejectWord =
    /\b(?:decline|declined|reject|rejected|not proceeding|will not be proceeding|passing on this)\b/i.test(
      trimmed,
    );
  const hasPartialCue =
    /\b(?:accept and award only|only the following lanes|accept some|subset|remaining lanes)\b/i.test(
      trimmed,
    ) ||
    (split.accepted.length > 0 && split.accepted.length < quotedUpper.length);

  if (hasExplicitAcceptWord && hasPartialCue && split.accepted.length > 0) {
    return {
      intent: "ACCEPT_PARTIAL",
      acceptedLaneCodes: split.accepted,
      rejectedLaneCodes: split.rejected,
      questions: [],
      evidenceQuote: firstSentence,
      confidence: 0.93,
      summary: `Customer accepted ${split.accepted.length} of ${quotedUpper.length} quoted lane(s): ${split.accepted.join(", ")}.`,
    };
  }

  if (hasExplicitRejectWord && !hasExplicitAcceptWord) {
    return {
      intent: "REJECT",
      acceptedLaneCodes: [],
      rejectedLaneCodes: quotedUpper,
      questions: [],
      evidenceQuote: firstSentence,
      confidence: 0.95,
      summary: "Customer rejected the proposal.",
    };
  }

  const questions = extractSentencesWithQuestions(trimmed);
  if (
    questions.length > 0 &&
    (/\b(?:before we|clarify|question|could you explain|once you clarify)\b/i.test(
      trimmed,
    ) ||
      !hasExplicitAcceptWord)
  ) {
    return {
      intent: "QUESTION",
      acceptedLaneCodes: [],
      rejectedLaneCodes: [],
      questions,
      evidenceQuote: questions[0] ?? firstSentence,
      confidence: 0.92,
      summary: `Customer asked ${questions.length} question(s) before committing.`,
    };
  }

  if (hasExplicitAcceptWord && !hasExplicitRejectWord && quotedUpper.length > 0) {
    return {
      intent: "ACCEPT_ALL",
      acceptedLaneCodes: quotedUpper,
      rejectedLaneCodes: [],
      questions: [],
      evidenceQuote: firstSentence,
      confidence: 0.96,
      summary: `Customer accepted all ${quotedUpper.length} quoted lane(s) in full.`,
    };
  }

  return {
    intent: "UNCLEAR",
    acceptedLaneCodes: [],
    rejectedLaneCodes: [],
    questions,
    evidenceQuote: firstSentence,
    confidence: 0.4,
    summary: "Could not establish unambiguous customer intent; human review required.",
  };
}

export async function handleCustomerReply(
  options: HandleCustomerReplyOptions,
): Promise<HandleCustomerReplyResult> {
  const now = new Date().toISOString();

  const [proposal] = await options.db
    .select()
    .from(proposals)
    .where(eq(proposals.id, options.proposalId));

  if (!proposal) {
    throw new Error(`Proposal #${options.proposalId} was not found.`);
  }

  if (proposal.status === "DRAFT") {
    throw new Error(
      `Cannot process customer reply for Proposal #${proposal.id}: proposal is still DRAFT and has not passed approval/send.`,
    );
  }

  const [rfp] = await options.db
    .select()
    .from(rfps)
    .where(eq(rfps.id, proposal.rfpId));

  if (!rfp) {
    throw new Error(`Parent RFP #${proposal.rfpId} was not found.`);
  }

  const pLanes = await options.db
    .select({
      proposalLane: proposalLanes,
      laneCode: lanesTable.laneCode,
      laneNumber: lanesTable.laneNumber,
    })
    .from(proposalLanes)
    .innerJoin(lanesTable, eq(proposalLanes.laneId, lanesTable.id))
    .where(eq(proposalLanes.proposalId, proposal.id));

  const quotedLaneRows = pLanes.filter(
    (row) => row.proposalLane.disposition !== "DECLINE",
  );
  const quotedCodes = quotedLaneRows.map((row) => row.laneCode.toUpperCase());

  const senderEmail = options.senderEmail ?? rfp.customerEmail;
  const rfpTeamContact = options.rfpTeamContact ?? {
    name: "RFP Response Lead",
    email: "rfp-response-team@carrier.example",
  };
  const pricingTeamContact = options.pricingTeamContact ?? {
    name: "Air Pricing Desk",
    email: "pricing-desk@carrier.example",
  };
  const emailSubject =
    options.emailSubject ?? `Re: Air Freight Proposal v${proposal.version}: ${rfp.title}`;

  let inboundEmailId = options.inboundEmailId;
  if (inboundEmailId === undefined) {
    const [insertedInbound] = await options.db
      .insert(emailsTable)
      .values({
        rfpId: rfp.id,
        threadType: "CUSTOMER_QUOTE",
        direction: "inbound",
        counterparty: "customer",
        sender: senderEmail,
        recipient: rfpTeamContact.email,
        subject: emailSubject,
        body: options.emailBody,
        plainTextBody: options.emailBody,
        parsedPayloadJson: null,
        status: "RECEIVED",
        createdAt: now,
      })
      .returning({ id: emailsTable.id });

    if (!insertedInbound) {
      throw new Error("Failed to insert inbound customer reply email.");
    }
    inboundEmailId = insertedInbound.id;
  }

  const deterministicReading = parseCustomerReplyDeterministic(
    options.emailBody,
    quotedCodes,
  );

  const llmCall = await options.llm.generateStructured({
    agentName: "DealAgent",
    operation: `parse_customer_reply_proposal_${proposal.id}`,
    schema: CustomerReplyParseSchema,
    system: DEAL_PARSE_SYSTEM_PROMPT,
    prompt: [
      `Proposal #${proposal.id} (RFP: ${rfp.title})`,
      `Quoted Lane Codes: ${quotedCodes.join(", ") || "NONE"}`,
      "",
      "Customer Reply Email:",
      '"""',
      options.emailBody,
      '"""',
    ].join("\n"),
    rfpId: rfp.id,
    metadata: {
      proposalId: proposal.id,
      inboundEmailId,
      quotedCount: quotedCodes.length,
    },
    offlineHandler: () => deterministicReading,
  });

  if (!llmCall.ok) {
    const taskTitle = `Customer reply could not be parsed for Proposal #${proposal.id}`;
    const taskReason = `DealAgent LLM failure (${llmCall.errorKind}): ${llmCall.errorMessage}. Manual review required before booking.`;

    const [taskRow] = await options.db
      .insert(humanTasks)
      .values({
        rfpId: rfp.id,
        laneId: null,
        laneCode: null,
        taskType: "CUSTOMER_REPLY_REVIEW",
        title: taskTitle,
        reason: taskReason,
        payloadJson: JSON.stringify({
          proposalId: proposal.id,
          inboundEmailId,
          emailBody: options.emailBody,
          errorKind: llmCall.errorKind,
          errorMessage: llmCall.errorMessage,
          deterministicFallback: deterministicReading,
        }),
        status: "OPEN",
        createdAt: now,
      })
      .returning({ id: humanTasks.id });

    await options.db.insert(agentEvents).values({
      rfpId: rfp.id,
      laneId: null,
      agentName: "DealAgent",
      eventType: "DEAL_NEEDS_HUMAN_REVIEW",
      provider: llmCall.provider,
      model: llmCall.model,
      latencyMs: llmCall.latencyMs,
      inputTokens: llmCall.usage.inputTokens,
      outputTokens: llmCall.usage.outputTokens,
      totalTokens: llmCall.usage.totalTokens,
      costUsd: llmCall.costUsd,
      retryCount: llmCall.retriesUsed,
      status: "NEEDS_REVIEW",
      summary: taskReason,
      payloadJson: JSON.stringify({ proposalId: proposal.id, inboundEmailId }),
      createdAt: now,
    });

    return {
      proposalId: proposal.id,
      inboundEmailId,
      intent: "UNCLEAR",
      confidence: 0,
      proposalStatus: proposal.status,
      rfpStatus: rfp.status,
      acceptedLaneCodes: [],
      rejectedLaneCodes: [],
      humanTaskCreated: {
        id: taskRow!.id,
        taskType: "CUSTOMER_REPLY_REVIEW",
        title: taskTitle,
        reason: taskReason,
      },
      meetingCreated: null,
    };
  }

  const parsed = llmCall.data;
  const normalizedBody = normalizeWhitespace(options.emailBody);
  const normalizedEvidence = normalizeWhitespace(parsed.evidenceQuote);
  const evidenceGrounded =
    normalizedEvidence.length === 0 || normalizedBody.includes(normalizedEvidence);
  const effectiveConfidence = evidenceGrounded
    ? parsed.confidence
    : Math.min(parsed.confidence, 0.45);

  await options.db
    .update(emailsTable)
    .set({
      parsedPayloadJson: JSON.stringify({
        ...parsed,
        evidenceGrounded,
        effectiveConfidence,
      }),
      status: "PARSED",
    })
    .where(eq(emailsTable.id, inboundEmailId));

  // Normalize accepted lane set for partial acceptances before committing
  const quotedSet = new Set(quotedCodes);
  let resolvedIntent: CustomerReplyIntent = parsed.intent;
  let acceptedSet = new Set<string>();

  if (parsed.intent === "ACCEPT_ALL") {
    acceptedSet = new Set(quotedCodes);
  } else if (parsed.intent === "ACCEPT_PARTIAL") {
    const matched = parsed.acceptedLaneCodes
      .map((c) => c.toUpperCase())
      .filter((c) => quotedSet.has(c));
    acceptedSet = new Set(matched);
    if (acceptedSet.size === 0) {
      resolvedIntent = "UNCLEAR";
    }
  }

  // Handle QUESTION -> human task so RFP team answers customer's question
  if (resolvedIntent === "QUESTION" && effectiveConfidence >= DEAL_CONFIDENCE_THRESHOLD) {
    const taskTitle = `Respond to customer question on Proposal #${proposal.id}`;
    const taskReason =
      parsed.questions.length > 0
        ? `Customer asked: ${parsed.questions.join(" | ")}`
        : parsed.summary;

    const [taskRow] = await options.db
      .insert(humanTasks)
      .values({
        rfpId: rfp.id,
        laneId: null,
        laneCode: null,
        taskType: "CUSTOMER_QUESTION",
        title: taskTitle,
        reason: taskReason,
        payloadJson: JSON.stringify({
          proposalId: proposal.id,
          inboundEmailId,
          questions: parsed.questions,
          evidenceQuote: parsed.evidenceQuote,
          summary: parsed.summary,
          emailBody: options.emailBody,
        }),
        status: "OPEN",
        createdAt: now,
      })
      .returning({ id: humanTasks.id });

    await options.db
      .update(proposals)
      .set({ customerReplyEmailId: inboundEmailId })
      .where(eq(proposals.id, proposal.id));

    await options.db.insert(agentEvents).values({
      rfpId: rfp.id,
      laneId: null,
      agentName: "DealAgent",
      eventType: "DEAL_CUSTOMER_QUESTION",
      provider: llmCall.provider,
      model: llmCall.model,
      latencyMs: llmCall.latencyMs,
      inputTokens: llmCall.usage.inputTokens,
      outputTokens: llmCall.usage.outputTokens,
      totalTokens: llmCall.usage.totalTokens,
      costUsd: llmCall.costUsd,
      retryCount: llmCall.retriesUsed,
      status: "NEEDS_REVIEW",
      summary: `Customer asked question(s) on Proposal #${proposal.id}; created human_task #${taskRow!.id}.`,
      payloadJson: JSON.stringify({
        proposalId: proposal.id,
        inboundEmailId,
        questions: parsed.questions,
        humanTaskId: taskRow!.id,
      }),
      createdAt: now,
    });

    return {
      proposalId: proposal.id,
      inboundEmailId,
      intent: "QUESTION",
      confidence: effectiveConfidence,
      proposalStatus: proposal.status,
      rfpStatus: rfp.status,
      acceptedLaneCodes: [],
      rejectedLaneCodes: [],
      humanTaskCreated: {
        id: taskRow!.id,
        taskType: "CUSTOMER_QUESTION",
        title: taskTitle,
        reason: taskReason,
      },
      meetingCreated: null,
    };
  }

  // Handle UNCLEAR / low confidence / ungrounded evidence -> fail-closed human task
  if (
    resolvedIntent === "UNCLEAR" ||
    effectiveConfidence < DEAL_CONFIDENCE_THRESHOLD
  ) {
    const taskTitle = `Confirm unclear customer reply for Proposal #${proposal.id}`;
    const taskReason = !evidenceGrounded
      ? `Customer reply evidence quote was not grounded in email body; manual confirmation required.`
      : `Customer reply intent is "${resolvedIntent}" with confidence ${effectiveConfidence.toFixed(2)} (< ${DEAL_CONFIDENCE_THRESHOLD.toFixed(2)}): ${parsed.summary}`;

    const [taskRow] = await options.db
      .insert(humanTasks)
      .values({
        rfpId: rfp.id,
        laneId: null,
        laneCode: null,
        taskType: "CUSTOMER_REPLY_REVIEW",
        title: taskTitle,
        reason: taskReason,
        payloadJson: JSON.stringify({
          proposalId: proposal.id,
          inboundEmailId,
          parsed,
          effectiveConfidence,
          evidenceGrounded,
          emailBody: options.emailBody,
        }),
        status: "OPEN",
        createdAt: now,
      })
      .returning({ id: humanTasks.id });

    await options.db
      .update(proposals)
      .set({ customerReplyEmailId: inboundEmailId })
      .where(eq(proposals.id, proposal.id));

    await options.db.insert(agentEvents).values({
      rfpId: rfp.id,
      laneId: null,
      agentName: "DealAgent",
      eventType: "DEAL_NEEDS_HUMAN_REVIEW",
      provider: llmCall.provider,
      model: llmCall.model,
      latencyMs: llmCall.latencyMs,
      inputTokens: llmCall.usage.inputTokens,
      outputTokens: llmCall.usage.outputTokens,
      totalTokens: llmCall.usage.totalTokens,
      costUsd: llmCall.costUsd,
      retryCount: llmCall.retriesUsed,
      status: "NEEDS_REVIEW",
      summary: taskReason,
      payloadJson: JSON.stringify({
        proposalId: proposal.id,
        inboundEmailId,
        humanTaskId: taskRow!.id,
      }),
      createdAt: now,
    });

    return {
      proposalId: proposal.id,
      inboundEmailId,
      intent: "UNCLEAR",
      confidence: effectiveConfidence,
      proposalStatus: proposal.status,
      rfpStatus: rfp.status,
      acceptedLaneCodes: [],
      rejectedLaneCodes: [],
      humanTaskCreated: {
        id: taskRow!.id,
        taskType: "CUSTOMER_REPLY_REVIEW",
        title: taskTitle,
        reason: taskReason,
      },
      meetingCreated: null,
    };
  }

  // Handle REJECT
  if (resolvedIntent === "REJECT") {
    for (const row of quotedLaneRows) {
      await options.db
        .update(proposalLanes)
        .set({ disposition: "CUSTOMER_DECLINED" })
        .where(eq(proposalLanes.id, row.proposalLane.id));
    }

    await options.db
      .update(proposals)
      .set({
        status: "REJECTED",
        customerReplyEmailId: inboundEmailId,
      })
      .where(eq(proposals.id, proposal.id));

    await options.db
      .update(rfps)
      .set({
        status: "CLOSED_LOST",
        updatedAt: now,
      })
      .where(eq(rfps.id, rfp.id));

    await options.db.insert(agentEvents).values({
      rfpId: rfp.id,
      laneId: null,
      agentName: "DealAgent",
      eventType: "DEAL_REJECTED",
      provider: llmCall.provider,
      model: llmCall.model,
      latencyMs: llmCall.latencyMs,
      inputTokens: llmCall.usage.inputTokens,
      outputTokens: llmCall.usage.outputTokens,
      totalTokens: llmCall.usage.totalTokens,
      costUsd: llmCall.costUsd,
      retryCount: llmCall.retriesUsed,
      status: "SUCCESS",
      summary: `Customer rejected Proposal #${proposal.id}; RFP marked CLOSED_LOST.`,
      payloadJson: JSON.stringify({
        proposalId: proposal.id,
        inboundEmailId,
        evidenceQuote: parsed.evidenceQuote,
      }),
      createdAt: now,
    });

    return {
      proposalId: proposal.id,
      inboundEmailId,
      intent: "REJECT",
      confidence: effectiveConfidence,
      proposalStatus: "REJECTED",
      rfpStatus: "CLOSED_LOST",
      acceptedLaneCodes: [],
      rejectedLaneCodes: quotedCodes,
      humanTaskCreated: null,
      meetingCreated: null,
    };
  }

  // Handle ACCEPT_ALL or ACCEPT_PARTIAL -> book accepted proposal_lanes + schedule kickoff meeting
  const acceptedLaneCodes: string[] = [];
  const rejectedLaneCodes: string[] = [];
  let acceptedTons = 0;
  let acceptedValueUsd = 0;
  let declinedCount = pLanes.filter(
    (r) => r.proposalLane.disposition === "DECLINE",
  ).length;

  for (const row of quotedLaneRows) {
    const codeUpper = row.laneCode.toUpperCase();
    if (acceptedSet.has(codeUpper)) {
      acceptedLaneCodes.push(row.laneCode);
      acceptedTons += row.proposalLane.tons;
      acceptedValueUsd += row.proposalLane.lineTotalUsd ?? 0;
      await options.db
        .update(proposalLanes)
        .set({ disposition: "ACCEPTED" })
        .where(eq(proposalLanes.id, row.proposalLane.id));
    } else {
      rejectedLaneCodes.push(row.laneCode);
      declinedCount += 1;
      await options.db
        .update(proposalLanes)
        .set({ disposition: "CUSTOMER_DECLINED" })
        .where(eq(proposalLanes.id, row.proposalLane.id));
    }
  }

  const finalProposalStatus =
    rejectedLaneCodes.length > 0 ? "PARTIALLY_ACCEPTED" : "ACCEPTED";
  const roundedTons = roundTons(acceptedTons);
  const roundedValueUsd = roundMoneyUsd(acceptedValueUsd);

  await options.db
    .update(proposals)
    .set({
      status: finalProposalStatus,
      customerReplyEmailId: inboundEmailId,
      totalQuotedLanes: acceptedLaneCodes.length,
      totalDeclinedLanes: declinedCount,
      totalTons: roundedTons,
      totalValueUsd: roundedValueUsd,
      acceptedAt: now,
    })
    .where(eq(proposals.id, proposal.id));

  const slot = computeNextBusinessDay10amET(
    options.kickoffReferenceDate ?? new Date(),
    options.meetingDurationMinutes ?? 45,
  );

  const attendees: MeetingAttendee[] = [
    {
      role: "RFP_TEAM",
      name: rfpTeamContact.name,
      email: rfpTeamContact.email,
    },
    {
      role: "CUSTOMER",
      name: rfp.customerName,
      email: rfp.customerEmail,
    },
    {
      role: "PRICING",
      name: pricingTeamContact.name,
      email: pricingTeamContact.email,
    },
    ...(options.extraAttendees ?? []),
  ];

  const meetingTitle = `Air Freight Kickoff: ${rfp.title} (${rfp.customerName})`;
  const agenda = [
    `1. Confirm booked lanes (${acceptedLaneCodes.join(", ")}) totaling ${roundedTons.toFixed(1)}t / $${roundedValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD.`,
    "2. Align carrier capacity allocation, special handling SOPs, and station cutoffs.",
    "3. Confirm Pricing rate schedule activation & billing contacts.",
    "4. Set first uplift target date and operational escalation contacts.",
  ].join("\n");

  const { uid: icsUid, icsContent } = generateKickoffIcs({
    title: meetingTitle,
    description: `${rfp.customerName} Air Freight Proposal v${proposal.version} Kickoff (${slot.scheduledAtEtDisplay})\n\nAgenda:\n${agenda}`,
    slot,
    organizer: rfpTeamContact,
    attendees,
  });

  const [meetingRow] = await options.db
    .insert(meetings)
    .values({
      rfpId: rfp.id,
      proposalId: proposal.id,
      title: meetingTitle,
      scheduledAt: slot.scheduledAtUtcIso,
      durationMinutes: slot.durationMinutes,
      attendeesJson: JSON.stringify(attendees),
      agenda,
      icsUid,
      icsContent,
      status: "SCHEDULED",
      createdAt: now,
    })
    .returning({ id: meetings.id });

  await options.db
    .update(rfps)
    .set({
      status: "DEAL_BOOKED",
      updatedAt: now,
    })
    .where(eq(rfps.id, rfp.id));

  await options.db.insert(agentEvents).values({
    rfpId: rfp.id,
    laneId: null,
    agentName: "DealAgent",
    eventType: "DEAL_ACCEPTED",
    provider: llmCall.provider,
    model: llmCall.model,
    latencyMs: llmCall.latencyMs,
    inputTokens: llmCall.usage.inputTokens,
    outputTokens: llmCall.usage.outputTokens,
    totalTokens: llmCall.usage.totalTokens,
    costUsd: llmCall.costUsd,
    retryCount: llmCall.retriesUsed,
    status: "SUCCESS",
    summary: `Proposal #${proposal.id} ${finalProposalStatus} (${acceptedLaneCodes.length} lanes, ${roundedTons.toFixed(1)}t, $${roundedValueUsd.toFixed(2)} USD).`,
    payloadJson: JSON.stringify({
      proposalId: proposal.id,
      inboundEmailId,
      acceptedLaneCodes,
      rejectedLaneCodes,
      totalTons: roundedTons,
      totalValueUsd: roundedValueUsd,
    }),
    createdAt: now,
  });

  await options.db.insert(agentEvents).values({
    rfpId: rfp.id,
    laneId: null,
    agentName: "DealAgent",
    eventType: "KICKOFF_SCHEDULED",
    provider: "deterministic-scheduler",
    model: "rfc5545-ics-v1",
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    retryCount: 0,
    status: "SUCCESS",
    summary: `Scheduled kickoff meeting #${meetingRow!.id} for ${slot.scheduledAtEtDisplay} (${attendees.length} attendees).`,
    payloadJson: JSON.stringify({
      meetingId: meetingRow!.id,
      icsUid,
      scheduledAtUtcIso: slot.scheduledAtUtcIso,
      scheduledAtEtDisplay: slot.scheduledAtEtDisplay,
      attendees,
    }),
    createdAt: now,
  });

  return {
    proposalId: proposal.id,
    inboundEmailId,
    intent: resolvedIntent,
    confidence: effectiveConfidence,
    proposalStatus: finalProposalStatus,
    rfpStatus: "DEAL_BOOKED",
    acceptedLaneCodes,
    rejectedLaneCodes,
    humanTaskCreated: null,
    meetingCreated: {
      id: meetingRow!.id,
      title: meetingTitle,
      scheduledAt: slot.scheduledAtUtcIso,
      scheduledAtEtDisplay: slot.scheduledAtEtDisplay,
      durationMinutes: slot.durationMinutes,
      attendees,
      icsUid,
      icsContent,
    },
  };
}
