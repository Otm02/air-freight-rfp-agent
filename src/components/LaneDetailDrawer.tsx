"use client";

import { Fragment, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Mail,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import { SERVICE_TYPES, type Route, type ServiceType } from "../domain/types";
import type { LaneWorkspaceView } from "../orchestrator/types";
import {
  DISPOSITION_META,
  LANE_STATUS_META,
  SERVICE_FULL_LABELS,
  formatUsd,
} from "./ui-helpers";

interface LaneDetailDrawerProps {
  lane: LaneWorkspaceView | null;
  busy: boolean;
  onClose: () => void;
  onConfirmRequirements: (
    laneId: number,
    requestedServices: ServiceType[],
    note: string,
  ) => Promise<void>;
  onRouteDecision: (
    laneId: number,
    disposition:
      | "QUOTE_COMPLIANT"
      | "QUOTE_COMPLIANT_LATE"
      | "QUOTE_PARTIAL_ON_TIME"
      | "DECLINE",
    alternativeIndex?: number,
    note?: string,
  ) => Promise<void>;
}

function renderEmailWithHighlights(
  text: string,
  quotes: readonly string[],
) {
  const uniqueQuotes = Array.from(
    new Set(quotes.map((q) => q.trim()).filter((q) => q.length >= 2)),
  ).sort((a, b) => b.length - a.length);

  if (uniqueQuotes.length === 0) {
    return <span>{text}</span>;
  }

  let segments: Array<{ text: string; highlighted: boolean }> = [
    { text, highlighted: false },
  ];

  for (const quote of uniqueQuotes) {
    const qLower = quote.toLowerCase();
    const nextSegments: Array<{ text: string; highlighted: boolean }> = [];
    for (const seg of segments) {
      if (seg.highlighted) {
        nextSegments.push(seg);
        continue;
      }
      const lower = seg.text.toLowerCase();
      let cursor = 0;
      let idx = lower.indexOf(qLower, cursor);
      while (idx !== -1) {
        if (idx > cursor) {
          nextSegments.push({
            text: seg.text.slice(cursor, idx),
            highlighted: false,
          });
        }
        nextSegments.push({
          text: seg.text.slice(idx, idx + quote.length),
          highlighted: true,
        });
        cursor = idx + quote.length;
        idx = lower.indexOf(qLower, cursor);
      }
      if (cursor < seg.text.length) {
        nextSegments.push({
          text: seg.text.slice(cursor),
          highlighted: false,
        });
      }
    }
    segments = nextSegments;
  }

  return segments.map((seg, i) =>
    seg.highlighted ? (
      <mark
        key={i}
        className="rounded bg-amber-100 px-1 py-0.5 font-medium text-amber-950 ring-1 ring-amber-300"
      >
        {seg.text}
      </mark>
    ) : (
      <Fragment key={i}>{seg.text}</Fragment>
    ),
  );
}

function AirportChips({ route }: { route: Route }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {route.airports.map((code, idx) => (
        <span key={`${code}-${idx}`} className="inline-flex items-center gap-1">
          <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-900 ring-1 ring-slate-200">
            {code}
          </span>
          {idx < route.airports.length - 1 && (
            <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
          )}
        </span>
      ))}
    </div>
  );
}

