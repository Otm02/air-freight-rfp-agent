import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultDatabase } from "@/db";
import {
  getLlmModeFromRequest,
  handleApiError,
  HttpBadRequestError,
  parsePositiveIntId,
} from "@/lib/api-helpers";
import { getRfpWorkspace, resolveFollowUpTask } from "@/orchestrator";

export const dynamic = "force-dynamic";

const ResolveTaskSchema = z.object({
  reviewer: z.string().min(1).default("RFP Analyst"),
  responseNote: z.string().min(1),
  outcome: z.enum(["RETURN_TO_SENT", "CLOSE_LOST"]).optional(),
  llmMode: z.enum(["offline", "auto"]).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const { id, taskId: rawTaskId } = await context.params;
    const rfpId = parsePositiveIntId(id, "rfpId");
    const taskId = parsePositiveIntId(rawTaskId, "taskId");

    const body: unknown = await request.json();
    const parsed = ResolveTaskSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpBadRequestError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }

    const { db } = await getDefaultDatabase();
    await resolveFollowUpTask(db, rfpId, taskId, {
      reviewer: parsed.data.reviewer,
      responseNote: parsed.data.responseNote,
      outcome: parsed.data.outcome,
    });

    const workspace = await getRfpWorkspace(
      db,
      rfpId,
      getLlmModeFromRequest(request, parsed.data.llmMode),
    );
    return NextResponse.json(workspace);
  } catch (err) {
    return handleApiError(err);
  }
}
