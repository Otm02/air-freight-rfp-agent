import path from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  approveCustomerQuote,
  computeRouteServiceCoverage,
  createPricingRequestEmail,
  draftCustomerQuote,
  handleCustomerReply,
  parsePricingReply,
  runIntakeForLane,
  sendCustomerQuote,
  sendPricingClarificationAndResolve,
  type ParsedLanePriceResult,
  type QuoteLaneDisposition,
  type QuoteLaneInput,
} from "../agents";
import {
  agentEvents,
  emails as emailsTable,
  flights as flightsTable,
  humanTasks,
  laneAssessments,
  lanes as lanesTable,
  meetings,
  pricingResponses,
  proposalLanes,
  proposals,
  rfps,
  type AppDatabase,
} from "../db";
import {
  generateMockCustomerReply,
  type CustomerReplyScenario,
} from "../deal";
import {
  assessLane,
  buildFlightGraph,
  loadDatasetFromFile,
  loadRfpBufferWithFallbackFlights,
  normalizeAirportCode,
  parseDatasetRows,
  SERVICE_DISPLAY_LABELS,
  SERVICE_TYPES,
  type Flight,
  type Lane,
  type LaneAssessment,
  type LaneStatus,
  type LegServiceGap,
  type RequirementExtraction,
  type Route,
  type RouteAlternative,
  type ServiceType,
} from "../domain";
import {
  LlmClient,
  resolveProviderConfig,
  type LlmProviderPreference,
} from "../llm";
import {
  generateMockPricingReply,
  type PricingQuoteLaneInput,
} from "../pricing";
import {
  emitAgentEvent,
  getEventsAfter,
  publishUnseenEventsAfter,
  toAgentEventView,
} from "./event-bus";
import { isWaitingForHumanState, type RfpState } from "./states";
import type {
  EmailView,
  HumanTaskView,
  LaneWorkspaceView,
  MeetingAttendeeView,
  MeetingView,
  ProposalLaneView,
  ProposalView,
  RfpListItem,
  RfpWorkspaceSnapshot,
} from "./types";

export const SHOWCASE_LANE_CODES = [
  "MEX-CDG", // FULLY_SERVABLE (direct 11d, DG)
  "DFW-MEX", // FULLY_SERVABLE (2-hop 15d <= 17d, High-value security)
  "BOG-CDG", // FULLY_SERVABLE (2-hop 9d <= 14d, Fragile)
  "HKG-LAX", // COMPLIANT_BUT_LATE (12d vs 11d, +1d late, no on-time option)
  "JFK-LAX", // COMPLIANT_BUT_LATE (18d vs 3d, Temp/DG)
  "NRT-SIN", // COMPLIANT_BUT_LATE (15d vs 10d with faster non-compliant alternative)
  "GRU-BOG", // ON_TIME_BUT_MISSING_SERVICES (8d <= 12d, missing Temp Controlled on GRU->BOG)
  "HKG-MIA", // ON_TIME_BUT_MISSING_SERVICES (two incomparable 1-service partial subsets)
  "DXB-HKG", // NO_ROUTE_IN_TIME (fastest unconstrained > maxTransitDays)
  "FAI-SIN", // UNREACHABLE (isolated ANC/FAI Alaska subnet)
] as const;

export type LlmModeOverride = "offline" | "auto";

export interface CustomLaneInput {
  origin: string;
  destination: string;
  tons: number;
  maxTransitDays: number;
  rawEmail: string;
}

export type CreateRfpInput =
  | {
      mode: "preset";
      preset: "showcase" | "full100";
      title?: string;
      customerName?: string;
      customerEmail?: string;
      llmMode?: LlmModeOverride;
    }
  | {
      mode: "xlsx";
      buffer: Buffer | Uint8Array;
      fileName?: string;
      title?: string;
      customerName?: string;
      customerEmail?: string;
      llmMode?: LlmModeOverride;
    }
  | {
      mode: "custom";
      title: string;
      customerName: string;
      customerEmail: string;
      lanes: readonly CustomLaneInput[];
      llmMode?: LlmModeOverride;
    };

const globalForSeed = globalThis as typeof globalThis & {
  __airFreightDemoSeedPromise?: Promise<number>;
};

