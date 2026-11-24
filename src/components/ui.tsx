import { ArrowRight, Check, X } from "lucide-react";
import type { Tone } from "./ui-helpers";

/* ------------------------------------------------------------------ */
/* Surface + control class tokens                                      */
/* ------------------------------------------------------------------ */

/** Flat bordered surface. No shadow. */
export const PANEL = "rounded-md border border-zinc-200 bg-white";

/** Panel header strip. */
export const PANEL_HEADER =
  "flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 h-11";

/** Text input / textarea / select. */
export const INPUT =
  "w-full rounded-sm border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 transition-colors hover:border-zinc-300 focus:border-zinc-900 focus:outline-hidden focus:ring-2 focus:ring-zinc-900/10";

/** Ledger column header cell. */
export const TH = "eyebrow whitespace-nowrap font-medium";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "approve";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40";

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
};

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-zinc-900 text-white hover:bg-zinc-700",
  secondary:
    "border border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50",
  ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
  danger:
    "border border-zinc-200 bg-white text-red-700 hover:border-red-200 hover:bg-red-50/60",
  approve: "bg-emerald-800 text-white hover:bg-emerald-900",
};

export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "sm",
  extra = "",
): string {
  return `${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${extra}`.trim();
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

const DOT_CLASS: Record<Tone, string> = {
  ok: "bg-emerald-600",
  warn: "bg-amber-500",
  bad: "bg-red-600",
  neutral: "bg-zinc-400",
  muted: "bg-transparent ring-1 ring-inset ring-zinc-400",
};

const TEXT_CLASS: Record<Tone, string> = {
  ok: "text-zinc-700",
  warn: "text-zinc-700",
  bad: "text-red-700",
  neutral: "text-zinc-700",
  muted: "text-zinc-500",
};

export function StatusDot({
  tone,
  className = "",
}: {
  tone: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[tone]} ${className}`}
    />
  );
}

/** Dot + neutral text. The only status treatment in the product. */
export function StatusMark({
  tone,
  label,
  className = "",
}: {
  tone: Tone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${TEXT_CLASS[tone]} ${className}`}
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Domain atoms                                                        */
/* ------------------------------------------------------------------ */

/** `MEX → LAX → CDG` in mono, with muted arrows and no chip chrome. */
export function RoutePath({
  airports,
  className = "text-xs",
}: {
  airports: readonly string[];
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-x-1 whitespace-nowrap font-mono font-medium text-zinc-900 ${className}`}
    >
      {airports.map((code, idx) => (
        <span key={`${code}-${idx}`} className="inline-flex items-center gap-1">
          {code}
          {idx < airports.length - 1 && (
            <ArrowRight className="h-3 w-3 text-zinc-300" aria-hidden="true" />
          )}
        </span>
      ))}
    </span>
  );
}

/** Service coverage marker: check (muted) or cross (red). Text stays neutral. */
export function ServiceMark({
  fulfilled,
  label,
  title,
  className = "",
}: {
  fulfilled: boolean;
  label: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 text-xs whitespace-nowrap ${
        fulfilled ? "text-zinc-600" : "font-medium text-red-700"
      } ${className}`}
    >
      {fulfilled ? (
        <Check className="h-3 w-3 text-zinc-400" aria-hidden="true" />
      ) : (
        <X className="h-3 w-3 text-red-600" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
