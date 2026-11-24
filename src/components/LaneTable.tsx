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

type LaneFilter = "ALL" | "NEEDS_DECISION" | LaneStatus;

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
        (lane.assessment?.chosenRoute?.airports
          .join(" ")
          .toLowerCase()
          .includes(q) ??
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
    <div className="rounded-md border border-border/70 bg-white shadow-xs">
      <div className="flex flex-col gap-2.5 border-b border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1">
          {filterChips.map((chip) => {
            const count = counts[chip.id];
            const active = filter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setFilter(chip.id)}
                data-testid={`lane-filter-${chip.id}`}
                className={`inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium transition-colors ${
                  active
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-border/60 bg-zinc-50/70 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                }`}
              >
                <span>{chip.label}</span>
                <span
                  className={`rounded-sm px-1 text-[11px] tabular-nums ${
                    active
                      ? "bg-white/20 text-white"
                      : "bg-zinc-200/70 text-zinc-700"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-2 left-2.5 h-3.5 w-3.5 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter lane, airport, text..."
            className="h-7 w-full rounded-sm border border-border/70 bg-zinc-50/70 pr-2.5 pl-8 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:bg-white focus:outline-hidden"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-border/60 bg-zinc-50/60 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
              <th className="px-3 py-2 font-medium">Lane</th>
              <th className="px-2.5 py-2 font-medium">Status</th>
              <th className="px-2.5 py-2 font-medium">Route & transit</th>
              <th className="px-2.5 py-2 font-medium">Services</th>
              <th className="px-2.5 py-2 text-right font-medium">Rate</th>
              <th className="px-2.5 py-2 font-medium">Decision</th>
              <th className="px-3 py-2 text-right font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filteredLanes.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-8 text-center text-xs text-zinc-500"
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
                      badgeClass: "bg-zinc-100 text-zinc-700 border-border/70",
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
                    className={`cursor-pointer transition-colors ${
                      selected
                        ? "bg-zinc-100/90"
                        : lane.needsDecision
                          ? "bg-amber-50/25 hover:bg-amber-50/50"
                          : "hover:bg-zinc-50/90"
                    }`}
                  >
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[13px] font-medium text-zinc-900">
                          {lane.laneCode}
                        </span>
                        <span className="text-[11px] text-zinc-400 tabular-nums">
                          #{lane.laneNumber}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                        {lane.tons.toFixed(1)}t · max {lane.maxTransitDays}d
                      </div>
                    </td>

                    <td className="px-2.5 py-2 align-top">
                      {statusMeta && (
                        <span
                          className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${statusMeta.badgeClass}`}
                        >
                          {statusMeta.label}
                        </span>
                      )}
                    </td>

                    <td className="px-2.5 py-2 align-top">
                      {chosenRoute &&
                      lane.assessment?.disposition !== "DECLINE" ? (
                        <div>
                          <div className="flex flex-wrap items-center gap-1">
                            {chosenRoute.airports.map((code, idx) => (
                              <span
                                key={`${lane.id}-${code}-${idx}`}
                                className="inline-flex items-center gap-1"
                              >
                                <span className="rounded-sm border border-border/60 bg-zinc-50 px-1.5 py-px font-mono text-[11px] font-medium text-zinc-800">
                                  {code}
                                </span>
                                {idx < chosenRoute.airports.length - 1 && (
                                  <ArrowRight className="h-3 w-3 text-zinc-400" />
                                )}
                              </span>
                            ))}
                          </div>
                          <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
                            <span>
                              {chosenRoute.totalTransitDays}d (
                              {chosenRoute.legCount} leg
                              {chosenRoute.legCount > 1 ? "s" : ""})
                            </span>
                            {lane.assessment?.daysOverLimit !== null &&
                              lane.assessment?.daysOverLimit !== undefined &&
                              lane.assessment.daysOverLimit > 0 && (
                                <span className="ml-1.5 font-medium text-amber-700">
                                  +{lane.assessment.daysOverLimit}d late
                                </span>
                              )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[11px] text-zinc-400 italic">
                          {lane.assessment?.disposition === "DECLINE"
                            ? "Declined"
                            : "No compliant route"}
                        </span>
                      )}
                    </td>

                    <td className="px-2.5 py-2 align-top">
                      {lane.requestedServices.length === 0 ? (
                        <span className="inline-flex items-center rounded-sm border border-border/60 bg-zinc-50 px-1.5 py-0.5 text-[11px] text-zinc-600">
                          Standard
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
                                className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${
                                  fulfilled
                                    ? "border-emerald-200/80 bg-emerald-50/70 text-emerald-700"
                                    : "border-rose-200/80 bg-rose-50/70 text-rose-700"
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

                    <td className="px-2.5 py-2 text-right align-top tabular-nums">
                      {lane.pricing ? (
                        <div>
                          <div className="font-medium text-zinc-900">
                            {formatUsd(lane.pricing.effectivePricePerTonUsd)}/t
                          </div>
                          <div className="text-[11px] text-zinc-500">
                            {formatUsd(lane.pricing.lineTotalUsd)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[11px] text-zinc-400">-</span>
                      )}
                    </td>

                    <td className="px-2.5 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-1">
                        {lane.needsDecision && (
                          <span
                            data-testid={`needs-decision-${lane.laneCode}`}
                            className="inline-flex items-center gap-1 rounded-sm border border-amber-300/80 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900"
                          >
                            <AlertTriangle className="h-3 w-3 text-amber-600" />
                            Needs Decision
                          </span>
                        )}
                        {dispMeta && !lane.needsDecision && (
                          <span
                            className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${dispMeta.badgeClass}`}
                          >
                            {dispMeta.label}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-2 text-right align-top">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectLane(lane);
                        }}
                        className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:border-border hover:bg-zinc-50"
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