function getMockWorkbookPath(): string {
  return path.resolve(process.cwd(), "data/Air_Freight_RFP_Mock_Data.xlsx");
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getActiveLlmInfo(preference?: LlmModeOverride): {
  provider: string;
  model: string;
  mode: "offline" | "live";
  displayLabel: string;
} {
  const cfg = resolveProviderConfig({
    provider: preference,
  });
  if (cfg.provider === "offline") {
    return {
      provider: cfg.provider,
      model: cfg.model,
      mode: "offline",
      displayLabel: "Offline Mode (Rule Engine)",
    };
  }
  return {
    provider: cfg.provider,
    model: cfg.model,
    mode: "live",
    displayLabel: `${cfg.provider.toUpperCase()} · ${cfg.model}`,
  };
}

function buildLlmClient(
  db: AppDatabase,
  preference?: LlmProviderPreference,
): LlmClient {
  return new LlmClient({
    provider: preference,
    db,
  });
}

async function getLatestEventId(db: AppDatabase, rfpId: number): Promise<number> {
  const [row] = await db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(eq(agentEvents.rfpId, rfpId))
    .orderBy(desc(agentEvents.id))
    .limit(1);
  return row?.id ?? 0;
}

async function loadFlightsFromDb(db: AppDatabase): Promise<Flight[]> {
  const rows = await db.select().from(flightsTable).orderBy(asc(flightsTable.id));
  return rows.map((row, idx) => ({
    flightNumber: idx + 1,
    origin: row.origin,
    destination: row.destination,
    transitDays: row.transitDays,
    availableServices: safeJsonParse<ServiceType[]>(
      row.availableServicesJson,
      [],
    ),
  }));
}

async function seedFlightsIntoDb(
  db: AppDatabase,
  flightList: readonly Flight[],
): Promise<void> {
  for (const flight of flightList) {
    await db
      .insert(flightsTable)
      .values({
        origin: flight.origin,
        destination: flight.destination,
        transitDays: flight.transitDays,
        availableServicesJson: JSON.stringify(flight.availableServices),
      })
      .onConflictDoNothing();
  }
}

export async function ensureFlightsLoaded(db: AppDatabase): Promise<Flight[]> {
  const existing = await loadFlightsFromDb(db);
  if (existing.length > 0) {
    return existing;
  }
  const dataset = await loadDatasetFromFile(getMockWorkbookPath());
  if (dataset.flights.length === 0) {
    throw new Error(
      `Failed to load flight transit table from ${getMockWorkbookPath()}.`,
    );
  }
  await seedFlightsIntoDb(db, dataset.flights);
  return loadFlightsFromDb(db);
}

function hydrateRouteFromAirports(
  airports: readonly string[] | null,
  flightMap: ReadonlyMap<string, Flight>,
): Route | null {
  if (!airports || airports.length < 2) {
    return null;
  }
  const legs: Flight[] = [];
  let totalTransitDays = 0;
  for (let i = 0; i < airports.length - 1; i += 1) {
    const leg = flightMap.get(`${airports[i]}->${airports[i + 1]}`);
    if (!leg) {
      return null;
    }
    legs.push(leg);
    totalTransitDays += leg.transitDays;
  }
  const commonServices = SERVICE_TYPES.filter((svc) =>
    legs.every((leg) => leg.availableServices.includes(svc)),
  );
  return {
    airports: [...airports],
    legs,
    totalTransitDays,
    legCount: legs.length,
    commonServices,
  };
}

function buildFlightEdgeMap(flights: readonly Flight[]): Map<string, Flight> {
  const map = new Map<string, Flight>();
  for (const f of flights) {
    map.set(`${f.origin}->${f.destination}`, f);
  }
  return map;
}

async function setRfpState(
  db: AppDatabase,
  rfpId: number,
  fromState: string | null,
  toState: RfpState,
  summary: string,
  options?: {
    executionMode?: "SYSTEM" | "HUMAN_GATE" | "DETERMINISTIC" | "LLM";
    status?: string;
    step?: string;
    inputSummary?: string;
    outputSummary?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(rfps)
    .set({ status: toState, updatedAt: now })
    .where(eq(rfps.id, rfpId));

  await emitAgentEvent(db, {
    rfpId,
    agentName: "Orchestrator",
    eventType:
      options?.executionMode === "HUMAN_GATE" || isWaitingForHumanState(toState)
        ? "WAITING_FOR_HUMAN"
        : "STATE_TRANSITION",
    step: options?.step ?? `TRANSITION_${toState}`,
    executionMode:
      options?.executionMode ??
      (isWaitingForHumanState(toState) ? "HUMAN_GATE" : "SYSTEM"),
    status:
      options?.status ??
      (isWaitingForHumanState(toState) ? "WAITING_FOR_HUMAN" : "SUCCESS"),
    summary,
    inputSummary:
      options?.inputSummary ??
      (fromState ? `From state: ${fromState}` : "Initial state"),
    outputSummary: options?.outputSummary ?? `Entered state: ${toState}`,
    fromState,
    toState,
    details: options?.details,
  });
}

function buildRouteTaskTitleAndReason(assessment: LaneAssessment): {
  title: string;
  reason: string;
  recommendedDisposition: QuoteLaneDisposition;
} {
  const { lane, status, routing, daysOverLimit } = assessment;
  switch (status) {
    case "COMPLIANT_BUT_LATE": {
      const routeStr = routing.bestCompliantRoute?.airports.join(" -> ") ?? "N/A";
      const onTimeAlt = routing.alternatives.find(
        (alt) => alt.daysOverLimit <= 0 && alt.route.totalTransitDays <= lane.maxTransitDays,
      );
      const altHint = onTimeAlt
        ? ` On-time partial alternative (${onTimeAlt.route.airports.join(" -> ")}, ${onTimeAlt.route.totalTransitDays}d) is also available missing ${onTimeAlt.missingServices.join(", ")}.`
        : " No on-time non-compliant alternative exists.";
      return {
        title: `Decide route trade-off for ${lane.laneCode}: compliant route is +${daysOverLimit ?? 0}d late`,
        reason: `Compliant route ${routeStr} takes ${routing.bestCompliantRoute?.totalTransitDays ?? "?"}d vs ${lane.maxTransitDays}d max (+${daysOverLimit ?? "?"}d). Recommend quoting compliant route and requesting transit extension.${altHint}`,
        recommendedDisposition: "QUOTE_COMPLIANT_LATE",
      };
    }
    case "ON_TIME_BUT_MISSING_SERVICES": {
      const routeStr = assessment.chosenRoute?.airports.join(" -> ") ?? "N/A";
      const missing = assessment.serviceCoverage
        .filter((s) => !s.fulfilled)
        .map((s) => `${SERVICE_DISPLAY_LABELS[s.service]} on ${s.missingOnLegs.join(", ")}`)
        .join("; ");
      return {
        title: `Decide service waiver for ${lane.laneCode}: missing required services on-time`,
        reason: `No route covers all requested services at any transit time. Fastest partial on-time route ${routeStr} misses: ${missing}. Recommend quoting partial on-time option with explicit service disclosure or declining.`,
        recommendedDisposition: "QUOTE_PARTIAL_ON_TIME",
      };
    }
    case "NO_ROUTE_IN_TIME": {
      const fastest = routing.fastestUnconstrainedRoute;
      return {
        title: `Decide late waiver vs decline for ${lane.laneCode}: no route meets ${lane.maxTransitDays}d limit`,
        reason: fastest
          ? `Fastest unconstrained route ${fastest.airports.join(" -> ")} takes ${fastest.totalTransitDays}d (vs ${lane.maxTransitDays}d max) and misses requested services. Recommend declining unless customer accepts exception.`
          : `No viable route fits transit deadline.`,
        recommendedDisposition: "DECLINE",
      };
    }
    case "UNREACHABLE":
      return {
        title: `Confirm decline for unreachable lane ${lane.laneCode}`,
        reason: `Origin ${lane.origin} and destination ${lane.destination} lie in disconnected flight components on our carrier network. Recommend declining.`,
        recommendedDisposition: "DECLINE",
      };
    case "FULLY_SERVABLE":
      return {
        title: `Lane ${lane.laneCode} fully servable`,
        reason: "All services and transit constraints satisfied.",
        recommendedDisposition: "QUOTE_COMPLIANT",
      };
  }
}

export async function runIntakeAndRouting(
  db: AppDatabase,
  rfpId: number,
  options?: { llmMode?: LlmModeOverride },
): Promise<void> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  if (!rfpRow) {
    throw new Error(`RFP #${rfpId} not found.`);
  }

  const dbLanes = await db
    .select()
    .from(lanesTable)
    .where(eq(lanesTable.rfpId, rfpId))
    .orderBy(asc(lanesTable.laneNumber));

  const llm = buildLlmClient(db, options?.llmMode);
  await db
    .update(rfps)
    .set({ llmProvider: llm.provider, updatedAt: new Date().toISOString() })
    .where(eq(rfps.id, rfpId));

  await setRfpState(
    db,
    rfpId,
    rfpRow.status,
    "INTAKE",
    `Starting Intake Agent across ${dbLanes.length} shipper lane(s) (${llm.provider}/${llm.model}).`,
    {
      inputSummary: `${dbLanes.length} lanes from ${rfpRow.sourceType}`,
      outputSummary: `Intake initialized with ${llm.provider}`,
    },
  );

  // Close any stale open intake/route tasks if re-running
  await db
    .update(humanTasks)
    .set({ status: "SUPERSEDED", resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.status, "OPEN"),
        inArray(humanTasks.taskType, [
          "CONFIRM_REQUIREMENTS",
          "LANE_ROUTE_DECISION",
        ]),
      ),
    );

  let eventCursor = await getLatestEventId(db, rfpId);

  const intakeByDbLaneId = new Map<number, RequirementExtraction>();
  const needsIntakeConfirmLaneIds = new Set<number>();

  for (const row of dbLanes) {
    const domainLane: Lane = {
      laneNumber: row.laneNumber,
      laneCode: row.laneCode,
      origin: row.origin,
      destination: row.destination,
      tons: row.tons,
      maxTransitDays: row.maxTransitDays,
      rawEmail: row.rawEmail,
    };

    const intakeRes = await runIntakeForLane(domainLane, {
      llm,
      db,
      rfpId,
      laneId: row.id,
    });
    eventCursor = await publishUnseenEventsAfter(db, rfpId, eventCursor);

    intakeByDbLaneId.set(row.id, {
      ...intakeRes.ruleReading,
      requestedServices: intakeRes.mergedServices,
      confidence: intakeRes.mergedConfidence,
      needsHumanReview: intakeRes.needsHumanTask,
      reviewReason: intakeRes.humanTask?.reason ?? null,
    });

    if (intakeRes.needsHumanTask) {
      needsIntakeConfirmLaneIds.add(row.id);
    }
  }

  await setRfpState(
    db,
    rfpId,
    "INTAKE",
    "ROUTING",
    `Running deterministic flight-graph routing & compliance checks on ${dbLanes.length} lane(s).`,
    {
      executionMode: "DETERMINISTIC",
      inputSummary: `${dbLanes.length} parsed lane requirement sets`,
      outputSummary: "Building flight adjacency graph & running constrained Dijkstra",
    },
  );

  const flights = await ensureFlightsLoaded(db);
  const graph = buildFlightGraph(flights);

  const counts: Record<LaneStatus, number> = {
    FULLY_SERVABLE: 0,
    COMPLIANT_BUT_LATE: 0,
    ON_TIME_BUT_MISSING_SERVICES: 0,
    NO_ROUTE_IN_TIME: 0,
    UNREACHABLE: 0,
  };
  let routeDecisionsNeeded = 0;

  for (const row of dbLanes) {
    const t0 = performance.now();
    const extraction = intakeByDbLaneId.get(row.id)!;
    const domainLane: Lane = {
      laneNumber: row.laneNumber,
      laneCode: row.laneCode,
      origin: row.origin,
      destination: row.destination,
      tons: row.tons,
      maxTransitDays: row.maxTransitDays,
      rawEmail: row.rawEmail,
    };

    const assessment = assessLane(domainLane, graph, extraction);
    const latencyMs = Math.round(performance.now() - t0);
    counts[assessment.status] += 1;

    const defaultDisposition =
      assessment.status === "FULLY_SERVABLE" && !needsIntakeConfirmLaneIds.has(row.id)
        ? "QUOTE_COMPLIANT"
        : "PENDING_REVIEW";

    const existingAssessment = await db
      .select({ id: laneAssessments.id })
      .from(laneAssessments)
      .where(eq(laneAssessments.laneId, row.id));

    const values = {
      rfpId,
      laneId: row.id,
      status: assessment.status,
      chosenRouteJson: assessment.chosenRoute
        ? JSON.stringify(assessment.chosenRoute.airports)
        : null,
      bestCompliantRouteJson: assessment.routing.bestCompliantRoute
        ? JSON.stringify(assessment.routing.bestCompliantRoute.airports)
        : null,
      fastestUnconstrainedRouteJson: assessment.routing.fastestUnconstrainedRoute
        ? JSON.stringify(assessment.routing.fastestUnconstrainedRoute.airports)
        : null,
      alternativesJson: JSON.stringify(assessment.routing.alternatives),
      serviceCoverageJson: JSON.stringify(assessment.serviceCoverage),
      daysOverLimit: assessment.daysOverLimit,
      recommendedAction: assessment.recommendedAction,
      needsHumanDecision: assessment.needsHumanDecision ? 1 : 0,
      humanDecisionReason: assessment.humanDecisionReason,
      disposition: defaultDisposition,
      createdAt: new Date().toISOString(),
    };

    if (existingAssessment.length > 0) {
      await db
        .update(laneAssessments)
        .set(values)
        .where(eq(laneAssessments.laneId, row.id));
    } else {
      await db.insert(laneAssessments).values(values);
    }

    await emitAgentEvent(db, {
      rfpId,
      laneId: row.id,
      agentName: "RoutingEngine",
      eventType: "LANE_ROUTED",
      step: `route_${row.laneCode}`,
      executionMode: "DETERMINISTIC",
      provider: "deterministic",
      model: "constrained-dijkstra-v1",
      latencyMs,
      status: assessment.needsHumanDecision ? "NEEDS_REVIEW" : "SUCCESS",
      summary: `${row.laneCode}: ${assessment.status} (${assessment.chosenRoute ? `${assessment.chosenRoute.airports.join(" -> ")} · ${assessment.chosenRoute.totalTransitDays}d` : "no route"})`,
      inputSummary: `${row.origin}->${row.destination}, max ${row.maxTransitDays}d, req=[${extraction.requestedServices.join(", ") || "STANDARD"}]`,
      outputSummary: `${assessment.status} -> ${defaultDisposition}`,
      details: {
        laneCode: row.laneCode,
        status: assessment.status,
        chosenRoute: assessment.chosenRoute?.airports ?? null,
        daysOverLimit: assessment.daysOverLimit,
      },
    });

    if (
      assessment.needsHumanDecision &&
      !needsIntakeConfirmLaneIds.has(row.id)
    ) {
      const taskCopy = buildRouteTaskTitleAndReason(assessment);
      routeDecisionsNeeded += 1;
      await db.insert(humanTasks).values({
        rfpId,
        laneId: row.id,
        laneCode: row.laneCode,
        taskType: "LANE_ROUTE_DECISION",
        title: taskCopy.title,
        reason: taskCopy.reason,
        payloadJson: JSON.stringify({
          laneId: row.id,
          laneCode: row.laneCode,
          assessmentStatus: assessment.status,
          recommendedDisposition: taskCopy.recommendedDisposition,
          daysOverLimit: assessment.daysOverLimit,
          bestCompliantRoute: assessment.routing.bestCompliantRoute?.airports ?? null,
          fastestUnconstrainedRoute:
            assessment.routing.fastestUnconstrainedRoute?.airports ?? null,
        }),
        status: "OPEN",
        createdAt: new Date().toISOString(),
      });
    }
  }

  const openConfirmCount = needsIntakeConfirmLaneIds.size;
  const totalWaiting = openConfirmCount + routeDecisionsNeeded;

  if (totalWaiting > 0) {
    await setRfpState(
      db,
      rfpId,
      "ROUTING",
      "AWAITING_REQUIREMENT_CONFIRMATION",
      `Paused for human decisions: ${openConfirmCount} requirement confirmation(s) and ${routeDecisionsNeeded} route trade-off/decline decision(s).`,
      {
        executionMode: "HUMAN_GATE",
        status: "WAITING_FOR_HUMAN",
        inputSummary: `Routed ${dbLanes.length} lanes (${counts.FULLY_SERVABLE} servable, ${counts.COMPLIANT_BUT_LATE} late, ${counts.ON_TIME_BUT_MISSING_SERVICES} partial, ${counts.NO_ROUTE_IN_TIME} over SLA, ${counts.UNREACHABLE} unreachable)`,
        outputSummary: `Created ${totalWaiting} blocking human_task(s)`,
      },
    );
  } else {
    await emitAgentEvent(db, {
      rfpId,
      agentName: "Orchestrator",
      eventType: "ROUTING_READY_FOR_PRICING",
      step: "ROUTING_COMPLETE",
      executionMode: "DETERMINISTIC",
      status: "SUCCESS",
      summary: `All ${dbLanes.length} lanes confirmed FULLY_SERVABLE; ready to request Pricing.`,
      inputSummary: `${dbLanes.length} lanes`,
      outputSummary: "0 human blockers",
    });
  }
}

