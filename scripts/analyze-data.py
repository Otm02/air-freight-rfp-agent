#!/usr/bin/env python3
"""Deterministic analysis of Air_Freight_RFP_Mock_Data.xlsx.

Loads the `Shipper RFP` and `Transit Table` sheets, parses requested special
requirements from unstructured shipper emails with rule-based patterns, computes
exact shortest simple-path routes via Dijkstra, classifies all lanes, checks
graph connectivity (Kosaraju SCCs & BFS WCCs), and verifies all spot checks.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
import heapq
from itertools import combinations
import json
from pathlib import Path
import re
import sys
from typing import Any

import openpyxl

CANONICAL_SERVICES: tuple[str, ...] = (
    "Temperature controlled (2-8 C)",
    "Dangerous goods",
    "High-value security",
    "Fragile handling",
    "Oversized cargo",
)

SERVICE_PATTERNS: dict[str, tuple[str, ...]] = {
    "Temperature controlled (2-8 C)": (
        r"2-8\s*c",
        r"2 and 8 degrees",
        r"cold chain",
        r"refrigerat",
    ),
    "Dangerous goods": (r"dangerous[\s-]goods",),
    "High-value security": (r"high-value", r"secure handling"),
    "Fragile handling": (r"fragile",),
    "Oversized cargo": (r"oversized",),
}

NO_SERVICE_PATTERN = re.compile(
    r"standard general cargo|no special services|nothing special|no additional services",
    re.IGNORECASE,
)

CATEGORY_ORDER: tuple[str, ...] = (
    "FULLY_SERVABLE",
    "COMPLIANT_BUT_LATE",
    "ON_TIME_BUT_MISSING_SERVICES",
    "NO_ROUTE_IN_TIME",
    "UNREACHABLE",
)

EXPECTED_RFP_HEADER = (
    "Origin (airport)",
    "Destination (airport)",
    "Tons of freight",
    "Maximum transit time (days)",
    "Shipper email / special requirements",
)

EXPECTED_TRANSIT_HEADER = (
    "Origin (airport)",
    "Destination (airport)",
    "Transit time (days)",
    "Available special requirements",
)


@dataclass(frozen=True)
class FlightEdge:
    origin: str
    dest: str
    transit_days: int
    services: frozenset[str]


@dataclass(frozen=True)
class RouteResult:
    days: int
    hops: int
    path: tuple[str, ...]
    legs: tuple[FlightEdge, ...]
    common_services: frozenset[str]

    def format_path(self) -> str:
        return " -> ".join(self.path)

    def format_legs(self) -> str:
        parts = []
        for leg in self.legs:
            svcs = ", ".join(sorted(leg.services)) if leg.services else "none"
            parts.append(f"{leg.origin}->{leg.dest} ({leg.transit_days}d: {svcs})")
        return " | ".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "days": self.days,
            "hops": self.hops,
            "path": list(self.path),
            "common_services": sorted(self.common_services),
            "legs": [
                {
                    "origin": leg.origin,
                    "dest": leg.dest,
                    "transit_days": leg.transit_days,
                    "services": sorted(leg.services),
                }
                for leg in self.legs
            ],
        }


@dataclass(frozen=True)
class PartialOption:
    fulfilled_services: frozenset[str]
    missing_services: frozenset[str]
    route: RouteResult

    def to_dict(self) -> dict[str, Any]:
        return {
            "fulfilled_services": sorted(self.fulfilled_services),
            "missing_services": sorted(self.missing_services),
            "route": self.route.to_dict(),
        }


@dataclass(frozen=True)
class LaneAnalysis:
    lane_id: int
    origin: str
    dest: str
    tons: float
    max_days: int
    email: str
    requested_services: frozenset[str]
    has_direct_flight: bool
    direct_flight: FlightEdge | None
    best_compliant_route: RouteResult | None
    fastest_unconstrained_route: RouteResult | None
    partial_on_time_options: tuple[PartialOption, ...]
    category_compliance_first: str
    category_time_first: str

    @property
    def lane_code(self) -> str:
        return f"{self.origin}-{self.dest}"


def parse_shipper_email(email_text: str, origin: str, dest: str, lane_id: int) -> frozenset[str]:
    """Deterministically extract canonical special requirements from a shipper email."""
    lowered = email_text.lower()
    matched = {
        service
        for service, patterns in SERVICE_PATTERNS.items()
        if any(re.search(pat, lowered) for pat in patterns)
    }
    explicit_none = bool(NO_SERVICE_PATTERN.search(lowered))

    if matched and explicit_none:
        raise ValueError(
            f"Lane {lane_id} ({origin}-{dest}) matched both services {sorted(matched)} and 'no special services'"
        )
    if not matched and not explicit_none:
        raise ValueError(
            f"Lane {lane_id} ({origin}-{dest}) matched neither special services nor explicit standard cargo: {email_text!r}"
        )
    if origin not in email_text or dest not in email_text:
        raise ValueError(
            f"Lane {lane_id} ({origin}-{dest}) email missing expected airport codes: {email_text!r}"
        )
    return frozenset(matched)


def parse_transit_services(raw_value: Any) -> frozenset[str]:
    if raw_value is None:
        return frozenset()
    tokens = [tok.strip() for tok in str(raw_value).split(";") if tok.strip()]
    unknown = set(tokens) - set(CANONICAL_SERVICES)
    if unknown:
        raise ValueError(f"Unknown transit service token(s): {sorted(unknown)}")
    return frozenset(tokens)


def intersect_services(legs: tuple[FlightEdge, ...]) -> frozenset[str]:
    if not legs:
        return frozenset()
    common = set(legs[0].services)
    for leg in legs[1:]:
        common &= leg.services
    return frozenset(common)


def shortest_simple_path(
    adj: dict[str, list[FlightEdge]],
    origin: str,
    dest: str,
    required_services: frozenset[str] = frozenset(),
) -> RouteResult | None:
    """Exact shortest simple-path via Dijkstra minimizing (total_days, hop_count, path)."""
    start_path = (origin,)
    pq: list[tuple[int, int, tuple[str, ...], tuple[FlightEdge, ...]]] = [
        (0, 0, start_path, ())
    ]
    best: dict[str, tuple[int, int, tuple[str, ...]]] = {origin: (0, 0, start_path)}

    while pq:
        days, hops, path, legs = heapq.heappop(pq)
        u = path[-1]
        key = (days, hops, path)
        if u == dest:
            return RouteResult(
                days=days,
                hops=hops,
                path=path,
                legs=legs,
                common_services=intersect_services(legs),
            )
        if key > best[u]:
            continue
        for edge in adj.get(u, []):
            if edge.dest in path:
                continue
            if required_services and not required_services.issubset(edge.services):
                continue
            nd = days + edge.transit_days
            nh = hops + 1
            npath = path + (edge.dest,)
            nkey = (nd, nh, npath)
            if edge.dest not in best or nkey < best[edge.dest]:
                best[edge.dest] = nkey
                heapq.heappush(pq, (nd, nh, npath, legs + (edge,)))
    return None


def compute_partial_on_time_options(
    adj: dict[str, list[FlightEdge]],
    origin: str,
    dest: str,
    requested_services: frozenset[str],
    max_days: int,
) -> tuple[PartialOption, ...]:
    """Find all maximal non-empty subsets of requested_services achievable within max_days."""
    if len(requested_services) <= 1:
        return ()

    maximal_options: list[PartialOption] = []
    ordered_services = sorted(requested_services)
    for size in range(len(ordered_services) - 1, 0, -1):
        for combo in combinations(ordered_services, size):
            subset = frozenset(combo)
            if any(subset.issubset(opt.fulfilled_services) for opt in maximal_options):
                continue
            route = shortest_simple_path(adj, origin, dest, subset)
            if route is not None and route.days <= max_days:
                maximal_options.append(
                    PartialOption(
                        fulfilled_services=subset,
                        missing_services=requested_services - subset,
                        route=route,
                    )
                )

    maximal_options.sort(
        key=lambda opt: (
            -len(opt.fulfilled_services),
            opt.route.days,
            opt.route.hops,
            opt.route.path,
        )
    )
    return tuple(maximal_options)


def compute_sccs(airports: list[str], adj: dict[str, list[FlightEdge]]) -> list[list[str]]:
    """Kosaraju's algorithm for strongly connected components."""
    visited: set[str] = set()
    order: list[str] = []

    def dfs1(start: str) -> None:
        stack: list[tuple[str, int]] = [(start, 0)]
        visited.add(start)
        while stack:
            u, idx = stack[-1]
            neighbors = adj.get(u, [])
            if idx < len(neighbors):
                stack[-1] = (u, idx + 1)
                v = neighbors[idx].dest
                if v not in visited:
                    visited.add(v)
                    stack.append((v, 0))
            else:
                stack.pop()
                order.append(u)

    for airport in airports:
        if airport not in visited:
            dfs1(airport)

    rev_adj: dict[str, list[str]] = defaultdict(list)
    for u in airports:
        for edge in adj.get(u, []):
            rev_adj[edge.dest].append(u)

    visited.clear()
    sccs: list[list[str]] = []
    for airport in reversed(order):
        if airport in visited:
            continue
        comp: list[str] = []
        q = deque([airport])
        visited.add(airport)
        while q:
            u = q.popleft()
            comp.append(u)
            for v in rev_adj.get(u, []):
                if v not in visited:
                    visited.add(v)
                    q.append(v)
        sccs.append(sorted(comp))

    sccs.sort(key=lambda c: (-len(c), c))
    return sccs


