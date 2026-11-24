"use client";

import { useCallback, useState } from "react";
import { Download, FileText, Mail, Send, ShieldCheck, Sparkles } from "lucide-react";
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
  PANEL,
  PANEL_HEADER,
  RoutePath,
  ServiceMark,
  StatusDot,
  StatusMark,
  TH,
  buttonClass,
} from "./ui";
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
  const [reviewerEmail, setReviewerEmail] = useState("alice.rfp@carrier.example");
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
      reviewer: reviewerEmail.trim() || "alice.rfp@carrier.example",
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
      reviewer: reviewerEmail.trim() || "alice.rfp@carrier.example",
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
      reviewer: reviewerEmail.trim() || "alice.rfp@carrier.example",
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
      approvedBy: approvedBy.trim() || reviewerEmail.trim() || "alice.rfp@carrier.example",
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
        reviewer: reviewerEmail.trim() || "alice.rfp@carrier.example",
        responseNote,
        outcome,
      },
    );
  };

  const { rfp, summary, proposal, meeting } = workspace;

  const bannerTone = rfp.isWaitingForHuman
    ? "warn"
    : rfp.status === "WON"
      ? "ok"
      : rfp.status === "LOST"
        ? "bad"
        : "neutral";

  const kpis: Array<{
    label: string;
    value: React.ReactNode;
    sub: React.ReactNode;
  }> = [
    {
      label: "RFP Volume",
      value: (
        <>
          {summary.totalLanes}
          <span className="ml-1 text-sm font-normal text-zinc-500">Lanes</span>
        </>
      ),
      sub: `${summary.totalTons.toLocaleString("en-US")}t freight`,
    },
    {
      label: "Fully Servable",
      value: summary.servableCount,
      sub:
        summary.totalLanes > 0
          ? `${Math.round((summary.servableCount / summary.totalLanes) * 100)}% compliant on time`
          : "-",
    },
    {
      label: "Late / Partial",
      value: summary.lateCount + summary.missingServicesCount,
      sub: `${summary.lateCount} late · ${summary.missingServicesCount} partial`,
    },
    {
      label: "No Time / Unreachable",
      value: summary.noRouteInTimeCount + summary.unreachableCount,
      sub: `${summary.noRouteInTimeCount} SLA · ${summary.unreachableCount} unreachable`,
    },
    {
      label: rfp.status === "WON" ? "Booked Revenue" : "Est. Revenue",
      value:
        summary.estimatedRevenueUsd > 0 ? (
          formatUsd(summary.estimatedRevenueUsd)
        ) : (
          <span className="text-zinc-400">Pending</span>
        ),
      sub: `${summary.pricedLanesCount} lane(s) priced`,
    },
  ];

  const tabs = [
    {
      id: "lanes",
      label: "Lanes",
      count: String(workspace.lanes.length),
      highlight: false,
    },
    {
      id: "tasks",
      label: "Human Tasks",
      count: `${summary.openHumanTasksCount} open`,
      highlight: summary.openHumanTasksCount > 0,
    },
    {
      id: "emails",
      label: "Emails",
      count: String(workspace.emails.length),
      highlight: false,
    },
    {
      id: "proposal",
      label: "Proposal & Kickoff",
      count: null,
      highlight: false,
    },
  ] as const;

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

      <div className="flex flex-col lg:flex-row lg:items-start">
        <main className="min-w-0 flex-1 px-6 py-8 lg:px-8 lg:py-10">
          <div className="mx-auto max-w-[1120px] space-y-8">
            {errorBanner && (
              <div
                role="alert"
                className="flex items-start justify-between gap-4 rounded-md border border-zinc-200 border-l-2 border-l-red-600 bg-white px-4 py-3 text-xs text-zinc-700"
              >
                <div>
                  <span className="font-medium text-red-700">
                    Action blocked:{" "}
                  </span>
                  {errorBanner}
                </div>
                <button
                  type="button"
                  onClick={() => setErrorBanner(null)}
                  className="font-medium text-zinc-500 transition-colors hover:text-zinc-900"
                >
                  Dismiss
                </button>
              </div>
            )}

            <section
              data-testid="stage-action-banner"
              className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-md border border-zinc-200 border-l-2 bg-white px-5 py-4 ${
                bannerTone === "warn"
                  ? "border-l-amber-500"
                  : bannerTone === "ok"
                    ? "border-l-emerald-600"
                    : bannerTone === "bad"
                      ? "border-l-red-600"
                      : "border-l-zinc-300"
              }`}
            >
              <div className="min-w-0">
                <div className="eyebrow">
                  Shipper:{" "}
                  <span className="tracking-normal normal-case">
                    {rfp.customerName} (
                    <span className="font-mono">{rfp.customerEmail}</span>)
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2.5 text-sm font-medium text-zinc-900">
                  <StatusDot tone={bannerTone} />
                  <span>
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
                    {rfp.status === "LOST" &&
                      "Closed Lost following shipper rejection."}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {rfp.isWaitingForHuman && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("tasks")}
                    className={buttonClass("secondary", "md")}
                  >
                    <StatusDot tone="warn" />
                    Open Tasks ({summary.openHumanTasksCount})
                  </button>
                )}

                {rfp.status === "ROUTING" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleRequestPricing}
                    data-testid="action-request-pricing"
                    className={buttonClass("primary", "md")}
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
                    className={buttonClass("primary", "md")}
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
                    className={buttonClass("primary", "md")}
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
                      handleApproveAndSend(proposal.id, reviewerEmail)
                    }
                    data-testid="action-approve-send-banner"
                    className={buttonClass("approve", "md")}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Approve &amp; Send Quote
                  </button>
                )}

                {rfp.status === "SENT" && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("emails")}
                    data-testid="action-open-reply-simulator"
                    className={buttonClass("primary", "md")}
                  >
                    <Send className="h-3.5 w-3.5" />
                    Simulate Customer Reply
                  </button>
                )}

                {rfp.status === "WON" && meeting && (
                  <a
                    href={`/api/rfps/${rfp.id}/kickoff.ics`}
                    data-testid="action-download-ics"
                    className={buttonClass("primary", "md")}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download Kickoff .ics
                  </a>
                )}
              </div>
            </section>

            <section
              aria-label="RFP summary"
              className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-zinc-200 py-5 sm:grid-cols-3 lg:grid-cols-5 lg:gap-x-0"
            >
              {kpis.map((kpi) => (
                <div
                  key={kpi.label}
                  className="min-w-0 lg:border-l lg:border-zinc-200 lg:pl-6 lg:first:border-l-0 lg:first:pl-0"
                >
                  <div className="eyebrow">{kpi.label}</div>
                  <div className="mt-1.5 text-xl font-semibold tracking-tight text-zinc-900 tabular-nums">
                    {kpi.value}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 tabular-nums">
                    {kpi.sub}
                  </div>
                </div>
              ))}
            </section>

            <div className="space-y-4">
              <nav
                role="tablist"
                className="flex flex-wrap items-center gap-x-6 border-b border-zinc-200"
              >
                {tabs.map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveTab(tab.id)}
                      data-testid={`tab-${tab.id}`}
                      className={`-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 text-sm transition-colors ${
                        isActive
                          ? "border-zinc-900 font-medium text-zinc-900"
                          : "border-transparent text-zinc-500 hover:text-zinc-900"
                      }`}
                    >
                      <span>{tab.label}</span>
                      {tab.count !== null && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-normal text-zinc-400 tabular-nums">
                          {tab.highlight && <StatusDot tone="warn" />}
                          {tab.count}
                        </span>
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
                  reviewerEmail={reviewerEmail}
                  onReviewerEmailChange={setReviewerEmail}
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
                <div className="space-y-6" data-testid="proposal-kickoff-panel">
                  {!proposal ? (
                    <div className="rounded-md border border-dashed border-zinc-300 px-4 py-12 text-center text-xs text-zinc-500">
                      No customer proposal drafted yet. Complete route triage, validate pricing, and click Draft Customer Quote.
                    </div>
                  ) : (
                    <div className={`${PANEL} overflow-hidden`}>
                      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-200 px-5 py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 text-zinc-400" />
                            <h3 className="text-sm font-semibold text-zinc-900">
                              Proposal v{proposal.version} ({proposal.status})
                            </h3>
                          </div>
                          <p className="mt-1 text-xs text-zinc-500">
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
                          <div className="text-xl font-semibold tracking-tight text-zinc-900">
                            {formatUsd(proposal.totalValueUsd, 2)}{" "}
                            <span className="text-sm font-normal text-zinc-400">
                              USD
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-zinc-500">
                            {proposal.totalQuotedLanes} quoted ({proposal.totalTons}t) ·{" "}
                            {proposal.totalDeclinedLanes} declined
                          </div>
                        </div>
                      </div>

                      <div className="scroll-thin overflow-x-auto">
                        <table className="w-full border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-zinc-200 bg-zinc-50/60">
                              <th className={`${TH} py-2 pr-2 pl-5`}>Lane</th>
                              <th className={`${TH} px-2 py-2`}>Route</th>
                              <th className={`${TH} px-2 py-2 text-right`}>Tons</th>
                              <th className={`${TH} px-2 py-2 text-right`}>Transit</th>
                              <th className={`${TH} px-2 py-2`}>Services</th>
                              <th className={`${TH} px-2 py-2 text-right`}>Rate/t</th>
                              <th className={`${TH} px-2 py-2 text-right`}>Line Total</th>
                              <th className={`${TH} py-2 pr-5 pl-4`}>Disposition</th>
                            </tr>
                          </thead>
                          <tbody>
                            {proposal.lanes.map((pl) => {
                              const meta = DISPOSITION_META[pl.disposition] ?? {
                                label: pl.disposition,
                                tone: "neutral" as const,
                              };
                              return (
                                <tr
                                  key={pl.id}
                                  className="border-b border-zinc-100 last:border-b-0"
                                >
                                  <td className="py-2 pr-2 pl-5 font-mono font-semibold text-zinc-900">
                                    {pl.laneCode}
                                  </td>
                                  <td className="px-2 py-2">
                                    {pl.routeAirports.length > 0 ? (
                                      <RoutePath airports={pl.routeAirports} />
                                    ) : (
                                      <span className="text-zinc-300">-</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-2 text-right text-zinc-700 tabular-nums">
                                    {pl.tons.toFixed(1)}t
                                  </td>
                                  <td className="px-2 py-2 text-right text-zinc-900 tabular-nums">
                                    {pl.transitDays !== null ? (
                                      `${pl.transitDays}d`
                                    ) : (
                                      <span className="text-zinc-300">-</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-2">
                                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                                      {pl.fulfilledServices.map((s) => (
                                        <ServiceMark
                                          key={s}
                                          fulfilled
                                          label={SERVICE_SHORT_LABELS[s]}
                                        />
                                      ))}
                                      {pl.missingServices.map((s) => (
                                        <ServiceMark
                                          key={s}
                                          fulfilled={false}
                                          label={SERVICE_SHORT_LABELS[s]}
                                        />
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-2 py-2 text-right text-zinc-700 tabular-nums">
                                    {pl.pricePerTonUsd !== null ? (
                                      formatUsd(pl.pricePerTonUsd)
                                    ) : (
                                      <span className="text-zinc-300">-</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-2 text-right font-medium text-zinc-900 tabular-nums">
                                    {pl.lineTotalUsd !== null ? (
                                      formatUsd(pl.lineTotalUsd, 2)
                                    ) : (
                                      <span className="text-zinc-300">-</span>
                                    )}
                                  </td>
                                  <td className="py-2 pr-5 pl-4">
                                    <StatusMark
                                      tone={meta.tone}
                                      label={meta.label}
                                    />
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
                      className={`${PANEL} overflow-hidden`}
                    >
                      <div className={PANEL_HEADER}>
                        <div className="flex min-w-0 items-center gap-3">
                          <h3 className="truncate text-sm font-semibold text-zinc-900">
                            {meeting.title}
                          </h3>
                          <StatusMark tone="ok" label={meeting.status} />
                        </div>

                        <a
                          href={`/api/rfps/${rfp.id}/kickoff.ics`}
                          data-testid="download-kickoff-ics-link"
                          className={buttonClass("primary")}
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download .ics Invite
                        </a>
                      </div>

                      <div className="border-b border-zinc-100 px-5 py-3 text-xs text-zinc-600">
                        Scheduled UTC{" "}
                        <span className="font-mono font-medium text-zinc-900">
                          {meeting.scheduledAt}
                        </span>{" "}
                        ({meeting.durationMinutes} min · Next Business Day 10:00 ET)
                      </div>

                      <div className="grid grid-cols-1 gap-x-8 gap-y-5 px-5 py-4 sm:grid-cols-2">
                        <div>
                          <h4 className="eyebrow">Attendees</h4>
                          <ul className="mt-2 divide-y divide-zinc-100 text-xs text-zinc-800">
                            {meeting.attendees.map((att, idx) => (
                              <li
                                key={idx}
                                className="flex items-baseline gap-3 py-1.5"
                              >
                                <span className="w-20 shrink-0 font-mono text-2xs font-medium text-zinc-500">
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
                          <h4 className="eyebrow">Agenda</h4>
                          <pre className="mt-2 rounded-sm border border-zinc-200 bg-zinc-50/60 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap text-zinc-700">
                            {meeting.agenda}
                          </pre>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>

        {orchestrationOpen && (
          <AgentOrchestrationPanel
            rfpId={rfp.id}
            currentStatus={rfp.status}
            events={workspace.events}
            onStreamEvent={mergeEvents}
          />
        )}
      </div>

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
