"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
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

/*
 * The activity log is deliberately the only dark surface in the product.
 * Deterministic steps recede (zinc), LLM steps are lifted (white-on-zinc)
 * because they are the probabilistic ones, human gates are amber.
 */
function getModeStyle(ev: AgentEventView): {
  label: string;
  tagClass: string;
  ruleClass: string;
} {
  if (
    ev.executionMode === "HUMAN_GATE" ||
    ev.status === "WAITING_FOR_HUMAN" ||
    ev.eventType === "WAITING_FOR_HUMAN"
  ) {
    return {
      label: ev.status === "WAITING_FOR_HUMAN" ? "Waiting for Human" : "Human Gate",
      tagClass: "text-amber-400",
      ruleClass: "border-l-amber-500",
    };
  }
  if (ev.executionMode === "LLM") {
    return {
      label: "LLM",
      tagClass: "bg-zinc-800 px-1 text-zinc-100",
      ruleClass: "border-l-zinc-400",
    };
  }
  if (ev.executionMode === "DETERMINISTIC") {
    return {
      label: "Deterministic",
      tagClass: "text-zinc-400",
      ruleClass: "border-l-zinc-800",
    };
  }
  return {
    label: "State",
    tagClass: "text-zinc-600",
    ruleClass: "border-l-zinc-800",
  };
}

type ModeFilter = "ALL" | "DETERMINISTIC" | "LLM" | "HUMAN_GATE";