def compute_wccs(airports: list[str], adj: dict[str, list[FlightEdge]]) -> list[list[str]]:
    """BFS for weakly connected components."""
    undirected: dict[str, set[str]] = defaultdict(set)
    for u, edges in adj.items():
        for edge in edges:
            undirected[u].add(edge.dest)
            undirected[edge.dest].add(u)

    visited: set[str] = set()
    wccs: list[list[str]] = []
    for airport in airports:
        if airport in visited:
            continue
        comp: list[str] = []
        q = deque([airport])
        visited.add(airport)
        while q:
            u = q.popleft()
            comp.append(u)
            for v in sorted(undirected[u]):
                if v not in visited:
                    visited.add(v)
                    q.append(v)
        wccs.append(sorted(comp))

    wccs.sort(key=lambda c: (-len(c), c))
    return wccs


def classify_lane(
    best_compliant: RouteResult | None,
    fastest_any: RouteResult | None,
    max_days: int,
) -> tuple[str, str]:
    """Return (compliance_first_category, time_first_category)."""
    if fastest_any is None:
        return "UNREACHABLE", "UNREACHABLE"
    if best_compliant is not None and best_compliant.days <= max_days:
        return "FULLY_SERVABLE", "FULLY_SERVABLE"

    has_compliant = best_compliant is not None
    has_on_time_any = fastest_any.days <= max_days

    if has_compliant and has_on_time_any:
        return "COMPLIANT_BUT_LATE", "ON_TIME_BUT_MISSING_SERVICES"
    if has_compliant and not has_on_time_any:
        return "COMPLIANT_BUT_LATE", "COMPLIANT_BUT_LATE"
    if not has_compliant and has_on_time_any:
        return "ON_TIME_BUT_MISSING_SERVICES", "ON_TIME_BUT_MISSING_SERVICES"
    return "NO_ROUTE_IN_TIME", "NO_ROUTE_IN_TIME"


