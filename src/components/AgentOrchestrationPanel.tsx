"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Cpu,
  PauseCircle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  PIPELINE_STAGES,
  isWaitingForHumanState,
} from "../orchestrator/states";
import type { AgentEventView } from "../orchestrator/types";
import { formatDateTimeShort } from "./ui-helpers";

interface AgentOrchestrationPanelProps {
  rfpId: number;
  currentStatus: string;
  events: readonly AgentEventView[];
  onStreamEvent: (ev: AgentEventView) => void;
}

function getModeStyle(ev: AgentEventView): {
  label: string;
  pillClass: string;
  barClass: string;
} {
  if (
    ev.executionMode === "HUMAN_GATE" ||
    ev.status === "WAITING_FOR_HUMAN" ||
    ev.eventType === "WAITING_FOR_HUMAN"
  ) {
    return {
      label: ev.status === "WAITING_FOR_HUMAN" ? "Waiting for Human" : "Human Gate",
      pillClass: "bg-amber-50/90 text-amber-900 border-amber-300/80",
      barClass: "border-l-amber-500",
    };
  }
  if (ev.executionMode === "LLM") {
    return {
      label: "LLM",
      pillClass: "bg-zinc-100 text-zinc-800 border-border/70",
      barClass: "border-l-zinc-600",
    };
  }
  if (ev.executionMode === "DETERMINISTIC") {
    return {
      label: "Deterministic",
      pillClass: "bg-emerald-50/80 text-emerald-800 border-emerald-200/80",
      barClass: "border-l-emerald-500",
    };
  }
  return {
    label: "State",
    pillClass: "bg-zinc-100 text-zinc-700 border-border/70",
    barClass: "border-l-zinc-400",
  };
}

