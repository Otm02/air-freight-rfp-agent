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
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                isOutbound
                  ? "bg-sky-50 text-sky-800 ring-1 ring-sky-200"
                  : "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"
              }`}
            >
              {isOutbound ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownLeft className="h-3 w-3" />
              )}
              {isOutbound ? "OUTBOUND" : "INBOUND"}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600">
              {email.threadType}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
              {email.status}
            </span>
            {email.approvedBy && (
              <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                <ShieldCheck className="h-3 w-3" />
                Approved by {email.approvedBy}
              </span>
            )}
          </div>
          <h4 className="mt-1.5 text-sm font-semibold text-slate-900">
            {email.subject}
          </h4>
          <p className="mt-0.5 text-[11px] text-slate-500">
            From: <span className="font-mono">{email.sender}</span> → To:{" "}
            <span className="font-mono">{email.recipient}</span> ·{" "}
            {formatDateTimeShort(email.sentAt ?? email.createdAt)}
          </p>
        </div>

        {hasPlain && (
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setViewMode("formatted")}
              className={`rounded-md px-2 py-1 font-medium ${
                viewMode === "formatted"
                  ? "bg-white text-slate-900 shadow-2xs"
                  : "text-slate-500"
              }`}
            >
              Markdown
            </button>
            <button
              type="button"
              onClick={() => setViewMode("plain")}
              className={`rounded-md px-2 py-1 font-medium ${
                viewMode === "plain"
                  ? "bg-white text-slate-900 shadow-2xs"
                  : "text-slate-500"
              }`}
            >
              Plain Text
            </button>
          </div>
        )}
      </div>

      <pre className="mt-3 max-h-96 overflow-x-auto overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-slate-800">
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
    <div className="space-y-6" data-testid="emails-panel">
      {/* Customer Reply Simulator when Quote is Sent */}
      {canSimulateCustomerReply && proposal && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Send className="h-4 w-4 text-[#1E3A5F]" />
                Simulate Customer Reply (Deal Agent)
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                Test full acceptance (books SQL deal + next-business-day 10:00 ET .ics kickoff), partial award, question escalation, rejection, or paste custom reply text.
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
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
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
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
              className="rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-50 disabled:opacity-50"
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
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50 disabled:opacity-50"
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
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50 disabled:opacity-50"
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
              className="rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 hover:bg-rose-50 disabled:opacity-50"
            >
              Simulate: Reject
            </button>
          </div>

          {quotedLaneCodes.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
              <span className="font-medium">Optional subset for Partial Accept:</span>
              {quotedLaneCodes.map((code) => (
                <label
                  key={code}
                  className="inline-flex cursor-pointer items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 font-mono"
                >
                  <input
                    type="checkbox"
                    checked={selectedPartialLanes.includes(code)}
                    onChange={() => togglePartialLane(code)}
                    className="accent-[#1E3A5F]"
                  />
                  {code}
                </label>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <textarea
              rows={2}
              placeholder="Or paste custom customer reply text to test Deal Agent parsing..."
              value={customReplyText}
              onChange={(e) => setCustomReplyText(e.target.value)}
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs focus:border-[#1E3A5F] focus:outline-hidden"
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
              className="shrink-0 rounded-lg bg-[#1E3A5F] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-45"
            >
              Send Custom Reply
            </button>
          </div>
        </div>
      )}

      {/* Split Thread Columns */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="space-y-3">
          <h3 className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-700 uppercase">
            <FileText className="h-4 w-4 text-slate-500" />
            Customer Quote Thread ({customerEmails.length})
          </h3>
          {customerEmails.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-xs text-slate-500">
              No customer quote emails drafted yet. Resolve pricing and draft the proposal first.
            </div>
          ) : (
            customerEmails.map((em) => <EmailCard key={em.id} email={em} />)
          )}
        </section>

        <section className="space-y-3">
          <h3 className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-700 uppercase">
            <Mail className="h-4 w-4 text-slate-500" />
            Pricing Desk Thread ({pricingEmails.length})
          </h3>
          {pricingEmails.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-xs text-slate-500">
              No Pricing Team correspondence yet. Complete route triage and request pricing.
            </div>
          ) : (
            pricingEmails.map((em) => <EmailCard key={em.id} email={em} />)
          )}
        </section>
      </div>
    </div>
  );
}