export async function ensureDemoSeeded(db: AppDatabase): Promise<number> {
  const existing = await db
    .select({ id: rfps.id })
    .from(rfps)
    .orderBy(asc(rfps.id))
    .limit(1);

  if (existing[0]) {
    return existing[0].id;
  }

  if (!globalForSeed.__airFreightDemoSeedPromise) {
    globalForSeed.__airFreightDemoSeedPromise = (async () => {
      try {
        const recheck = await db
          .select({ id: rfps.id })
          .from(rfps)
          .orderBy(asc(rfps.id))
          .limit(1);
        if (recheck[0]) {
          return recheck[0].id;
        }
        return await createRfp(db, {
          mode: "preset",
          preset: "showcase",
          title: "Global Air Freight Q4 Showcase RFP (10 Lanes)",
          customerName: "Maya Lin (GlobalMed Biopharma)",
          customerEmail: "maya.lin@globalmed.example",
          llmMode: "offline",
        });
      } finally {
        globalForSeed.__airFreightDemoSeedPromise = undefined;
      }
    })();
  }

  return globalForSeed.__airFreightDemoSeedPromise;
}

export async function createRfp(
  db: AppDatabase,
  input: CreateRfpInput,
): Promise<number> {
  const existingFlights = await ensureFlightsLoaded(db);
  const now = new Date().toISOString();

  let title: string;
  let sourceType: string;
  let customerName: string;
  let customerEmail: string;
  let lanesToInsert: Lane[] = [];

  if (input.mode === "preset") {
    const dataset = await loadDatasetFromFile(getMockWorkbookPath());
    if (dataset.lanes.length === 0) {
      throw new Error("Mock workbook contains no valid lanes.");
    }
    if (input.preset === "showcase") {
      const byCode = new Map(dataset.lanes.map((l) => [l.laneCode, l]));
      lanesToInsert = SHOWCASE_LANE_CODES.map((code) => {
        const found = byCode.get(code);
        if (!found) {
          throw new Error(`Showcase lane ${code} missing in workbook.`);
        }
        return found;
      });
      title = input.title?.trim() || "Global Air Freight Q4 Showcase RFP (10 Lanes)";
      sourceType = "showcase-preset";
    } else {
      lanesToInsert = dataset.lanes;
      title = input.title?.trim() || "Full 100-Lane Air Freight Mock RFP";
      sourceType = "full-workbook-preset";
    }
    customerName = input.customerName?.trim() || "Maya Lin (GlobalMed Biopharma)";
    customerEmail = input.customerEmail?.trim() || "maya.lin@globalmed.example";
  } else if (input.mode === "xlsx") {
    const parsed = await loadRfpBufferWithFallbackFlights(
      input.buffer,
      existingFlights,
    );
    if (parsed.flights.length > 0) {
      await seedFlightsIntoDb(db, parsed.flights);
    }
    if (parsed.lanes.length === 0) {
      const firstErr =
        parsed.issues[0]?.message ?? "No valid RFP lanes found in uploaded workbook.";
      throw new Error(firstErr);
    }
    lanesToInsert = parsed.lanes;
    title =
      input.title?.trim() ||
      (input.fileName ? `Uploaded RFP: ${input.fileName}` : "Uploaded XLSX RFP");
    sourceType = "xlsx-upload";
    customerName = input.customerName?.trim() || "Shipper Logistics Contact";
    customerEmail = input.customerEmail?.trim() || "rfp-contact@shipper.example";
  } else {
    if (input.lanes.length === 0) {
      throw new Error("At least one lane is required for custom RFP creation.");
    }
    const rawRows = input.lanes.map((row, idx) => ({
      rowNumber: idx + 2,
      origin: row.origin,
      destination: row.destination,
      tons: row.tons,
      maxTransitDays: row.maxTransitDays,
      rawEmail: row.rawEmail,
    }));
    const transitRows = existingFlights.map((f, idx) => ({
      rowNumber: idx + 2,
      origin: f.origin,
      destination: f.destination,
      transitDays: f.transitDays,
      availableServices: f.availableServices.join(", "),
    }));
    const dataset = parseDatasetRows(rawRows, transitRows);
    const fatalErrors = dataset.issues.filter((i) => i.severity === "ERROR");
    if (dataset.lanes.length === 0 || fatalErrors.length > 0) {
      throw new Error(
        fatalErrors[0]?.message ??
          "Custom RFP lane rows contained invalid airport codes or numbers.",
      );
    }
    lanesToInsert = dataset.lanes.map((l, idx) => ({
      ...l,
      laneNumber: idx + 1,
      origin: normalizeAirportCode(l.origin) ?? l.origin,
      destination: normalizeAirportCode(l.destination) ?? l.destination,
    }));
    title = input.title.trim() || "Custom Shipper RFP";
    sourceType = "custom-email-table";
    customerName = input.customerName.trim() || "Shipper Procurement Lead";
    customerEmail = input.customerEmail.trim() || "logistics@shipper.example";
  }

  const activeInfo = getActiveLlmInfo(input.llmMode);
  const [insertedRfp] = await db
    .insert(rfps)
    .values({
      title,
      sourceType,
      status: "INTAKE",
      llmProvider: activeInfo.provider,
      customerName,
      customerEmail,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!insertedRfp) {
    throw new Error("Failed to insert RFP record.");
  }

  for (const lane of lanesToInsert) {
    await db.insert(lanesTable).values({
      rfpId: insertedRfp.id,
      laneNumber: lane.laneNumber,
      laneCode: lane.laneCode,
      origin: lane.origin,
      destination: lane.destination,
      tons: lane.tons,
      maxTransitDays: lane.maxTransitDays,
      rawEmail: lane.rawEmail,
    });
  }

  await runIntakeAndRouting(db, insertedRfp.id, {
    llmMode: input.llmMode,
  });

  return insertedRfp.id;
}

async function advanceFromConfirmationIfUnblocked(
  db: AppDatabase,
  rfpId: number,
): Promise<void> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  if (!rfpRow || rfpRow.status !== "AWAITING_REQUIREMENT_CONFIRMATION") {
    return;
  }

  const remaining = await db
    .select({ id: humanTasks.id })
    .from(humanTasks)
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.status, "OPEN"),
        inArray(humanTasks.taskType, [
          "CONFIRM_REQUIREMENTS",
          "LANE_ROUTE_DECISION",
        ]),
      ),
    );

  if (remaining.length === 0) {
    await setRfpState(
      db,
      rfpId,
      "AWAITING_REQUIREMENT_CONFIRMATION",
      "ROUTING",
      "All requirement confirmations and lane route decisions completed; ready to request Pricing.",
      {
        executionMode: "DETERMINISTIC",
        inputSummary: "0 remaining requirement/route blockers",
        outputSummary: "State ready for PRICING_REQUESTED",
      },
    );
  }
}

export async function confirmLaneRequirements(
  db: AppDatabase,
  rfpId: number,
  laneId: number,
  params: {
    requestedServices: readonly ServiceType[];
    reviewer: string;
    note?: string;
  },
): Promise<void> {
  const [laneRow] = await db
    .select()
    .from(lanesTable)
    .where(and(eq(lanesTable.id, laneId), eq(lanesTable.rfpId, rfpId)));
  if (!laneRow) {
    throw new Error(`Lane #${laneId} not found in RFP #${rfpId}.`);
  }

  const canonicalServices = SERVICE_TYPES.filter((s) =>
    params.requestedServices.includes(s),
  );
  const now = new Date().toISOString();

  await db
    .update(lanesTable)
    .set({
      requestedServicesJson: JSON.stringify(canonicalServices),
      intakeConfidence: 1.0,
      intakeSource: "HUMAN_CONFIRMED",
      intakeStatus: "CONFIRMED",
    })
    .where(eq(lanesTable.id, laneId));

  await db
    .update(humanTasks)
    .set({
      status: "RESOLVED",
      resolvedAt: now,
      resolutionJson: JSON.stringify({
        reviewer: params.reviewer,
        confirmedServices: canonicalServices,
        note: params.note ?? "Human confirmed special services.",
      }),
    })
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.laneId, laneId),
        eq(humanTasks.taskType, "CONFIRM_REQUIREMENTS"),
        eq(humanTasks.status, "OPEN"),
      ),
    );

  const flights = await ensureFlightsLoaded(db);
  const graph = buildFlightGraph(flights);
  const domainLane: Lane = {
    laneNumber: laneRow.laneNumber,
    laneCode: laneRow.laneCode,
    origin: laneRow.origin,
    destination: laneRow.destination,
    tons: laneRow.tons,
    maxTransitDays: laneRow.maxTransitDays,
    rawEmail: laneRow.rawEmail,
  };

  const extraction: RequirementExtraction = {
    requestedServices: canonicalServices,
    evidence: safeJsonParse(laneRow.evidenceJson, []),
    standardCargoQuote:
      canonicalServices.length === 0 ? "Human confirmed standard cargo" : null,
    unmappedPhrases: [],
    warnings: [],
    confidence: 1.0,
    needsHumanReview: false,
    reviewReason: null,
  };

  const assessment = assessLane(domainLane, graph, extraction);
  const defaultDisposition =
    assessment.status === "FULLY_SERVABLE" ? "QUOTE_COMPLIANT" : "PENDING_REVIEW";

  await db
    .update(laneAssessments)
    .set({
      status: assessment.status,
      chosenRouteJson: assessment.chosenRoute
        ? JSON.stringify(assessment.chosenRoute.airports)
        : null,
      bestCompliantRouteJson: assessment.routing.bestCompliantRoute
        ? JSON.stringify(assessment.routing.bestCompliantRoute.airports)
        : null,
      fastestUnconstrainedRouteJson: assessment.routing.fastestUnconstrainedRoute
        ? JSON.stringify(assessment.routing.fastestUnconstrainedRoute.airports)
        : null,
      alternativesJson: JSON.stringify(assessment.routing.alternatives),
      serviceCoverageJson: JSON.stringify(assessment.serviceCoverage),
      daysOverLimit: assessment.daysOverLimit,
      recommendedAction: assessment.recommendedAction,
      needsHumanDecision: assessment.needsHumanDecision ? 1 : 0,
      humanDecisionReason: assessment.humanDecisionReason,
      disposition: defaultDisposition,
    })
    .where(eq(laneAssessments.laneId, laneId));

  // Clear any old open route task for this lane first
  await db
    .update(humanTasks)
    .set({ status: "SUPERSEDED", resolvedAt: now })
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.laneId, laneId),
        eq(humanTasks.taskType, "LANE_ROUTE_DECISION"),
        eq(humanTasks.status, "OPEN"),
      ),
    );

  if (assessment.needsHumanDecision) {
    const copy = buildRouteTaskTitleAndReason(assessment);
    await db.insert(humanTasks).values({
      rfpId,
      laneId,
      laneCode: laneRow.laneCode,
      taskType: "LANE_ROUTE_DECISION",
      title: copy.title,
      reason: copy.reason,
      payloadJson: JSON.stringify({
        laneId,
        laneCode: laneRow.laneCode,
        assessmentStatus: assessment.status,
        recommendedDisposition: copy.recommendedDisposition,
      }),
      status: "OPEN",
      createdAt: now,
    });
  }

  await emitAgentEvent(db, {
    rfpId,
    laneId,
    agentName: "IntakeAgent",
    eventType: "REQUIREMENTS_CONFIRMED_BY_HUMAN",
    step: `confirm_req_${laneRow.laneCode}`,
    executionMode: "HUMAN_GATE",
    status: "SUCCESS",
    summary: `${params.reviewer} confirmed ${laneRow.laneCode} services [${canonicalServices.join(", ") || "STANDARD"}]; re-routed as ${assessment.status}.`,
    inputSummary: `Reviewer=${params.reviewer}`,
    outputSummary: `${assessment.status} (${defaultDisposition})`,
  });

  await advanceFromConfirmationIfUnblocked(db, rfpId);
}

