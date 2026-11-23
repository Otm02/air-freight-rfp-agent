"use client";

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  DollarSign,
  Mail,
  Send,
  ShieldCheck,
} from "lucide-react";
import { SERVICE_TYPES, type ServiceType } from "../domain/types";
import type {
  HumanTaskView,
  LaneWorkspaceView,
  ProposalView,
} from "../orchestrator/types";
import { SERVICE_FULL_LABELS, formatDateTimeShort, formatUsd } from "./ui-helpers";

interface HumanTasksPanelProps {
  tasks: readonly HumanTaskView[];
  lanes: readonly LaneWorkspaceView[];
  proposal: ProposalView | null;
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

export function HumanTasksPanel({
  tasks,
  lanes,
  proposal,
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
  const [approverName, setApproverName] = useState("alice.rfp@carrier.example");
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
      {/* Open Blocking Tasks */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <AlertCircle
              className={`h-4 w-4 ${openTasks.length > 0 ? "text-amber-600" : "text-emerald-600"}`}
            />
            <h2 className="text-sm font-semibold text-slate-900">
              Open Human Tasks ({openTasks.length})
            </h2>
          </div>

          {openTasks.some((t) => t.taskType === "CLARIFY_PRICING") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onClarifyPricing()}
              data-testid="clarify-all-pricing-btn"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
            >
              <Mail className="h-3.5 w-3.5" />
              Clarify All Pricing via Email
            </button>
          )}
        </div>

        {openTasks.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-600" />
            <p className="mt-2 text-sm font-medium text-slate-800">
              All human checkpoints for this stage are clear.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              No unresolved escalations or approvals are blocking workflow progression.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {openTasks.map((task) => {
              const lane =
                task.laneId !== null ? laneById.get(task.laneId) : undefined;

              return (
                <div
                  key={task.id}
                  data-testid={`open-task-${task.taskType}-${task.laneCode ?? "rfp"}`}
                  className="space-y-3 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-900">
                          {task.taskType}
                        </span>
                        {task.laneCode && (
                          <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-800">
                            {task.laneCode}
                          </span>
                        )}
                        <h3 className="text-sm font-semibold text-slate-900">
                          {task.title}
                        </h3>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                        <strong className="text-slate-800">
                          Agent Recommendation & Why:{" "}
                        </strong>
                        {task.reason}
                      </p>
                    </div>

                    {lane && (
                      <button
                        type="button"
                        onClick={() => onInspectLane(lane.id)}
                        className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Open Lane Drawer
                      </button>
                    )}
                  </div>

                  {/* Task-Specific Resolution Controls */}
                  {task.taskType === "CONFIRM_REQUIREMENTS" && lane && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="mb-2 text-xs text-slate-600 italic">
                        &ldquo;{lane.rawEmail}&rdquo;
                      </p>
                      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                        {SERVICE_TYPES.map((svc) => {
                          const current = getDraftServices(lane);
                          return (
                            <label
                              key={svc}
                              className="flex cursor-pointer items-center gap-2 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                            >
                              <input
                                type="checkbox"
                                checked={current.includes(svc)}
                                onChange={() =>
                                  toggleDraftService(lane.id, current, svc)
                                }
                                className="accent-[#1E3A5F]"
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
                        className="mt-3 rounded-lg bg-[#1E3A5F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                      >
                        Confirm Requirements & Re-Route
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
                          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Use compliant route & ask for longer transit (+
                          {Math.max(
                            0,
                            lane.assessment.bestCompliantRoute.totalTransitDays -
                              lane.maxTransitDays,
                          )}
                          d)
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
                          className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-950 hover:bg-sky-100 disabled:opacity-50"
                        >
                          Use on-time route & state missing services
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRouteDecision(lane.id, "DECLINE")}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-50"
                      >
                        Decline lane
                      </button>
                    </div>
                  )}

                  {task.taskType === "CLARIFY_PRICING" && lane && (
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onClarifyPricing(task.id)}
                        data-testid={`send-pricing-clarification-${lane.laneCode}`}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        Send Clarification Email to Pricing
                      </button>

                      <span className="text-xs text-slate-400">or</span>

                      <div className="inline-flex items-center gap-1.5">
                        <div className="relative">
                          <DollarSign className="pointer-events-none absolute top-2 left-2 h-3.5 w-3.5 text-slate-400" />
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
                            className="w-32 rounded-lg border border-slate-200 py-1.5 pr-2 pl-7 text-xs tabular-nums focus:border-[#1E3A5F] focus:outline-hidden"
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
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-45"
                        >
                          Save Manual Rate (/t)
                        </button>
                      </div>
                    </div>
                  )}

                  {task.taskType === "APPROVE_QUOTE" && proposal && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-xs text-slate-700">
                          Proposal v{proposal.version}:{" "}
                          <strong className="text-slate-900">
                            {proposal.totalQuotedLanes} quoted
                          </strong>
                          , {proposal.totalDeclinedLanes} declined ·{" "}
                          <strong className="text-slate-900">
                            {formatUsd(proposal.totalValueUsd, 2)} USD
                          </strong>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            value={approverName}
                            onChange={(e) => setApproverName(e.target.value)}
                            aria-label="Approver identifier"
                            className="w-52 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-[#1E3A5F] focus:outline-hidden"
                          />
                          <button
                            type="button"
                            disabled={busy || !approverName.trim()}
                            onClick={() =>
                              onApproveAndSendQuote(
                                proposal.id,
                                approverName.trim(),
                              )
                            }
                            data-testid="approve-send-quote-btn"
                            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Approve & Send Customer Quote
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {(task.taskType === "CUSTOMER_QUESTION" ||
                    task.taskType === "CUSTOMER_REPLY_REVIEW") && (
                    <div className="space-y-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <textarea
                        rows={2}
                        placeholder="Write clarification response sent to customer or internal resolution summary..."
                        value={followUpNotes[task.id] ?? ""}
                        onChange={(e) =>
                          setFollowUpNotes((prev) => ({
                            ...prev,
                            [task.id]: e.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs focus:border-[#1E3A5F] focus:outline-hidden"
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
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-45"
                        >
                          <Send className="h-3.5 w-3.5" />
                          Send Follow-Up & Re-open Reply
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            onResolveFollowUp(
                              task.id,
                              (followUpNotes[task.id] ?? "").trim() ||
                                "Customer opted not to proceed.",
                              "CLOSE_LOST",
                            )
                          }
                          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-50"
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

      {/* Resolved Audit Trail */}
      {resolvedTasks.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-2xs">
          <div className="border-b border-slate-200 px-5 py-3">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Resolved Human Checkpoints ({resolvedTasks.length})
            </h3>
          </div>
          <div className="divide-y divide-slate-100">
            {resolvedTasks.map((task) => (
              <div
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs"
              >
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  {task.laneCode && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-700">
                      {task.laneCode}
                    </span>
                  )}
                  <span className="font-medium text-slate-800">{task.title}</span>
                </div>
                <span className="text-[11px] text-slate-400">
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
