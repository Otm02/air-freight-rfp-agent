"use client";

import { useState } from "react";
import { Check, Mail, Send, ShieldCheck } from "lucide-react";
import { SERVICE_TYPES, type ServiceType } from "../domain/types";
import type {
  HumanTaskView,
  LaneWorkspaceView,
  ProposalView,
} from "../orchestrator/types";
import {
  INPUT,
  PANEL,
  PANEL_HEADER,
  StatusDot,
  buttonClass,
} from "./ui";
import { SERVICE_FULL_LABELS, formatDateTimeShort, formatUsd } from "./ui-helpers";

interface HumanTasksPanelProps {
  tasks: readonly HumanTaskView[];
  lanes: readonly LaneWorkspaceView[];
  proposal: ProposalView | null;
  reviewerEmail: string;
  onReviewerEmailChange: (value: string) => void;
  busy: boolean;
  onInspectLane: (laneId: number) => void;
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
  onClarifyPricing: (taskId?: number) => Promise<void>;
  onSetManualPrice: (
    laneId: number,
    pricePerTonUsd: number,
    note: string,
  ) => Promise<void>;
  onApproveAndSendQuote: (
    proposalId: number,
    approvedBy: string,
  ) => Promise<void>;
  onResolveFollowUp: (
    taskId: number,
    responseNote: string,
    outcome: "RETURN_TO_SENT" | "CLOSE_LOST",
  ) => Promise<void>;
}

const ACTION_WELL = "rounded-sm border border-zinc-200 bg-zinc-50/60 p-3";