export async function decideLaneDisposition(
  db: AppDatabase,
  rfpId: number,
  laneId: number,
  params: {
    disposition: QuoteLaneDisposition;
    alternativeIndex?: number;
    reviewer: string;
    note?: string;
  },
): Promise<void> {
  const [laneRow] = await db
    .select()
    .from(lanesTable)
    .where(and(eq(lanesTable.id, laneId), eq(lanesTable.rfpId, rfpId)));
  if (!laneRow) {
    throw new Error(`Lane #${laneId} not found in RFP #${rfpId}.`);
  }

  const [assessmentRow] = await db
    .select()
    .from(laneAssessments)
    .where(eq(laneAssessments.laneId, laneId));
  if (!assessmentRow) {
    throw new Error(`Assessment missing for lane #${laneId}.`);
  }

  const flights = await ensureFlightsLoaded(db);
  const flightMap = buildFlightEdgeMap(flights);
  const requestedServices = safeJsonParse<ServiceType[]>(
    laneRow.requestedServicesJson,
    [],
  );

  const bestCompliantAirports = safeJsonParse<string[] | null>(
    assessmentRow.bestCompliantRouteJson,
    null,
  );
  const fastestAirports = safeJsonParse<string[] | null>(
    assessmentRow.fastestUnconstrainedRouteJson,
    null,
  );
  const alternatives = safeJsonParse<RouteAlternative[]>(
    assessmentRow.alternativesJson,
    [],
  );
  const currentChosenAirports = safeJsonParse<string[] | null>(
    assessmentRow.chosenRouteJson,
    null,
  );

  let selectedAirports: string[] | null = null;
  if (params.disposition === "DECLINE") {
    selectedAirports = null;
  } else if (
    params.alternativeIndex !== undefined &&
    alternatives[params.alternativeIndex]
  ) {
    selectedAirports = alternatives[params.alternativeIndex]!.route.airports;
  } else if (params.disposition === "QUOTE_COMPLIANT_LATE" || params.disposition === "QUOTE_COMPLIANT") {
    selectedAirports = bestCompliantAirports ?? currentChosenAirports ?? fastestAirports;
    if (!selectedAirports) {
      throw new Error(
        `Cannot apply ${params.disposition} to ${laneRow.laneCode}: no route exists on flight network.`,
      );
    }
  } else if (params.disposition === "QUOTE_PARTIAL_ON_TIME") {
    const onTimeAlt =
      alternatives.find((a) => a.daysOverLimit <= 0) ?? alternatives[0];
    selectedAirports =
      onTimeAlt?.route.airports ?? fastestAirports ?? currentChosenAirports;
    if (!selectedAirports) {
      throw new Error(
        `Cannot apply QUOTE_PARTIAL_ON_TIME to ${laneRow.laneCode}: no route exists.`,
      );
    }
  }

  const hydratedRoute = hydrateRouteFromAirports(selectedAirports, flightMap);
  const serviceCoverage: LegServiceGap[] = computeRouteServiceCoverage(
    requestedServices,
    hydratedRoute,
  );
  const daysOverLimit = hydratedRoute
    ? hydratedRoute.totalTransitDays - laneRow.maxTransitDays
    : null;

  await db
    .update(laneAssessments)
    .set({
      disposition: params.disposition,
      chosenRouteJson: selectedAirports ? JSON.stringify(selectedAirports) : null,
      serviceCoverageJson: JSON.stringify(serviceCoverage),
      daysOverLimit,
    })
    .where(eq(laneAssessments.laneId, laneId));

  const now = new Date().toISOString();
  await db
    .update(humanTasks)
    .set({
      status: "RESOLVED",
      resolvedAt: now,
      resolutionJson: JSON.stringify({
        reviewer: params.reviewer,
        disposition: params.disposition,
        selectedAirports,
        note: params.note ?? null,
      }),
    })
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.laneId, laneId),
        eq(humanTasks.taskType, "LANE_ROUTE_DECISION"),
        eq(humanTasks.status, "OPEN"),
      ),
    );

  await emitAgentEvent(db, {
    rfpId,
    laneId,
    agentName: "RoutingEngine",
    eventType: "LANE_DECISION_APPLIED",
    step: `decide_${laneRow.laneCode}`,
    executionMode: "HUMAN_GATE",
    status: "SUCCESS",
    summary: `${params.reviewer} set ${laneRow.laneCode} disposition -> ${params.disposition}${selectedAirports ? ` (${selectedAirports.join(" -> ")})` : ""}`,
    inputSummary: `Disposition=${params.disposition}`,
    outputSummary: selectedAirports
      ? `Route=${selectedAirports.join(" -> ")}, delta=${daysOverLimit ?? 0}d`
      : "Declined lane",
  });

  await advanceFromConfirmationIfUnblocked(db, rfpId);
}

export async function requestPricing(
  db: AppDatabase,
  rfpId: number,
  options?: {
    llmMode?: LlmModeOverride;
    missingLaneIndex?: number | null;
    ambiguousLaneIndex?: number | null;
  },
): Promise<void> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  if (!rfpRow) {
    throw new Error(`RFP #${rfpId} not found.`);
  }

  const openBlockers = await db
    .select()
    .from(humanTasks)
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.status, "OPEN"),
        inArray(humanTasks.taskType, [
          "CONFIRM_REQUIREMENTS",
          "LANE_ROUTE_DECISION",
        ]),
      ),
    );

  if (openBlockers.length > 0) {
    throw new Error(
      `Cannot request pricing: ${openBlockers.length} requirement/route decision task(s) remain OPEN.`,
    );
  }

  const joined = await db
    .select({
      lane: lanesTable,
      assessment: laneAssessments,
    })
    .from(lanesTable)
    .innerJoin(laneAssessments, eq(lanesTable.id, laneAssessments.laneId))
    .where(eq(lanesTable.rfpId, rfpId))
    .orderBy(asc(lanesTable.laneNumber));

  const flights = await ensureFlightsLoaded(db);
  const flightMap = buildFlightEdgeMap(flights);

  const pricingInputs: PricingQuoteLaneInput[] = [];
  for (const row of joined) {
    if (row.assessment.disposition === "DECLINE") {
      continue;
    }
    const airports = safeJsonParse<string[] | null>(
      row.assessment.chosenRouteJson,
      null,
    );
    const route = hydrateRouteFromAirports(airports, flightMap);
    if (!route) {
      continue;
    }
    const coverage = safeJsonParse<LegServiceGap[]>(
      row.assessment.serviceCoverageJson,
      [],
    );
    const requested = safeJsonParse<ServiceType[]>(
      row.lane.requestedServicesJson,
      [],
    );
    pricingInputs.push({
      laneId: row.lane.id,
      laneNumber: row.lane.laneNumber,
      laneCode: row.lane.laneCode,
      origin: row.lane.origin,
      destination: row.lane.destination,
      tons: row.lane.tons,
      routeAirports: route.airports,
      transitDays: route.totalTransitDays,
      requestedServices: requested,
      fulfillableServices: coverage
        .filter((c) => c.fulfilled)
        .map((c) => c.service),
    });
  }

  if (pricingInputs.length === 0) {
    await setRfpState(
      db,
      rfpId,
      rfpRow.status,
      "PRICING_RECEIVED",
      "All lanes declined; no Pricing request required.",
      {
        executionMode: "DETERMINISTIC",
        inputSummary: "0 active quoted lanes",
        outputSummary: "Skipped Pricing outreach",
      },
    );
    return;
  }

  const llm = buildLlmClient(db, options?.llmMode);
  await setRfpState(
    db,
    rfpId,
    rfpRow.status,
    "PRICING_REQUESTED",
    `Sending Pricing request email for ${pricingInputs.length} active lane(s).`,
    {
      executionMode: "DETERMINISTIC",
      inputSummary: `${pricingInputs.length} routable lanes`,
      outputSummary: "Outbound Pricing Request email persisted",
    },
  );

  let eventCursor = await getLatestEventId(db, rfpId);
  await createPricingRequestEmail({
    lanes: pricingInputs,
    rfpId,
    rfpTitle: rfpRow.title,
    db,
  });
  eventCursor = await publishUnseenEventsAfter(db, rfpId, eventCursor);

  const missingIdx =
    options?.missingLaneIndex !== undefined
      ? options.missingLaneIndex
      : pricingInputs.length >= 3
        ? 1
        : null;
  const ambiguousIdx =
    options?.ambiguousLaneIndex !== undefined
      ? options.ambiguousLaneIndex
      : pricingInputs.length >= 3
        ? 2
        : null;

  const mockReply = await generateMockPricingReply({
    lanes: pricingInputs,
    rfpTitle: rfpRow.title,
    missingLaneIndex: missingIdx,
    ambiguousLaneIndex: ambiguousIdx,
    styleVariant: rfpId % 5,
    llm,
  });
  eventCursor = await publishUnseenEventsAfter(db, rfpId, eventCursor);

  await setRfpState(
    db,
    rfpId,
    "PRICING_REQUESTED",
    "PRICING_RECEIVED",
    `Received unstructured reply from Pricing Desk; parsing & validating rates for ${pricingInputs.length} lane(s).`,
    {
      executionMode: llm.provider === "offline" ? "DETERMINISTIC" : "LLM",
      inputSummary: `Subject: ${mockReply.subject}`,
      outputSummary: "Parsing USD/ton rates with schema & bounds validation",
    },
  );

  const parsed = await parsePricingReply({
    emailBody: mockReply.body,
    requestedLanes: pricingInputs,
    llm,
    db,
    rfpId,
    persistInboundEmail: {
      subject: mockReply.subject,
      sender: "pricing-desk@carrier.example",
      recipient: "rfp-response-team@carrier.example",
    },
  });
  await publishUnseenEventsAfter(db, rfpId, eventCursor);

  if (parsed.flagged.length > 0) {
    await setRfpState(
      db,
      rfpId,
      "PRICING_RECEIVED",
      "AWAITING_PRICING_FIXES",
      `Paused for Pricing fixes: ${parsed.flagged.length} lane(s) flagged (${parsed.flagged.map((f) => f.lane.laneCode).join(", ")}).`,
      {
        executionMode: "HUMAN_GATE",
        status: "WAITING_FOR_HUMAN",
        inputSummary: `${parsed.validated.length} validated, ${parsed.flagged.length} anomalous`,
        outputSummary: "Send clarification email to Pricing or enter manual USD/t",
      },
    );
  }
}

