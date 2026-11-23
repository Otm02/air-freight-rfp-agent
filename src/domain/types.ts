export const SERVICE_TYPES = [
  "TEMP_CONTROLLED",
  "DANGEROUS_GOODS",
  "HIGH_VALUE_SECURITY",
  "FRAGILE",
  "OVERSIZED",
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_DISPLAY_LABELS: Record<ServiceType, string> = {
  TEMP_CONTROLLED: "Temperature controlled (2-8 C)",
  DANGEROUS_GOODS: "Dangerous goods",
  HIGH_VALUE_SECURITY: "High-value security",
  FRAGILE: "Fragile handling",
  OVERSIZED: "Oversized cargo",
};

export type AirportCode = string;

export interface Lane {
  laneNumber: number;
  laneCode: string;
  origin: AirportCode;
  destination: AirportCode;
  tons: number;
  maxTransitDays: number;
  rawEmail: string;
}

export interface Flight {
  flightNumber: number;
  origin: AirportCode;
  destination: AirportCode;
  transitDays: number;
  availableServices: readonly ServiceType[];
}

export type DataIssueSeverity = "ERROR" | "WARNING";

export type DataSheetName = "Shipper RFP" | "Transit Table" | "Workbook";

export interface DataIssue {
  sheet: DataSheetName;
  rowNumber: number | null;
  field: string;
  severity: DataIssueSeverity;
  message: string;
  rawValue?: string;
}

export interface LoadedDataset {
  lanes: Lane[];
  flights: Flight[];
  airports: AirportCode[];
  issues: DataIssue[];
}

export interface ServiceEvidence {
  service: ServiceType;
  quote: string;
  matchedPattern: string;
}

export interface RequirementExtraction {
  requestedServices: ServiceType[];
  evidence: ServiceEvidence[];
  standardCargoQuote: string | null;
  unmappedPhrases: string[];
  warnings: string[];
  confidence: number;
  needsHumanReview: boolean;
  reviewReason: string | null;
}

export interface GoldRequirementRecord {
  laneNumber: number;
  laneCode: string;
  origin: AirportCode;
  destination: AirportCode;
  requestedServices: ServiceType[];
  standardCargo: boolean;
  expectedQuotes: Partial<Record<ServiceType, string>> & {
    standardCargo?: string;
  };
}

export interface Route {
  airports: AirportCode[];
  legs: Flight[];
  totalTransitDays: number;
  legCount: number;
  commonServices: ServiceType[];
}

export interface LegServiceGap {
  service: ServiceType;
  fulfilled: boolean;
  missingOnLegs: string[];
}

export type RouteAlternativeKind =
  | "COMPLIANT_LATE"
  | "ON_TIME_MOST_SERVICES"
  | "ON_TIME_PARTIAL_SUBSET"
  | "LATE_MOST_SERVICES"
  | "FASTEST_UNCONSTRAINED";

export interface RouteAlternative {
  kind: RouteAlternativeKind;
  label: string;
  route: Route;
  daysOverLimit: number;
  fulfilledServices: ServiceType[];
  missingServices: ServiceType[];
  serviceGaps: LegServiceGap[];
}

export interface RoutingResult {
  origin: AirportCode;
  destination: AirportCode;
  requiredServices: readonly ServiceType[];
  maxTransitDays: number;
  bestCompliantRoute: Route | null;
  fastestUnconstrainedRoute: Route | null;
  alternatives: RouteAlternative[];
}

export const LANE_STATUSES = [
  "FULLY_SERVABLE",
  "COMPLIANT_BUT_LATE",
  "ON_TIME_BUT_MISSING_SERVICES",
  "NO_ROUTE_IN_TIME",
  "UNREACHABLE",
] as const;

export type LaneStatus = (typeof LANE_STATUSES)[number];

export type RecommendedAction =
  | "AUTO_PROCEED_TO_PRICING"
  | "RESOLVE_INTAKE_AMBIGUITY_FIRST"
  | "REVIEW_TRADE_OFF_LATE_VS_PARTIAL"
  | "REQUEST_TRANSIT_EXTENSION_OR_DECLINE"
  | "PROPOSE_PARTIAL_SERVICE_WAIVER_OR_DECLINE"
  | "DECLINE_NO_VIABLE_OPTION"
  | "DECLINE_UNREACHABLE";

export interface LaneAssessment {
  lane: Lane;
  extraction: RequirementExtraction;
  routing: RoutingResult;
  status: LaneStatus;
  chosenRoute: Route | null;
  serviceCoverage: LegServiceGap[];
  daysOverLimit: number | null;
  hasOnTimeNonCompliantAlternative: boolean;
  recommendedAction: RecommendedAction;
  needsHumanDecision: boolean;
  humanDecisionReason: string | null;
}

export interface AssessmentSummary {
  totalLanes: number;
  statusCounts: Record<LaneStatus, number>;
  compliantButLateWithOnTimeFallbackCount: number;
  compliantButLateNoOnTimeCount: number;
  needsHumanDecisionCount: number;
  autoProceedCount: number;
}
