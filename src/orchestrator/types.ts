import type {
  LaneStatus,
  LegServiceGap,
  Route,
  RouteAlternative,
  ServiceType,
} from "../domain";

export interface RfpListItem {
  id: number;
  title: string;
  sourceType: string;
  status: string;
  isWaitingForHuman: boolean;
  llmProvider: string;
  activeModelLabel: string;
  customerName: string;
  customerEmail: string;
  laneCount: number;
  totalTons: number;
  openTasksCount: number;
  estimatedRevenueUsd: number;
  proposalStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HumanTaskView {
  id: number;
  rfpId: number | null;
  laneId: number | null;
  laneCode: string | null;
  taskType: string;
  title: string;
  reason: string;
  status: string;
  payload: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface LanePricingView {
  id: number;
  recommendedPricePerTonUsd: number;
  approvedPricePerTonUsd: number | null;
  effectivePricePerTonUsd: number;
  lineTotalUsd: number;
  includedServices: ServiceType[];
  notes: string;
  confidence: number;
  status: string;
  createdAt: string;
}

export interface LaneWorkspaceView {
  id: number;
  rfpId: number;
  laneNumber: number;
  laneCode: string;
  origin: string;
  destination: string;
  tons: number;
  maxTransitDays: number;
  rawEmail: string;
  requestedServices: ServiceType[];
  evidence: Array<{ service: string; quote: string }>;
  intakeConfidence: number | null;
  intakeSource: string | null;
  intakeStatus: string;
  assessment: {
    status: LaneStatus;
    disposition: string;
    daysOverLimit: number | null;
    recommendedAction: string;
    needsHumanDecision: boolean;
    humanDecisionReason: string | null;
    chosenRoute: Route | null;
    bestCompliantRoute: Route | null;
    fastestUnconstrainedRoute: Route | null;
    alternatives: RouteAlternative[];
    serviceCoverage: LegServiceGap[];
  } | null;
  pricing: LanePricingView | null;
  openTasksCount: number;
  needsDecision: boolean;
}

export interface EmailView {
  id: number;
  rfpId: number;
  threadType: string;
  direction: string;
  counterparty: string;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  plainTextBody: string | null;
  parsedPayload: Record<string, unknown> | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface ProposalLaneView {
  id: number;
  proposalId: number;
  laneId: number;
  laneCode: string;
  origin: string;
  destination: string;
  tons: number;
  disposition: string;
  routeAirports: string[];
  transitDays: number | null;
  fulfilledServices: ServiceType[];
  missingServices: ServiceType[];
  pricePerTonUsd: number | null;
  lineTotalUsd: number | null;
}

export interface ProposalView {
  id: number;
  rfpId: number;
  version: number;
  status: string;
  quoteEmailId: number | null;
  customerReplyEmailId: number | null;
  totalQuotedLanes: number;
  totalDeclinedLanes: number;
  totalTons: number;
  totalValueUsd: number;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  lanes: ProposalLaneView[];
}

export interface MeetingAttendeeView {
  role: string;
  name: string;
  email: string;
}

export interface MeetingView {
  id: number;
  rfpId: number;
  proposalId: number;
  title: string;
  scheduledAt: string;
  durationMinutes: number;
  attendees: MeetingAttendeeView[];
  agenda: string;
  icsUid: string;
  icsContent: string;
  status: string;
  createdAt: string;
}

export interface AgentEventView {
  id: number;
  rfpId: number | null;
  laneId: number | null;
  agentName: string;
  eventType: string;
  step: string;
  executionMode: "DETERMINISTIC" | "LLM" | "HUMAN_GATE" | "SYSTEM";
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  retryCount: number;
  status: string;
  summary: string;
  inputSummary: string | null;
  outputSummary: string | null;
  fromState: string | null;
  toState: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RfpSummaryStats {
  totalLanes: number;
  totalTons: number;
  servableCount: number;
  lateCount: number;
  missingServicesCount: number;
  noRouteInTimeCount: number;
  unreachableCount: number;
  needsDecisionCount: number;
  declinedCount: number;
  pricedLanesCount: number;
  openHumanTasksCount: number;
  estimatedRevenueUsd: number;
}

export interface RfpWorkspaceSnapshot {
  rfp: {
    id: number;
    title: string;
    sourceType: string;
    status: string;
    isWaitingForHuman: boolean;
    llmProvider: string;
    activeModelLabel: string;
    activeProviderMode: "offline" | "live";
    customerName: string;
    customerEmail: string;
    createdAt: string;
    updatedAt: string;
  };
  summary: RfpSummaryStats;
  lanes: LaneWorkspaceView[];
  humanTasks: HumanTaskView[];
  emails: EmailView[];
  proposal: ProposalView | null;
  meeting: MeetingView | null;
  events: AgentEventView[];
}
