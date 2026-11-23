"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Search,
  XCircle,
} from "lucide-react";
import type { LaneStatus } from "../domain/types";
import type { LaneWorkspaceView } from "../orchestrator/types";
import {
  DISPOSITION_META,
  LANE_STATUS_META,
  SERVICE_SHORT_LABELS,
  formatUsd,
} from "./ui-helpers";

type LaneFilter =
  | "ALL"
  | "NEEDS_DECISION"
  | LaneStatus;

interface LaneTableProps {
  lanes: readonly LaneWorkspaceView[];
  selectedLaneId: number | null;
  onSelectLane: (lane: LaneWorkspaceView) => void;
}

export function LaneTable({
  lanes,
  selectedLaneId,
  onSelectLane,
}: LaneTableProps) {
  const [filter, setFilter] = useState<LaneFilter>("ALL");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const map: Record<LaneFilter, number> = {
      ALL: lanes.length,
      NEEDS_DECISION: 0,
      FULLY_SERVABLE: 0,
      COMPLIANT_BUT_LATE: 0,
      ON_TIME_BUT_MISSING_SERVICES: 0,
      NO_ROUTE_IN_TIME: 0,
      UNREACHABLE: 0,
    };
    for (const lane of lanes) {
      if (lane.needsDecision) map.NEEDS_DECISION += 1;
      if (lane.assessment?.status) {
        map[lane.assessment.status] += 1;
      }
    }
    return map;
  }, [lanes]);

  const filteredLanes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lanes.filter((lane) => {
      if (filter === "NEEDS_DECISION" && !lane.needsDecision) return false;
      if (
        filter !== "ALL" &&
        filter !== "NEEDS_DECISION" &&
        lane.assessment?.status !== filter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        lane.laneCode.toLowerCase().includes(q) ||
        lane.rawEmail.toLowerCase().includes(q) ||
        (lane.assessment?.chosenRoute?.airports.join(" ").toLowerCase().includes(q) ??
          false)
      );
    });
  }, [lanes, filter, query]);

  const filterChips: Array<{ id: LaneFilter; label: string }> = [
    { id: "ALL", label: "All" },
    { id: "NEEDS_DECISION", label: "Needs Decision" },
    { id: "FULLY_SERVABLE", label: "Fully Servable" },
    { id: "COMPLIANT_BUT_LATE", label: "Compliant (Late)" },
    { id: "ON_TIME_BUT_MISSING_SERVICES", label: "Missing Services" },
    { id: "NO_ROUTE_IN_TIME", label: "No Route in Time" },
    { id: "UNREACHABLE", label: "Unreachable" },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-2xs">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {filterChips.map((chip) => {
            const count = counts[chip.id];
            const active = filter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setFilter(chip.id)}
                data-testid={`lane-filter-${chip.id}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  active
                    ? "border-[#1E3A5F] bg-[#1E3A5F] text-white"
                    : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                }`}
              >
                <span>{chip.label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[11px] tabular-nums ${
                    active
                      ? "bg-white/20 text-white"
                      : "bg-slate-200/80 text-slate-700"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute top-2.5 left-3 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search lane, airport, text..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-3 pl-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-[#1E3A5F] focus:bg-white focus:outline-hidden"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <th className="px-4 py-2.5">Lane</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Chosen Route & SLA</th>
              <th className="px-3 py-2.5">Requested Services</th>
              <th className="px-3 py-2.5 text-right">Pricing</th>
              <th className="px-3 py-2.5">Decision / Action</th>
              <th className="px-3 py-2.5 text-right">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredLanes.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  No lanes match the active filter.
                </td>
              </tr>
            ) : (
              filteredLanes.map((lane) => {
                const statusMeta = lane.assessment
                  ? LANE_STATUS_META[lane.assessment.status]
                  : null;
                const dispMeta = lane.assessment
                  ? (DISPOSITION_META[lane.assessment.disposition] ?? {
                      label: lane.assessment.disposition,
                      badgeClass: "bg-slate-100 text-slate-700 border-slate-200",
                    })
                  : null;
                const chosenRoute = lane.assessment?.chosenRoute ?? null;
                const coverageMap = new Map(
                  (lane.assessment?.serviceCoverage ?? []).map((c) => [
                    c.service,
                    c,
                  ]),
                );
                const selected = selectedLaneId === lane.id;

                return (
                  <tr
                    key={lane.id}
                    onClick={() => onSelectLane(lane)}
                    data-testid={`lane-row-${lane.laneCode}`}
                    className={`cursor-pointer transition ${
                      selected
                        ? "bg-sky-50/60"
                        : lane.needsDecision
                          ? "bg-amber-50/25 hover:bg-amber-50/60"
                          : "hover:bg-slate-50"
                    }`}
                  >
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-900">
                          {lane.laneCode}
                        </span>
                        <span className="text-[11px] text-slate-400 tabular-nums">
                          #{lane.laneNumber}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                        {lane.tons.toFixed(1)} t · max {lane.maxTransitDays}d
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top">
                      {statusMeta && (
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${statusMeta.badgeClass}`}
                        >
                          {statusMeta.label}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-3 align-top">
                      {chosenRoute && lane.assessment?.disposition !== "DECLINE" ? (
                        <div>
                          <div className="flex flex-wrap items-center gap-1">
                            {chosenRoute.airports.map((code, idx) => (
                              <span
                                key={`${lane.id}-${code}-${idx}`}
                                className="inline-flex items-center gap-1"
                              >
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-800 ring-1 ring-slate-200 ring-inset">
                                  {code}
                                </span>
                                {idx < chosenRoute.airports.length - 1 && (
                                  <ArrowRight className="h-3 w-3 text-slate-400" />
                                )}
                              </span>
                            ))}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                            <span>
                              {chosenRoute.totalTransitDays}d (
                              {chosenRoute.legCount} leg
                              {chosenRoute.legCount > 1 ? "s" : ""})
                            </span>
                            {lane.assessment?.daysOverLimit !== null &&
                              lane.assessment?.daysOverLimit !== undefined &&
                              lane.assessment.daysOverLimit > 0 && (
                                <span className="ml-1.5 font-semibold text-amber-700">
                                  +{lane.assessment.daysOverLimit}d over limit
                                </span>
                              )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[11px] font-medium text-slate-400 italic">
                          {lane.assessment?.disposition === "DECLINE"
                            ? "Declined (no route quoted)"
                            : "No compliant route"}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-3 align-top">
                      {lane.requestedServices.length === 0 ? (
                        <span className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
                          Standard Cargo
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {lane.requestedServices.map((svc) => {
                            const cov = coverageMap.get(svc);
                            const fulfilled = cov?.fulfilled ?? false;
                            return (
                              <span
                                key={svc}
                                title={
                                  fulfilled
                                    ? `${svc}: Fulfilled on all legs`
                                    : `${svc}: Missing on ${cov?.missingOnLegs.join(", ") || "route"}`
                                }
                                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                                  fulfilled
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-rose-200 bg-rose-50 text-rose-700"
                                }`}
                              >
                                {fulfilled ? (
                                  <CheckCircle2 className="h-3 w-3" />
                                ) : (
                                  <XCircle className="h-3 w-3" />
                                )}
                                {SERVICE_SHORT_LABELS[svc]}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-3 text-right align-top tabular-nums">
                      {lane.pricing ? (
                        <div>
                          <div className="font-semibold text-slate-900">
                            {formatUsd(lane.pricing.effectivePricePerTonUsd)}/t
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatUsd(lane.pricing.lineTotalUsd)} total
                          </div>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </td>

                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {lane.needsDecision && (
                          <span
                            data-testid={`needs-decision-${lane.laneCode}`}
                            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900"
                          >
                            <AlertTriangle className="h-3 w-3 text-amber-700" />
                            Needs Decision
                          </span>
                        )}
                        {dispMeta && !lane.needsDecision && (
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${dispMeta.badgeClass}`}
                          >
                            {dispMeta.label}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-3 text-right align-top">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectLane(lane);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                      >
                        Inspect
                        <ChevronRight className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