export function AgentOrchestrationPanel({
  rfpId,
  currentStatus,
  events,
  onStreamEvent,
}: AgentOrchestrationPanelProps) {
  const [sseConnected, setSseConnected] = useState(false);
  const [modeFilter, setModeFilter] = useState<
    "ALL" | "DETERMINISTIC" | "LLM" | "HUMAN_GATE"
  >("ALL");
  const [expandedIds, setExpandedIds] = useState<Record<number, boolean>>({});
  const [newestFirst, setNewestFirst] = useState(true);

  useEffect(() => {
    const initialMaxId = events.reduce((m, e) => Math.max(m, e.id), 0);
    const source = new EventSource(
      `/api/rfps/${rfpId}/events?afterId=${initialMaxId}`,
    );

    const handleAgentEvent = (msg: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(msg.data) as AgentEventView;
        onStreamEvent(parsed);
      } catch {
        // Ignore malformed SSE frame
      }
    };

    source.onopen = () => setSseConnected(true);
    source.onerror = () => setSseConnected(false);
    source.addEventListener("agent_event", handleAgentEvent as EventListener);

    return () => {
      source.removeEventListener(
        "agent_event",
        handleAgentEvent as EventListener,
      );
      source.close();
      setSseConnected(false);
    };
    // Re-subscribe cleanly when RFP changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfpId]);

  const currentIdx = PIPELINE_STAGES.findIndex(
    (s) => s.state === currentStatus,
  );
  const waitingHuman = isWaitingForHumanState(currentStatus);

  const visibleEvents = events.filter((ev) => {
    if (modeFilter === "ALL") return true;
    return ev.executionMode === modeFilter;
  });

  const orderedEvents = newestFirst
    ? [...visibleEvents].reverse()
    : [...visibleEvents];

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const graphStages = PIPELINE_STAGES.filter((s) => {
    if (s.state === "LOST" && currentStatus !== "LOST") return false;
    if (s.state === "NEEDS_FOLLOW_UP" && currentStatus !== "NEEDS_FOLLOW_UP")
      return false;
    if (
      s.state === "WON" &&
      (currentStatus === "LOST" || currentStatus === "NEEDS_FOLLOW_UP")
    ) {
      return false;
    }
    return true;
  });

  return (
    <aside
      data-testid="agent-orchestration-panel"
      className="flex flex-col rounded-md border border-border/70 bg-white shadow-xs lg:sticky lg:top-16 lg:max-h-[calc(100vh-5rem)]"
    >
      <div className="flex items-center justify-between border-b border-border/60 px-3.5 py-2.5">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-zinc-700" />
          <h2 className="text-[13px] font-medium text-zinc-900">
            Activity Log
          </h2>
        </div>

        <span
          data-testid="sse-connection-pill"
          className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-px text-[11px] font-medium ${
            sseConnected
              ? "border-emerald-200/80 bg-emerald-50/80 text-emerald-700"
              : "border-border/70 bg-zinc-50 text-zinc-500"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              sseConnected ? "bg-emerald-600" : "bg-zinc-400"
            }`}
          />
          {sseConnected ? "Live SSE" : "Connecting"}
        </span>
      </div>

      <div
        className="border-b border-border/60 bg-zinc-50/60 px-3.5 py-2.5"
        data-testid="pipeline-state-graph"
      >
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
          <span>Pipeline</span>
          {waitingHuman && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-amber-100/80 px-1.5 py-px text-[10px] font-medium text-amber-900">
              <PauseCircle className="h-3 w-3" />
              WAITING FOR HUMAN
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {graphStages.map((stage, idx) => {
            const stageMasterIdx = PIPELINE_STAGES.findIndex(
              (s) => s.state === stage.state,
            );
            const isCurrent = stage.state === currentStatus;
            const isDone =
              !isCurrent && currentIdx >= 0 && stageMasterIdx < currentIdx;

            return (
              <div
                key={stage.state}
                title={`${stage.state}: ${stage.description}`}
                className="flex items-center gap-1"
              >
                <span
                  data-testid={`pipeline-node-${stage.state}`}
                  data-active={isCurrent ? "true" : "false"}
                  className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[10px] font-medium transition-colors ${
                    isCurrent && stage.isHumanGate
                      ? "border-amber-400 bg-amber-50 text-amber-950 ring-1 ring-amber-400/50"
                      : isCurrent && stage.state === "WON"
                        ? "border-emerald-400 bg-emerald-50 text-emerald-900 ring-1 ring-emerald-400/50"
                        : isCurrent && stage.state === "LOST"
                          ? "border-rose-400 bg-rose-50 text-rose-900 ring-1 ring-rose-400/50"
                          : isCurrent
                            ? "border-zinc-900 bg-zinc-900 text-white ring-1 ring-zinc-900/20"
                            : isDone
                              ? "border-emerald-200/80 bg-emerald-50/60 text-emerald-700"
                              : "border-border/60 bg-white text-zinc-400"
                  }`}
                >
                  {stage.shortLabel}
                </span>
                {idx < graphStages.length - 1 && (
                  <span className="text-[10px] text-zinc-300">/</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setModeFilter("ALL")}
            className={`rounded-sm px-2 py-0.5 font-medium ${
              modeFilter === "ALL"
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            All ({events.length})
          </button>
          <button
            type="button"
            onClick={() => setModeFilter("DETERMINISTIC")}
            className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-medium ${
              modeFilter === "DETERMINISTIC"
                ? "bg-emerald-700 text-white"
                : "text-emerald-700 hover:bg-emerald-50"
            }`}
          >
            <ShieldCheck className="h-3 w-3" />
            Code
          </button>
          <button
            type="button"
            onClick={() => setModeFilter("LLM")}
            className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-medium ${
              modeFilter === "LLM"
                ? "bg-zinc-900 text-white"
                : "text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            <Sparkles className="h-3 w-3" />
            LLM
          </button>
          <button
            type="button"
            onClick={() => setModeFilter("HUMAN_GATE")}
            className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-medium ${
              modeFilter === "HUMAN_GATE"
                ? "bg-amber-700 text-white"
                : "text-amber-800 hover:bg-amber-50"
            }`}
          >
            <PauseCircle className="h-3 w-3" />
            Human
          </button>
        </div>

        <button
          type="button"
          onClick={() => setNewestFirst((v) => !v)}
          className="text-[11px] font-medium text-zinc-500 hover:text-zinc-900"
        >
          {newestFirst ? "Newest first" : "Oldest first"}
        </button>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
        {orderedEvents.length === 0 ? (
          <p className="py-8 text-center text-xs text-zinc-400">
            No matching events recorded.
          </p>
        ) : (
          orderedEvents.map((ev) => {
            const style = getModeStyle(ev);
            const expanded = Boolean(expandedIds[ev.id]);

            return (
              <div
                key={ev.id}
                className={`rounded-sm border border-border/70 border-l-2 ${style.barClass} bg-white p-2 text-xs`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-zinc-900">
                      {ev.agentName}
                    </span>
                    <span
                      className={`rounded-sm border px-1.5 py-px text-[10px] font-medium ${style.pillClass}`}
                    >
                      {style.label}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500">
                      {ev.step}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-400 tabular-nums">
                    {ev.latencyMs}ms
                  </span>
                </div>

                <p className="mt-1 leading-snug text-zinc-700">{ev.summary}</p>

                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] text-zinc-400">
                  <span className="inline-flex items-center gap-1">
                    <Cpu className="h-3 w-3" />
                    {ev.provider}/{ev.model}
                    {ev.totalTokens > 0 && (
                      <span className="ml-1 tabular-nums">
                        · {ev.totalTokens} tok (${ev.costUsd.toFixed(4)})
                      </span>
                    )}
                    {" · "}
                    {formatDateTimeShort(ev.createdAt)}
                  </span>

                  <button
                    type="button"
                    onClick={() => toggleExpanded(ev.id)}
                    className="inline-flex items-center gap-0.5 font-medium text-zinc-600 hover:text-zinc-900"
                  >
                    {expanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    I/O
                  </button>
                </div>

                {expanded && (
                  <div className="mt-2 space-y-1 rounded-sm border border-border/60 bg-zinc-50 p-2 font-mono text-[10px] text-zinc-700">
                    {ev.fromState || ev.toState ? (
                      <div>
                        <span className="font-medium">Transition:</span>{" "}
                        {ev.fromState ?? "-"} -&gt; {ev.toState ?? "-"}
                      </div>
                    ) : null}
                    {ev.inputSummary && (
                      <div>
                        <span className="font-medium">Input:</span>{" "}
                        {ev.inputSummary}
                      </div>
                    )}
                    {ev.outputSummary && (
                      <div>
                        <span className="font-medium">Output:</span>{" "}
                        {ev.outputSummary}
                      </div>
                    )}
                    <pre className="max-h-40 overflow-x-auto whitespace-pre-wrap text-[10px] text-zinc-600">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