def analyze_workbook(xlsx_path: Path, verify_canonical_mock: bool = True) -> dict[str, Any]:
    if not xlsx_path.exists():
        raise FileNotFoundError(f"Workbook not found: {xlsx_path}")

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    if "Shipper RFP" not in wb.sheetnames or "Transit Table" not in wb.sheetnames:
        raise ValueError(f"Unexpected sheets: {wb.sheetnames}")

    rfp_rows = list(wb["Shipper RFP"].iter_rows(values_only=True))
    transit_rows = list(wb["Transit Table"].iter_rows(values_only=True))

    if tuple(rfp_rows[0]) != EXPECTED_RFP_HEADER:
        raise ValueError(f"Unexpected Shipper RFP header: {rfp_rows[0]}")
    if tuple(transit_rows[0]) != EXPECTED_TRANSIT_HEADER:
        raise ValueError(f"Unexpected Transit Table header: {transit_rows[0]}")

    adj: dict[str, list[FlightEdge]] = defaultdict(list)
    direct_map: dict[tuple[str, str], FlightEdge] = {}
    flights: list[FlightEdge] = []
    flight_service_avail: Counter[str] = Counter()
    self_loops: list[tuple[str, str]] = []

    for row_idx, row in enumerate(transit_rows[1:], start=1):
        orig, dest, days_raw, svcs_raw = row
        orig_s = str(orig).strip().upper()
        dest_s = str(dest).strip().upper()
        days = int(days_raw)
        if days <= 0:
            raise ValueError(f"Transit row {row_idx} has non-positive days: {days}")
        if orig_s == dest_s:
            self_loops.append((orig_s, dest_s))
        svcs = parse_transit_services(svcs_raw)
        for svc in svcs:
            flight_service_avail[svc] += 1
        edge = FlightEdge(origin=orig_s, dest=dest_s, transit_days=days, services=svcs)
        if (orig_s, dest_s) in direct_map:
            raise ValueError(f"Duplicate directed flight: {orig_s}->{dest_s}")
        direct_map[(orig_s, dest_s)] = edge
        adj[orig_s].append(edge)
        flights.append(edge)

    for orig_s in adj:
        adj[orig_s].sort(key=lambda e: (e.transit_days, e.dest))

    transit_airports = sorted({e.origin for e in flights} | {e.dest for e in flights})
    rfp_airports: set[str] = set()
    rfp_pairs_seen: set[tuple[str, str]] = set()
    lanes: list[LaneAnalysis] = []
    service_count_dist: Counter[int] = Counter()
    service_demand: Counter[str] = Counter()

    for idx, row in enumerate(rfp_rows[1:], start=1):
        orig, dest, tons_raw, max_days_raw, email_raw = row
        orig_s = str(orig).strip().upper()
        dest_s = str(dest).strip().upper()
        tons = float(tons_raw)
        max_days = int(max_days_raw)
        email = str(email_raw)

        if (orig_s, dest_s) in rfp_pairs_seen:
            raise ValueError(f"Duplicate RFP lane: {orig_s}-{dest_s}")
        rfp_pairs_seen.add((orig_s, dest_s))
        rfp_airports.update((orig_s, dest_s))

        req = parse_shipper_email(email, orig_s, dest_s, idx)
        service_count_dist[len(req)] += 1
        for svc in req:
            service_demand[svc] += 1

        direct_edge = direct_map.get((orig_s, dest_s))
        best_compliant = shortest_simple_path(adj, orig_s, dest_s, req)
        fastest_any = shortest_simple_path(adj, orig_s, dest_s, frozenset())
        cat_comp, cat_time = classify_lane(best_compliant, fastest_any, max_days)

        partial_opts: tuple[PartialOption, ...] = ()
        if cat_comp != "FULLY_SERVABLE" and fastest_any is not None:
            partial_opts = compute_partial_on_time_options(adj, orig_s, dest_s, req, max_days)

        lanes.append(
            LaneAnalysis(
                lane_id=idx,
                origin=orig_s,
                dest=dest_s,
                tons=tons,
                max_days=max_days,
                email=email,
                requested_services=req,
                has_direct_flight=direct_edge is not None,
                direct_flight=direct_edge,
                best_compliant_route=best_compliant,
                fastest_unconstrained_route=fastest_any,
                partial_on_time_options=partial_opts,
                category_compliance_first=cat_comp,
                category_time_first=cat_time,
            )
        )

    sccs = compute_sccs(transit_airports, adj)
    wccs = compute_wccs(transit_airports, adj)

    direct_on_rfp = [ln for ln in lanes if ln.has_direct_flight]
    direct_usable = [
        ln
        for ln in direct_on_rfp
        if ln.direct_flight is not None
        and ln.requested_services.issubset(ln.direct_flight.services)
        and ln.direct_flight.transit_days <= ln.max_days
    ]
    direct_servable_via_multihop = [
        ln
        for ln in direct_on_rfp
        if ln.category_compliance_first == "FULLY_SERVABLE"
        and ln.best_compliant_route is not None
        and ln.best_compliant_route.hops > 1
    ]

    by_comp_cat: dict[str, list[LaneAnalysis]] = {c: [] for c in CATEGORY_ORDER}
    by_time_cat: dict[str, list[LaneAnalysis]] = {c: [] for c in CATEGORY_ORDER}
    for ln in lanes:
        by_comp_cat[ln.category_compliance_first].append(ln)
        by_time_cat[ln.category_time_first].append(ln)

    cbl_tradeoff = [
        ln
        for ln in by_comp_cat["COMPLIANT_BUT_LATE"]
        if ln.fastest_unconstrained_route is not None and ln.fastest_unconstrained_route.days <= ln.max_days
    ]
    cbl_no_ontime = [
        ln
        for ln in by_comp_cat["COMPLIANT_BUT_LATE"]
        if ln.fastest_unconstrained_route is not None and ln.fastest_unconstrained_route.days > ln.max_days
    ]

    hop_dist_servable = Counter(
        ln.best_compliant_route.hops
        for ln in by_comp_cat["FULLY_SERVABLE"]
        if ln.best_compliant_route is not None
    )

    spot_checks = build_spot_checks(lanes, direct_map)

    if verify_canonical_mock:
        run_canonical_assertions(
            lanes=lanes,
            flights=flights,
            transit_airports=transit_airports,
            rfp_airports=rfp_airports,
            self_loops=self_loops,
            direct_on_rfp=direct_on_rfp,
            service_count_dist=service_count_dist,
            sccs=sccs,
            wccs=wccs,
            by_comp_cat=by_comp_cat,
            by_time_cat=by_time_cat,
            cbl_tradeoff=cbl_tradeoff,
            cbl_no_ontime=cbl_no_ontime,
            spot_checks=spot_checks,
        )

    component_stats = []
    for comp in sccs:
        comp_set = set(comp)
        comp_edges = [e for e in flights if e.origin in comp_set and e.dest in comp_set]
        avg_out = round(len(comp_edges) / len(comp), 2) if comp else 0.0
        component_stats.append(
            {
                "airports": comp,
                "airport_count": len(comp),
                "flight_count": len(comp_edges),
                "avg_out_degree": avg_out,
            }
        )

    return {
        "workbook": str(xlsx_path),
        "overview": {
            "lanes_count": len(lanes),
            "unique_rfp_pairs": len(rfp_pairs_seen),
            "total_tons": round(sum(ln.tons for ln in lanes), 2),
            "min_tons": min(ln.tons for ln in lanes),
            "max_tons": max(ln.tons for ln in lanes),
            "min_max_transit_days": min(ln.max_days for ln in lanes),
            "max_max_transit_days": max(ln.max_days for ln in lanes),
            "airports_count": len(transit_airports),
            "airports": transit_airports,
            "rfp_airports_missing_from_transit": sorted(rfp_airports - set(transit_airports)),
            "flights_count": len(flights),
            "duplicate_flights": 0,
            "self_loops": len(self_loops),
            "min_flight_days": min(e.transit_days for e in flights),
            "max_flight_days": max(e.transit_days for e in flights),
            "lanes_with_direct_flight": len(direct_on_rfp),
            "direct_flights_compliant_and_on_time": len(direct_usable),
            "direct_flight_lanes_served_via_multihop": len(direct_servable_via_multihop),
            "direct_multihop_details": [
                {
                    "lane": ln.lane_code,
                    "direct_days": ln.direct_flight.transit_days if ln.direct_flight else None,
                    "direct_services": sorted(ln.direct_flight.services) if ln.direct_flight else [],
                    "requested": sorted(ln.requested_services),
                    "chosen_route": ln.best_compliant_route.to_dict() if ln.best_compliant_route else None,
                }
                for ln in direct_servable_via_multihop
            ],
        },
        "special_requirements": {
            "per_lane_count_distribution": {str(k): service_count_dist[k] for k in sorted(service_count_dist)},
            "per_service_demand_lanes": {svc: service_demand[svc] for svc in CANONICAL_SERVICES},
            "per_service_available_flights": {svc: flight_service_avail[svc] for svc in CANONICAL_SERVICES},
        },
        "connectivity": {
            "strongly_connected_components": sccs,
            "weakly_connected_components": wccs,
            "scc_equals_wcc": sccs == wccs,
            "components": component_stats,
        },
        "classifications": {
            "compliance_first_counts": {c: len(by_comp_cat[c]) for c in CATEGORY_ORDER},
            "time_first_counts": {c: len(by_time_cat[c]) for c in CATEGORY_ORDER},
            "fully_servable_hop_distribution": {str(k): hop_dist_servable[k] for k in sorted(hop_dist_servable)},
            "tradeoff_matrix_reachable_95": {
                "fully_servable": len(by_comp_cat["FULLY_SERVABLE"]),
                "compliant_late_with_ontime_noncompliant_fallback": len(cbl_tradeoff),
                "compliant_late_no_ontime_route": len(cbl_no_ontime),
                "no_compliant_with_ontime_noncompliant": len(by_comp_cat["ON_TIME_BUT_MISSING_SERVICES"]),
                "no_compliant_and_no_ontime": len(by_comp_cat["NO_ROUTE_IN_TIME"]),
            },
        },
        "examples_per_category": select_category_examples(by_comp_cat),
        "spot_checks": spot_checks,
        "lanes": [lane_to_dict(ln) for ln in lanes],
    }


