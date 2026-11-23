"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Cpu,
  Plane,
} from "lucide-react";
import { getRfpStatusBadge } from "./ui-helpers";

interface AppHeaderProps {
  activeModelLabel: string;
  openTasksCount: number;
  currentRfp?: {
    id: number;
    title: string;
    status: string;
  };
  onHumanTasksClick?: () => void;
  showOrchestrationToggle?: boolean;
  orchestrationOpen?: boolean;
  onToggleOrchestration?: () => void;
}

export function AppHeader({
  activeModelLabel,
  openTasksCount,
  currentRfp,
  onHumanTasksClick,
  showOrchestrationToggle = false,
  orchestrationOpen = true,
  onToggleOrchestration,
}: AppHeaderProps) {
  const router = useRouter();
  const statusMeta = currentRfp ? getRfpStatusBadge(currentRfp.status) : null;
  const isOfflineActive = activeModelLabel.toLowerCase().includes("offline");

  const handleToggleLlmMode = () => {
    const nextMode = isOfflineActive ? "auto" : "offline";
    document.cookie = `rfp_llm_mode=${nextMode}; path=/; max-age=86400; SameSite=Lax`;
    router.refresh();
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-slate-900 transition hover:bg-slate-100"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E3A5F] text-white">
              <Plane className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-900">
              AeroBid Air Freight
            </span>
          </Link>

          {currentRfp && (
            <>
              <span className="text-slate-300">/</span>
              <Link
                href="/"
                className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Inbox
              </Link>
              <span className="text-slate-300">/</span>
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-800">
                  {currentRfp.title}
                </span>
                {statusMeta && (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusMeta.badgeClass}`}
                  >
                    {statusMeta.isWaiting && (
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-600" />
                    )}
                    {statusMeta.label}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleToggleLlmMode}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
              isOfflineActive
                ? "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                : "border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
            }`}
            title="Click to toggle Offline Mode vs Env Auto LLM"
            data-testid="llm-mode-badge"
          >
            <Cpu className="h-3.5 w-3.5" />
            <span>{activeModelLabel}</span>
          </button>

          <button
            type="button"
            onClick={onHumanTasksClick}
            data-testid="header-human-tasks-badge"
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition ${
              openTasksCount > 0
                ? "border-amber-300 bg-amber-50 text-amber-900 shadow-xs hover:bg-amber-100"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            <AlertCircle
              className={`h-3.5 w-3.5 ${openTasksCount > 0 ? "text-amber-600" : "text-slate-400"}`}
            />
            <span>Human Tasks</span>
            <span
              className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
                openTasksCount > 0
                  ? "bg-amber-600 text-white"
                  : "bg-slate-200 text-slate-700"
              }`}
            >
              {openTasksCount}
            </span>
          </button>

          {showOrchestrationToggle && onToggleOrchestration && (
            <button
              type="button"
              onClick={onToggleOrchestration}
              data-testid="toggle-orchestration-panel"
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                orchestrationOpen
                  ? "border-[#1E3A5F] bg-[#1E3A5F] text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>Agent Stream</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
