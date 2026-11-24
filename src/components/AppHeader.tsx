"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Plane } from "lucide-react";
import { StatusDot, StatusMark } from "./ui";
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
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white">
      <div className="flex h-12 items-center justify-between gap-4 px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-sm text-zinc-900"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-zinc-900 text-white">
              <Plane className="h-3 w-3" />
            </span>
            <span className="text-sm font-semibold tracking-tight">
              AeroBid
            </span>
          </Link>

          {currentRfp && (
            <>
              <span className="text-zinc-300" aria-hidden="true">
                /
              </span>
              <Link
                href="/"
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-900"
              >
                Inbox
              </Link>
              <span className="text-zinc-300" aria-hidden="true">
                /
              </span>
              <div className="flex min-w-0 items-center gap-3">
                <span className="truncate text-sm font-medium text-zinc-900">
                  {currentRfp.title}
                </span>
                {statusMeta && (
                  <StatusMark
                    tone={statusMeta.tone}
                    label={statusMeta.label}
                    className="shrink-0"
                  />
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleToggleLlmMode}
            className="inline-flex h-7 items-center gap-2 rounded-sm border border-zinc-200 bg-white px-2.5 text-xs text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
            title={
              isOfflineActive
                ? "Running on the rule engine. Click to use the configured LLM provider."
                : "Running on the configured LLM provider. Click to switch to the rule engine."
            }
            data-testid="llm-mode-badge"
          >
            <StatusDot tone={isOfflineActive ? "muted" : "ok"} />
            <span>{activeModelLabel}</span>
          </button>

          <button
            type="button"
            onClick={onHumanTasksClick}
            data-testid="header-human-tasks-badge"
            className="inline-flex h-7 items-center gap-2 rounded-sm border border-zinc-200 bg-white px-2.5 text-xs text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
          >
            <StatusDot tone={openTasksCount > 0 ? "warn" : "muted"} />
            <span>Needs review</span>
            <span
              className={`min-w-4 border-l border-zinc-200 pl-2 text-right font-medium tabular-nums ${
                openTasksCount > 0 ? "text-zinc-900" : "text-zinc-400"
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
              aria-pressed={orchestrationOpen}
              className={`inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-xs transition-colors ${
                orchestrationOpen
                  ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
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
