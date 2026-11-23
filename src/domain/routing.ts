import {
  SERVICE_TYPES,
  type AirportCode,
  type Flight,
  type LegServiceGap,
  type Route,
  type RouteAlternative,
  type RoutingResult,
  type ServiceType,
} from "./types";

export interface FlightGraph {
  readonly adjacency: ReadonlyMap<AirportCode, readonly Flight[]>;
  readonly airports: readonly AirportCode[];
  readonly flightCount: number;
}

interface SearchState {
  readonly airport: AirportCode;
  readonly totalTransitDays: number;
  readonly legCount: number;
  readonly airports: readonly AirportCode[];
  readonly legs: readonly Flight[];
}

class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    let idx = index;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const current = this.items[idx]!;
      const parent = this.items[parentIdx]!;
      if (this.compare(current, parent) >= 0) {
        break;
      }
      this.items[idx] = parent;
      this.items[parentIdx] = current;
      idx = parentIdx;
    }
  }

  private sinkDown(index: number): void {
    let idx = index;
    const length = this.items.length;
    while (true) {
      const leftIdx = idx * 2 + 1;
      const rightIdx = idx * 2 + 2;
      let smallestIdx = idx;

      if (
        leftIdx < length &&
        this.compare(this.items[leftIdx]!, this.items[smallestIdx]!) < 0
      ) {
        smallestIdx = leftIdx;
      }
      if (
        rightIdx < length &&
        this.compare(this.items[rightIdx]!, this.items[smallestIdx]!) < 0
      ) {
        smallestIdx = rightIdx;
      }
      if (smallestIdx === idx) {
        break;
      }
      const tmp = this.items[idx]!;
      this.items[idx] = this.items[smallestIdx]!;
      this.items[smallestIdx] = tmp;
      idx = smallestIdx;
    }
  }
}

function compareAirportTuples(
  a: readonly AirportCode[],
  b: readonly AirportCode[],
): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 1) {
    const cmp = a[i]!.localeCompare(b[i]!);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return a.length - b.length;
}

function compareSearchStates(a: SearchState, b: SearchState): number {
  if (a.totalTransitDays !== b.totalTransitDays) {
    return a.totalTransitDays - b.totalTransitDays;
  }
  if (a.legCount !== b.legCount) {
    return a.legCount - b.legCount;
  }
  return compareAirportTuples(a.airports, b.airports);
}

function sortServicesCanonical(services: Iterable<ServiceType>): ServiceType[] {
  const set = new Set(services);
  return SERVICE_TYPES.filter((svc) => set.has(svc));
}

function intersectRouteServices(legs: readonly Flight[]): ServiceType[] {
  if (legs.length === 0) {
    return [...SERVICE_TYPES];
  }
  let common = new Set<ServiceType>(legs[0]!.availableServices);
  for (let i = 1; i < legs.length; i += 1) {
    const legSet = new Set<ServiceType>(legs[i]!.availableServices);
    common = new Set([...common].filter((svc) => legSet.has(svc)));
  }
  return sortServicesCanonical(common);
}

export function buildFlightGraph(flights: readonly Flight[]): FlightGraph {
  const adjacency = new Map<AirportCode, Flight[]>();
  const airportSet = new Set<AirportCode>();

  for (const flight of flights) {
    airportSet.add(flight.origin);
    airportSet.add(flight.destination);
    const list = adjacency.get(flight.origin);
    if (list) {
      list.push(flight);
    } else {
      adjacency.set(flight.origin, [flight]);
    }
  }

  for (const list of adjacency.values()) {
    list.sort((a, b) => {
      if (a.transitDays !== b.transitDays) {
        return a.transitDays - b.transitDays;
      }
      return a.destination.localeCompare(b.destination);
    });
  }

  return {
    adjacency,
    airports: [...airportSet].sort(),
    flightCount: flights.length,
  };
}

/**
 * Constrained shortest simple-path search using Dijkstra's algorithm on the
 * service-filtered flight graph.
 *
 * Complexity:
 * - Filtering each directed edge `requiredServices ⊆ flight.availableServices`
 *   takes O(|R|) time where |R| <= 5 (constant in practice).
 * - With a binary min-heap over |V| airports and |E| directed flights, each
 *   shortest-path query runs in O((|V| + |E|) log |V|) time and O(|V|) space
 *   (with tie-breaking priority key `(totalTransitDays, legCount, pathTuple)`).
 * - Because every flight has strictly positive integer `transitDays > 0`, any
 *   cycle strictly increases `(totalTransitDays, legCount)` and the lexicographic
 *   key has optimal substructure, guaranteeing globally optimal simple paths.
 * - For non-servable multi-service lanes, partial-service subset exploration
 *   runs at most 2^|R| - 2 filtered Dijkstra queries: O(2^|R| (|V| + |E|) log |V|).
 */
