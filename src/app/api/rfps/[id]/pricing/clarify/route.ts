import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultDatabase } from "@/db";
import {
  getLlmModeFromRequest,
  handleApiError,
  parsePositiveIntId,
} from "@/lib/api-helpers";
import { clarifyPricing, getRfpWorkspace } from "@/orchestrator";

export const dynamic = "force-dynamic";

const ClarifyPricingSchema = z
  .object({
    taskId: z.number().int().positive().optional(),
    llmMode: z.enum(["offline", "auto"]).optional(),
  })
  .optional();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const rfpId = parsePositiveIntId(id, "rfpId");

    let rawBody: unknown = {};
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const parsed = ClarifyPricingSchema.safeParse(rawBody);
    const taskId = parsed.success ? parsed.data?.taskId : undefined;
    const llmMode = getLlmModeFromRequest(
      request,
      parsed.success ? parsed.data?.llmMode : undefined,
    );

    const { db } = await getDefaultDatabase();
    await clarifyPricing(db, rfpId, { taskId, llmMode });

    const workspace = await getRfpWorkspace(db, rfpId, llmMode);
    return NextResponse.json(workspace);
  } catch (err) {
    return handleApiError(err);
  }
}