async function advanceFromPricingIfUnblocked(
  db: AppDatabase,
  rfpId: number,
): Promise<void> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  if (!rfpRow || rfpRow.status !== "AWAITING_PRICING_FIXES") {
    return;
  }

  const openPricing = await db
    .select({ id: humanTasks.id })
    .from(humanTasks)
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.status, "OPEN"),
        eq(humanTasks.taskType, "CLARIFY_PRICING"),
      ),
    );

  if (openPricing.length === 0) {
    await setRfpState(
      db,
      rfpId,
      "AWAITING_PRICING_FIXES",
      "PRICING_RECEIVED",
      "All flagged Pricing anomalies resolved; ready to draft customer quote.",
      {
        executionMode: "DETERMINISTIC",
        inputSummary: "0 remaining pricing blockers",
        outputSummary: "State ready for QUOTE_DRAFTED",
      },
    );
  }
}

export async function clarifyPricing(
  db: AppDatabase,
  rfpId: number,
  options?: { taskId?: number; llmMode?: LlmModeOverride },
): Promise<void> {
  const whereClause = options?.taskId
    ? and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.id, options.taskId),
        eq(humanTasks.taskType, "CLARIFY_PRICING"),
        eq(humanTasks.status, "OPEN"),
      )
    : and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.taskType, "CLARIFY_PRICING"),
        eq(humanTasks.status, "OPEN"),
      );

  const openTasks = await db.select().from(humanTasks).where(whereClause);
  if (openTasks.length === 0) {
    throw new Error("No open pricing clarification tasks found.");
  }

  const flights = await ensureFlightsLoaded(db);
  const flightMap = buildFlightEdgeMap(flights);
  const flaggedLanes: ParsedLanePriceResult[] = [];

  for (const task of openTasks) {
    if (!task.laneId) continue;
    const [laneRow] = await db
      .select()
      .from(lanesTable)
      .where(eq(lanesTable.id, task.laneId));
    const [assessmentRow] = await db
      .select()
      .from(laneAssessments)
      .where(eq(laneAssessments.laneId, task.laneId));
    if (!laneRow || !assessmentRow) continue;

    const airports = safeJsonParse<string[] | null>(
      assessmentRow.chosenRouteJson,
      null,
    );
    const route = hydrateRouteFromAirports(airports, flightMap);
    if (!route) continue;

    const coverage = safeJsonParse<LegServiceGap[]>(
      assessmentRow.serviceCoverageJson,
      [],
    );
    const requested = safeJsonParse<ServiceType[]>(
      laneRow.requestedServicesJson,
      [],
    );
    const payload = safeJsonParse<Record<string, unknown>>(task.payloadJson, {});

    flaggedLanes.push({
      lane: {
        laneId: laneRow.id,
        laneNumber: laneRow.laneNumber,
        laneCode: laneRow.laneCode,
        origin: laneRow.origin,
        destination: laneRow.destination,
        tons: laneRow.tons,
        routeAirports: route.airports,
        transitDays: route.totalTransitDays,
        requestedServices: requested,
        fulfillableServices: coverage
          .filter((c) => c.fulfilled)
          .map((c) => c.service),
      },
      status: "FLAGGED",
      pricePerTonUsd: null,
      unitDetected: "UNKNOWN",
      evidenceQuote:
        typeof payload.evidenceQuote === "string" ? payload.evidenceQuote : null,
      conditions:
        typeof payload.conditions === "string" ? payload.conditions : "",
      confidence: 0,
      issueType:
        (payload.issueType as ParsedLanePriceResult["issueType"]) ??
        "AMBIGUOUS_PRICE",
      issueReason: task.reason,
      candidatePricesPerTonUsd: Array.isArray(payload.candidatePricesPerTonUsd)
        ? (payload.candidatePricesPerTonUsd as number[])
        : [],
      humanTaskId: task.id,
      humanTaskTitle: task.title,
    });
  }

  const llm = buildLlmClient(db, options?.llmMode);
  const eventCursor = await getLatestEventId(db, rfpId);

  const result = await sendPricingClarificationAndResolve({
    db,
    rfpId,
    llm,
    flaggedLanes,
    styleVariant: rfpId % 3,
  });
  await publishUnseenEventsAfter(db, rfpId, eventCursor);

  await emitAgentEvent(db, {
    rfpId,
    agentName: "PricingAgent",
    eventType: "PRICING_CLARIFICATION_RESOLVED",
    step: "clarify_pricing",
    executionMode: "HUMAN_GATE",
    status: "SUCCESS",
    summary: `Pricing clarification round trip resolved ${result.resolvedTaskIds.length} lane task(s).`,
    inputSummary: `Flagged lanes: ${flaggedLanes.map((f) => f.lane.laneCode).join(", ")}`,
    outputSummary: `Validated ${result.parsedClarification.validated.length} firm USD/t rate(s)`,
  });

  await advanceFromPricingIfUnblocked(db, rfpId);
}

export async function setManualLanePrice(
  db: AppDatabase,
  rfpId: number,
  laneId: number,
  params: { pricePerTonUsd: number; reviewer: string; note?: string },
): Promise<void> {
  if (!Number.isFinite(params.pricePerTonUsd) || params.pricePerTonUsd <= 0) {
    throw new Error("Manual pricePerTonUsd must be a positive number.");
  }

  const [laneRow] = await db
    .select()
    .from(lanesTable)
    .where(and(eq(lanesTable.id, laneId), eq(lanesTable.rfpId, rfpId)));
  const [assessmentRow] = await db
    .select()
    .from(laneAssessments)
    .where(eq(laneAssessments.laneId, laneId));

  if (!laneRow || !assessmentRow) {
    throw new Error(`Lane #${laneId} not found in RFP #${rfpId}.`);
  }

  const coverage = safeJsonParse<LegServiceGap[]>(
    assessmentRow.serviceCoverageJson,
    [],
  );
  const includedServices = coverage
    .filter((c) => c.fulfilled)
    .map((c) => c.service);
  const now = new Date().toISOString();
  const cleanPrice = Math.round(params.pricePerTonUsd * 100) / 100;

  await db.insert(pricingResponses).values({
    rfpId,
    laneId,
    emailId: null,
    recommendedPricePerTonUsd: cleanPrice,
    approvedPricePerTonUsd: cleanPrice,
    includedServicesJson: JSON.stringify(includedServices),
    notes:
      params.note?.trim() ||
      `Manually entered by ${params.reviewer}`,
    confidence: 1.0,
    status: "APPROVED",
    createdAt: now,
  });

  await db
    .update(humanTasks)
    .set({
      status: "RESOLVED",
      resolvedAt: now,
      resolutionJson: JSON.stringify({
        resolvedVia: "MANUAL_RATE_ENTRY",
        reviewer: params.reviewer,
        pricePerTonUsd: cleanPrice,
        note: params.note ?? null,
      }),
    })
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.laneId, laneId),
        eq(humanTasks.taskType, "CLARIFY_PRICING"),
        eq(humanTasks.status, "OPEN"),
      ),
    );

  await emitAgentEvent(db, {
    rfpId,
    laneId,
    agentName: "PricingAgent",
    eventType: "MANUAL_PRICE_APPROVED",
    step: `manual_price_${laneRow.laneCode}`,
    executionMode: "HUMAN_GATE",
    status: "SUCCESS",
    summary: `${params.reviewer} entered manual rate $${cleanPrice.toLocaleString("en-US")}/t for ${laneRow.laneCode}.`,
    inputSummary: `Reviewer=${params.reviewer}`,
    outputSummary: `Approved $${cleanPrice}/t`,
  });

  await advanceFromPricingIfUnblocked(db, rfpId);
}