export function AgentOrchestrationPanel({
  rfpId,
  currentStatus,
  events,
  onStreamEvent,
}: AgentOrchestrationPanelProps) {
  const [sseConnected, setSseConnected] = useState(false);
  const [modeFilter, setModeFilter] = useState<ModeFilter>("ALL");
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

  const filters: Array<{ id: ModeFilter; label: string }> = [
    { id: "ALL", label: `All ${events.length}` },
    { id: "DETERMINISTIC", label: "Code" },
    { id: "LLM", label: "LLM" },
    { id: "HUMAN_GATE", label: "Human" },
  ];

  return (
    <aside
      data-testid="agent-orchestration-panel"
      className="flex h-[600px] w-full shrink-0 flex-col border-t border-zinc-800 bg-zinc-950 font-mono text-zinc-300 lg:sticky lg:top-12 lg:h-[calc(100vh-3rem)] lg:w-[360px] xl:w-[400px] lg:border-t-0 lg:border-l"
    >
      {/* Header ------------------------------------------------------- */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-medium text-zinc-100">Activity log</h2>
          <span className="text-2xs text-zinc-600">rfp/{rfpId}</span>
        </div>

        <span
          data-testid="sse-connection-pill"
          className="inline-flex items-center gap-1.5 text-2xs text-zinc-400"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              sseConnected
                ? "bg-emerald-500"
                : "bg-transparent ring-1 ring-inset ring-zinc-600"
            }`}
          />
          {sseConnected ? "Live SSE" : "Connecting"}
        </span>
      </div>

      {/* Pipeline ----------------------------------------------------- */}
      <div
        className="shrink-0 border-b border-zinc-800 px-4 py-3"
        data-testid="pipeline-state-graph"
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-2xs font-medium tracking-[0.08em] text-zinc-500 uppercase">
            Pipeline
          </span>
          {waitingHuman && (
            <span className="inline-flex items-center gap-1.5 text-2xs font-medium tracking-[0.08em] text-amber-400 uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Waiting for human
            </span>
          )}
        </div>

        <ol className="relative ml-[5px] border-l border-zinc-800">
          {graphStages.map((stage) => {
            const stageMasterIdx = PIPELINE_STAGES.findIndex(
              (s) => s.state === stage.state,
            );
            const isCurrent = stage.state === currentStatus;
            const isDone =
              !isCurrent && currentIdx >= 0 && stageMasterIdx < currentIdx;

            const currentDot =
              stage.isHumanGate
                ? "bg-amber-400"
                : stage.state === "WON"
                  ? "bg-emerald-500"
                  : stage.state === "LOST"
                    ? "bg-red-500"
                    : "bg-zinc-100";

            return (
              <li
                key={stage.state}
                title={`${stage.state}: ${stage.description}`}
                data-testid={`pipeline-node-${stage.state}`}
                data-active={isCurrent ? "true" : "false"}
                className="relative flex h-[22px] items-center pl-4 text-xs"
              >
                <span className="absolute top-1/2 left-0 flex h-3 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center bg-zinc-950">
                  {isCurrent ? (
                    <span className={`h-2 w-2 rounded-full ${currentDot}`} />
                  ) : isDone ? (
                    <Check className="h-3 w-3 text-zinc-500" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full ring-1 ring-inset ring-zinc-700" />
                  )}
                </span>
                <span
                  className={
                    isCurrent
                      ? "font-medium text-zinc-100"
                      : isDone
                        ? "text-zinc-500"
                        : "text-zinc-600"
                  }
                >
                  {stage.shortLabel}
                </span>
                {stage.isHumanGate && !isCurrent && (
                  <span className="ml-2 text-2xs text-zinc-700">gate</span>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Filters ------------------------------------------------------ */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-3 text-2xs">
        <div className="flex items-center gap-0.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setModeFilter(f.id)}
              aria-pressed={modeFilter === f.id}
              className={`rounded-sm px-1.5 py-0.5 tracking-[0.04em] uppercase transition-colors ${
                modeFilter === f.id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setNewestFirst((v) => !v)}
          className="text-zinc-500 transition-colors hover:text-zinc-200"
        >
          {newestFirst ? "Newest first" : "Oldest first"}
        </button>
      </div>

      {/* Log ---------------------------------------------------------- */}
      <div className="scroll-thin-dark min-h-0 flex-1 overflow-y-auto">
        {orderedEvents.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-zinc-600">
            No matching events recorded.
          </p>
        ) : (
          orderedEvents.map((ev) => {
            const style = getModeStyle(ev);
            const expanded = Boolean(expandedIds[ev.id]);

            return (
              <div
                key={ev.id}
                className={`border-b border-zinc-900 border-l-2 ${style.ruleClass} px-3.5 py-2.5 text-xs`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-zinc-100">
                      {ev.agentName}
                    </span>
                    <span
                      className={`rounded-xs text-2xs tracking-[0.06em] uppercase ${style.tagClass}`}
                    >
                      {style.label}
                    </span>
                  </div>
                  <span className="shrink-0 text-2xs text-zinc-500 tabular-nums">
                    {ev.latencyMs}ms
                  </span>
                </div>

                <div className="mt-0.5 text-2xs text-zinc-500">{ev.step}</div>

                <p className="mt-1.5 leading-[1.45] text-zinc-300">
                  {ev.summary}
                </p>

                <div className="mt-2 flex items-center justify-between gap-2 text-2xs text-zinc-600">
                  <span className="min-w-0 truncate">
                    {ev.provider}/{ev.model}
                    {ev.totalTokens > 0 && (
                      <span className="tabular-nums">
                        {" "}
                        · {ev.totalTokens} tok (${ev.costUsd.toFixed(4)})
                      </span>
                    )}
                    {" · "}
                    {formatDateTimeShort(ev.createdAt)}
                  </span>

                  <button
                    type="button"
                    onClick={() => toggleExpanded(ev.id)}
                    aria-expanded={expanded}
                    className="inline-flex shrink-0 items-center gap-0.5 text-zinc-500 transition-colors hover:text-zinc-100"
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
                  <div className="mt-2 space-y-1.5 rounded-sm border border-zinc-800 bg-zinc-900/60 p-2.5 text-2xs leading-relaxed text-zinc-400">
                    {ev.fromState || ev.toState ? (
                      <div>
                        <span className="text-zinc-500">transition</span>{" "}
                        <span className="text-zinc-200">
                          {ev.fromState ?? "-"} -&gt; {ev.toState ?? "-"}
                        </span>
                      </div>
                    ) : null}
                    {ev.inputSummary && (
                      <div>
                        <span className="text-zinc-500">input</span>{" "}
                        <span className="text-zinc-200">{ev.inputSummary}</span>
                      </div>
                    )}
                    {ev.outputSummary && (
                      <div>
                        <span className="text-zinc-500">output</span>{" "}
                        <span className="text-zinc-200">
                          {ev.outputSummary}
                        </span>
                      </div>
                    )}
                    <pre className="scroll-thin-dark max-h-40 overflow-auto border-t border-zinc-800 pt-1.5 text-2xs whitespace-pre-wrap text-zinc-500">
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
