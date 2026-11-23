import { extractRequirementsOffline } from "./requirements";
import { buildFlightGraph, computeServiceGaps, routeLane, type FlightGraph } from "./routing";
import {
  LANE_STATUSES,
  type AssessmentSummary,
  type Flight,
  type Lane,
  type LaneAssessment,
  type LaneStatus,
  type LegServiceGap,
  type RecommendedAction,
  type RequirementExtraction,
  type Route,
} from "./types";

function formatServiceGapsSummary(gaps: readonly LegServiceGap[]): string {
  const missing = gaps.filter((g) => !g.fulfilled);
  if (missing.length === 0) {
    return "all requested services fulfilled";
  }
  return missing
    .map((g) => `${g.service} missing on [${g.missingOnLegs.join(", ")}]`)
    .join("; ");
}

export function assessLane(
  lane: Lane,
  graph: FlightGraph,
  extractionOverride?: RequirementExtraction,
): LaneAssessment {
  const extraction =
    extractionOverride ??
    extractRequirementsOffline(lane.rawEmail, {
      origin: lane.origin,
      destination: lane.destination,
    });

  const routing = routeLane(graph, {
    origin: lane.origin,
    destination: lane.destination,
    requiredServices: extraction.requestedServices,
    maxTransitDays: lane.maxTransitDays,
  });

  let status: LaneStatus;
  if (routing.fastestUnconstrainedRoute === null) {
    status = "UNREACHABLE";
  } else if (
    routing.bestCompliantRoute !== null &&
    routing.bestCompliantRoute.totalTransitDays <= lane.maxTransitDays
  ) {
    status = "FULLY_SERVABLE";
  } else if (routing.bestCompliantRoute !== null) {
    status = "COMPLIANT_BUT_LATE";
  } else if (
    routing.fastestUnconstrainedRoute.totalTransitDays <= lane.maxTransitDays
  ) {
    status = "ON_TIME_BUT_MISSING_SERVICES";
  } else {
    status = "NO_ROUTE_IN_TIME";
  }

  const hasOnTimeNonCompliantAlternative =
    status === "COMPLIANT_BUT_LATE" &&
    routing.fastestUnconstrainedRoute !== null &&
    routing.fastestUnconstrainedRoute.totalTransitDays <= lane.maxTransitDays;

  let chosenRoute: Route | null = null;
  if (status === "FULLY_SERVABLE" || status === "COMPLIANT_BUT_LATE") {
    chosenRoute = routing.bestCompliantRoute;
  } else if (status === "ON_TIME_BUT_MISSING_SERVICES") {
    const partialOnTime = routing.alternatives.find(
      (alt) =>
        alt.kind === "ON_TIME_MOST_SERVICES" ||
        alt.kind === "FASTEST_UNCONSTRAINED",
    );
    chosenRoute = partialOnTime?.route ?? routing.fastestUnconstrainedRoute;
  } else if (status === "NO_ROUTE_IN_TIME") {
    chosenRoute = routing.fastestUnconstrainedRoute;
  }

  const serviceCoverage: LegServiceGap[] =
    chosenRoute !== null
      ? computeServiceGaps(chosenRoute, extraction.requestedServices)
      : extraction.requestedServices.map((service) => ({
          service,
          fulfilled: false,
          missingOnLegs: ["UNREACHABLE"],
        }));

  const daysOverLimit =
    chosenRoute !== null
      ? Math.max(0, chosenRoute.totalTransitDays - lane.maxTransitDays)
      : null;

  let recommendedAction: RecommendedAction;
  let needsHumanDecision: boolean;
  let humanDecisionReason: string | null = null;

  switch (status) {
    case "FULLY_SERVABLE": {
      if (extraction.needsHumanReview) {
        recommendedAction = "RESOLVE_INTAKE_AMBIGUITY_FIRST";
        needsHumanDecision = true;
        humanDecisionReason =
          extraction.reviewReason ??
          "Low-confidence requirement extraction requires analyst confirmation.";
      } else {
        recommendedAction = "AUTO_PROCEED_TO_PRICING";
        needsHumanDecision = false;
        humanDecisionReason = null;
      }
      break;
    }
    case "COMPLIANT_BUT_LATE": {
      needsHumanDecision = true;
      const compliantDays = chosenRoute?.totalTransitDays ?? 0;
      const over = daysOverLimit ?? 0;
      if (hasOnTimeNonCompliantAlternative && routing.fastestUnconstrainedRoute) {
        recommendedAction = "REVIEW_TRADE_OFF_LATE_VS_PARTIAL";
        const fast = routing.fastestUnconstrainedRoute;
        const fastGaps = computeServiceGaps(fast, extraction.requestedServices);
        humanDecisionReason =
          `Compliant route takes ${compliantDays}d (+${over}d over ${lane.maxTransitDays}d limit); ` +
          `an on-time trade-off route (${fast.airports.join(" -> ")}, ${fast.totalTransitDays}d) is available with ${formatServiceGapsSummary(fastGaps)}.`;
      } else {
        recommendedAction = "REQUEST_TRANSIT_EXTENSION_OR_DECLINE";
        humanDecisionReason =
          `Compliant route takes ${compliantDays}d (+${over}d over ${lane.maxTransitDays}d limit) ` +
          `and no route of any service level meets the ${lane.maxTransitDays}d limit.`;
      }
      break;
    }
    case "ON_TIME_BUT_MISSING_SERVICES": {
      needsHumanDecision = true;
      recommendedAction = "PROPOSE_PARTIAL_SERVICE_WAIVER_OR_DECLINE";
      const onTimePartials = routing.alternatives.filter(
        (alt) =>
          alt.kind === "ON_TIME_MOST_SERVICES" ||
          alt.kind === "ON_TIME_PARTIAL_SUBSET",
      );
      const optionNote =
        onTimePartials.length > 1
          ? ` (${onTimePartials.length} distinct on-time partial options available)`
          : "";
      humanDecisionReason =
        `No fully compliant route exists; fastest on-time option (${chosenRoute?.airports.join(" -> ") ?? "N/A"}, ` +
        `${chosenRoute?.totalTransitDays ?? 0}d) has ${formatServiceGapsSummary(serviceCoverage)}${optionNote}.`;
      break;
    }
    case "NO_ROUTE_IN_TIME": {
      needsHumanDecision = true;
      recommendedAction = "DECLINE_NO_VIABLE_OPTION";
      const over = daysOverLimit ?? 0;
      const partialLate = routing.alternatives.find(
        (alt) => alt.kind === "LATE_MOST_SERVICES",
      );
      const partialSuffix = partialLate
        ? ` Partial-service late alternative: ${partialLate.route.airports.join(" -> ")} (${partialLate.route.totalTransitDays}d, ${formatServiceGapsSummary(partialLate.serviceGaps)}).`
        : "";
      humanDecisionReason =
        `No compliant route exists and fastest route (${chosenRoute?.airports.join(" -> ") ?? "N/A"}, ` +
        `${chosenRoute?.totalTransitDays ?? 0}d) is +${over}d over the ${lane.maxTransitDays}d limit with ${formatServiceGapsSummary(serviceCoverage)}.${partialSuffix}`;
      break;
    }
    case "UNREACHABLE": {
      needsHumanDecision = true;
      recommendedAction = "DECLINE_UNREACHABLE";
      humanDecisionReason = `No directed flight path exists from ${lane.origin} to ${lane.destination} in the transit network.`;
      break;
    }
  }

  if (
    status !== "FULLY_SERVABLE" &&
    extraction.needsHumanReview &&
    extraction.reviewReason
  ) {
    humanDecisionReason = `[Intake flag: ${extraction.reviewReason}] ${humanDecisionReason}`;
  }

  return {
    lane,
    extraction,
    routing,
    status,
    chosenRoute,
    serviceCoverage,
    daysOverLimit,
    hasOnTimeNonCompliantAlternative,
    recommendedAction,
    needsHumanDecision,
    humanDecisionReason,
  };
}

