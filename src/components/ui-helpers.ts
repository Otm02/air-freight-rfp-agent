import type { LaneStatus, ServiceType } from "../domain/types";

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
  { label: string; badgeClass: string }
> = {
  FULLY_SERVABLE: {
    label: "Fully Servable",
    badgeClass: "bg-emerald-50/80 text-emerald-700 border-emerald-200/80",
  },
  COMPLIANT_BUT_LATE: {
    label: "Compliant (Late)",
    badgeClass: "bg-amber-50/80 text-amber-800 border-amber-200/80",
  },
  ON_TIME_BUT_MISSING_SERVICES: {
    label: "On-Time (Partial)",
    badgeClass: "bg-amber-50/60 text-amber-800 border-amber-200/70",
  },
  NO_ROUTE_IN_TIME: {
    label: "No Route in Time",
    badgeClass: "bg-rose-50/80 text-rose-700 border-rose-200/80",
  },
  UNREACHABLE: {
    label: "Unreachable",
    badgeClass: "bg-zinc-100 text-zinc-600 border-border/70",
  },
};

export const DISPOSITION_META: Record<
  string,
  { label: string; badgeClass: string }
> = {
  QUOTE_COMPLIANT: {
    label: "Quote Compliant",
    badgeClass: "bg-emerald-50/80 text-emerald-700 border-emerald-200/80",
  },
  QUOTE_COMPLIANT_LATE: {
    label: "Quote Compliant (Late)",
    badgeClass: "bg-amber-50/80 text-amber-800 border-amber-200/80",
  },
  QUOTE_PARTIAL_ON_TIME: {
    label: "Quote On-Time (Partial)",
    badgeClass: "bg-zinc-100 text-zinc-800 border-border/70",
  },
  DECLINE: {
    label: "Declined",
    badgeClass: "bg-zinc-100 text-zinc-500 border-border/70",
  },
  PENDING_REVIEW: {
    label: "Pending Review",
    badgeClass: "bg-amber-50 text-amber-800 border-amber-300/80",
  },
  ACCEPTED: {
    label: "Accepted",
    badgeClass: "bg-emerald-50 text-emerald-800 border-emerald-300/80",
  },
  CUSTOMER_DECLINED: {
    label: "Customer Declined",
    badgeClass: "bg-rose-50/80 text-rose-700 border-rose-200/80",
  },
};

export function getRfpStatusBadge(status: string): {
  label: string;
  badgeClass: string;
  isWaiting: boolean;
} {
  switch (status) {
    case "INTAKE":
      return {
        label: "Intake",
        badgeClass: "bg-zinc-100 text-zinc-700 border-border/70",
        isWaiting: false,
      };
    case "ROUTING":
      return {
        label: "Routing Ready",
        badgeClass: "bg-emerald-50/80 text-emerald-700 border-emerald-200/80",
        isWaiting: false,
      };
    case "AWAITING_REQUIREMENT_CONFIRMATION":
      return {
        label: "Needs Route Review",
        badgeClass: "bg-amber-50/90 text-amber-800 border-amber-300/80",
        isWaiting: true,
      };
    case "PRICING_REQUESTED":
      return {
        label: "Pricing Requested",
        badgeClass: "bg-zinc-100 text-zinc-700 border-border/70",
        isWaiting: false,
      };
    case "PRICING_RECEIVED":
      return {
        label: "Pricing Validated",
        badgeClass: "bg-emerald-50/80 text-emerald-700 border-emerald-200/80",
        isWaiting: false,
      };
    case "AWAITING_PRICING_FIXES":
      return {
        label: "Pricing Fixes Open",
        badgeClass: "bg-amber-50/90 text-amber-800 border-amber-300/80",
        isWaiting: true,
      };
    case "QUOTE_DRAFTED":
      return {
        label: "Quote Drafted",
        badgeClass: "bg-zinc-100 text-zinc-800 border-border/70",
        isWaiting: false,
      };
    case "AWAITING_APPROVAL":
      return {
        label: "Pending Approval",
        badgeClass: "bg-amber-50/90 text-amber-800 border-amber-300/80",
        isWaiting: true,
      };
    case "SENT":
      return {
        label: "Quote Sent",
        badgeClass: "bg-zinc-100 text-zinc-800 border-border/70",
        isWaiting: false,
      };
    case "CUSTOMER_REPLIED":
      return {
        label: "Customer Replied",
        badgeClass: "bg-zinc-100 text-zinc-700 border-border/70",
        isWaiting: false,
      };
    case "WON":
      return {
        label: "Won",
        badgeClass: "bg-emerald-50 text-emerald-800 border-emerald-300/80",
        isWaiting: false,
      };
    case "LOST":
      return {
        label: "Closed Lost",
        badgeClass: "bg-rose-50/80 text-rose-700 border-rose-200/80",
        isWaiting: false,
      };
    case "NEEDS_FOLLOW_UP":
      return {
        label: "Needs Follow-Up",
        badgeClass: "bg-amber-50/90 text-amber-800 border-amber-300/80",
        isWaiting: true,
      };
    default:
      return {
        label: status,
        badgeClass: "bg-zinc-100 text-zinc-700 border-border/70",
        isWaiting: false,
      };
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