export function findShortestPath(
  graph: FlightGraph,
  origin: AirportCode,
  destination: AirportCode,
  requiredServices: readonly ServiceType[] = [],
): Route | null {
  const normalizedOrigin = origin.trim().toUpperCase();
  const normalizedDest = destination.trim().toUpperCase();
  const required = sortServicesCanonical(requiredServices);

  if (normalizedOrigin === normalizedDest) {
    return {
      airports: [normalizedOrigin],
      legs: [],
      totalTransitDays: 0,
      legCount: 0,
      commonServices: [...SERVICE_TYPES],
    };
  }

  const startState: SearchState = {
    airport: normalizedOrigin,
    totalTransitDays: 0,
    legCount: 0,
    airports: [normalizedOrigin],
    legs: [],
  };

  const heap = new MinHeap<SearchState>(compareSearchStates);
  const bestByAirport = new Map<AirportCode, SearchState>();
  bestByAirport.set(normalizedOrigin, startState);
  heap.push(startState);

  while (heap.size > 0) {
    const current = heap.pop()!;
    if (current.airport === normalizedDest) {
      return {
        airports: [...current.airports],
        legs: [...current.legs],
        totalTransitDays: current.totalTransitDays,
        legCount: current.legCount,
        commonServices: intersectRouteServices(current.legs),
      };
    }

    const bestRecorded = bestByAirport.get(current.airport);
    if (bestRecorded && compareSearchStates(current, bestRecorded) > 0) {
      continue;
    }

    const outgoing = graph.adjacency.get(current.airport) ?? [];
    for (const flight of outgoing) {
      if (current.airports.includes(flight.destination)) {
        continue;
      }
      if (
        required.length > 0 &&
        !required.every((svc) => flight.availableServices.includes(svc))
      ) {
        continue;
      }

      const nextState: SearchState = {
        airport: flight.destination,
        totalTransitDays: current.totalTransitDays + flight.transitDays,
        legCount: current.legCount + 1,
        airports: [...current.airports, flight.destination],
        legs: [...current.legs, flight],
      };

      const prevBest = bestByAirport.get(flight.destination);
      if (!prevBest || compareSearchStates(nextState, prevBest) < 0) {
        bestByAirport.set(flight.destination, nextState);
        heap.push(nextState);
      }
    }
  }

  return null;
}

