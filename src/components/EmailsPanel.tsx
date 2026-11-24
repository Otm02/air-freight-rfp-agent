"use client";

import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Mail,
  Send,
  ShieldCheck,
} from "lucide-react";
import type { EmailView, ProposalView } from "../orchestrator/types";
import { formatDateTimeShort } from "./ui-helpers";

interface EmailsPanelProps {
  emails: readonly EmailView[];
  proposal: ProposalView | null;
  rfpStatus: string;
  busy: boolean;
  onSimulateCustomerReply: (opts: {
    proposalId: number;
    scenario?: "accept_all" | "accept_some" | "reject" | "question" | "unclear";
    customBody?: string;
    acceptedLaneCodes?: string[];
  }) => Promise<void>;
}

function EmailCard({ email }: { email: EmailView }) {
  const [viewMode, setViewMode] = useState<"formatted" | "plain">("formatted");
  const isOutbound = email.direction === "outbound";
  const hasPlain = Boolean(
    email.plainTextBody && email.plainTextBody !== email.body,
  );

  return (
    <div className="rounded-md border border-border/70 bg-white p-3.5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/50 pb-2.5">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] font-medium ${
                isOutbound
                  ? "border-border/70 bg-zinc-100 text-zinc-700"
                  : "border-emerald-200/80 bg-emerald-50/70 text-emerald-700"
              }`}
            >
              {isOutbound ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownLeft className="h-3 w-3" />
              )}
              {isOutbound ? "OUTBOUND" : "INBOUND"}
            </span>
            <span className="rounded-sm bg-zinc-100 px-1.5 py-px font-mono text-[10px] font-medium text-zinc-600">
              {email.threadType}
            </span>
            <span className="rounded-sm bg-zinc-100 px-1.5 py-px text-[10px] font-medium text-zinc-700">
              {email.status}
            </span>
            {email.approvedBy && (
              <span className="inline-flex items-center gap-1 rounded-sm bg-emerald-50 px-1.5 py-px text-[10px] font-medium text-emerald-700">
                <ShieldCheck className="h-3 w-3" />
                Approved by {email.approvedBy}
              </span>
            )}
          </div>
          <h4 className="mt-1.5 text-[13px] font-medium text-zinc-900">
            {email.subject}
          </h4>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            From <span className="font-mono">{email.sender}</span> to{" "}
            <span className="font-mono">{email.recipient}</span> ·{" "}
            {formatDateTimeShort(email.sentAt ?? email.createdAt)}
          </p>
        </div>

        {hasPlain && (
          <div className="inline-flex rounded-sm border border-border/70 bg-zinc-50 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setViewMode("formatted")}
              className={`rounded-sm px-2 py-0.5 font-medium ${
                viewMode === "formatted"
                  ? "bg-white text-zinc-900 shadow-xs"
                  : "text-zinc-500"
              }`}
            >
              Markdown
            </button>
            <button
              type="button"
              onClick={() => setViewMode("plain")}
              className={`rounded-sm px-2 py-0.5 font-medium ${
                viewMode === "plain"
                  ? "bg-white text-zinc-900 shadow-xs"
                  : "text-zinc-500"
              }`}
            >
              Plain text
            </button>
          </div>
        )}
      </div>

      <pre className="mt-2.5 max-h-96 overflow-x-auto overflow-y-auto rounded-sm border border-border/50 bg-zinc-50/70 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-800">
        {viewMode === "plain" && email.plainTextBody
          ? email.plainTextBody
          : email.body}
      </pre>
    </div>
  );
}

export function EmailsPanel({
  emails,
  proposal,
  rfpStatus,
  busy,
  onSimulateCustomerReply,
}: EmailsPanelProps) {
  const [customReplyText, setCustomReplyText] = useState("");
  const [selectedPartialLanes, setSelectedPartialLanes] = useState<string[]>([]);

  const pricingEmails = emails.filter((e) => e.counterparty === "pricing");
  const customerEmails = emails.filter((e) => e.counterparty === "customer");
  const quotedLaneCodes = (proposal?.lanes ?? [])
    .filter((l) => l.disposition !== "DECLINE")
    .map((l) => l.laneCode);

  const togglePartialLane = (code: string) => {
    setSelectedPartialLanes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const canSimulateCustomerReply =
    proposal !== null &&
    (rfpStatus === "SENT" ||
      rfpStatus === "NEEDS_FOLLOW_UP" ||
      proposal.status === "SENT");

  return (
    <div className="space-y-5" data-testid="emails-panel">
      {canSimulateCustomerReply && proposal && (
        <div className="rounded-md border border-border/70 bg-white p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="inline-flex items-center gap-1.5 text-[13px] font-medium text-zinc-900">
                <Send className="h-3.5 w-3.5 text-zinc-700" />
                Customer Reply Simulator (DealAgent)
              </h3>
              <p className="mt-0.5 text-xs text-zinc-500">
                Trigger a canned reply scenario or paste raw reply text to run intent classification and booking.
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onSimulateCustomerReply({
                  proposalId: proposal.id,
                  scenario: "accept_all",
                })
              }
              data-testid="sim-customer-accept-all"
              className="rounded-sm bg-emerald-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              Simulate: Accept All
            </button>
            <button
              type="button"
              disabled={busy || quotedLaneCodes.length === 0}
              onClick={() =>
                onSimulateCustomerReply({
                  proposalId: proposal.id,
                  scenario: "accept_some",
                  acceptedLaneCodes:
                    selectedPartialLanes.length > 0
                      ? selectedPartialLanes
                      : quotedLaneCodes.slice(
                          0,
                          Math.max(1, Math.floor(quotedLaneCodes.length / 2)),
                        ),
                })
              }
              data-testid="sim-customer-accept-some"
              className="rounded-sm border border-border/70 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
            >
              Simulate: Accept Selected Lanes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onSimulateCustomerReply({
                  proposalId: proposal.id,
                  scenario: "question",
                })
              }
              data-testid="sim-customer-question"
              className="rounded-sm border border-amber-300/80 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50"
            >
              Simulate: Ask Question
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onSimulateCustomerReply({
                  proposalId: proposal.id,
                  scenario: "unclear",
                })
              }
              data-testid="sim-customer-unclear"
              className="rounded-sm border border-amber-300/80 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50"
            >
              Simulate: Unclear Reply
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onSimulateCustomerReply({
                  proposalId: proposal.id,
                  scenario: "reject",
                })
              }
              data-testid="sim-customer-reject"
              className="rounded-sm border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              Simulate: Reject
            </button>
          </div>

          {quotedLaneCodes.length > 1 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
              <span className="font-medium">Partial accept subset:</span>
              {quotedLaneCodes.map((code) => (
                <label
                  key={code}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-sm border border-border/70 bg-zinc-50/70 px-2 py-0.5 font-mono text-zinc-800"
                >
                  <input
                    type="checkbox"
                    checked={selectedPartialLanes.includes(code)}
                    onChange={() => togglePartialLane(code)}
                    className="accent-zinc-900"
                  />
                  {code}
                </label>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <textarea
              rows={2}
              placeholder="Paste custom customer reply text (English or French)..."
              value={customReplyText}
              onChange={(e) => setCustomReplyText(e.target.value)}
              className="flex-1 rounded-sm border border-border/70 bg-zinc-50/60 px-2.5 py-1.5 text-xs focus:border-zinc-400 focus:bg-white focus:outline-hidden"
            />
            <button
              type="button"
              disabled={busy || !customReplyText.trim()}
              onClick={() =>
                onSimulateCustomerReply({
                  proposalId: proposal.id,
                  customBody: customReplyText.trim(),
                })
              }
              className="shrink-0 rounded-sm bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-45"
            >
              Process Reply
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section className="space-y-2.5">
          <h3 className="inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
            <FileText className="h-3.5 w-3.5 text-zinc-400" />
            Customer quote thread ({customerEmails.length})
          </h3>
          {customerEmails.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 bg-white p-5 text-center text-xs text-zinc-500">
              No customer quote emails yet. Validate pricing and draft the proposal first.
            </div>
          ) : (
            customerEmails.map((em) => <EmailCard key={em.id} email={em} />)
          )}
        </section>

        <section className="space-y-2.5">
          <h3 className="inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
            <Mail className="h-3.5 w-3.5 text-zinc-400" />
            Pricing desk thread ({pricingEmails.length})
          </h3>
          {pricingEmails.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 bg-white p-5 text-center text-xs text-zinc-500">
              No pricing thread yet. Resolve route reviews, then click Request Pricing.
            </div>
          ) : (
            pricingEmails.map((em) => <EmailCard key={em.id} email={em} />)
          )}
        </section>
      </div>
    </div>
  );
}
