"use client";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ShieldCheck } from "lucide-react";
import type { EmailView, ProposalView } from "../orchestrator/types";
import { INPUT, PANEL, buttonClass } from "./ui";
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
    <div className={PANEL}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs font-medium tracking-[0.06em] text-zinc-500 uppercase">
            <span className="inline-flex items-center gap-1 text-zinc-700">
              {isOutbound ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownLeft className="h-3 w-3" />
              )}
              {isOutbound ? "OUTBOUND" : "INBOUND"}
            </span>
            <span className="font-mono tracking-normal">
              {email.threadType}
            </span>
            <span>{email.status}</span>
            {email.approvedBy && (
              <span className="inline-flex items-center gap-1 tracking-normal text-zinc-600 normal-case">
                <ShieldCheck className="h-3 w-3 text-emerald-700" />
                Approved by {email.approvedBy}
              </span>
            )}
          </div>
          <h4 className="mt-1.5 text-sm font-medium text-zinc-900">
            {email.subject}
          </h4>
          <p className="mt-0.5 text-xs text-zinc-500">
            From <span className="font-mono">{email.sender}</span> to{" "}
            <span className="font-mono">{email.recipient}</span> ·{" "}
            {formatDateTimeShort(email.sentAt ?? email.createdAt)}
          </p>
        </div>

        {hasPlain && (
          <div className="inline-flex shrink-0 rounded-sm border border-zinc-200 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewMode("formatted")}
              className={`rounded-xs px-2 py-0.5 font-medium transition-colors ${
                viewMode === "formatted"
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              Markdown
            </button>
            <button
              type="button"
              onClick={() => setViewMode("plain")}
              className={`rounded-xs px-2 py-0.5 font-medium transition-colors ${
                viewMode === "plain"
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              Plain text
            </button>
          </div>
        )}
      </div>

      <pre className="scroll-thin max-h-96 overflow-auto bg-zinc-50/60 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-zinc-800">
        {viewMode === "plain" && email.plainTextBody
          ? email.plainTextBody
          : email.body}
      </pre>
    </div>
  );
}

function ThreadEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-300 px-4 py-8 text-center text-xs text-zinc-500">
      {children}
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
      {canSimulateCustomerReply && proposal && (
        <div className={PANEL}>
          <div className="border-b border-zinc-200 px-4 py-3">
            <h3 className="text-sm font-medium text-zinc-900">
              Customer Reply Simulator (DealAgent)
            </h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              Trigger a canned reply scenario or paste raw reply text to run intent classification and booking.
            </p>
          </div>

          <div className="space-y-4 p-4">
            <div className="flex flex-wrap gap-2">
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
                className={buttonClass("primary", "md")}
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
                className={buttonClass("secondary", "md")}
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
                className={buttonClass("secondary", "md")}
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
                className={buttonClass("secondary", "md")}
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
                className={buttonClass("danger", "md")}
              >
                Simulate: Reject
              </button>
            </div>

            {quotedLaneCodes.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span className="eyebrow mr-1">Partial accept subset</span>
                {quotedLaneCodes.map((code) => {
                  const checked = selectedPartialLanes.includes(code);
                  return (
                    <label
                      key={code}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono transition-colors ${
                        checked
                          ? "border-zinc-900 text-zinc-900"
                          : "border-zinc-200 text-zinc-700 hover:border-zinc-300"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePartialLane(code)}
                        className="accent-zinc-900"
                      />
                      {code}
                    </label>
                  );
                })}
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-zinc-100 pt-4 sm:flex-row">
              <textarea
                rows={2}
                placeholder="Paste custom customer reply text (English or French)..."
                value={customReplyText}
                onChange={(e) => setCustomReplyText(e.target.value)}
                className={`${INPUT} flex-1 resize-none py-1.5 text-xs`}
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
                className={buttonClass("primary", "md", "sm:self-start")}
              >
                Process Reply
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="space-y-3">
          <h3 className="eyebrow">
            Customer quote thread ({customerEmails.length})
          </h3>
          {customerEmails.length === 0 ? (
            <ThreadEmpty>
              No customer quote emails yet. Validate pricing and draft the proposal first.
            </ThreadEmpty>
          ) : (
            customerEmails.map((em) => <EmailCard key={em.id} email={em} />)
          )}
        </section>

        <section className="space-y-3">
          <h3 className="eyebrow">
            Pricing desk thread ({pricingEmails.length})
          </h3>
          {pricingEmails.length === 0 ? (
            <ThreadEmpty>
              No pricing thread yet. Resolve route reviews, then click Request Pricing.
            </ThreadEmpty>
          ) : (
            pricingEmails.map((em) => <EmailCard key={em.id} email={em} />)
          )}
        </section>
      </div>
    </div>
  );
}
