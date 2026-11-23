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
      pillClass: "bg-amber-50 text-amber-900 border-amber-300",
      barClass: "border-l-amber-500",
    };
  }
  if (ev.executionMode === "LLM") {
    return {
      label: "LLM Call",
      pillClass: "bg-indigo-50 text-indigo-800 border-indigo-200",
      barClass: "border-l-indigo-500",
    };
  }
  if (ev.executionMode === "DETERMINISTIC") {
    return {
      label: "Deterministic",
      pillClass: "bg-emerald-50 text-emerald-800 border-emerald-200",
      barClass: "border-l-emerald-500",
    };
  }
  return {
    label: "State Machine",
    pillClass: "bg-slate-100 text-slate-700 border-slate-200",
    barClass: "border-l-slate-400",
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
        // Ignore malformed frame
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

  // Show main progression path plus matching terminal node
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
      className="flex flex-col rounded-xl border border-slate-200 bg-white shadow-2xs lg:sticky lg:top-20 lg:max-h-[calc(100vh-6.5rem)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#1E3A5F]" />
          <h2 className="text-sm font-semibold text-slate-900">
            Agent Orchestration
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <span
            data-testid="sse-connection-pill"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              sseConnected
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-slate-200 bg-slate-50 text-slate-500"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                sseConnected ? "bg-emerald-600" : "bg-slate-400"
              }`}
            />
            {sseConnected ? "Live SSE" : "Connecting"}
          </span>
        </div>
      </div>

      {/* Pipeline State Graph */}
      <div
        className="border-b border-slate-200 bg-slate-50/70 px-4 py-3"
        data-testid="pipeline-state-graph"
      >
        <div className="mb-2 flex items-center justify-between text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
          <span>RFP Pipeline Graph</span>
          {waitingHuman && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
              <PauseCircle className="h-3 w-3" />
              WAITING FOR HUMAN
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
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
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold transition ${
                    isCurrent && stage.isHumanGate
                      ? "border-amber-400 bg-amber-100 text-amber-950 ring-2 ring-amber-300/70"
                      : isCurrent && stage.state === "WON"
                        ? "border-emerald-400 bg-emerald-100 text-emerald-900 ring-2 ring-emerald-300/70"
                        : isCurrent && stage.state === "LOST"
                          ? "border-rose-400 bg-rose-100 text-rose-900 ring-2 ring-rose-300/70"
                          : isCurrent
                            ? "border-[#1E3A5F] bg-[#1E3A5F] text-white ring-2 ring-sky-200"
                            : isDone
                              ? "border-emerald-200 bg-emerald-50/80 text-emerald-700"
                              : "border-slate-200 bg-white text-slate-400"
                  }`}
                >
                  {stage.shortLabel}
                </span>
                {idx < graphStages.length - 1 && (
                  <span className="text-[10px] text-slate-300">→</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Filter Legend Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setModeFilter("ALL")}
            className={`rounded px-2 py-0.5 font-medium ${
              modeFilter === "ALL"
                ? "bg-slate-800 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            All ({events.length})
          </button>
          <button
            type="button"
            onClick={() => setModeFilter("DETERMINISTIC")}
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ${
              modeFilter === "DETERMINISTIC"
                ? "bg-emerald-700 text-white"
                : "text-emerald-700 hover:bg-emerald-50"
            }`}
          >
            <ShieldCheck className="h-3 w-3" />
            Deterministic
          </button>
          <button
            type="button"
            onClick={() => setModeFilter("LLM")}
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ${
              modeFilter === "LLM"
                ? "bg-indigo-700 text-white"
                : "text-indigo-700 hover:bg-indigo-50"
            }`}
          >
            <Sparkles className="h-3 w-3" />
            LLM
          </button>
          <button
            type="button"
            onClick={() => setModeFilter("HUMAN_GATE")}
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ${
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
          className="text-[11px] font-medium text-slate-500 hover:text-slate-900"
        >
          {newestFirst ? "Newest first ↓" : "Oldest first ↑"}
        </button>
      </div>

      {/* Live Timeline */}
      <div className="flex-1 divide-y divide-slate-100 overflow-y-auto p-3">
        {orderedEvents.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-400">
            No matching orchestration events yet.
          </p>
        ) : (
          orderedEvents.map((ev) => {
            const style = getModeStyle(ev);
            const expanded = Boolean(expandedIds[ev.id]);

            return (
              <div
                key={ev.id}
                className={`mb-2 rounded-lg border border-slate-200 border-l-4 ${style.barClass} bg-white p-2.5 text-xs`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-slate-900">
                      {ev.agentName}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.2 text-[10px] font-semibold ${style.pillClass}`}
                    >
                      {style.label}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">
                      {ev.step}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-slate-400 tabular-nums">
                    {ev.latencyMs}ms
                  </span>
                </div>

                <p className="mt-1 leading-snug text-slate-700">{ev.summary}</p>

                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
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
                    className="inline-flex items-center gap-0.5 font-medium text-slate-600 hover:text-slate-900"
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
                  <div className="mt-2 space-y-1.5 rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[10px] text-slate-700">
                    {ev.fromState || ev.toState ? (
                      <div>
                        <strong>Transition:</strong> {ev.fromState ?? "—"} →{" "}
                        {ev.toState ?? "—"}
                      </div>
                    ) : null}
                    {ev.inputSummary && (
                      <div>
                        <strong>Input:</strong> {ev.inputSummary}
                      </div>
                    )}
                    {ev.outputSummary && (
                      <div>
                        <strong>Output:</strong> {ev.outputSummary}
                      </div>
                    )}
                    <pre className="max-h-40 overflow-x-auto whitespace-pre-wrap text-[10px] text-slate-600">
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
