"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, AlertCircle, ArrowLeft, Cpu, Plane } from "lucide-react";
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
    <header className="sticky top-0 z-30 border-b border-border/60 bg-white">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-sm py-1 pr-1 text-zinc-900"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-zinc-900 text-white">
              <Plane className="h-3 w-3" />
            </span>
            <span className="text-[13px] font-medium tracking-tight text-zinc-900">
              AeroBid
            </span>
          </Link>

          {currentRfp && (
            <>
              <span className="text-zinc-300">/</span>
              <Link
                href="/"
                className="inline-flex items-center gap-1 text-[13px] text-zinc-500 hover:text-zinc-900"
              >
                <ArrowLeft className="h-3 w-3" />
                Inbox
              </Link>
              <span className="text-zinc-300">/</span>
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-medium text-zinc-900">
                  {currentRfp.title}
                </span>
                {statusMeta && (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-1.5 py-px text-[11px] font-medium ${statusMeta.badgeClass}`}
                  >
                    {statusMeta.isWaiting && (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    )}
                    {statusMeta.label}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggleLlmMode}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border/70 bg-white px-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
            title={
              isOfflineActive
                ? "Running on the rule engine. Click to use the configured LLM provider."
                : "Running on the configured LLM provider. Click to switch to the rule engine."
            }
            data-testid="llm-mode-badge"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${isOfflineActive ? "bg-zinc-400" : "bg-emerald-500"}`}
            />
            <Cpu className="h-3 w-3 text-zinc-400" />
            <span>{activeModelLabel}</span>
          </button>

          <button
            type="button"
            onClick={onHumanTasksClick}
            data-testid="header-human-tasks-badge"
            className={`inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium transition-colors ${
              openTasksCount > 0
                ? "border-amber-300/80 bg-amber-50 text-amber-900 hover:bg-amber-100/70"
                : "border-border/70 bg-white text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            <AlertCircle
              className={`h-3 w-3 ${openTasksCount > 0 ? "text-amber-600" : "text-zinc-400"}`}
            />
            <span>Needs review</span>
            <span
              className={`inline-flex min-w-4 items-center justify-center rounded-sm px-1 text-[11px] font-medium tabular-nums ${
                openTasksCount > 0
                  ? "bg-amber-600 text-white"
                  : "bg-zinc-100 text-zinc-600"
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
              className={`inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors ${
                orchestrationOpen
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-border/70 bg-white text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
              }`}
            >
              <Activity className="h-3 w-3" />
              <span>Activity log</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
