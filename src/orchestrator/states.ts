export const RFP_STATES = [
  "INTAKE",
  "ROUTING",
  "AWAITING_REQUIREMENT_CONFIRMATION",
  "PRICING_REQUESTED",
  "PRICING_RECEIVED",
  "AWAITING_PRICING_FIXES",
  "QUOTE_DRAFTED",
  "AWAITING_APPROVAL",
  "SENT",
  "CUSTOMER_REPLIED",
  "WON",
  "LOST",
  "NEEDS_FOLLOW_UP",
] as const;

export type RfpState = (typeof RFP_STATES)[number];

export const WAITING_FOR_HUMAN_STATES: ReadonlySet<string> = new Set<RfpState>([
  "AWAITING_REQUIREMENT_CONFIRMATION",
  "AWAITING_PRICING_FIXES",
  "AWAITING_APPROVAL",
  "NEEDS_FOLLOW_UP",
]);

export function isWaitingForHumanState(state: string): boolean {
  return WAITING_FOR_HUMAN_STATES.has(state);
}

export interface PipelineStageMeta {
  state: RfpState;
  shortLabel: string;
  description: string;
  isHumanGate: boolean;
}

export const PIPELINE_STAGES: readonly PipelineStageMeta[] = [
  {
    state: "INTAKE",
    shortLabel: "Intake",
    description: "Extract shipper requirements & evidence quotes",
    isHumanGate: false,
  },
  {
    state: "ROUTING",
    shortLabel: "Routing",
    description: "Deterministic constrained Dijkstra & SLA triage",
    isHumanGate: false,
  },
  {
    state: "AWAITING_REQUIREMENT_CONFIRMATION",
    shortLabel: "Req / Route Review",
    description: "Confirm ambiguous requirements & non-servable lane dispositions",
    isHumanGate: true,
  },
  {
    state: "PRICING_REQUESTED",
    shortLabel: "Pricing Sent",
    description: "Outbound rate request sent to Pricing Desk",
    isHumanGate: false,
  },
  {
    state: "PRICING_RECEIVED",
    shortLabel: "Pricing Parsed",
    description: "Unstructured Pricing reply normalized & validated",
    isHumanGate: false,
  },
  {
    state: "AWAITING_PRICING_FIXES",
    shortLabel: "Pricing Fixes",
    description: "Resolve missing or ambiguous Pricing rates",
    isHumanGate: true,
  },
  {
    state: "QUOTE_DRAFTED",
    shortLabel: "Quote Drafted",
    description: "Deterministic quote matrix + LLM framing generated",
    isHumanGate: false,
  },
  {
    state: "AWAITING_APPROVAL",
    shortLabel: "Human Approval",
    description: "Mandatory RFP Team sign-off gate before sending",
    isHumanGate: true,
  },
  {
    state: "SENT",
    shortLabel: "Quote Sent",
    description: "Delivered to shipper outbox / SMTP",
    isHumanGate: false,
  },
  {
    state: "CUSTOMER_REPLIED",
    shortLabel: "Reply Parsed",
    description: "Deal Agent classifies customer intent",
    isHumanGate: false,
  },
  {
    state: "WON",
    shortLabel: "Won / Booked",
    description: "Proposal logged to SQL & kickoff .ics scheduled",
    isHumanGate: false,
  },
  {
    state: "LOST",
    shortLabel: "Closed Lost",
    description: "Customer rejected proposal",
    isHumanGate: false,
  },
  {
    state: "NEEDS_FOLLOW_UP",
    shortLabel: "Needs Follow-Up",
    description: "Customer question or unclear reply escalated to human",
    isHumanGate: true,
  },
];

export const STATE_DISPLAY_META: Readonly<Record<string, { label: string; isHumanGate: boolean }>> =
  Object.fromEntries(
    PIPELINE_STAGES.map((s) => [s.state, { label: s.shortLabel, isHumanGate: s.isHumanGate }]),
  );