export async function draftQuote(
  db: AppDatabase,
  rfpId: number,
  options?: { llmMode?: LlmModeOverride },
): Promise<number> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  if (!rfpRow) {
    throw new Error(`RFP #${rfpId} not found.`);
  }

  const openPreQuote = await db
    .select()
    .from(humanTasks)
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.status, "OPEN"),
        inArray(humanTasks.taskType, [
          "CONFIRM_REQUIREMENTS",
          "LANE_ROUTE_DECISION",
          "CLARIFY_PRICING",
        ]),
      ),
    );

  if (openPreQuote.length > 0) {
    throw new Error(
      `Cannot draft quote: ${openPreQuote.length} open task(s) remain unresolved.`,
    );
  }

  const joined = await db
    .select({
      lane: lanesTable,
      assessment: laneAssessments,
    })
    .from(lanesTable)
    .innerJoin(laneAssessments, eq(lanesTable.id, laneAssessments.laneId))
    .where(eq(lanesTable.rfpId, rfpId))
    .orderBy(asc(lanesTable.laneNumber));

  const pricingRows = await db
    .select()
    .from(pricingResponses)
    .where(eq(pricingResponses.rfpId, rfpId))
    .orderBy(desc(pricingResponses.id));

  const latestPriceByLaneId = new Map<number, number>();
  for (const pr of pricingRows) {
    if (!latestPriceByLaneId.has(pr.laneId)) {
      latestPriceByLaneId.set(
        pr.laneId,
        pr.approvedPricePerTonUsd ?? pr.recommendedPricePerTonUsd,
      );
    }
  }

  const flights = await ensureFlightsLoaded(db);
  const flightMap = buildFlightEdgeMap(flights);

  const quoteInputs: QuoteLaneInput[] = joined.map(({ lane, assessment }) => {
    const requested = safeJsonParse<ServiceType[]>(lane.requestedServicesJson, []);
    const evidence = safeJsonParse<Array<{ service: ServiceType; quote: string }>>(
      lane.evidenceJson,
      [],
    );
    const chosenAirports = safeJsonParse<string[] | null>(
      assessment.chosenRouteJson,
      null,
    );
    const bestAirports = safeJsonParse<string[] | null>(
      assessment.bestCompliantRouteJson,
      null,
    );
    const fastestAirports = safeJsonParse<string[] | null>(
      assessment.fastestUnconstrainedRouteJson,
      null,
    );
    const chosenRoute = hydrateRouteFromAirports(chosenAirports, flightMap);
    const bestCompliantRoute = hydrateRouteFromAirports(bestAirports, flightMap);
    const fastestUnconstrainedRoute = hydrateRouteFromAirports(
      fastestAirports,
      flightMap,
    );
    const serviceCoverage = safeJsonParse<LegServiceGap[]>(
      assessment.serviceCoverageJson,
      [],
    );
    const alternatives = safeJsonParse<RouteAlternative[]>(
      assessment.alternativesJson,
      [],
    );

    const reconstructedAssessment: LaneAssessment = {
      lane: {
        laneNumber: lane.laneNumber,
        laneCode: lane.laneCode,
        origin: lane.origin,
        destination: lane.destination,
        tons: lane.tons,
        maxTransitDays: lane.maxTransitDays,
        rawEmail: lane.rawEmail,
      },
      extraction: {
        requestedServices: requested,
        evidence: evidence.map((e) => ({
          service: e.service,
          quote: e.quote,
          matchedPattern: "stored",
        })),
        standardCargoQuote:
          requested.length === 0 ? "Standard general cargo" : null,
        unmappedPhrases: [],
        warnings: [],
        confidence: lane.intakeConfidence ?? 1,
        needsHumanReview: false,
        reviewReason: null,
      },
      routing: {
        origin: lane.origin,
        destination: lane.destination,
        requiredServices: requested,
        maxTransitDays: lane.maxTransitDays,
        bestCompliantRoute,
        fastestUnconstrainedRoute,
        alternatives,
      },
      status: assessment.status as LaneStatus,
      chosenRoute,
      serviceCoverage,
      daysOverLimit: assessment.daysOverLimit,
      hasOnTimeNonCompliantAlternative: alternatives.some(
        (alt) => alt.daysOverLimit <= 0,
      ),
      recommendedAction:
        assessment.recommendedAction as LaneAssessment["recommendedAction"],
      needsHumanDecision: assessment.needsHumanDecision === 1,
      humanDecisionReason: assessment.humanDecisionReason,
    };

    const disposition =
      assessment.disposition === "PENDING_REVIEW"
        ? undefined
        : (assessment.disposition as QuoteLaneDisposition);

    return {
      laneId: lane.id,
      assessment: reconstructedAssessment,
      disposition,
      selectedRoute: chosenRoute,
      pricePerTonUsd:
        disposition === "DECLINE" || chosenRoute === null
          ? null
          : (latestPriceByLaneId.get(lane.id) ?? null),
    };
  });

  const llm = buildLlmClient(db, options?.llmMode);
  const eventCursor = await getLatestEventId(db, rfpId);

  const draft = await draftCustomerQuote({
    db,
    rfpId,
    customerName: rfpRow.customerName,
    customerEmail: rfpRow.customerEmail,
    rfpTitle: rfpRow.title,
    lanes: quoteInputs,
    llm,
  });
  await publishUnseenEventsAfter(db, rfpId, eventCursor);

  await setRfpState(
    db,
    rfpId,
    rfpRow.status,
    "QUOTE_DRAFTED",
    `Drafted Proposal v${draft.version} (${draft.totalQuotedLanes} quoted, ${draft.totalDeclinedLanes} declined, $${draft.totalValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}).`,
    {
      executionMode: "DETERMINISTIC",
      inputSummary: `${quoteInputs.length} assessed & priced lanes`,
      outputSummary: `Proposal #${draft.proposalId} created in Markdown & plain text`,
    },
  );

  // Supersede prior quote approval tasks if re-drafting
  await db
    .update(humanTasks)
    .set({ status: "SUPERSEDED", resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.taskType, "APPROVE_QUOTE"),
        eq(humanTasks.status, "OPEN"),
      ),
    );

  await db.insert(humanTasks).values({
    rfpId,
    laneId: null,
    laneCode: null,
    taskType: "APPROVE_QUOTE",
    title: `Approve & send Customer Proposal v${draft.version} ($${draft.totalValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
    reason: `Hard approval gate active: Proposal #${draft.proposalId} cannot be sent until a human on the RFP Response Team signs off and dispatches.`,
    payloadJson: JSON.stringify({
      proposalId: draft.proposalId,
      version: draft.version,
      quoteEmailId: draft.quoteEmailId,
      totalQuotedLanes: draft.totalQuotedLanes,
      totalDeclinedLanes: draft.totalDeclinedLanes,
      totalTons: draft.totalTons,
      totalValueUsd: draft.totalValueUsd,
    }),
    status: "OPEN",
    createdAt: new Date().toISOString(),
  });

  await setRfpState(
    db,
    rfpId,
    "QUOTE_DRAFTED",
    "AWAITING_APPROVAL",
    `Paused at human approval gate for Proposal v${draft.version}.`,
    {
      executionMode: "HUMAN_GATE",
      status: "WAITING_FOR_HUMAN",
      inputSummary: `Proposal #${draft.proposalId} (v${draft.version})`,
      outputSummary: "Requires RFP Team sign-off to unlock Send",
    },
  );

  return draft.proposalId;
}

export async function approveAndSendQuote(
  db: AppDatabase,
  rfpId: number,
  proposalId: number,
  params: {
    approvedBy: string;
    acceptOpenTaskIds?: readonly number[];
    exceptionNote?: string;
  },
): Promise<void> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  if (!rfpRow) {
    throw new Error(`RFP #${rfpId} not found.`);
  }

  const now = new Date().toISOString();
  // Resolve the explicit APPROVE_QUOTE gate task so hard check over non-approval open tasks stays pure
  await db
    .update(humanTasks)
    .set({
      status: "RESOLVED",
      resolvedAt: now,
      resolutionJson: JSON.stringify({
        approvedBy: params.approvedBy,
        proposalId,
        approvedAt: now,
      }),
    })
    .where(
      and(
        eq(humanTasks.rfpId, rfpId),
        eq(humanTasks.taskType, "APPROVE_QUOTE"),
        eq(humanTasks.status, "OPEN"),
      ),
    );

  const eventCursor = await getLatestEventId(db, rfpId);

  try {
    await approveCustomerQuote({
      db,
      proposalId,
      approvedBy: params.approvedBy,
      acceptOpenTaskIds: params.acceptOpenTaskIds,
      exceptionNote: params.exceptionNote,
    });

    await sendCustomerQuote({
      db,
      proposalId,
    });
  } catch (error) {
    // Re-open approval task if approval gate blocked due to other unresolved tasks
    await db
      .update(humanTasks)
      .set({ status: "OPEN", resolvedAt: null, resolutionJson: null })
      .where(
        and(
          eq(humanTasks.rfpId, rfpId),
          eq(humanTasks.taskType, "APPROVE_QUOTE"),
          eq(humanTasks.status, "RESOLVED"),
        ),
      );
    throw error;
  }

  await publishUnseenEventsAfter(db, rfpId, eventCursor);

  await setRfpState(
    db,
    rfpId,
    rfpRow.status,
    "SENT",
    `Proposal #${proposalId} approved by ${params.approvedBy} and delivered to shipper outbox.`,
    {
      executionMode: "HUMAN_GATE",
      inputSummary: `Reviewer=${params.approvedBy}`,
      outputSummary: "Outbox updated to SENT; awaiting customer reply",
    },
  );
}