export function assessAllLanes(
  lanes: readonly Lane[],
  flights: readonly Flight[],
): { assessments: LaneAssessment[]; summary: AssessmentSummary } {
  const graph = buildFlightGraph(flights);
  const statusCounts: Record<LaneStatus, number> = {
    FULLY_SERVABLE: 0,
    COMPLIANT_BUT_LATE: 0,
    ON_TIME_BUT_MISSING_SERVICES: 0,
    NO_ROUTE_IN_TIME: 0,
    UNREACHABLE: 0,
  };

  let compliantButLateWithOnTimeFallbackCount = 0;
  let compliantButLateNoOnTimeCount = 0;
  let needsHumanDecisionCount = 0;
  let autoProceedCount = 0;

  const assessments = lanes.map((lane) => {
    const assessment = assessLane(lane, graph);
    statusCounts[assessment.status] += 1;

    if (assessment.status === "COMPLIANT_BUT_LATE") {
      if (assessment.hasOnTimeNonCompliantAlternative) {
        compliantButLateWithOnTimeFallbackCount += 1;
      } else {
        compliantButLateNoOnTimeCount += 1;
      }
    }

    if (assessment.needsHumanDecision) {
      needsHumanDecisionCount += 1;
    } else {
      autoProceedCount += 1;
    }

    return assessment;
  });

  // Ensure every status key exists explicitly
  for (const st of LANE_STATUSES) {
    statusCounts[st] = statusCounts[st] ?? 0;
  }

  return {
    assessments,
    summary: {
      totalLanes: assessments.length,
      statusCounts,
      compliantButLateWithOnTimeFallbackCount,
      compliantButLateNoOnTimeCount,
      needsHumanDecisionCount,
      autoProceedCount,
    },
  };
}