export function computeServiceGaps(
  route: Route,
  requiredServices: readonly ServiceType[],
): LegServiceGap[] {
  const ordered = sortServicesCanonical(requiredServices);
  return ordered.map((service) => {
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

function generateSubsetsOfSize(
  items: readonly ServiceType[],
  size: number,
): ServiceType[][] {
  const results: ServiceType[][] = [];
  function backtrack(start: number, current: ServiceType[]): void {
    if (current.length === size) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      current.push(items[i]!);
      backtrack(i + 1, current);
      current.pop();
    }
  }
  backtrack(0, []);
  return results;
}

function isSubsetOf(
  candidate: readonly ServiceType[],
  superset: readonly ServiceType[],
): boolean {
  const superSetObj = new Set(superset);
  return candidate.every((item) => superSetObj.has(item));
}

function buildAlternative(
  kind: RouteAlternative["kind"],
  label: string,
  route: Route,
  requiredServices: readonly ServiceType[],
  maxTransitDays: number,
): RouteAlternative {
  const serviceGaps = computeServiceGaps(route, requiredServices);
  return {
    kind,
    label,
    route,
    daysOverLimit: Math.max(0, route.totalTransitDays - maxTransitDays),
    fulfilledServices: serviceGaps
      .filter((g) => g.fulfilled)
      .map((g) => g.service),
    missingServices: serviceGaps
      .filter((g) => !g.fulfilled)
      .map((g) => g.service),
    serviceGaps,
  };
}

export interface RouteLaneInput {
  origin: AirportCode;
  destination: AirportCode;
  requiredServices: readonly ServiceType[];
  maxTransitDays: number;
}

export function routeLane(
  graph: FlightGraph,
  input: RouteLaneInput,
): RoutingResult {
  const origin = input.origin.trim().toUpperCase();
  const destination = input.destination.trim().toUpperCase();
  const required = sortServicesCanonical(input.requiredServices);

  const bestCompliantRoute = findShortestPath(
    graph,
    origin,
    destination,
    required,
  );
  const fastestUnconstrainedRoute =
    required.length === 0
      ? bestCompliantRoute
      : findShortestPath(graph, origin, destination, []);

  const isFullyServable =
    bestCompliantRoute !== null &&
    bestCompliantRoute.totalTransitDays <= input.maxTransitDays;

  if (fastestUnconstrainedRoute === null || isFullyServable) {
    return {
      origin,
      destination,
      requiredServices: required,
      maxTransitDays: input.maxTransitDays,
      bestCompliantRoute,
      fastestUnconstrainedRoute,
      alternatives: [],
    };
  }

  const alternatives: RouteAlternative[] = [];
  const seenPaths = new Set<string>();
  const addAlternative = (alt: RouteAlternative): void => {
    const key = alt.route.airports.join("->");
    if (seenPaths.has(key)) {
      return;
    }
    seenPaths.add(key);
    alternatives.push(alt);
  };

  if (bestCompliantRoute !== null) {
    addAlternative(
      buildAlternative(
        "COMPLIANT_LATE",
        `Compliant route (+${bestCompliantRoute.totalTransitDays - input.maxTransitDays}d over max)`,
        bestCompliantRoute,
        required,
        input.maxTransitDays,
      ),
    );
  }

  if (required.length >= 2) {
    const onTimeMaximals: Array<{
      subset: ServiceType[];
      route: Route;
    }> = [];

    for (let size = required.length - 1; size >= 1; size -= 1) {
      for (const subset of generateSubsetsOfSize(required, size)) {
        if (onTimeMaximals.some((opt) => isSubsetOf(subset, opt.subset))) {
          continue;
        }
        const route = findShortestPath(graph, origin, destination, subset);
        if (route !== null && route.totalTransitDays <= input.maxTransitDays) {
          onTimeMaximals.push({ subset, route });
        }
      }
    }

    onTimeMaximals.sort((a, b) => {
      if (b.subset.length !== a.subset.length) {
        return b.subset.length - a.subset.length;
      }
      if (a.route.totalTransitDays !== b.route.totalTransitDays) {
        return a.route.totalTransitDays - b.route.totalTransitDays;
      }
      if (a.route.legCount !== b.route.legCount) {
        return a.route.legCount - b.route.legCount;
      }
      return compareAirportTuples(a.route.airports, b.route.airports);
    });

    onTimeMaximals.forEach((opt, idx) => {
      const kind = idx === 0 ? "ON_TIME_MOST_SERVICES" : "ON_TIME_PARTIAL_SUBSET";
      const label =
        idx === 0
          ? `On-time partial route (${opt.subset.length}/${required.length} services)`
          : `Alternative on-time partial route (${opt.subset.length}/${required.length} services)`;
      addAlternative(
        buildAlternative(kind, label, opt.route, required, input.maxTransitDays),
      );
    });

    if (onTimeMaximals.length === 0 && bestCompliantRoute === null) {
      const lateCandidates: Array<{ subset: ServiceType[]; route: Route }> = [];
      for (let size = required.length - 1; size >= 1; size -= 1) {
        for (const subset of generateSubsetsOfSize(required, size)) {
          const route = findShortestPath(graph, origin, destination, subset);
          if (route !== null) {
            lateCandidates.push({ subset, route });
          }
        }
        if (lateCandidates.length > 0) {
          break;
        }
      }

      lateCandidates.sort((a, b) => {
        if (a.route.totalTransitDays !== b.route.totalTransitDays) {
          return a.route.totalTransitDays - b.route.totalTransitDays;
        }
        if (a.route.legCount !== b.route.legCount) {
          return a.route.legCount - b.route.legCount;
        }
        return compareAirportTuples(a.route.airports, b.route.airports);
      });

      const topLate = lateCandidates[0];
      if (topLate) {
        addAlternative(
          buildAlternative(
            "LATE_MOST_SERVICES",
            `Fastest route covering ${topLate.subset.length}/${required.length} services (+${topLate.route.totalTransitDays - input.maxTransitDays}d over max)`,
            topLate.route,
            required,
            input.maxTransitDays,
          ),
        );
      }
    }
  }

  const fastestKey = fastestUnconstrainedRoute.airports.join("->");
  if (!seenPaths.has(fastestKey)) {
    const isOnTime =
      fastestUnconstrainedRoute.totalTransitDays <= input.maxTransitDays;
    addAlternative(
      buildAlternative(
        "FASTEST_UNCONSTRAINED",
        isOnTime
          ? "Fastest on-time route (missing requested services)"
          : `Fastest available route (+${fastestUnconstrainedRoute.totalTransitDays - input.maxTransitDays}d over max, missing services)`,
        fastestUnconstrainedRoute,
        required,
        input.maxTransitDays,
      ),
    );
  }

  return {
    origin,
    destination,
    requiredServices: required,
    maxTransitDays: input.maxTransitDays,
    bestCompliantRoute,
    fastestUnconstrainedRoute,
    alternatives,
  };
}