export async function processCustomerReply(
  db: AppDatabase,
  rfpId: number,
  proposalId: number,
  options: {
    scenario?: CustomerReplyScenario;
    customBody?: string;
    acceptedLaneCodes?: readonly string[];
    llmMode?: LlmModeOverride;
  },
): Promise<{
  intent: string;
  finalState: RfpState;
}> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  const [propRow] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.rfpId, rfpId)));
  if (!rfpRow || !propRow) {
    throw new Error(`Proposal #${proposalId} for RFP #${rfpId} not found.`);
  }

  const pLanes = await db
    .select({
      pl: proposalLanes,
      laneCode: lanesTable.laneCode,
      maxTransitDays: lanesTable.maxTransitDays,
    })
    .from(proposalLanes)
    .innerJoin(lanesTable, eq(proposalLanes.laneId, lanesTable.id))
    .where(eq(proposalLanes.proposalId, proposalId));

  const quotedSummary = pLanes
    .filter((r) => r.pl.disposition !== "DECLINE")
    .map((r) => ({
      laneCode: r.laneCode,
      origin: r.pl.origin,
      destination: r.pl.destination,
      tons: r.pl.tons,
      pricePerTonUsd: r.pl.pricePerTonUsd ?? 0,
      lineTotalUsd: r.pl.lineTotalUsd ?? 0,
      transitDays: r.pl.transitDays,
      maxTransitDays: r.maxTransitDays,
    }));

  const llm = buildLlmClient(db, options.llmMode);
  let eventCursor = await getLatestEventId(db, rfpId);

  let replyBody = options.customBody?.trim() ?? "";
  let replySubject = `Re: Air Freight Proposal v${propRow.version}: ${rfpRow.title}`;

  if (!replyBody) {
    const scenario = options.scenario ?? "accept_all";
    const mockReply = await generateMockCustomerReply({
      rfpTitle: rfpRow.title,
      customerName: rfpRow.customerName,
      customerEmail: rfpRow.customerEmail,
      scenario,
      quotedLanes: quotedSummary,
      acceptedLaneCodes: options.acceptedLaneCodes,
      llm,
    });
    replyBody = mockReply.body;
    replySubject = mockReply.subject;
    eventCursor = await publishUnseenEventsAfter(db, rfpId, eventCursor);
  }

  await setRfpState(
    db,
    rfpId,
    rfpRow.status,
    "CUSTOMER_REPLIED",
    `Received customer reply for Proposal #${proposalId}; running Deal Agent classifier.`,
    {
      executionMode: llm.provider === "offline" ? "DETERMINISTIC" : "LLM",
      inputSummary: `Subject: ${replySubject}`,
      outputSummary: "Evaluating intent (Accept / Partial / Reject / Question / Unclear)",
    },
  );

  const dealRes = await handleCustomerReply({
    db,
    proposalId,
    emailBody: replyBody,
    emailSubject: replySubject,
    llm,
  });
  await publishUnseenEventsAfter(db, rfpId, eventCursor);

  let finalState: RfpState;
  if (dealRes.intent === "ACCEPT_ALL" || dealRes.intent === "ACCEPT_PARTIAL") {
    finalState = "WON";
    await setRfpState(
      db,
      rfpId,
      "CUSTOMER_REPLIED",
      "WON",
      `Deal WON (${dealRes.acceptedLaneCodes.length} lanes booked, kickoff invite ${dealRes.meetingCreated?.icsUid ?? ""} generated).`,
      {
        executionMode: "DETERMINISTIC",
        inputSummary: `Intent=${dealRes.intent}`,
        outputSummary: `Booked SQL proposal & kickoff meeting`,
      },
    );
  } else if (dealRes.intent === "REJECT") {
    finalState = "LOST";
    await setRfpState(
      db,
      rfpId,
      "CUSTOMER_REPLIED",
      "LOST",
      `Proposal #${proposalId} closed LOST after customer rejection.`,
      {
        executionMode: "DETERMINISTIC",
        inputSummary: "Intent=REJECT",
        outputSummary: "Proposal marked REJECTED; zero meeting created",
      },
    );
  } else {
    finalState = "NEEDS_FOLLOW_UP";
    await setRfpState(
      db,
      rfpId,
      "CUSTOMER_REPLIED",
      "NEEDS_FOLLOW_UP",
      `Paused for human follow-up (${dealRes.humanTaskCreated?.title ?? dealRes.intent}).`,
      {
        executionMode: "HUMAN_GATE",
        status: "WAITING_FOR_HUMAN",
        inputSummary: `Intent=${dealRes.intent} (confidence=${dealRes.confidence.toFixed(2)})`,
        outputSummary: "Escalated to Human Tasks panel",
      },
    );
  }

  return { intent: dealRes.intent, finalState };
}

export async function resolveFollowUpTask(
  db: AppDatabase,
  rfpId: number,
  taskId: number,
  params: {
    reviewer: string;
    responseNote: string;
    outcome?: "RETURN_TO_SENT" | "CLOSE_LOST";
  },
): Promise<void> {
  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  const [taskRow] = await db
    .select()
    .from(humanTasks)
    .where(and(eq(humanTasks.id, taskId), eq(humanTasks.rfpId, rfpId)));
  if (!rfpRow || !taskRow) {
    throw new Error(`Task #${taskId} not found in RFP #${rfpId}.`);
  }

  const now = new Date().toISOString();
  await db
    .update(humanTasks)
    .set({
      status: "RESOLVED",
      resolvedAt: now,
      resolutionJson: JSON.stringify({
        reviewer: params.reviewer,
        responseNote: params.responseNote,
        outcome: params.outcome ?? "RETURN_TO_SENT",
      }),
    })
    .where(eq(humanTasks.id, taskId));

  if (params.responseNote.trim().length > 0) {
    await db.insert(emailsTable).values({
      rfpId,
      threadType: "CUSTOMER_QUOTE",
      direction: "outbound",
      counterparty: "customer",
      sender: "rfp-response-team@carrier.example",
      recipient: rfpRow.customerEmail,
      subject: `Re: Follow-Up on ${rfpRow.title}`,
      body: params.responseNote,
      plainTextBody: params.responseNote,
      parsedPayloadJson: JSON.stringify({ taskId, resolvedBy: params.reviewer }),
      status: "SENT",
      approvedBy: params.reviewer,
      approvedAt: now,
      sentAt: now,
      createdAt: now,
    });
  }

  const nextState: RfpState =
    params.outcome === "CLOSE_LOST" ? "LOST" : "SENT";

  await setRfpState(
    db,
    rfpId,
    rfpRow.status,
    nextState,
    `${params.reviewer} resolved follow-up task #${taskId}; RFP transitioned to ${nextState}.`,
    {
      executionMode: "HUMAN_GATE",
      inputSummary: `Task #${taskId}: ${taskRow.taskType}`,
      outputSummary: params.responseNote.slice(0, 120),
    },
  );
}

export async function listRfps(
  db: AppDatabase,
  llmMode?: LlmModeOverride,
): Promise<RfpListItem[]> {
  await ensureDemoSeeded(db);

  const rfpRows = await db.select().from(rfps).orderBy(desc(rfps.id));
  const allLanes = await db.select().from(lanesTable);
  const allTasks = await db
    .select()
    .from(humanTasks)
    .where(eq(humanTasks.status, "OPEN"));
  const allProposals = await db
    .select()
    .from(proposals)
    .orderBy(desc(proposals.version), desc(proposals.id));
  const allPricing = await db
    .select()
    .from(pricingResponses)
    .orderBy(desc(pricingResponses.id));
  const allAssessments = await db.select().from(laneAssessments);

  const activeInfo = getActiveLlmInfo(llmMode);
  const assessmentByLaneId = new Map(allAssessments.map((a) => [a.laneId, a]));

  const latestPriceByLaneId = new Map<number, number>();
  for (const pr of allPricing) {
    if (!latestPriceByLaneId.has(pr.laneId)) {
      latestPriceByLaneId.set(
        pr.laneId,
        pr.approvedPricePerTonUsd ?? pr.recommendedPricePerTonUsd,
      );
    }
  }

  return rfpRows.map((rfp) => {
    const rLanes = allLanes.filter((l) => l.rfpId === rfp.id);
    const totalTons = Math.round(rLanes.reduce((s, l) => s + l.tons, 0) * 10) / 10;
    const openTasksCount = allTasks.filter((t) => t.rfpId === rfp.id).length;
    const latestProp = allProposals.find((p) => p.rfpId === rfp.id) ?? null;

    let estimatedRevenueUsd = latestProp?.totalValueUsd ?? 0;
    if (estimatedRevenueUsd === 0) {
      for (const l of rLanes) {
        const assess = assessmentByLaneId.get(l.id);
        if (assess?.disposition === "DECLINE") continue;
        const rate = latestPriceByLaneId.get(l.id);
        if (rate) {
          estimatedRevenueUsd += l.tons * rate;
        }
      }
      estimatedRevenueUsd = Math.round(estimatedRevenueUsd * 100) / 100;
    }

    return {
      id: rfp.id,
      title: rfp.title,
      sourceType: rfp.sourceType,
      status: rfp.status,
      isWaitingForHuman: isWaitingForHumanState(rfp.status),
      llmProvider: rfp.llmProvider,
      activeModelLabel: activeInfo.displayLabel,
      customerName: rfp.customerName,
      customerEmail: rfp.customerEmail,
      laneCount: rLanes.length,
      totalTons,
      openTasksCount,
      estimatedRevenueUsd,
      proposalStatus: latestProp?.status ?? null,
      createdAt: rfp.createdAt,
      updatedAt: rfp.updatedAt,
    };
  });
}