export function HumanTasksPanel({
  tasks,
  lanes,
  proposal,
  reviewerEmail,
  onReviewerEmailChange,
  busy,
  onInspectLane,
  onConfirmRequirements,
  onRouteDecision,
  onClarifyPricing,
  onSetManualPrice,
  onApproveAndSendQuote,
  onResolveFollowUp,
}: HumanTasksPanelProps) {
  const [manualPrices, setManualPrices] = useState<Record<number, string>>({});
  const [serviceDrafts, setServiceDrafts] = useState<
    Record<number, ServiceType[]>
  >({});
  const [followUpNotes, setFollowUpNotes] = useState<Record<number, string>>({});

  const laneById = new Map(lanes.map((l) => [l.id, l]));
  const openTasks = tasks.filter((t) => t.status === "OPEN");
  const resolvedTasks = tasks.filter((t) => t.status !== "OPEN");

  const getDraftServices = (lane: LaneWorkspaceView | undefined): ServiceType[] => {
    if (!lane) return [];
    return serviceDrafts[lane.id] ?? lane.requestedServices;
  };

  const toggleDraftService = (
    laneId: number,
    current: ServiceType[],
    svc: ServiceType,
  ) => {
    const next = current.includes(svc)
      ? current.filter((s) => s !== svc)
      : [...current, svc];
    setServiceDrafts((prev) => ({ ...prev, [laneId]: next }));
  };

  return (
    <div className="space-y-6" data-testid="human-tasks-panel">
      <div className={PANEL}>
        <div className={PANEL_HEADER}>
          <div className="flex items-center gap-2">
            <StatusDot tone={openTasks.length > 0 ? "warn" : "ok"} />
            <h2 className="text-sm font-medium text-zinc-900">
              Open Review Tasks
              <span className="ml-1.5 font-normal text-zinc-500 tabular-nums">
                ({openTasks.length})
              </span>
            </h2>
          </div>

          {openTasks.some((t) => t.taskType === "CLARIFY_PRICING") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onClarifyPricing()}
              data-testid="clarify-all-pricing-btn"
              className={buttonClass("primary")}
            >
              <Mail className="h-3.5 w-3.5" />
              Clarify All Pricing via Email
            </button>
          )}
        </div>

        {openTasks.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Check className="mx-auto h-4 w-4 text-zinc-400" />
            <p className="mt-2 text-sm font-medium text-zinc-900">
              No open tasks for this stage.
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              All blockers are resolved; the pipeline can advance.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-200">
            {openTasks.map((task) => {
              const lane =
                task.laneId !== null ? laneById.get(task.laneId) : undefined;

              return (
                <div
                  key={task.id}
                  data-testid={`open-task-${task.taskType}-${task.laneCode ?? "rfp"}`}
                  className="space-y-3 px-4 py-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <StatusDot tone="warn" />
                        <span className="font-mono text-2xs font-medium tracking-[0.04em] text-zinc-500">
                          {task.taskType}
                        </span>
                        {task.laneCode && (
                          <span className="font-mono text-xs font-semibold text-zinc-900">
                            {task.laneCode}
                          </span>
                        )}
                      </div>
                      <h3 className="mt-1.5 text-sm font-medium text-zinc-900">
                        {task.title}
                      </h3>
                      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-600">
                        <span className="font-medium text-zinc-900">
                          Recommendation:{" "}
                        </span>
                        {task.reason}
                      </p>
                    </div>

                    {lane && (
                      <button
                        type="button"
                        onClick={() => onInspectLane(lane.id)}
                        className={buttonClass("secondary")}
                      >
                        Inspect Lane
                      </button>
                    )}
                  </div>

                  {task.taskType === "CONFIRM_REQUIREMENTS" && lane && (
                    <div className={ACTION_WELL}>
                      <p className="mb-2.5 border-l-2 border-zinc-300 pl-2.5 text-xs leading-relaxed text-zinc-600">
                        &ldquo;{lane.rawEmail}&rdquo;
                      </p>
                      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                        {SERVICE_TYPES.map((svc) => {
                          const current = getDraftServices(lane);
                          const checked = current.includes(svc);
                          return (
                            <label
                              key={svc}
                              className={`flex cursor-pointer items-center gap-2 rounded-sm border bg-white px-2.5 py-1.5 text-xs transition-colors ${
                                checked
                                  ? "border-zinc-900 text-zinc-900"
                                  : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  toggleDraftService(lane.id, current, svc)
                                }
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
                          onConfirmRequirements(
                            lane.id,
                            getDraftServices(lane),
                            "Confirmed via Human Tasks panel",
                          )
                        }
                        data-testid={`confirm-req-btn-${lane.laneCode}`}
                        className={buttonClass("primary", "md", "mt-3")}
                      >
                        Confirm Requirements &amp; Re-Route
                      </button>
                    </div>
                  )}

                  {task.taskType === "LANE_ROUTE_DECISION" && lane && (
                    <div className="flex flex-wrap gap-2">
                      {lane.assessment?.bestCompliantRoute && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            onRouteDecision(lane.id, "QUOTE_COMPLIANT_LATE")
                          }
                          className={buttonClass("secondary", "md")}
                        >
                          Quote compliant route &amp; ask for +
                          {Math.max(
                            0,
                            lane.assessment.bestCompliantRoute.totalTransitDays -
                              lane.maxTransitDays,
                          )}
                          d transit
                        </button>
                      )}
                      {(lane.assessment?.alternatives.length ?? 0) > 0 ||
                      lane.assessment?.fastestUnconstrainedRoute ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            onRouteDecision(lane.id, "QUOTE_PARTIAL_ON_TIME", 0)
                          }
                          className={buttonClass("secondary", "md")}
                        >
                          Quote on-time route &amp; disclose missing services
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRouteDecision(lane.id, "DECLINE")}
                        className={buttonClass("danger", "md")}
                      >
                        Decline lane
                      </button>
                    </div>
                  )}

                  {task.taskType === "CLARIFY_PRICING" && lane && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onClarifyPricing(task.id)}
                        data-testid={`send-pricing-clarification-${lane.laneCode}`}
                        className={buttonClass("primary", "md")}
                      >
                        <Mail className="h-3.5 w-3.5" />
                        Send Clarification Email to Pricing
                      </button>

                      <span className="text-2xs tracking-[0.06em] text-zinc-400 uppercase">
                        or
                      </span>

                      <div className="inline-flex items-center gap-2">
                        <div className="relative">
                          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-zinc-400">
                            $
                          </span>
                          <input
                            type="number"
                            min={100}
                            step={10}
                            placeholder="e.g. 2650"
                            value={manualPrices[lane.id] ?? ""}
                            onChange={(e) =>
                              setManualPrices((prev) => ({
                                ...prev,
                                [lane.id]: e.target.value,
                              }))
                            }
                            data-testid={`manual-price-input-${lane.laneCode}`}
                            className={`${INPUT} h-8 w-32 pl-6 text-right tabular-nums`}
                          />
                        </div>
                        <button
                          type="button"
                          disabled={
                            busy ||
                            !manualPrices[lane.id] ||
                            Number(manualPrices[lane.id]) <= 0
                          }
                          onClick={() =>
                            onSetManualPrice(
                              lane.id,
                              Number(manualPrices[lane.id]),
                              "Manual rate confirmed in Human Tasks panel",
                            )
                          }
                          data-testid={`manual-price-submit-${lane.laneCode}`}
                          className={buttonClass("secondary", "md")}
                        >
                          Save Manual Rate (/t)
                        </button>
                      </div>
                    </div>
                  )}

                  {task.taskType === "APPROVE_QUOTE" && proposal && (
                    <div className={ACTION_WELL}>
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="text-xs text-zinc-600 tabular-nums">
                          Proposal v{proposal.version}:{" "}
                          <span className="font-medium text-zinc-900">
                            {proposal.totalQuotedLanes} quoted
                          </span>
                          , {proposal.totalDeclinedLanes} declined ·{" "}
                          <span className="font-medium text-zinc-900">
                            {formatUsd(proposal.totalValueUsd, 2)} USD
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            value={reviewerEmail}
                            onChange={(e) => onReviewerEmailChange(e.target.value)}
                            aria-label="Approver identifier"
                            className={`${INPUT} h-8 w-56 text-xs`}
                          />
                          <button
                            type="button"
                            disabled={busy || !reviewerEmail.trim()}
                            onClick={() =>
                              onApproveAndSendQuote(
                                proposal.id,
                                reviewerEmail.trim(),
                              )
                            }
                            data-testid="approve-send-quote-btn"
                            className={buttonClass("approve", "md")}
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Approve &amp; Send Customer Quote
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {(task.taskType === "CUSTOMER_QUESTION" ||
                    task.taskType === "CUSTOMER_REPLY_REVIEW") && (
                    <div className={`${ACTION_WELL} space-y-2.5`}>
                      <textarea
                        rows={2}
                        placeholder="Record clarification sent to shipper or resolution note..."
                        value={followUpNotes[task.id] ?? ""}
                        onChange={(e) =>
                          setFollowUpNotes((prev) => ({
                            ...prev,
                            [task.id]: e.target.value,
                          }))
                        }
                        className={`${INPUT} resize-none py-1.5 text-xs`}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy || !(followUpNotes[task.id] ?? "").trim()}
                          onClick={() =>
                            onResolveFollowUp(
                              task.id,
                              followUpNotes[task.id]!.trim(),
                              "RETURN_TO_SENT",
                            )
                          }
                          className={buttonClass("primary", "md")}
                        >
                          <Send className="h-3.5 w-3.5" />
                          Send Follow-Up &amp; Reopen Quote
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            onResolveFollowUp(
                              task.id,
                              (followUpNotes[task.id] ?? "").trim() ||
                                "Customer declined to proceed.",
                              "CLOSE_LOST",
                            )
                          }
                          className={buttonClass("danger", "md")}
                        >
                          Close Deal Lost
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {resolvedTasks.length > 0 && (
        <div className={PANEL}>
          <div className="flex h-9 items-center border-b border-zinc-200 px-4">
            <h3 className="eyebrow">
              Resolved Checkpoints
              <span className="ml-1.5 tabular-nums">
                ({resolvedTasks.length})
              </span>
            </h3>
          </div>
          <div className="divide-y divide-zinc-100">
            {resolvedTasks.map((task) => (
              <div
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs"
              >
                <div className="flex items-center gap-2.5">
                  <Check className="h-3.5 w-3.5 text-zinc-400" />
                  {task.laneCode && (
                    <span className="font-mono font-semibold text-zinc-900">
                      {task.laneCode}
                    </span>
                  )}
                  <span className="text-zinc-700">{task.title}</span>
                </div>
                <span className="text-xs text-zinc-400 tabular-nums">
                  {task.status} ·{" "}
                  {task.resolvedAt ? formatDateTimeShort(task.resolvedAt) : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