export function LaneDetailDrawer({
  lane,
  busy,
  onClose,
  onConfirmRequirements,
  onRouteDecision,
}: LaneDetailDrawerProps) {
  const [selectedServices, setSelectedServices] = useState<ServiceType[]>([]);
  const [decisionNote, setDecisionNote] = useState("");
  const [selectedPartialIdx, setSelectedPartialIdx] = useState(0);

  useEffect(() => {
    if (lane) {
      setSelectedServices([...lane.requestedServices]);
      setDecisionNote("");
      setSelectedPartialIdx(0);
    }
  }, [lane]);

  if (!lane) {
    return null;
  }

  const assessment = lane.assessment;
  const statusMeta = assessment ? LANE_STATUS_META[assessment.status] : null;
  const dispMeta = assessment
    ? (DISPOSITION_META[assessment.disposition] ?? {
        label: assessment.disposition,
        badgeClass: "bg-slate-100 text-slate-700 border-slate-200",
      })
    : null;

  const compliantRoute = assessment?.bestCompliantRoute ?? null;
  const fastestRoute = assessment?.fastestUnconstrainedRoute ?? null;
  const alternatives = assessment?.alternatives ?? [];
  const onTimeAlternatives = alternatives.filter(
    (alt) => alt.daysOverLimit <= 0,
  );
  const partialAltList =
    onTimeAlternatives.length > 0 ? onTimeAlternatives : alternatives;

  const canQuoteCompliant = compliantRoute !== null;
  const canQuotePartial = partialAltList.length > 0 || fastestRoute !== null;
  const selectedPartialIndexInFull =
    partialAltList[selectedPartialIdx]
      ? alternatives.indexOf(partialAltList[selectedPartialIdx]!)
      : undefined;

  const toggleService = (svc: ServiceType) => {
    setSelectedServices((prev) =>
      prev.includes(svc) ? prev.filter((s) => s !== svc) : [...prev, svc],
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-[1px]"
      onClick={onClose}
      data-testid="lane-detail-drawer"
    >
      <aside
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-lg font-bold text-slate-900">
                {lane.laneCode}
              </h2>
              <span className="text-xs text-slate-400">
                Lane #{lane.laneNumber}
              </span>
              {statusMeta && (
                <span
                  className={`rounded-md border px-2 py-0.5 text-xs font-medium ${statusMeta.badgeClass}`}
                >
                  {statusMeta.label}
                </span>
              )}
              {dispMeta && (
                <span
                  className={`rounded-md border px-2 py-0.5 text-xs font-medium ${dispMeta.badgeClass}`}
                >
                  {dispMeta.label}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500 tabular-nums">
              Freight: <strong className="text-slate-700">{lane.tons.toFixed(1)} tons</strong> ·
              Max Transit: <strong className="text-slate-700">{lane.maxTransitDays} days</strong>
              {lane.pricing && (
                <>
                  {" · "}Rate:{" "}
                  <strong className="text-slate-900">
                    {formatUsd(lane.pricing.effectivePricePerTonUsd)}/t
                  </strong>{" "}
                  ({formatUsd(lane.pricing.lineTotalUsd)})
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* 1. Shipper Email & Highlighted Evidence */}
          <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-700 uppercase">
                <Mail className="h-3.5 w-3.5 text-slate-500" />
                Shipper Email Request & Extracted Evidence
              </h3>
              <span className="text-[11px] font-medium text-slate-500 tabular-nums">
                Intake conf:{" "}
                {lane.intakeConfidence !== null
                  ? `${Math.round(lane.intakeConfidence * 100)}%`
                  : "—"}{" "}
                ({lane.intakeStatus})
              </span>
            </div>

            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-800">
              {renderEmailWithHighlights(
                lane.rawEmail,
                lane.evidence.map((e) => e.quote),
              )}
            </div>

            {lane.evidence.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                {lane.evidence.map((ev, i) => (
                  <div
                    key={`${ev.service}-${i}`}
                    className="flex items-start gap-2 text-xs text-slate-600"
                  >
                    <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-indigo-700 ring-1 ring-indigo-200">
                      {ev.service}
                    </span>
                    <span className="italic">&ldquo;{ev.quote}&rdquo;</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2.5 text-xs text-slate-500">
                No special handling services matched; treated as standard general cargo unless updated below.
              </p>
            )}

            {lane.intakeStatus === "NEEDS_HUMAN_CONFIRMATION" && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                  <ShieldAlert className="h-4 w-4 text-amber-700" />
                  Confirm Requested Special Services (Intake Escalation)
                </div>
                <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {SERVICE_TYPES.map((svc) => (
                    <label
                      key={svc}
                      className="flex cursor-pointer items-center gap-2 rounded border border-amber-200 bg-white px-2.5 py-1.5 text-xs text-slate-800"
                    >
                      <input
                        type="checkbox"
                        checked={selectedServices.includes(svc)}
                        onChange={() => toggleService(svc)}
                        className="h-3.5 w-3.5 accent-[#1E3A5F]"
                      />
                      <span>{SERVICE_FULL_LABELS[svc]}</span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onConfirmRequirements(lane.id, selectedServices, decisionNote)
                  }
                  className="mt-3 rounded-lg bg-[#1E3A5F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                >
                  Confirm Requirements & Re-Route
                </button>
              </div>
            )}
          </section>

          {/* 2. Route Options Comparison */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold tracking-wide text-slate-700 uppercase">
              Deterministic Route Options Comparison
            </h3>

            {assessment?.humanDecisionReason && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <span className="font-semibold">Agent Assessment: </span>
                  {assessment.humanDecisionReason}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Best Compliant Route */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-900">
                    Best Compliant Route
                  </span>
                  {compliantRoute ? (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                        compliantRoute.totalTransitDays <= lane.maxTransitDays
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-amber-50 text-amber-800"
                      }`}
                    >
                      <Clock className="h-3 w-3" />
                      {compliantRoute.totalTransitDays}d vs {lane.maxTransitDays}d
                    </span>
                  ) : (
                    <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                      None Available
                    </span>
                  )}
                </div>

                {compliantRoute ? (
                  <div className="mt-3 space-y-2">
                    <AirportChips route={compliantRoute} />
                    <p className="text-xs text-slate-600">
                      All {lane.requestedServices.length || "standard"} required services supported on all {compliantRoute.legCount} leg(s).
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    No simple path fulfills every requested service simultaneously.
                  </p>
                )}
              </div>

              {/* Fastest Unconstrained Route */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-900">
                    Fastest Unconstrained Route
                  </span>
                  {fastestRoute ? (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                        fastestRoute.totalTransitDays <= lane.maxTransitDays
                          ? "bg-sky-50 text-sky-700"
                          : "bg-rose-50 text-rose-700"
                      }`}
                    >
                      <Clock className="h-3 w-3" />
                      {fastestRoute.totalTransitDays}d vs {lane.maxTransitDays}d
                    </span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      Unreachable
                    </span>
                  )}
                </div>

                {fastestRoute ? (
                  <div className="mt-3 space-y-2">
                    <AirportChips route={fastestRoute} />
                    <div className="space-y-1 text-xs">
                      {lane.requestedServices.map((svc) => {
                        const missingLegs = fastestRoute.legs
                          .filter((leg) => !leg.availableServices.includes(svc))
                          .map((leg) => `${leg.origin}->${leg.destination}`);
                        return (
                          <div key={svc} className="flex items-center gap-1.5">
                            {missingLegs.length === 0 ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-rose-600" />
                            )}
                            <span className="text-slate-700">
                              {SERVICE_FULL_LABELS[svc]}
                              {missingLegs.length > 0 && (
                                <span className="text-rose-700">
                                  {" "}
                                  (missing on {missingLegs.join(", ")})
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    Disconnected airport component — no path exists.
                  </p>
                )}
              </div>
            </div>

            {/* Best Partial / Trade-Off Alternatives */}
            {alternatives.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="text-xs font-semibold text-slate-800">
                  Partial-Service & Trade-off Options
                </div>
                <div className="mt-2.5 space-y-2">
                  {partialAltList.map((alt, idx) => {
                    const isSelected = idx === selectedPartialIdx;
                    return (
                      <label
                        key={`${alt.kind}-${alt.route.airports.join("-")}`}
                        className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition ${
                          isSelected
                            ? "border-[#1E3A5F] bg-white ring-1 ring-[#1E3A5F]"
                            : "border-slate-200 bg-white/80 hover:border-slate-300"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="partial-alt"
                              checked={isSelected}
                              onChange={() => setSelectedPartialIdx(idx)}
                              className="accent-[#1E3A5F]"
                            />
                            <span className="text-xs font-semibold text-slate-900">
                              {alt.label}
                            </span>
                          </div>
                          <span className="text-xs font-medium text-slate-600 tabular-nums">
                            {alt.route.totalTransitDays}d (
                            {alt.daysOverLimit <= 0
                              ? "on time"
                              : `+${alt.daysOverLimit}d late`}
                            )
                          </span>
                        </div>
                        <AirportChips route={alt.route} />
                        <div className="flex flex-wrap gap-1.5 text-[11px]">
                          {alt.fulfilledServices.map((s) => (
                            <span
                              key={s}
                              className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700"
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              {SERVICE_FULL_LABELS[s]}
                            </span>
                          ))}
                          {alt.serviceGaps
                            .filter((g) => !g.fulfilled)
                            .map((g) => (
                              <span
                                key={g.service}
                                className="inline-flex items-center gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-rose-700"
                              >
                                <XCircle className="h-3 w-3" />
                                Missing {SERVICE_FULL_LABELS[g.service]} (
                                {g.missingOnLegs.join(", ")})
                              </span>
                            ))}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* 3. Human Decision Buttons */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="text-xs font-semibold tracking-wide text-slate-700 uppercase">
              Human Decision for Proposal & Pricing Scope
            </h3>

            <textarea
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              rows={2}
              placeholder="Optional commercial rationale or disclosure note for audit log..."
              className="mt-2.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-[#1E3A5F] focus:bg-white focus:outline-hidden"
            />

            <div className="mt-3 flex flex-col gap-2">
              {assessment?.status === "FULLY_SERVABLE" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onRouteDecision(lane.id, "QUOTE_COMPLIANT", undefined, decisionNote)
                  }
                  data-testid="decision-btn-compliant"
                  className="flex w-full items-center justify-between rounded-lg bg-[#1E3A5F] px-4 py-2.5 text-left text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                >
                  <span>Quote compliant route as requested</span>
                  <CheckCircle2 className="h-4 w-4" />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy || !canQuoteCompliant}
                    onClick={() =>
                      onRouteDecision(
                        lane.id,
                        "QUOTE_COMPLIANT_LATE",
                        undefined,
                        decisionNote,
                      )
                    }
                    data-testid="decision-btn-compliant-late"
                    className="flex w-full items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-left text-xs font-semibold text-amber-950 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span>
                      Use compliant route and ask for a longer transit time
                    </span>
                    {compliantRoute && (
                      <span className="font-mono text-[11px] font-normal text-amber-800">
                        {compliantRoute.totalTransitDays}d (+
                        {Math.max(0, compliantRoute.totalTransitDays - lane.maxTransitDays)}d)
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={busy || !canQuotePartial}
                    onClick={() =>
                      onRouteDecision(
                        lane.id,
                        "QUOTE_PARTIAL_ON_TIME",
                        selectedPartialIndexInFull !== undefined &&
                          selectedPartialIndexInFull >= 0
                          ? selectedPartialIndexInFull
                          : undefined,
                        decisionNote,
                      )
                    }
                    data-testid="decision-btn-partial-on-time"
                    className="flex w-full items-center justify-between rounded-lg border border-sky-300 bg-sky-50 px-4 py-2.5 text-left text-xs font-semibold text-sky-950 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span>
                      Use on-time route and state missing services
                    </span>
                    {partialAltList[selectedPartialIdx] && (
                      <span className="font-mono text-[11px] font-normal text-sky-800">
                        {partialAltList[selectedPartialIdx]!.route.totalTransitDays}d
                      </span>
                    )}
                  </button>
                </>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onRouteDecision(lane.id, "DECLINE", undefined, decisionNote)
                }
                data-testid="decision-btn-decline"
                className="flex w-full items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-left text-xs font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-50"
              >
                <span>Decline lane</span>
                <XCircle className="h-4 w-4 text-rose-600" />
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
