"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { LaneStatus } from "../domain/types";
import type { LaneWorkspaceView } from "../orchestrator/types";
import {
  PANEL,
  RoutePath,
  ServiceMark,
  StatusMark,
  TH,
  INPUT,
} from "./ui";
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

  const visibleTons = filteredLanes.reduce((sum, l) => sum + l.tons, 0);

  return (
    <div className={`${PANEL} overflow-hidden`}>
      <div className="flex flex-col gap-2 border-b border-zinc-200 px-3 py-2 xl:flex-row xl:items-center xl:justify-between">
        <div
          role="group"
          aria-label="Lane filters"
          className="flex flex-wrap items-center gap-px"
        >
          {filterChips.map((chip) => {
            const count = counts[chip.id];
            const active = filter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(chip.id)}
                data-testid={`lane-filter-${chip.id}`}
                className={`inline-flex h-7 items-center gap-1.5 rounded-sm px-1.5 text-xs whitespace-nowrap transition-colors ${
                  active
                    ? "bg-zinc-100 font-medium text-zinc-900"
                    : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900"
                }`}
              >
                <span>{chip.label}</span>
                <span
                  className={`tabular-nums ${
                    active ? "text-zinc-600" : "text-zinc-400"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full xl:w-44">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter lane, airport, text..."
            aria-label="Filter lanes"
            className={`${INPUT} h-7 pl-8 text-xs`}
          />
        </div>
      </div>

      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50/60">
              <th className={`${TH} py-2 pr-2 pl-4`}>Lane</th>
              <th className={`${TH} px-2 py-2`}>Status</th>
              <th className={`${TH} px-2 py-2`}>Route</th>
              <th className={`${TH} px-2 py-2 text-right`}>Tons</th>
              <th className={`${TH} px-2 py-2 text-right`}>SLA</th>
              <th className={`${TH} px-2 py-2 text-right`}>Transit</th>
              <th className={`${TH} px-2 py-2`}>Services</th>
              <th className={`${TH} px-2 py-2 text-right`}>$/t</th>
              <th className={`${TH} px-2 py-2 text-right`}>Total</th>
              <th className={`${TH} px-2 py-2`}>Decision</th>
              <th className="w-8 py-2 pr-3 pl-1">
                <span className="sr-only">Inspect</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredLanes.length === 0 ? (
              <tr>
                <td
                  colSpan={11}
                  className="px-4 py-10 text-center text-xs text-zinc-500"
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
                      tone: "neutral" as const,
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
                const daysOver = lane.assessment?.daysOverLimit;

                return (
                  <tr
                    key={lane.id}
                    onClick={() => onSelectLane(lane)}
                    data-testid={`lane-row-${lane.laneCode}`}
                    className={`group cursor-pointer border-b border-zinc-100 last:border-b-0 transition-colors ${
                      selected ? "bg-zinc-50" : "hover:bg-zinc-50/70"
                    }`}
                  >
                    <td
                      className={`border-l-2 py-2 pr-2 pl-[14px] ${
                        selected ? "border-l-zinc-900" : "border-l-transparent"
                      }`}
                    >
                      <div className="flex items-baseline gap-1.5 whitespace-nowrap">
                        <span className="font-mono text-sm font-semibold text-zinc-900">
                          {lane.laneCode}
                        </span>
                        <span className="text-xs text-zinc-400 tabular-nums">
                          #{lane.laneNumber}
                        </span>
                      </div>
                    </td>

                    <td className="px-2 py-2">
                      {statusMeta && (
                        <StatusMark
                          tone={statusMeta.tone}
                          label={statusMeta.label}
                        />
                      )}
                    </td>

                    <td className="px-2 py-2">
                      {chosenRoute &&
                      lane.assessment?.disposition !== "DECLINE" ? (
                        <div className="flex flex-wrap items-center gap-x-2">
                          <RoutePath airports={chosenRoute.airports} />
                          <span className="text-xs whitespace-nowrap text-zinc-400 tabular-nums">
                            {chosenRoute.legCount} leg
                            {chosenRoute.legCount > 1 ? "s" : ""}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-400">
                          {lane.assessment?.disposition === "DECLINE"
                            ? "Declined"
                            : "No compliant route"}
                        </span>
                      )}
                    </td>

                    <td className="px-2 py-2 text-right text-zinc-700 tabular-nums">
                      {lane.tons.toFixed(1)}
                    </td>

                    <td className="px-2 py-2 text-right text-zinc-500 tabular-nums">
                      {lane.maxTransitDays}d
                    </td>

                    <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                      {chosenRoute &&
                      lane.assessment?.disposition !== "DECLINE" ? (
                        <>
                          <span className="text-zinc-900">
                            {chosenRoute.totalTransitDays}d
                          </span>
                          {daysOver !== null &&
                            daysOver !== undefined &&
                            daysOver > 0 && (
                              <span
                                className="ml-1.5 text-xs font-medium text-red-700"
                                title={`${daysOver}d over the ${lane.maxTransitDays}d limit`}
                              >
                                +{daysOver}d late
                              </span>
                            )}
                        </>
                      ) : (
                        <span className="text-zinc-300">-</span>
                      )}
                    </td>

                    <td className="px-2 py-2">
                      {lane.requestedServices.length === 0 ? (
                        <span className="text-xs text-zinc-400">Standard</span>
                      ) : (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                          {lane.requestedServices.map((svc) => {
                            const cov = coverageMap.get(svc);
                            const fulfilled = cov?.fulfilled ?? false;
                            return (
                              <ServiceMark
                                key={svc}
                                fulfilled={fulfilled}
                                label={SERVICE_SHORT_LABELS[svc]}
                                title={
                                  fulfilled
                                    ? `${svc}: Fulfilled on all legs`
                                    : `${svc}: Missing on ${cov?.missingOnLegs.join(", ") || "route"}`
                                }
                              />
                            );
                          })}
                        </div>
                      )}
                    </td>

                    <td className="px-2 py-2 text-right tabular-nums">
                      {lane.pricing ? (
                        <span className="text-zinc-900">
                          {formatUsd(lane.pricing.effectivePricePerTonUsd)}
                          <span className="text-zinc-400">/t</span>
                        </span>
                      ) : (
                        <span className="text-zinc-300">-</span>
                      )}
                    </td>

                    <td className="px-2 py-2 text-right tabular-nums">
                      {lane.pricing ? (
                        <span className="font-medium text-zinc-900">
                          {formatUsd(lane.pricing.lineTotalUsd)}
                        </span>
                      ) : (
                        <span className="text-zinc-300">-</span>
                      )}
                    </td>

                    <td className="px-2 py-2">
                      {lane.needsDecision && (
                        <span data-testid={`needs-decision-${lane.laneCode}`}>
                          <StatusMark tone="warn" label="Needs Decision" />
                        </span>
                      )}
                      {dispMeta && !lane.needsDecision && (
                        <StatusMark
                          tone={dispMeta.tone}
                          label={dispMeta.label}
                        />
                      )}
                    </td>

                    <td className="py-2 pr-3 pl-1 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectLane(lane);
                        }}
                        aria-label={`Inspect lane ${lane.laneCode}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-zinc-400 transition-colors group-hover:text-zinc-700 hover:bg-zinc-100"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50/60 px-4 py-1.5 text-xs text-zinc-500 tabular-nums">
        <span>
          {filteredLanes.length} of {lanes.length} lanes
        </span>
        <span>{visibleTons.toLocaleString("en-US", { maximumFractionDigits: 1 })}t</span>
      </div>
    </div>
  );
}