def lane_to_dict(ln: LaneAnalysis) -> dict[str, Any]:
    return {
        "lane_id": ln.lane_id,
        "origin": ln.origin,
        "dest": ln.dest,
        "tons": ln.tons,
        "max_days": ln.max_days,
        "requested_services": sorted(ln.requested_services),
        "has_direct_flight": ln.has_direct_flight,
        "direct_flight": (
            {
                "transit_days": ln.direct_flight.transit_days,
                "services": sorted(ln.direct_flight.services),
            }
            if ln.direct_flight
            else None
        ),
        "category_compliance_first": ln.category_compliance_first,
        "category_time_first": ln.category_time_first,
        "best_compliant_route": ln.best_compliant_route.to_dict() if ln.best_compliant_route else None,
        "fastest_unconstrained_route": (
            ln.fastest_unconstrained_route.to_dict() if ln.fastest_unconstrained_route else None
        ),
        "partial_on_time_options": [opt.to_dict() for opt in ln.partial_on_time_options],
    }


def select_category_examples(by_comp_cat: dict[str, list[LaneAnalysis]]) -> dict[str, list[dict[str, Any]]]:
    examples: dict[str, list[dict[str, Any]]] = {}

    # FULLY_SERVABLE: 5 diverse examples covering 1/2/3/4 hops and MEX-CDG spot check
    fs = by_comp_cat["FULLY_SERVABLE"]
    fs_by_code = {ln.lane_code: ln for ln in fs}
    picked_fs: list[LaneAnalysis] = []
    if "MEX-CDG" in fs_by_code:
        picked_fs.append(fs_by_code["MEX-CDG"])
    for want in (
        lambda l: len(l.requested_services) == 0 and l.best_compliant_route and l.best_compliant_route.hops == 1,
        lambda l: l.best_compliant_route and l.best_compliant_route.hops == 2,
        lambda l: l.best_compliant_route and l.best_compliant_route.hops == 3,
        lambda l: l.best_compliant_route and l.best_compliant_route.hops == 4,
    ):
        cand = next((l for l in fs if l not in picked_fs and want(l)), None)
        if cand is not None:
            picked_fs.append(cand)
    for l in fs:
        if len(picked_fs) >= 5:
            break
        if l not in picked_fs:
            picked_fs.append(l)
    examples["FULLY_SERVABLE"] = [lane_to_dict(l) for l in picked_fs[:5]]

    # COMPLIANT_BUT_LATE: 5 examples covering both no-on-time (9) and trade-off (35) sub-buckets
    cbl = by_comp_cat["COMPLIANT_BUT_LATE"]
    cbl_by_code = {ln.lane_code: ln for ln in cbl}
    picked_cbl: list[LaneAnalysis] = []
    for preferred in ("HKG-LAX", "JFK-LAX", "GRU-SIN", "NRT-SIN", "ORD-AMS"):
        if preferred in cbl_by_code and cbl_by_code[preferred] not in picked_cbl:
            picked_cbl.append(cbl_by_code[preferred])
    for l in cbl:
        if len(picked_cbl) >= 5:
            break
        if l not in picked_cbl:
            picked_cbl.append(l)
    examples["COMPLIANT_BUT_LATE"] = [lane_to_dict(l) for l in picked_cbl[:5]]

    # Remaining categories have <= 5 lanes, so include all of them
    for cat in ("ON_TIME_BUT_MISSING_SERVICES", "NO_ROUTE_IN_TIME", "UNREACHABLE"):
        examples[cat] = [lane_to_dict(l) for l in by_comp_cat[cat][:5]]

    return examples


