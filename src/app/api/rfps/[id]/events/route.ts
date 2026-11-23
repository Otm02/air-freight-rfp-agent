import { getDefaultDatabase } from "@/db";
import { parsePositiveIntId } from "@/lib/api-helpers";
import {
  ensureDemoSeeded,
  getEventsAfter,
  subscribeToRfpEvents,
  toAgentEventView,
  type AgentEventRow,
} from "@/orchestrator";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let rfpId: number;
  try {
    rfpId = parsePositiveIntId(id, "rfpId");
  } catch (err) {
    return new Response(
      err instanceof Error ? err.message : "Invalid rfpId",
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const lastEventHeader = request.headers.get("last-event-id");
  const afterParam = url.searchParams.get("afterId");
  const rawAfter = lastEventHeader ?? afterParam ?? "0";
  const parsedAfter = Number.parseInt(rawAfter, 10);
  const initialAfterId =
    Number.isFinite(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;

  const { db } = await getDefaultDatabase();
  await ensureDemoSeeded(db);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSentId = initialAfterId;
      let closed = false;

      const sendRow = (row: AgentEventRow) => {
        if (closed || row.id <= lastSentId) {
          return;
        }
        lastSentId = row.id;
        const view = toAgentEventView(row);
        const chunk = `id: ${row.id}\nevent: agent_event\ndata: ${JSON.stringify(view)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      };

      const unsubscribe = subscribeToRfpEvents(rfpId, (row) => {
        sendRow(row);
      });

      const keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Ignore closed stream
        }
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepaliveTimer);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      };

      request.signal.addEventListener("abort", cleanup, { once: true });

      try {
        const missed = await getEventsAfter(db, rfpId, initialAfterId);
        for (const row of missed) {
          sendRow(row);
        }
      } catch {
        cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
