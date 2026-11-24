import type { LaneStatus, ServiceType } from "../domain/types";

/**
 * Semantic tone for a status. Rendered as a 6px dot beside neutral text
 * (see `StatusMark` in ./ui) - never as a coloured badge background.
 *
 *   ok      booked / approved / fully servable
 *   warn    conditional, or waiting on a human
 *   bad     blocked / exception
 *   neutral in progress
 *   muted   inactive / declined / unreachable
 */
export type Tone = "ok" | "warn" | "bad" | "neutral" | "muted";

export const SERVICE_SHORT_LABELS: Record<ServiceType, string> = {
  TEMP_CONTROLLED: "Temp 2-8C",
  DANGEROUS_GOODS: "DG",
  HIGH_VALUE_SECURITY: "High-Value",
  FRAGILE: "Fragile",
  OVERSIZED: "Oversized",
};

export const SERVICE_FULL_LABELS: Record<ServiceType, string> = {
  TEMP_CONTROLLED: "Temperature controlled (2-8 C)",
  DANGEROUS_GOODS: "Dangerous goods",
  HIGH_VALUE_SECURITY: "High-value security",
  FRAGILE: "Fragile handling",
  OVERSIZED: "Oversized cargo",
};

export const LANE_STATUS_META: Record<
  LaneStatus,
  { label: string; tone: Tone }
> = {
  FULLY_SERVABLE: { label: "Fully Servable", tone: "ok" },
  COMPLIANT_BUT_LATE: { label: "Compliant (Late)", tone: "warn" },
  ON_TIME_BUT_MISSING_SERVICES: { label: "On-Time (Partial)", tone: "warn" },
  NO_ROUTE_IN_TIME: { label: "No Route in Time", tone: "bad" },
  UNREACHABLE: { label: "Unreachable", tone: "muted" },
};

export const DISPOSITION_META: Record<string, { label: string; tone: Tone }> = {
  QUOTE_COMPLIANT: { label: "Quote Compliant", tone: "ok" },
  QUOTE_COMPLIANT_LATE: { label: "Quote Compliant (Late)", tone: "warn" },
  QUOTE_PARTIAL_ON_TIME: { label: "Quote On-Time (Partial)", tone: "neutral" },
  DECLINE: { label: "Declined", tone: "muted" },
  PENDING_REVIEW: { label: "Pending Review", tone: "warn" },
  ACCEPTED: { label: "Accepted", tone: "ok" },
  CUSTOMER_DECLINED: { label: "Customer Declined", tone: "bad" },
};

export function getRfpStatusBadge(status: string): {
  label: string;
  tone: Tone;
  isWaiting: boolean;
} {
  switch (status) {
    case "INTAKE":
      return { label: "Intake", tone: "neutral", isWaiting: false };
    case "ROUTING":
      return { label: "Routing Ready", tone: "ok", isWaiting: false };
    case "AWAITING_REQUIREMENT_CONFIRMATION":
      return { label: "Needs Route Review", tone: "warn", isWaiting: true };
    case "PRICING_REQUESTED":
      return { label: "Pricing Requested", tone: "neutral", isWaiting: false };
    case "PRICING_RECEIVED":
      return { label: "Pricing Validated", tone: "ok", isWaiting: false };
    case "AWAITING_PRICING_FIXES":
      return { label: "Pricing Fixes Open", tone: "warn", isWaiting: true };
    case "QUOTE_DRAFTED":
      return { label: "Quote Drafted", tone: "neutral", isWaiting: false };
    case "AWAITING_APPROVAL":
      return { label: "Pending Approval", tone: "warn", isWaiting: true };
    case "SENT":
      return { label: "Quote Sent", tone: "neutral", isWaiting: false };
    case "CUSTOMER_REPLIED":
      return { label: "Customer Replied", tone: "neutral", isWaiting: false };
    case "WON":
      return { label: "Won", tone: "ok", isWaiting: false };
    case "LOST":
      return { label: "Closed Lost", tone: "bad", isWaiting: false };
    case "NEEDS_FOLLOW_UP":
      return { label: "Needs Follow-Up", tone: "warn", isWaiting: true };
    default:
      return { label: status, tone: "neutral", isWaiting: false };
  }
}

export function formatUsd(amount: number, decimals: number = 0): string {
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatDateTimeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