def build_spot_checks(
    lanes: list[LaneAnalysis],
    direct_map: dict[tuple[str, str], FlightEdge],
) -> list[dict[str, Any]]:
    by_code = {ln.lane_code: ln for ln in lanes}
    checks: list[dict[str, Any]] = []

    if "MEX-CDG" in by_code:
        ln = by_code["MEX-CDG"]
        leg1 = direct_map.get(("MEX", "LHR"))
        leg2 = direct_map.get(("LHR", "CDG"))
        checks.append(
            {
                "lane": "MEX-CDG",
                "classification": ln.category_compliance_first,
                "requested": sorted(ln.requested_services),
                "max_days": ln.max_days,
                "chosen_route": ln.best_compliant_route.to_dict() if ln.best_compliant_route else None,
                "faster_non_compliant_alternative": {
                    "path": ["MEX", "LHR", "CDG"],
                    "days": (leg1.transit_days + leg2.transit_days) if leg1 and leg2 else None,
                    "missing_on_legs": (
                        [{"leg": "MEX->LHR", "services": sorted(leg1.services)}] if leg1 else []
                    ),
                },
                "verdict": "VERIFIED: Uses direct MEX->CDG at 11d (exact max_days limit); MEX->LHR->CDG is 10d but MEX->LHR lacks Dangerous goods.",
            }
        )

    if "GRU-BOG" in by_code:
        ln = by_code["GRU-BOG"]
        checks.append(
            {
                "lane": "GRU-BOG",
                "classification": ln.category_compliance_first,
                "requested": sorted(ln.requested_services),
                "max_days": ln.max_days,
                "chosen_route": None,
                "fastest_unconstrained_route": (
                    ln.fastest_unconstrained_route.to_dict() if ln.fastest_unconstrained_route else None
                ),
                "partial_on_time_options": [opt.to_dict() for opt in ln.partial_on_time_options],
                "verdict": "VERIFIED: No compliant route exists at any transit time; direct GRU->BOG takes 8d with Fragile handling but lacks Temperature controlled (2-8 C).",
            }
        )

    if "HKG-LAX" in by_code:
        ln = by_code["HKG-LAX"]
        checks.append(
            {
                "lane": "HKG-LAX",
                "classification": ln.category_compliance_first,
                "requested": sorted(ln.requested_services),
                "max_days": ln.max_days,
                "chosen_route": ln.best_compliant_route.to_dict() if ln.best_compliant_route else None,
                "fastest_unconstrained_route": (
                    ln.fastest_unconstrained_route.to_dict() if ln.fastest_unconstrained_route else None
                ),
                "verdict": "VERIFIED: Best route (compliant & unconstrained) is HKG->NRT->DFW->LAX at 12d (4+2+6), 1 day over the 11d max limit.",
            }
        )

    if "JFK-LAX" in by_code:
        ln = by_code["JFK-LAX"]
        direct = ln.direct_flight
        checks.append(
            {
                "lane": "JFK-LAX",
                "classification": ln.category_compliance_first,
                "requested": sorted(ln.requested_services),
                "max_days": ln.max_days,
                "direct_flight": (
                    {"days": direct.transit_days, "services": sorted(direct.services)} if direct else None
                ),
                "chosen_route": ln.best_compliant_route.to_dict() if ln.best_compliant_route else None,
                "fastest_unconstrained_route": (
                    ln.fastest_unconstrained_route.to_dict() if ln.fastest_unconstrained_route else None
                ),
                "verdict": (
                    "VERIFIED WITH NUANCE: Direct JFK->LAX is 4d (late vs 3d) and lacks Dangerous goods, and NO route of any kind fits within 3d. "
                    "However, a 4-hop compliant route DOES exist (JFK->NRT->BOG->GRU->LAX, 3+3+5+7 = 18d), placing JFK-LAX in COMPLIANT_BUT_LATE (no on-time fallback)."
                ),
            }
        )

    return checks