export async function getRfpWorkspace(
  db: AppDatabase,
  rfpId: number,
  llmMode?: LlmModeOverride,
): Promise<RfpWorkspaceSnapshot | null> {
  await ensureDemoSeeded(db);

  const [rfpRow] = await db.select().from(rfps).where(eq(rfps.id, rfpId));
  if (!rfpRow) {
    return null;
  }

  const flights = await ensureFlightsLoaded(db);
  const flightMap = buildFlightEdgeMap(flights);

  const laneRows = await db
    .select()
    .from(lanesTable)
    .where(eq(lanesTable.rfpId, rfpId))
    .orderBy(asc(lanesTable.laneNumber));

  const assessmentRows = await db
    .select()
    .from(laneAssessments)
    .where(eq(laneAssessments.rfpId, rfpId));
  const assessmentByLaneId = new Map(assessmentRows.map((a) => [a.laneId, a]));

  const pricingRows = await db
    .select()
    .from(pricingResponses)
    .where(eq(pricingResponses.rfpId, rfpId))
    .orderBy(desc(pricingResponses.id));
  const latestPriceByLaneId = new Map<number, typeof pricingRows[number]>();
  for (const pr of pricingRows) {
    if (!latestPriceByLaneId.has(pr.laneId)) {
      latestPriceByLaneId.set(pr.laneId, pr);
    }
  }

  const taskRows = await db
    .select()
    .from(humanTasks)
    .where(eq(humanTasks.rfpId, rfpId))
    .orderBy(asc(humanTasks.id));

  const openTaskCountByLane = new Map<number, number>();
  for (const t of taskRows) {
    if (t.status === "OPEN" && t.laneId !== null) {
      openTaskCountByLane.set(
        t.laneId,
        (openTaskCountByLane.get(t.laneId) ?? 0) + 1,
      );
    }
  }

  const lanesView: LaneWorkspaceView[] = laneRows.map((l) => {
    const assessRow = assessmentByLaneId.get(l.id);
    const prRow = latestPriceByLaneId.get(l.id);
    const openCount = openTaskCountByLane.get(l.id) ?? 0;

    const chosenAirports = assessRow
      ? safeJsonParse<string[] | null>(assessRow.chosenRouteJson, null)
      : null;
    const bestAirports = assessRow
      ? safeJsonParse<string[] | null>(assessRow.bestCompliantRouteJson, null)
      : null;
    const fastestAirports = assessRow
      ? safeJsonParse<string[] | null>(
          assessRow.fastestUnconstrainedRouteJson,
          null,
        )
      : null;

    const assessment = assessRow
      ? {
          status: assessRow.status as LaneStatus,
          disposition: assessRow.disposition,
          daysOverLimit: assessRow.daysOverLimit,
          recommendedAction: assessRow.recommendedAction,
          needsHumanDecision: assessRow.needsHumanDecision === 1,
          humanDecisionReason: assessRow.humanDecisionReason,
          chosenRoute: hydrateRouteFromAirports(chosenAirports, flightMap),
          bestCompliantRoute: hydrateRouteFromAirports(bestAirports, flightMap),
          fastestUnconstrainedRoute: hydrateRouteFromAirports(
            fastestAirports,
            flightMap,
          ),
          alternatives: safeJsonParse<RouteAlternative[]>(
            assessRow.alternativesJson,
            [],
          ),
          serviceCoverage: safeJsonParse<LegServiceGap[]>(
            assessRow.serviceCoverageJson,
            [],
          ),
        }
      : null;

    const effectivePrice = prRow
      ? prRow.approvedPricePerTonUsd ?? prRow.recommendedPricePerTonUsd
      : null;

    const pricing = prRow && effectivePrice !== null
      ? {
          id: prRow.id,
          recommendedPricePerTonUsd: prRow.recommendedPricePerTonUsd,
          approvedPricePerTonUsd: prRow.approvedPricePerTonUsd,
          effectivePricePerTonUsd: effectivePrice,
          lineTotalUsd: Math.round(l.tons * effectivePrice * 100) / 100,
          includedServices: safeJsonParse<ServiceType[]>(
            prRow.includedServicesJson,
            [],
          ),
          notes: prRow.notes,
          confidence: prRow.confidence,
          status: prRow.status,
          createdAt: prRow.createdAt,
        }
      : null;

    const needsDecision =
      openCount > 0 ||
      (assessment?.disposition === "PENDING_REVIEW") ||
      l.intakeStatus === "NEEDS_HUMAN_CONFIRMATION";

    return {
      id: l.id,
      rfpId: l.rfpId,
      laneNumber: l.laneNumber,
      laneCode: l.laneCode,
      origin: l.origin,
      destination: l.destination,
      tons: l.tons,
      maxTransitDays: l.maxTransitDays,
      rawEmail: l.rawEmail,
      requestedServices: safeJsonParse<ServiceType[]>(l.requestedServicesJson, []),
      evidence: safeJsonParse<Array<{ service: string; quote: string }>>(
        l.evidenceJson,
        [],
      ),
      intakeConfidence: l.intakeConfidence,
      intakeSource: l.intakeSource,
      intakeStatus: l.intakeStatus,
      assessment,
      pricing,
      openTasksCount: openCount,
      needsDecision,
    };
  });

  const emailRows = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.rfpId, rfpId))
    .orderBy(asc(emailsTable.id));

  const emailsView: EmailView[] = emailRows.map((e) => ({
    id: e.id,
    rfpId: e.rfpId,
    threadType: e.threadType,
    direction: e.direction,
    counterparty: e.counterparty,
    sender: e.sender,
    recipient: e.recipient,
    subject: e.subject,
    body: e.body,
    plainTextBody: e.plainTextBody,
    parsedPayload: safeJsonParse<Record<string, unknown> | null>(
      e.parsedPayloadJson,
      null,
    ),
    status: e.status,
    approvedBy: e.approvedBy,
    approvedAt: e.approvedAt,
    sentAt: e.sentAt,
    createdAt: e.createdAt,
  }));

  const [latestPropRow] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.rfpId, rfpId))
    .orderBy(desc(proposals.version), desc(proposals.id))
    .limit(1);

  let proposalView: ProposalView | null = null;
  if (latestPropRow) {
    const pLaneRows = await db
      .select({
        pl: proposalLanes,
        laneCode: lanesTable.laneCode,
      })
      .from(proposalLanes)
      .innerJoin(lanesTable, eq(proposalLanes.laneId, lanesTable.id))
      .where(eq(proposalLanes.proposalId, latestPropRow.id))
      .orderBy(asc(proposalLanes.id));

    const pLanesView: ProposalLaneView[] = pLaneRows.map(({ pl, laneCode }) => ({
      id: pl.id,
      proposalId: pl.proposalId,
      laneId: pl.laneId,
      laneCode,
      origin: pl.origin,
      destination: pl.destination,
      tons: pl.tons,
      disposition: pl.disposition,
      routeAirports: safeJsonParse<string[]>(pl.routeAirportsJson, []),
      transitDays: pl.transitDays,
      fulfilledServices: safeJsonParse<ServiceType[]>(pl.fulfilledServicesJson, []),
      missingServices: safeJsonParse<ServiceType[]>(pl.missingServicesJson, []),
      pricePerTonUsd: pl.pricePerTonUsd,
      lineTotalUsd: pl.lineTotalUsd,
    }));

    proposalView = {
      id: latestPropRow.id,
      rfpId: latestPropRow.rfpId,
      version: latestPropRow.version,
      status: latestPropRow.status,
      quoteEmailId: latestPropRow.quoteEmailId,
      customerReplyEmailId: latestPropRow.customerReplyEmailId,
      totalQuotedLanes: latestPropRow.totalQuotedLanes,
      totalDeclinedLanes: latestPropRow.totalDeclinedLanes,
      totalTons: latestPropRow.totalTons,
      totalValueUsd: latestPropRow.totalValueUsd,
      approvedBy: latestPropRow.approvedBy,
      approvedAt: latestPropRow.approvedAt,
      sentAt: latestPropRow.sentAt,
      acceptedAt: latestPropRow.acceptedAt,
      createdAt: latestPropRow.createdAt,
      lanes: pLanesView,
    };
  }

  const [meetingRow] = await db
    .select()
    .from(meetings)
    .where(eq(meetings.rfpId, rfpId))
    .orderBy(desc(meetings.id))
    .limit(1);

  const meetingView: MeetingView | null = meetingRow
    ? {
        id: meetingRow.id,
        rfpId: meetingRow.rfpId,
        proposalId: meetingRow.proposalId,
        title: meetingRow.title,
        scheduledAt: meetingRow.scheduledAt,
        durationMinutes: meetingRow.durationMinutes,
        attendees: safeJsonParse<MeetingAttendeeView[]>(
          meetingRow.attendeesJson,
          [],
        ),
        agenda: meetingRow.agenda,
        icsUid: meetingRow.icsUid,
        icsContent: meetingRow.icsContent,
        status: meetingRow.status,
        createdAt: meetingRow.createdAt,
      }
    : null;

  const eventRows = await getEventsAfter(db, rfpId, 0);
  const eventsView = eventRows.map(toAgentEventView);

  const tasksView: HumanTaskView[] = taskRows.map((t) => ({
    id: t.id,
    rfpId: t.rfpId,
    laneId: t.laneId,
    laneCode: t.laneCode,
    taskType: t.taskType,
    title: t.title,
    reason: t.reason,
    status: t.status,
    payload: safeJsonParse<Record<string, unknown>>(t.payloadJson, {}),
    resolution: safeJsonParse<Record<string, unknown> | null>(
      t.resolutionJson,
      null,
    ),
    resolvedAt: t.resolvedAt,
    createdAt: t.createdAt,
  }));

  let estimatedRevenueUsd = proposalView?.totalValueUsd ?? 0;
  if (estimatedRevenueUsd === 0) {
    estimatedRevenueUsd =
      Math.round(
        lanesView
          .filter((l) => l.assessment?.disposition !== "DECLINE")
          .reduce((sum, l) => sum + (l.pricing?.lineTotalUsd ?? 0), 0) * 100,
      ) / 100;
  }

  const activeInfo = getActiveLlmInfo(llmMode);

  return {
    rfp: {
      id: rfpRow.id,
      title: rfpRow.title,
      sourceType: rfpRow.sourceType,
      status: rfpRow.status,
      isWaitingForHuman: isWaitingForHumanState(rfpRow.status),
      llmProvider: rfpRow.llmProvider,
      activeModelLabel: activeInfo.displayLabel,
      activeProviderMode: activeInfo.mode,
      customerName: rfpRow.customerName,
      customerEmail: rfpRow.customerEmail,
      createdAt: rfpRow.createdAt,
      updatedAt: rfpRow.updatedAt,
    },
    summary: {
      totalLanes: lanesView.length,
      totalTons: Math.round(lanesView.reduce((s, l) => s + l.tons, 0) * 10) / 10,
      servableCount: lanesView.filter(
        (l) => l.assessment?.status === "FULLY_SERVABLE",
      ).length,
      lateCount: lanesView.filter(
        (l) => l.assessment?.status === "COMPLIANT_BUT_LATE",
      ).length,
      missingServicesCount: lanesView.filter(
        (l) => l.assessment?.status === "ON_TIME_BUT_MISSING_SERVICES",
      ).length,
      noRouteInTimeCount: lanesView.filter(
        (l) => l.assessment?.status === "NO_ROUTE_IN_TIME",
      ).length,
      unreachableCount: lanesView.filter(
        (l) => l.assessment?.status === "UNREACHABLE",
      ).length,
      needsDecisionCount: lanesView.filter((l) => l.needsDecision).length,
      declinedCount: lanesView.filter(
        (l) => l.assessment?.disposition === "DECLINE",
      ).length,
      pricedLanesCount: lanesView.filter((l) => l.pricing !== null).length,
      openHumanTasksCount: tasksView.filter((t) => t.status === "OPEN").length,
      estimatedRevenueUsd,
    },
    lanes: lanesView,
    humanTasks: tasksView,
    emails: emailsView,
    proposal: proposalView,
    meeting: meetingView,
    events: eventsView,
  };
}
