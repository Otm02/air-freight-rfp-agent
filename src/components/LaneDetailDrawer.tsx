"use client";

import { Fragment, useEffect, useState } from "react";
import { ArrowRight, Check, ShieldAlert, X } from "lucide-react";
import { SERVICE_TYPES, type ServiceType } from "../domain/types";
import type { LaneWorkspaceView } from "../orchestrator/types";
import {
  INPUT,
  RoutePath,
  ServiceMark,
  StatusDot,
  StatusMark,
  buttonClass,
} from "./ui";
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
        className="rounded-xs bg-zinc-900/10 px-0.5 font-medium text-zinc-950 [box-decoration-break:clone] underline decoration-zinc-900/40 decoration-1 underline-offset-2"
      >
        {seg.text}
      </mark>
    ) : (
      <Fragment key={i}>{seg.text}</Fragment>
    ),
  );
}

function SectionHeading({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="eyebrow">{children}</h3>
      {aside}
    </div>
  );
}

function Metric({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 first:pl-0 sm:first:pl-0">
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-zinc-900 tabular-nums">
        {children}
      </div>
    </div>
  );
}

const DECISION_ROW =
  "group flex min-h-10 w-full items-center justify-between gap-4 rounded-sm border px-3.5 py-2 text-left text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

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
        tone: "neutral" as const,
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
      className="fixed inset-0 z-50 flex justify-end bg-zinc-950/25"
      onClick={onClose}
      data-testid="lane-detail-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={`Lane ${lane.laneCode} detail`}
    >
      <aside
        className="flex h-full w-full max-w-[640px] flex-col border-l border-zinc-200 bg-white shadow-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header ------------------------------------------------------- */}
        <div className="shrink-0 border-b border-zinc-200 px-6 pt-4 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <h2 className="font-mono text-lg font-semibold text-zinc-900">
                  {lane.laneCode}
                </h2>
                <span className="text-xs text-zinc-400 tabular-nums">
                  Lane #{lane.laneNumber}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                {statusMeta && (
                  <StatusMark
                    tone={statusMeta.tone}
                    label={statusMeta.label}
                  />
                )}
                {dispMeta && (
                  <StatusMark tone={dispMeta.tone} label={dispMeta.label} />
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close drawer"
              className="-mr-1.5 rounded-sm p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-y-3 divide-zinc-200 sm:grid-cols-4 sm:divide-x">
            <Metric label="Freight">{lane.tons.toFixed(1)}t</Metric>
            <Metric label="Max transit">{lane.maxTransitDays}d</Metric>
            <Metric label="Rate">
              {lane.pricing ? (
                <>
                  {formatUsd(lane.pricing.effectivePricePerTonUsd)}
                  <span className="font-normal text-zinc-400">/t</span>
                </>
              ) : (
                <span className="text-zinc-300">-</span>
              )}
            </Metric>
            <Metric label="Line total">
              {lane.pricing ? (
                formatUsd(lane.pricing.lineTotalUsd)
              ) : (
                <span className="text-zinc-300">-</span>
              )}
            </Metric>
          </div>
        </div>

        {/* Body --------------------------------------------------------- */}
        <div className="scroll-thin min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-6">
          <section className="space-y-3">
            <SectionHeading
              aside={
                <span className="text-xs text-zinc-500 tabular-nums">
                  Confidence{" "}
                  <span className="font-medium text-zinc-800">
                    {lane.intakeConfidence !== null
                      ? `${Math.round(lane.intakeConfidence * 100)}%`
                      : "-"}
                  </span>{" "}
                  ({lane.intakeStatus})
                </span>
              }
            >
              Shipper request &amp; evidence
            </SectionHeading>

            <div className="rounded-sm border border-zinc-200 bg-zinc-50/60 px-3.5 py-3 text-sm leading-relaxed text-zinc-800">
              {renderEmailWithHighlights(
                lane.rawEmail,
                lane.evidence.map((e) => e.quote),
              )}
            </div>

            {lane.evidence.length > 0 ? (
              <ul className="divide-y divide-zinc-100 border-y border-zinc-100">
                {lane.evidence.map((ev, i) => (
                  <li
                    key={`${ev.service}-${i}`}
                    className="flex items-baseline gap-3 py-1.5 text-xs"
                  >
                    <span className="w-36 shrink-0 font-mono text-2xs font-medium text-zinc-500">
                      {ev.service}
                    </span>
                    <span className="text-zinc-700">
                      &ldquo;{ev.quote}&rdquo;
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-500">
                No special handling phrases detected; treated as standard general cargo unless overridden below.
              </p>
            )}

            {lane.intakeStatus === "NEEDS_HUMAN_CONFIRMATION" && (
              <div className="rounded-sm border border-zinc-300 bg-white p-3.5">
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                  <StatusDot tone="warn" />
                  <ShieldAlert className="h-3.5 w-3.5 text-zinc-500" />
                  Confirm Required Special Services
                </div>
                <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {SERVICE_TYPES.map((svc) => {
                    const checked = selectedServices.includes(svc);
                    return (
                      <label
                        key={svc}
                        className={`flex cursor-pointer items-center gap-2 rounded-sm border px-2.5 py-1.5 text-xs transition-colors ${
                          checked
                            ? "border-zinc-900 bg-zinc-50 text-zinc-900"
                            : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleService(svc)}
                          className="h-3.5 w-3.5 accent-zinc-900"
                        />
                        <span>{SERVICE_FULL_LABELS[svc]}</span>
                      </label>
                    );
                  })}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onConfirmRequirements(lane.id, selectedServices, decisionNote)
                  }
                  className={buttonClass("primary", "md", "mt-3")}
                >
                  Confirm Requirements &amp; Re-Route
                </button>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <SectionHeading>Route options</SectionHeading>

            {assessment?.humanDecisionReason && (
              <div className="flex items-start gap-2.5 border-l-2 border-amber-500 bg-zinc-50/60 py-2 pr-3 pl-3 text-xs leading-relaxed text-zinc-700">
                <div>
                  <span className="font-medium text-zinc-900">
                    Assessment:{" "}
                  </span>
                  {assessment.humanDecisionReason}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-sm border border-zinc-200 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-900">
                    Best Compliant Route
                  </span>
                  {compliantRoute ? (
                    <StatusMark
                      tone={
                        compliantRoute.totalTransitDays <= lane.maxTransitDays
                          ? "ok"
                          : "warn"
                      }
                      label={`${compliantRoute.totalTransitDays}d vs ${lane.maxTransitDays}d`}
                      className="tabular-nums"
                    />
                  ) : (
                    <StatusMark tone="bad" label="None Available" />
                  )}
                </div>

                {compliantRoute ? (
                  <div className="mt-3 space-y-2">
                    <RoutePath airports={compliantRoute.airports} />
                    <p className="text-xs text-zinc-500">
                      All {lane.requestedServices.length || "standard"} required services supported across {compliantRoute.legCount} leg(s).
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-zinc-500">
                    No path fulfills every required service simultaneously.
                  </p>
                )}
              </div>

              <div className="rounded-sm border border-zinc-200 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-900">
                    Fastest Unconstrained
                  </span>
                  {fastestRoute ? (
                    <StatusMark
                      tone={
                        fastestRoute.totalTransitDays <= lane.maxTransitDays
                          ? "neutral"
                          : "bad"
                      }
                      label={`${fastestRoute.totalTransitDays}d vs ${lane.maxTransitDays}d`}
                      className="tabular-nums"
                    />
                  ) : (
                    <StatusMark tone="muted" label="Unreachable" />
                  )}
                </div>

                {fastestRoute ? (
                  <div className="mt-3 space-y-2">
                    <RoutePath airports={fastestRoute.airports} />
                    <div className="space-y-1">
                      {lane.requestedServices.map((svc) => {
                        const missingLegs = fastestRoute.legs
                          .filter((leg) => !leg.availableServices.includes(svc))
                          .map((leg) => `${leg.origin}->${leg.destination}`);
                        return (
                          <div key={svc} className="text-xs">
                            <ServiceMark
                              fulfilled={missingLegs.length === 0}
                              label={SERVICE_FULL_LABELS[svc]}
                            />
                            {missingLegs.length > 0 && (
                              <span className="ml-1 font-mono text-2xs text-red-700">
                                (missing on {missingLegs.join(", ")})
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-zinc-500">
                    No path exists in the transit network.
                  </p>
                )}
              </div>
            </div>

            {alternatives.length > 0 && (
              <div className="space-y-2 pt-1">
                <div className="text-xs font-medium text-zinc-900">
                  Trade-Off Alternatives
                </div>
                <div className="space-y-2">
                  {partialAltList.map((alt, idx) => {
                    const isSelected = idx === selectedPartialIdx;
                    return (
                      <label
                        key={`${alt.kind}-${alt.route.airports.join("-")}`}
                        className={`flex cursor-pointer flex-col gap-2 rounded-sm border p-3 transition-colors ${
                          isSelected
                            ? "border-zinc-900 bg-zinc-50"
                            : "border-zinc-200 bg-white hover:border-zinc-300"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="partial-alt"
                              checked={isSelected}
                              onChange={() => setSelectedPartialIdx(idx)}
                              className="accent-zinc-900"
                            />
                            <span className="text-xs font-medium text-zinc-900">
                              {alt.label}
                            </span>
                          </div>
                          <span className="font-mono text-xs text-zinc-600 tabular-nums">
                            {alt.route.totalTransitDays}d (
                            {alt.daysOverLimit <= 0
                              ? "on time"
                              : `+${alt.daysOverLimit}d late`}
                            )
                          </span>
                        </div>
                        <div className="pl-[22px]">
                          <RoutePath airports={alt.route.airports} />
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-[22px]">
                          {alt.fulfilledServices.map((s) => (
                            <ServiceMark
                              key={s}
                              fulfilled
                              label={SERVICE_FULL_LABELS[s]}
                            />
                          ))}
                          {alt.serviceGaps
                            .filter((g) => !g.fulfilled)
                            .map((g) => (
                              <ServiceMark
                                key={g.service}
                                fulfilled={false}
                                label={`Missing ${SERVICE_FULL_LABELS[g.service]} (${g.missingOnLegs.join(", ")})`}
                              />
                            ))}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Decision footer --------------------------------------------- */}
        <div className="shrink-0 border-t border-zinc-300 bg-zinc-50/80 px-6 py-4">
          <SectionHeading>Commercial decision</SectionHeading>

          <textarea
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.target.value)}
            rows={2}
            placeholder="Optional commercial rationale or disclosure note for audit log..."
            className={`${INPUT} mt-2 resize-none py-1.5 text-xs`}
          />

          <div className="mt-3 flex flex-col gap-2">
            {assessment?.status === "FULLY_SERVABLE" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onRouteDecision(
                    lane.id,
                    "QUOTE_COMPLIANT",
                    undefined,
                    decisionNote,
                  )
                }
                data-testid="decision-btn-compliant"
                className={`${DECISION_ROW} border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700`}
              >
                <span>Quote compliant route as requested</span>
                <Check className="h-3.5 w-3.5" />
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
                  title={
                    canQuoteCompliant
                      ? undefined
                      : "No route supports every required service"
                  }
                  data-testid="decision-btn-compliant-late"
                  className={`${DECISION_ROW} border-zinc-300 bg-white text-zinc-900 hover:border-zinc-900`}
                >
                  <span>
                    Use compliant route and ask for a longer transit time
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {compliantRoute && (
                      <span className="font-mono text-xs font-normal text-zinc-500 tabular-nums">
                        {compliantRoute.totalTransitDays}d (+
                        {Math.max(
                          0,
                          compliantRoute.totalTransitDays - lane.maxTransitDays,
                        )}
                        d)
                      </span>
                    )}
                    <ArrowRight className="h-3.5 w-3.5 text-zinc-300 transition-colors group-hover:text-zinc-900 group-disabled:text-zinc-300" />
                  </span>
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
                  title={
                    canQuotePartial
                      ? undefined
                      : "No alternative route is available"
                  }
                  data-testid="decision-btn-partial-on-time"
                  className={`${DECISION_ROW} border-zinc-300 bg-white text-zinc-900 hover:border-zinc-900`}
                >
                  <span>Use on-time route and state missing services</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {partialAltList[selectedPartialIdx] && (
                      <span className="font-mono text-xs font-normal text-zinc-500 tabular-nums">
                        {partialAltList[selectedPartialIdx]!.route.totalTransitDays}d
                      </span>
                    )}
                    <ArrowRight className="h-3.5 w-3.5 text-zinc-300 transition-colors group-hover:text-zinc-900 group-disabled:text-zinc-300" />
                  </span>
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
              className={`${DECISION_ROW} border-zinc-200 bg-white text-red-700 hover:border-red-300 hover:bg-red-50/50`}
            >
              <span>Decline lane</span>
              <X className="h-3.5 w-3.5 text-red-400 transition-colors group-hover:text-red-700" />
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