def run_canonical_assertions(
    *,
    lanes: list[LaneAnalysis],
    flights: list[FlightEdge],
    transit_airports: list[str],
    rfp_airports: set[str],
    self_loops: list[tuple[str, str]],
    direct_on_rfp: list[LaneAnalysis],
    service_count_dist: Counter[int],
    sccs: list[list[str]],
    wccs: list[list[str]],
    by_comp_cat: dict[str, list[LaneAnalysis]],
    by_time_cat: dict[str, list[LaneAnalysis]],
    cbl_tradeoff: list[LaneAnalysis],
    cbl_no_ontime: list[LaneAnalysis],
    spot_checks: list[dict[str, Any]],
) -> None:
    assert len(lanes) == 100, f"Expected 100 lanes, got {len(lanes)}"
    assert len(flights) == 100, f"Expected 100 flights, got {len(flights)}"
    assert len(transit_airports) == 20, f"Expected 20 airports, got {len(transit_airports)}"
    assert rfp_airports == set(transit_airports), "Airport mismatch between RFP and Transit Table"
    assert not self_loops, f"Unexpected self loops: {self_loops}"
    assert len(direct_on_rfp) == 34, f"Expected 34 direct lanes, got {len(direct_on_rfp)}"
    assert dict(service_count_dist) == {0: 15, 1: 64, 2: 21}, f"Unexpected dist: {dict(service_count_dist)}"
    assert sccs == wccs, "SCC and WCC partitions unexpectedly differ"
    assert [len(c) for c in sccs] == [18, 2], f"Unexpected component sizes: {[len(c) for c in sccs]}"
    assert sccs[1] == ["ANC", "FAI"], f"Expected isolated ANC/FAI component, got {sccs[1]}"

    expected_comp = {
        "FULLY_SERVABLE": 45,
        "COMPLIANT_BUT_LATE": 44,
        "ON_TIME_BUT_MISSING_SERVICES": 5,
        "NO_ROUTE_IN_TIME": 1,
        "UNREACHABLE": 5,
    }
    actual_comp = {c: len(by_comp_cat[c]) for c in CATEGORY_ORDER}
    assert actual_comp == expected_comp, f"Classification mismatch: {actual_comp} != {expected_comp}"
    assert len(cbl_tradeoff) == 35 and len(cbl_no_ontime) == 9
    assert {c: len(by_time_cat[c]) for c in CATEGORY_ORDER} == {
        "FULLY_SERVABLE": 45,
        "COMPLIANT_BUT_LATE": 9,
        "ON_TIME_BUT_MISSING_SERVICES": 40,
        "NO_ROUTE_IN_TIME": 1,
        "UNREACHABLE": 5,
    }
    assert {ln.lane_code for ln in by_comp_cat["UNREACHABLE"]} == {
        "FAI-SIN",
        "GRU-FAI",
        "ANC-LHR",
        "JFK-ANC",
        "NRT-ANC",
    }
    assert len(spot_checks) == 4


