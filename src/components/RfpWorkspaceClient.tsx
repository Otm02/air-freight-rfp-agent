"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Download,
  FileText,
  Mail,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ServiceType } from "../domain/types";
import type {
  AgentEventView,
  LaneWorkspaceView,
  RfpWorkspaceSnapshot,
} from "../orchestrator/types";
import { AgentOrchestrationPanel } from "./AgentOrchestrationPanel";
import { AppHeader } from "./AppHeader";
import { EmailsPanel } from "./EmailsPanel";
import { HumanTasksPanel } from "./HumanTasksPanel";
import { LaneDetailDrawer } from "./LaneDetailDrawer";
import { LaneTable } from "./LaneTable";
import { DISPOSITION_META, SERVICE_SHORT_LABELS, formatDateTimeShort, formatUsd } from "./ui-helpers";

type WorkspaceTab = "lanes" | "tasks" | "emails" | "proposal";

interface RfpWorkspaceClientProps {
  initialWorkspace: RfpWorkspaceSnapshot;
}

export function RfpWorkspaceClient({
  initialWorkspace,
}: RfpWorkspaceClientProps) {
  const [workspace, setWorkspace] = useState<RfpWorkspaceSnapshot>(initialWorkspace);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("lanes");
  const [selectedLaneId, setSelectedLaneId] = useState<number | null>(null);
  const [orchestrationOpen, setOrchestrationOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const selectedLane: LaneWorkspaceView | null =
    selectedLaneId !== null
      ? (workspace.lanes.find((l) => l.id === selectedLaneId) ?? null)
      : null;

  const mergeEvents = useCallback(
    (incoming: AgentEventView) => {
      setWorkspace((prev) => {
        if (prev.events.some((e) => e.id === incoming.id)) {
          return prev;
        }
        return {
          ...prev,
          events: [...prev.events, incoming].sort((a, b) => a.id - b.id),
        };
      });
    },
    [],
  );

  const runMutation = async (url: string, body?: unknown) => {
    setBusy(true);
    setErrorBanner(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : "{}",
      });
      const json: unknown = await res.json();
      if (!res.ok) {
        const msg =
          json && typeof json === "object" && "error" in json
            ? String((json as { error: unknown }).error)
            : `Request failed (${res.status})`;
        setErrorBanner(msg);
        return;
      }
      setWorkspace(json as RfpWorkspaceSnapshot);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRequirements = async (
    laneId: number,
    requestedServices: ServiceType[],
    note: string,
  ) => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/lanes/${laneId}/decision`, {
      action: "confirm_requirements",
      requestedServices,
      reviewer: "alice.rfp@carrier.example",
      note,
    });
  };

  const handleRouteDecision = async (
    laneId: number,
    disposition:
      | "QUOTE_COMPLIANT"
      | "QUOTE_COMPLIANT_LATE"
      | "QUOTE_PARTIAL_ON_TIME"
      | "DECLINE",
    alternativeIndex?: number,
    note?: string,
  ) => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/lanes/${laneId}/decision`, {
      action: "route_decision",
      disposition,
      alternativeIndex,
      reviewer: "alice.rfp@carrier.example",
      note,
    });
  };

  const handleRequestPricing = async () => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/pricing/request`, {});
  };

  const handleClarifyPricing = async (taskId?: number) => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/pricing/clarify`, {
      taskId,
    });
  };

  const handleSetManualPrice = async (
    laneId: number,
    pricePerTonUsd: number,
    note: string,
  ) => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/pricing/manual`, {
      laneId,
      pricePerTonUsd,
      reviewer: "alice.rfp@carrier.example",
      note,
    });
  };

  const handleDraftQuote = async () => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/quote/draft`, {});
  };

  const handleApproveAndSend = async (
    proposalId: number,
    approvedBy: string,
  ) => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/quote/approve-send`, {
      proposalId,
      approvedBy,
    });
  };

  const handleSimulateCustomerReply = async (opts: {
    proposalId: number;
    scenario?: "accept_all" | "accept_some" | "reject" | "question" | "unclear";
    customBody?: string;
    acceptedLaneCodes?: string[];
  }) => {
    await runMutation(`/api/rfps/${workspace.rfp.id}/customer-reply`, opts);
  };

  const handleResolveFollowUp = async (
    taskId: number,
    responseNote: string,
    outcome: "RETURN_TO_SENT" | "CLOSE_LOST",
  ) => {
    await runMutation(
      `/api/rfps/${workspace.rfp.id}/tasks/${taskId}/resolve`,
      {
        reviewer: "alice.rfp@carrier.example",
        responseNote,
        outcome,
      },
    );
  };

  const { rfp, summary, proposal, meeting } = workspace;

  return (
    <div className="min-h-screen bg-slate-50">
      <AppHeader
        activeModelLabel={rfp.activeModelLabel}
        openTasksCount={summary.openHumanTasksCount}
        currentRfp={{ id: rfp.id, title: rfp.title, status: rfp.status }}
        onHumanTasksClick={() => setActiveTab("tasks")}
        showOrchestrationToggle
        orchestrationOpen={orchestrationOpen}
        onToggleOrchestration={() => setOrchestrationOpen((v) => !v)}
      />

      <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        <div
          className={`grid grid-cols-1 gap-6 ${
            orchestrationOpen ? "lg:grid-cols-[minmax(0,1fr)_400px]" : ""
          }`}
        >
          {/* Main Left Workspace */}
          <div className="min-w-0 space-y-5">
            {/* Error Banner */}
            {errorBanner && (
              <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-900">
                <div>
                  <strong className="font-semibold">Action Blocked: </strong>
                  {errorBanner}
                </div>
                <button
                  type="button"
                  onClick={() => setErrorBanner(null)}
                  className="font-semibold text-rose-700 hover:text-rose-950"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Contextual Orchestrator Action Banner */}
            <section
              data-testid="stage-action-banner"
              className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border px-5 py-4 shadow-2xs ${
                rfp.isWaitingForHuman
                  ? "border-amber-300 bg-amber-50/90"
                  : rfp.status === "WON"
                    ? "border-emerald-300 bg-emerald-50/80"
                    : "border-slate-200 bg-white"
              }`}
            >
              <div>
                <div className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  Shipper: {rfp.customerName} ({rfp.customerEmail})
                </div>
                <div className="mt-0.5 text-sm font-semibold text-slate-900">
                  {rfp.status === "AWAITING_REQUIREMENT_CONFIRMATION" &&
                    `Paused for Human Input — ${summary.openHumanTasksCount} requirement or route trade-off decision(s) open.`}
                  {rfp.status === "ROUTING" &&
                    "All lanes triaged and approved for outreach. Ready to email Pricing Desk."}
                  {rfp.status === "AWAITING_PRICING_FIXES" &&
                    `Paused on Pricing Anomalies — ${summary.openHumanTasksCount} lane(s) missing or ambiguous. Clarify or enter manually.`}
                  {rfp.status === "PRICING_RECEIVED" &&
                    "All quoted lane rates validated. Ready to draft Customer Quote email."}
                  {rfp.status === "AWAITING_APPROVAL" &&
                    "Quote drafted (Markdown + Plain-Text). Human RFP Team approval required before sending."}
                  {rfp.status === "SENT" &&
                    "Proposal delivered to shipper outbox. Simulate or paste shipper reply in Emails tab."}
                  {rfp.status === "NEEDS_FOLLOW_UP" &&
                    "Customer question or unclear reply requires human follow-up."}
                  {rfp.status === "WON" &&
                    "Deal booked to SQLite Proposals ledger and Kickoff Meeting scheduled."}
                  {rfp.status === "LOST" &&
                    "Proposal closed as Lost following shipper rejection."}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {rfp.isWaitingForHuman && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("tasks")}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-100"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
                    Open Human Tasks ({summary.openHumanTasksCount})
                  </button>
                )}

                {rfp.status === "ROUTING" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleRequestPricing}
                    data-testid="action-request-pricing"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    Request Pricing from Desk
                  </button>
                )}

                {rfp.status === "AWAITING_PRICING_FIXES" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleClarifyPricing()}
                    data-testid="action-clarify-pricing-banner"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Clarify All Pricing via Email
                  </button>
                )}

                {rfp.status === "PRICING_RECEIVED" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDraftQuote}
                    data-testid="action-draft-quote"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Draft Customer Quote
                  </button>
                )}

                {rfp.status === "AWAITING_APPROVAL" && proposal && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      handleApproveAndSend(proposal.id, "alice.rfp@carrier.example")
                    }
                    data-testid="action-approve-send-banner"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Approve & Send Quote
                  </button>
                )}

                {rfp.status === "SENT" && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("emails")}
                    data-testid="action-open-reply-simulator"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162C49]"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Simulate Customer Reply
                  </button>
                )}

                {rfp.status === "WON" && meeting && (
                  <a
                    href={`/api/rfps/${rfp.id}/kickoff.ics`}
                    data-testid="action-download-ics"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download Kickoff .ics
                  </a>
                )}
              </div>
            </section>

            {/* Summary KPI Cards */}
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
                <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  RFP Volume
                </div>
                <div className="mt-1.5 text-2xl font-bold text-slate-900 tabular-nums">
                  {summary.totalLanes} Lanes
                </div>
                <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                  {summary.totalTons.toLocaleString("en-US")} tons freight
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
                <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  Fully Servable
                </div>
                <div className="mt-1.5 text-2xl font-bold text-emerald-700 tabular-nums">
                  {summary.servableCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                  {summary.totalLanes > 0
                    ? `${Math.round((summary.servableCount / summary.totalLanes) * 100)}% compliant on time`
                    : "—"}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
                <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  Late / Partial
                </div>
                <div className="mt-1.5 text-2xl font-bold text-amber-700 tabular-nums">
                  {summary.lateCount + summary.missingServicesCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                  {summary.lateCount} late · {summary.missingServicesCount} partial
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
                <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  No Time / Unreachable
                </div>
                <div className="mt-1.5 text-2xl font-bold text-slate-800 tabular-nums">
                  {summary.noRouteInTimeCount + summary.unreachableCount}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                  {summary.noRouteInTimeCount} SLA · {summary.unreachableCount} unreachable
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
                <div className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  {rfp.status === "WON" ? "Booked Revenue" : "Est. Revenue"}
                </div>
                <div className="mt-1.5 text-2xl font-bold text-[#1E3A5F] tabular-nums">
                  {summary.estimatedRevenueUsd > 0
                    ? formatUsd(summary.estimatedRevenueUsd)
                    : "Pending"}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                  {summary.pricedLanesCount} lane(s) priced
                </div>
              </div>
            </section>

            {/* Segmented Navigation Tabs */}
            <nav className="flex flex-wrap items-center gap-1 border-b border-slate-200">
              {(
                [
                  { id: "lanes", label: `Lanes (${workspace.lanes.length})` },
                  {
                    id: "tasks",
                    label: `Human Tasks (${summary.openHumanTasksCount} open)`,
                    highlight: summary.openHumanTasksCount > 0,
                  },
                  { id: "emails", label: `Emails (${workspace.emails.length})` },
                  {
                    id: "proposal",
                    label: meeting ? "Proposal & Kickoff ★" : "Proposal & Kickoff",
                  },
                ] as const
              ).map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    data-testid={`tab-${tab.id}`}
                    className={`relative px-4 py-2.5 text-xs font-semibold transition ${
                      isActive
                        ? "border-b-2 border-[#1E3A5F] text-[#1E3A5F]"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    <span>{tab.label}</span>
                    {"highlight" in tab && tab.highlight && (
                      <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-amber-500" />
                    )}
                  </button>
                );
              })}
            </nav>

            {/* Active Tab Body */}
            {activeTab === "lanes" && (
              <LaneTable
                lanes={workspace.lanes}
                selectedLaneId={selectedLaneId}
                onSelectLane={(lane) => setSelectedLaneId(lane.id)}
              />
            )}

            {activeTab === "tasks" && (
              <HumanTasksPanel
                tasks={workspace.humanTasks}
                lanes={workspace.lanes}
                proposal={proposal}
                busy={busy}
                onInspectLane={(laneId) => setSelectedLaneId(laneId)}
                onConfirmRequirements={handleConfirmRequirements}
                onRouteDecision={handleRouteDecision}
                onClarifyPricing={handleClarifyPricing}
                onSetManualPrice={handleSetManualPrice}
                onApproveAndSendQuote={handleApproveAndSend}
                onResolveFollowUp={handleResolveFollowUp}
              />
            )}

            {activeTab === "emails" && (
              <EmailsPanel
                emails={workspace.emails}
                proposal={proposal}
                rfpStatus={rfp.status}
                busy={busy}
                onSimulateCustomerReply={handleSimulateCustomerReply}
              />
            )}

            {activeTab === "proposal" && (
              <div className="space-y-5" data-testid="proposal-kickoff-panel">
                {!proposal ? (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-xs text-slate-500">
                    No customer proposal has been drafted yet. Complete route decisions, pricing validation, and click Draft Customer Quote.
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 bg-white shadow-2xs">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-[#1E3A5F]" />
                          <h3 className="text-sm font-semibold text-slate-900">
                            SQL Proposal v{proposal.version} — Status: {proposal.status}
                          </h3>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {proposal.approvedBy
                            ? `Approved by ${proposal.approvedBy} at ${formatDateTimeShort(proposal.approvedAt ?? "")}`
                            : "Pending approval"}
                          {proposal.sentAt &&
                            ` · Sent ${formatDateTimeShort(proposal.sentAt)}`}
                          {proposal.acceptedAt &&
                            ` · Booked ${formatDateTimeShort(proposal.acceptedAt)}`}
                        </p>
                      </div>
                      <div className="text-right tabular-nums">
                        <div className="text-lg font-bold text-[#1E3A5F]">
                          {formatUsd(proposal.totalValueUsd, 2)} USD
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {proposal.totalQuotedLanes} quoted ({proposal.totalTons}t) ·{" "}
                          {proposal.totalDeclinedLanes} declined
                        </div>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase">
                            <th className="px-4 py-2">Lane</th>
                            <th className="px-3 py-2">Route</th>
                            <th className="px-3 py-2">Transit</th>
                            <th className="px-3 py-2">Services</th>
                            <th className="px-3 py-2 text-right">Rate/t</th>
                            <th className="px-3 py-2 text-right">Line Total</th>
                            <th className="px-3 py-2">Disposition</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {proposal.lanes.map((pl) => {
                            const meta = DISPOSITION_META[pl.disposition] ?? {
                              label: pl.disposition,
                              badgeClass:
                                "bg-slate-100 text-slate-700 border-slate-200",
                            };
                            return (
                              <tr key={pl.id}>
                                <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">
                                  {pl.laneCode}{" "}
                                  <span className="font-sans font-normal text-slate-500">
                                    ({pl.tons.toFixed(1)}t)
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 font-mono text-slate-700">
                                  {pl.routeAirports.length > 0
                                    ? pl.routeAirports.join(" → ")
                                    : "—"}
                                </td>
                                <td className="px-3 py-2.5 tabular-nums">
                                  {pl.transitDays !== null
                                    ? `${pl.transitDays}d`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2.5">
                                  <div className="flex flex-wrap gap-1">
                                    {pl.fulfilledServices.map((s) => (
                                      <span
                                        key={s}
                                        className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                                      >
                                        ✓ {SERVICE_SHORT_LABELS[s]}
                                      </span>
                                    ))}
                                    {pl.missingServices.map((s) => (
                                      <span
                                        key={s}
                                        className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700"
                                      >
                                        ✗ {SERVICE_SHORT_LABELS[s]}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums">
                                  {pl.pricePerTonUsd !== null
                                    ? formatUsd(pl.pricePerTonUsd)
                                    : "—"}
                                </td>
                                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                                  {pl.lineTotalUsd !== null
                                    ? formatUsd(pl.lineTotalUsd, 2)
                                    : "—"}
                                </td>
                                <td className="px-3 py-2.5">
                                  <span
                                    className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold ${meta.badgeClass}`}
                                  >
                                    {meta.label}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {meeting && (
                  <div
                    data-testid="kickoff-meeting-card"
                    className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-5 shadow-2xs"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-950">
                          <Calendar className="h-4 w-4 text-emerald-700" />
                          <span>{meeting.title}</span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                            <CheckCircle2 className="h-3 w-3" />
                            {meeting.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-700">
                          Scheduled UTC:{" "}
                          <strong className="font-mono">
                            {meeting.scheduledAt}
                          </strong>{" "}
                          ({meeting.durationMinutes} min · Next Business Day 10:00 ET)
                        </p>
                      </div>

                      <a
                        href={`/api/rfps/${rfp.id}/kickoff.ics`}
                        data-testid="download-kickoff-ics-link"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E3A5F] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#162C49]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download .ics Invite
                      </a>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <h4 className="text-[11px] font-semibold tracking-wide text-slate-600 uppercase">
                          Invited Attendees
                        </h4>
                        <ul className="mt-1.5 space-y-1 text-xs text-slate-800">
                          {meeting.attendees.map((att, idx) => (
                            <li key={idx} className="flex items-center gap-2">
                              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-700 ring-1 ring-slate-200">
                                {att.role}
                              </span>
                              <span>
                                {att.name}{" "}
                                <span className="font-mono text-slate-500">
                                  &lt;{att.email}&gt;
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div>
                        <h4 className="text-[11px] font-semibold tracking-wide text-slate-600 uppercase">
                          Kickoff Agenda
                        </h4>
                        <pre className="mt-1.5 rounded-lg border border-emerald-200 bg-white p-2.5 font-sans text-xs whitespace-pre-wrap text-slate-700">
                          {meeting.agenda}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right-hand Live SSE Agent Orchestration Panel */}
          {orchestrationOpen && (
            <AgentOrchestrationPanel
              rfpId={rfp.id}
              currentStatus={rfp.status}
              events={workspace.events}
              onStreamEvent={mergeEvents}
            />
          )}
        </div>
      </main>

      <LaneDetailDrawer
        lane={selectedLane}
        busy={busy}
        onClose={() => setSelectedLaneId(null)}
        onConfirmRequirements={handleConfirmRequirements}
        onRouteDecision={handleRouteDecision}
      />
    </div>
  );
}
