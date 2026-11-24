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
import {
  DISPOSITION_META,
  SERVICE_SHORT_LABELS,
  formatDateTimeShort,
  formatUsd,
} from "./ui-helpers";

type WorkspaceTab = "lanes" | "tasks" | "emails" | "proposal";

interface RfpWorkspaceClientProps {
  initialWorkspace: RfpWorkspaceSnapshot;
}

export function RfpWorkspaceClient({
  initialWorkspace,
}: RfpWorkspaceClientProps) {
  const [workspace, setWorkspace] =
    useState<RfpWorkspaceSnapshot>(initialWorkspace);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("lanes");
  const [selectedLaneId, setSelectedLaneId] = useState<number | null>(null);
  const [orchestrationOpen, setOrchestrationOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const selectedLane: LaneWorkspaceView | null =
    selectedLaneId !== null
      ? (workspace.lanes.find((l) => l.id === selectedLaneId) ?? null)
      : null;

  const mergeEvents = useCallback((incoming: AgentEventView) => {
    setWorkspace((prev) => {
      if (prev.events.some((e) => e.id === incoming.id)) {
        return prev;
      }
      return {
        ...prev,
        events: [...prev.events, incoming].sort((a, b) => a.id - b.id),
      };
    });
  }, []);

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
    <div className="min-h-screen bg-canvas">
      <AppHeader
        activeModelLabel={rfp.activeModelLabel}
        openTasksCount={summary.openHumanTasksCount}
        currentRfp={{ id: rfp.id, title: rfp.title, status: rfp.status }}
        onHumanTasksClick={() => setActiveTab("tasks")}
        showOrchestrationToggle
        orchestrationOpen={orchestrationOpen}
        onToggleOrchestration={() => setOrchestrationOpen((v) => !v)}
      />

      <main className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6">
        <div
          className={`grid grid-cols-1 gap-5 ${
            orchestrationOpen ? "lg:grid-cols-[minmax(0,1fr)_390px]" : ""
          }`}
        >
          <div className="min-w-0 space-y-4">
            {errorBanner && (
              <div className="flex items-start justify-between gap-3 rounded-sm border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-900">
                <div>
                  <span className="font-medium">Action blocked: </span>
                  {errorBanner}
                </div>
                <button
                  type="button"
                  onClick={() => setErrorBanner(null)}
                  className="font-medium text-rose-700 hover:text-rose-950"
                >
                  Dismiss
                </button>
              </div>
            )}

            <section
              data-testid="stage-action-banner"
              className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 shadow-xs ${
                rfp.isWaitingForHuman
                  ? "border-amber-300/80 bg-amber-50/70"
                  : rfp.status === "WON"
                    ? "border-emerald-300/80 bg-emerald-50/60"
                    : "border-border/70 bg-white"
              }`}
            >
              <div>
                <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  Shipper: {rfp.customerName} ({rfp.customerEmail})
                </div>
                <div className="mt-0.5 text-[13px] font-medium text-zinc-900">
                  {rfp.status === "AWAITING_REQUIREMENT_CONFIRMATION" &&
                    `Paused for review: ${summary.openHumanTasksCount} lane requirement or route decision(s) open.`}
                  {rfp.status === "ROUTING" &&
                    "Routing approved. Ready to send specifications to Pricing Desk."}
                  {rfp.status === "AWAITING_PRICING_FIXES" &&
                    `Pricing anomalies open: ${summary.openHumanTasksCount} lane(s) require clarification or manual rate entry.`}
                  {rfp.status === "PRICING_RECEIVED" &&
                    "All quoted rates validated. Ready to draft the customer quote."}
                  {rfp.status === "AWAITING_APPROVAL" &&
                    "Quote drafted (Markdown and plain text). Sign-off required before sending."}
                  {rfp.status === "SENT" &&
                    "Proposal stored in outbox. Simulate or paste shipper reply in Emails."}
                  {rfp.status === "NEEDS_FOLLOW_UP" &&
                    "Customer question or unclear reply open for follow-up."}
                  {rfp.status === "WON" &&
                    "Deal booked in Proposals ledger and kickoff invite generated."}
                  {rfp.status === "LOST" && "Closed Lost following shipper rejection."}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {rfp.isWaitingForHuman && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("tasks")}
                    className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-amber-400/80 bg-white px-2.5 text-xs font-medium text-amber-950 hover:bg-amber-50"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    Open Tasks ({summary.openHumanTasksCount})
                  </button>
                )}

                {rfp.status === "ROUTING" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleRequestPricing}
                    data-testid="action-request-pricing"
                    className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
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
                    className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
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
                    className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
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
                    className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
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
                    className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Simulate Customer Reply
                  </button>
                )}

                {rfp.status === "WON" && meeting && (
                  <a
                    href={`/api/rfps/${rfp.id}/kickoff.ics`}
                    data-testid="action-download-ics"
                    className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-800"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download Kickoff .ics
                  </a>
                )}
              </div>
            </section>

            <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
              <div className="rounded-md border border-border/70 bg-white p-3.5 shadow-xs">
                <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  RFP Volume
                </div>
                <div className="mt-1 text-xl font-medium text-zinc-900 tabular-nums">
                  {summary.totalLanes} Lanes
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                  {summary.totalTons.toLocaleString("en-US")}t freight
                </div>
              </div>

              <div className="rounded-md border border-border/70 bg-white p-3.5 shadow-xs">
                <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  Fully Servable
                </div>
                <div className="mt-1 text-xl font-medium text-emerald-700 tabular-nums">
                  {summary.servableCount}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                  {summary.totalLanes > 0
                    ? `${Math.round((summary.servableCount / summary.totalLanes) * 100)}% compliant on time`
                    : "-"}
                </div>
              </div>

              <div className="rounded-md border border-border/70 bg-white p-3.5 shadow-xs">
                <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  Late / Partial
                </div>
                <div className="mt-1 text-xl font-medium text-amber-700 tabular-nums">
                  {summary.lateCount + summary.missingServicesCount}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                  {summary.lateCount} late · {summary.missingServicesCount} partial
                </div>
              </div>

              <div className="rounded-md border border-border/70 bg-white p-3.5 shadow-xs">
                <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  No Time / Unreachable
                </div>
                <div className="mt-1 text-xl font-medium text-zinc-800 tabular-nums">
                  {summary.noRouteInTimeCount + summary.unreachableCount}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                  {summary.noRouteInTimeCount} SLA · {summary.unreachableCount}{" "}
                  unreachable
                </div>
              </div>

              <div className="rounded-md border border-border/70 bg-white p-3.5 shadow-xs">
                <div className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  {rfp.status === "WON" ? "Booked Revenue" : "Est. Revenue"}
                </div>
                <div className="mt-1 text-xl font-medium text-zinc-900 tabular-nums">
                  {summary.estimatedRevenueUsd > 0
                    ? formatUsd(summary.estimatedRevenueUsd)
                    : "Pending"}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                  {summary.pricedLanesCount} lane(s) priced
                </div>
              </div>
            </section>

            <nav className="flex flex-wrap items-center gap-1 border-b border-border/70">
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
                    label: "Proposal & Kickoff",
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
                    className={`relative px-3.5 py-2 text-xs font-medium transition-colors ${
                      isActive
                        ? "border-b-2 border-zinc-900 text-zinc-900"
                        : "text-zinc-500 hover:text-zinc-900"
                    }`}
                  >
                    <span>{tab.label}</span>
                    {"highlight" in tab && tab.highlight && (
                      <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                    )}
                  </button>
                );
              })}
            </nav>

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
              <div className="space-y-4" data-testid="proposal-kickoff-panel">
                {!proposal ? (
                  <div className="rounded-md border border-dashed border-border/70 bg-white p-8 text-center text-xs text-zinc-500">
                    No customer proposal drafted yet. Complete route triage, validate pricing, and click Draft Customer Quote.
                  </div>
                ) : (
                  <div className="rounded-md border border-border/70 bg-white shadow-xs">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-zinc-700" />
                          <h3 className="text-[13px] font-medium text-zinc-900">
                            Proposal v{proposal.version} ({proposal.status})
                          </h3>
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-500">
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
                        <div className="text-base font-medium text-zinc-900">
                          {formatUsd(proposal.totalValueUsd, 2)} USD
                        </div>
                        <div className="text-[11px] text-zinc-500">
                          {proposal.totalQuotedLanes} quoted ({proposal.totalTons}t) ·{" "}
                          {proposal.totalDeclinedLanes} declined
                        </div>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-border/60 bg-zinc-50/60 text-[11px] font-medium text-zinc-500 uppercase">
                            <th className="px-3.5 py-2 font-medium">Lane</th>
                            <th className="px-3 py-2 font-medium">Route</th>
                            <th className="px-3 py-2 font-medium">Transit</th>
                            <th className="px-3 py-2 font-medium">Services</th>
                            <th className="px-3 py-2 text-right font-medium">
                              Rate/t
                            </th>
                            <th className="px-3 py-2 text-right font-medium">
                              Line Total
                            </th>
                            <th className="px-3.5 py-2 font-medium">
                              Disposition
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {proposal.lanes.map((pl) => {
                            const meta = DISPOSITION_META[pl.disposition] ?? {
                              label: pl.disposition,
                              badgeClass:
                                "bg-zinc-100 text-zinc-700 border-border/70",
                            };
                            return (
                              <tr key={pl.id}>
                                <td className="px-3.5 py-2 font-mono font-medium text-zinc-900">
                                  {pl.laneCode}{" "}
                                  <span className="font-sans font-normal text-zinc-500">
                                    ({pl.tons.toFixed(1)}t)
                                  </span>
                                </td>
                                <td className="px-3 py-2 font-mono text-zinc-700">
                                  {pl.routeAirports.length > 0
                                    ? pl.routeAirports.join(" -> ")
                                    : "-"}
                                </td>
                                <td className="px-3 py-2 tabular-nums">
                                  {pl.transitDays !== null
                                    ? `${pl.transitDays}d`
                                    : "-"}
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex flex-wrap gap-1">
                                    {pl.fulfilledServices.map((s) => (
                                      <span
                                        key={s}
                                        className="rounded-sm bg-emerald-50 px-1.5 py-px text-[10px] font-medium text-emerald-700"
                                      >
                                        ✓ {SERVICE_SHORT_LABELS[s]}
                                      </span>
                                    ))}
                                    {pl.missingServices.map((s) => (
                                      <span
                                        key={s}
                                        className="rounded-sm bg-rose-50 px-1.5 py-px text-[10px] font-medium text-rose-700"
                                      >
                                        ✗ {SERVICE_SHORT_LABELS[s]}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {pl.pricePerTonUsd !== null
                                    ? formatUsd(pl.pricePerTonUsd)
                                    : "-"}
                                </td>
                                <td className="px-3 py-2 text-right font-medium tabular-nums">
                                  {pl.lineTotalUsd !== null
                                    ? formatUsd(pl.lineTotalUsd, 2)
                                    : "-"}
                                </td>
                                <td className="px-3.5 py-2">
                                  <span
                                    className={`inline-flex rounded-sm border px-1.5 py-px text-[10px] font-medium ${meta.badgeClass}`}
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
                    className="rounded-md border border-emerald-200/80 bg-emerald-50/30 p-4 shadow-xs"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="inline-flex items-center gap-2 text-[13px] font-medium text-emerald-950">
                          <Calendar className="h-4 w-4 text-emerald-700" />
                          <span>{meeting.title}</span>
                          <span className="inline-flex items-center gap-1 rounded-sm bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-800">
                            <CheckCircle2 className="h-3 w-3" />
                            {meeting.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-600">
                          Scheduled UTC{" "}
                          <span className="font-mono font-medium text-zinc-900">
                            {meeting.scheduledAt}
                          </span>{" "}
                          ({meeting.durationMinutes} min · Next Business Day 10:00 ET)
                        </p>
                      </div>

                      <a
                        href={`/api/rfps/${rfp.id}/kickoff.ics`}
                        data-testid="download-kickoff-ics-link"
                        className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download .ics Invite
                      </a>
                    </div>

                    <div className="mt-3.5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <h4 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                          Attendees
                        </h4>
                        <ul className="mt-1.5 space-y-1 text-xs text-zinc-800">
                          {meeting.attendees.map((att, idx) => (
                            <li key={idx} className="flex items-center gap-2">
                              <span className="rounded-sm border border-border/70 bg-white px-1.5 py-px font-mono text-[10px] font-medium text-zinc-700">
                                {att.role}
                              </span>
                              <span>
                                {att.name}{" "}
                                <span className="font-mono text-zinc-500">
                                  &lt;{att.email}&gt;
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div>
                        <h4 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                          Agenda
                        </h4>
                        <pre className="mt-1.5 rounded-sm border border-emerald-200/80 bg-white p-2.5 font-sans text-xs whitespace-pre-wrap text-zinc-700">
                          {meeting.agenda}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

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
