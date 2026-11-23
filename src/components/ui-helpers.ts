import type { LaneStatus, ServiceType } from "../domain/types";

export const SERVICE_SHORT_LABELS: Record<ServiceType, string> = {
  TEMP_CONTROLLED: "Temp 2–8°C",
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
    badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  COMPLIANT_BUT_LATE: {
    label: "Compliant (Late)",
    badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
  },
  ON_TIME_BUT_MISSING_SERVICES: {
    label: "On-Time (Missing Services)",
    badgeClass: "bg-orange-50 text-orange-800 border-orange-200",
  },
  NO_ROUTE_IN_TIME: {
    label: "No Route in Time",
    badgeClass: "bg-rose-50 text-rose-700 border-rose-200",
  },
  UNREACHABLE: {
    label: "Unreachable",
    badgeClass: "bg-slate-100 text-slate-700 border-slate-300",
  },
};

export const DISPOSITION_META: Record<
  string,
  { label: string; badgeClass: string }
> = {
  QUOTE_COMPLIANT: {
    label: "Quote Compliant",
    badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  QUOTE_COMPLIANT_LATE: {
    label: "Quote Compliant (Late)",
    badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
  },
  QUOTE_PARTIAL_ON_TIME: {
    label: "Quote On-Time (Partial)",
    badgeClass: "bg-sky-50 text-sky-800 border-sky-200",
  },
  DECLINE: {
    label: "Declined",
    badgeClass: "bg-slate-100 text-slate-600 border-slate-300",
  },
  PENDING_REVIEW: {
    label: "Pending Decision",
    badgeClass: "bg-amber-100 text-amber-900 border-amber-300",
  },
  ACCEPTED: {
    label: "Accepted",
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-300",
  },
  CUSTOMER_DECLINED: {
    label: "Customer Declined",
    badgeClass: "bg-rose-50 text-rose-700 border-rose-200",
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
        badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200",
        isWaiting: false,
      };
    case "ROUTING":
      return {
        label: "Routing Complete",
        badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
        isWaiting: false,
      };
    case "AWAITING_REQUIREMENT_CONFIRMATION":
      return {
        label: "Awaiting Requirement / Route Review",
        badgeClass: "bg-amber-50 text-amber-800 border-amber-300",
        isWaiting: true,
      };
    case "PRICING_REQUESTED":
      return {
        label: "Pricing Requested",
        badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200",
        isWaiting: false,
      };
    case "PRICING_RECEIVED":
      return {
        label: "Pricing Validated",
        badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
        isWaiting: false,
      };
    case "AWAITING_PRICING_FIXES":
      return {
        label: "Awaiting Pricing Fixes",
        badgeClass: "bg-amber-50 text-amber-800 border-amber-300",
        isWaiting: true,
      };
    case "QUOTE_DRAFTED":
      return {
        label: "Quote Drafted",
        badgeClass: "bg-sky-50 text-sky-800 border-sky-200",
        isWaiting: false,
      };
    case "AWAITING_APPROVAL":
      return {
        label: "Awaiting Approval",
        badgeClass: "bg-amber-50 text-amber-800 border-amber-300",
        isWaiting: true,
      };
    case "SENT":
      return {
        label: "Quote Sent",
        badgeClass: "bg-sky-50 text-sky-800 border-sky-200",
        isWaiting: false,
      };
    case "CUSTOMER_REPLIED":
      return {
        label: "Customer Replied",
        badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200",
        isWaiting: false,
      };
    case "WON":
      return {
        label: "Won & Booked",
        badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-300",
        isWaiting: false,
      };
    case "LOST":
      return {
        label: "Closed Lost",
        badgeClass: "bg-rose-50 text-rose-700 border-rose-200",
        isWaiting: false,
      };
    case "NEEDS_FOLLOW_UP":
      return {
        label: "Needs Follow-Up",
        badgeClass: "bg-amber-50 text-amber-800 border-amber-300",
        isWaiting: true,
      };
    default:
      return {
        label: status,
        badgeClass: "bg-slate-100 text-slate-700 border-slate-200",
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