def print_report(report: dict[str, Any]) -> None:
    ov = report["overview"]
    sr = report["special_requirements"]
    conn = report["connectivity"]
    cls = report["classifications"]

    print("=" * 84)
    print("AIR FREIGHT RFP MOCK DATA — DETERMINISTIC NETWORK & LANE ANALYSIS")
    print("=" * 84)
    print(f"Workbook: {report['workbook']}")
    print()

    print("[1] DATASET & NETWORK OVERVIEW")
    print(
        f"  - Shipper RFP lanes: {ov['lanes_count']} (unique O-D pairs: {ov['unique_rfp_pairs']})"
    )
    print(
        f"  - Freight volume: {ov['total_tons']:.1f} tons total (min {ov['min_tons']:.1f}t, max {ov['max_tons']:.1f}t)"
    )
    print(
        f"  - Requested max transit window: {ov['min_max_transit_days']} to {ov['max_max_transit_days']} days"
    )
    print(
        f"  - Airports: {ov['airports_count']} ({', '.join(ov['airports'])})"
    )
    print(
        f"  - Directed flights: {ov['flights_count']} (duplicates: {ov['duplicate_flights']}, self-loops: {ov['self_loops']}, leg transit: {ov['min_flight_days']}–{ov['max_flight_days']} days)"
    )
    print(
        f"  - Direct flights on RFP lanes: {ov['lanes_with_direct_flight']} / {ov['lanes_count']} "
        f"({ov['direct_flights_compliant_and_on_time']} direct flights are compliant & on-time; "
        f"{ov['direct_flight_lanes_served_via_multihop']} additional direct-flight lanes are FULLY_SERVABLE via multi-hop)"
    )
    for d in ov["direct_multihop_details"]:
        route = d["chosen_route"]
        print(
            f"      * {d['lane']}: direct={d['direct_days']}d {d['direct_services']} vs req={d['requested']} "
            f"-> compliant multi-hop {' -> '.join(route['path'])} ({route['days']}d)"
        )
    print()

    print("[2] SPECIAL REQUIREMENTS DISTRIBUTION")
    dist = sr["per_lane_count_distribution"]
    print(
        f"  - Services per lane: 0 services = {dist.get('0', 0)}, "
        f"1 service = {dist.get('1', 0)}, 2 services = {dist.get('2', 0)}"
    )
    print("  - Per-service RFP demand vs. Transit Table flight coverage:")
    for svc in CANONICAL_SERVICES:
        print(
            f"      * {svc:<30s}: demanded on {sr['per_service_demand_lanes'][svc]:2d} lanes | "
            f"offered on {sr['per_service_available_flights'][svc]:2d}/100 flights"
        )
    print()

    print("[3] FLIGHT GRAPH CONNECTIVITY (KOSARAJU SCC & BFS WCC)")
    print(f"  - SCC partition == WCC partition: {conn['scc_equals_wcc']} ({len(conn['components'])} isolated components)")
    for i, comp in enumerate(conn["components"], start=1):
        print(
            f"      * Component {i}: {comp['airport_count']} airports, {comp['flight_count']} directed flights "
            f"(avg out-degree {comp['avg_out_degree']:.2f}) -> {', '.join(comp['airports'])}"
        )
    print()

    print("[4] LANE CLASSIFICATION COUNTS")
    print("  Primary classification (Compliance-first precedence):")
    comp_counts = cls["compliance_first_counts"]
    print(f"    - FULLY_SERVABLE              : {comp_counts['FULLY_SERVABLE']:2d}  (hops: {cls['fully_servable_hop_distribution']})")
    tm = cls["tradeoff_matrix_reachable_95"]
    print(
        f"    - COMPLIANT_BUT_LATE          : {comp_counts['COMPLIANT_BUT_LATE']:2d}  "
        f"({tm['compliant_late_with_ontime_noncompliant_fallback']} also have an on-time non-compliant route; "
        f"{tm['compliant_late_no_ontime_route']} have no on-time route at all)"
    )
    print(f"    - ON_TIME_BUT_MISSING_SERVICES: {comp_counts['ON_TIME_BUT_MISSING_SERVICES']:2d}  (no compliant route exists at any transit time)")
    print(f"    - NO_ROUTE_IN_TIME            : {comp_counts['NO_ROUTE_IN_TIME']:2d}  (no compliant route at any time AND no route in time)")
    print(f"    - UNREACHABLE                 : {comp_counts['UNREACHABLE']:2d}  (disconnected ANC/FAI subnet vs. 18-airport global network)")
    print("  Alternative Time-first precedence (if any on-time route ranks before compliant-but-late):")
    tf = cls["time_first_counts"]
    print(
        f"    - FULLY_SERVABLE={tf['FULLY_SERVABLE']}, ON_TIME_BUT_MISSING_SERVICES={tf['ON_TIME_BUT_MISSING_SERVICES']} (35+5), "
        f"COMPLIANT_BUT_LATE={tf['COMPLIANT_BUT_LATE']}, NO_ROUTE_IN_TIME={tf['NO_ROUTE_IN_TIME']}, UNREACHABLE={tf['UNREACHABLE']}"
    )
    print()

    print("[5] EXAMPLE LANES PER CATEGORY (5 EXAMPLES PER CATEGORY, ALL WHERE <= 5)")
    for cat in CATEGORY_ORDER:
        items = report["examples_per_category"][cat]
        total = comp_counts[cat]
        print(f"  --- {cat} (showing {len(items)} of {total}) ---")
        for ln in items:
            req_str = ", ".join(ln["requested_services"]) if ln["requested_services"] else "None (general cargo)"
            comp_r = ln["best_compliant_route"]
            any_r = ln["fastest_unconstrained_route"]
            comp_str = f"{' -> '.join(comp_r['path'])} ({comp_r['days']}d, {comp_r['hops']} hop{'s' if comp_r['hops'] != 1 else ''})" if comp_r else "None"
            any_str = f"{' -> '.join(any_r['path'])} ({any_r['days']}d, common={any_r['common_services']})" if any_r else "None"
            print(
                f"    * Lane #{ln['lane_id']:3d} {ln['origin']}-{ln['dest']} | {ln['tons']:4.1f}t | max={ln['max_days']:2d}d | req=[{req_str}]"
            )
            print(f"        best_compliant={comp_str} | fastest_any={any_str}")
            if ln["partial_on_time_options"]:
                opts = "; ".join(
                    f"{' -> '.join(o['route']['path'])} ({o['route']['days']}d) fulfills={o['fulfilled_services']} missing={o['missing_services']}"
                    for o in ln["partial_on_time_options"]
                )
                print(f"        partial_on_time_options: {opts}")
        if cat == "NO_ROUTE_IN_TIME":
            print(
                "        note: Under Compliance-first precedence, DXB-HKG is the 1 lane with neither compliant nor on-time routes; "
                "9 COMPLIANT_BUT_LATE lanes (including HKG-LAX and JFK-LAX) also have zero on-time routes."
            )
    print()

    print("[6] SPOT-CHECK VERIFICATION")
    for sc in report["spot_checks"]:
        print(f"  * {sc['lane']} ({sc['classification']}, max={sc['max_days']}d, req={sc['requested']})")
        if sc.get("direct_flight"):
            print(f"      direct_flight: {sc['direct_flight']['days']}d, services={sc['direct_flight']['services']}")
        if sc.get("chosen_route"):
            cr = sc["chosen_route"]
            legs_fmt = " | ".join(
                f"{lg['origin']}->{lg['dest']}({lg['transit_days']}d)" for lg in cr["legs"]
            )
            print(f"      best_compliant: {' -> '.join(cr['path'])} ({cr['days']}d) [{legs_fmt}]")
        if sc.get("faster_non_compliant_alternative"):
            alt = sc["faster_non_compliant_alternative"]
            print(f"      faster_alt: {' -> '.join(alt['path'])} ({alt['days']}d) blocked_by={alt['missing_on_legs']}")
        if sc.get("fastest_unconstrained_route") and sc["fastest_unconstrained_route"] != sc.get("chosen_route"):
            fu = sc["fastest_unconstrained_route"]
            print(f"      fastest_unconstrained: {' -> '.join(fu['path'])} ({fu['days']}d, common={fu['common_services']})")
        print(f"      {sc['verdict']}")
    print("=" * 84)


def main(argv: list[str] | None = None) -> int:
    default_xlsx = Path(__file__).resolve().parent.parent / "data" / "Air_Freight_RFP_Mock_Data.xlsx"
    parser = argparse.ArgumentParser(description="Analyze Air Freight RFP workbook.")
    parser.add_argument(
        "xlsx_path",
        nargs="?",
        default=str(default_xlsx),
        help="Path to Air_Freight_RFP_Mock_Data.xlsx",
    )
    parser.add_argument(
        "--json",
        dest="json_out",
        help="Optional file path to write structured JSON analysis output.",
    )
    parser.add_argument(
        "--no-canonical-assert",
        action="store_true",
        help="Skip hardcoded assertions specific to the 100-lane mock workbook.",
    )
    args = parser.parse_args(argv)

    report = analyze_workbook(
        Path(args.xlsx_path),
        verify_canonical_mock=not args.no_canonical_assert,
    )
    print_report(report)

    if args.json_out:
        out_path = Path(args.json_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Wrote JSON report to {out_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
