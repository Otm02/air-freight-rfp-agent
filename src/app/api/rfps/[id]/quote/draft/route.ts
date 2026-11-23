import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultDatabase } from "@/db";
import {
  getLlmModeFromRequest,
  handleApiError,
  parsePositiveIntId,
} from "@/lib/api-helpers";
import { draftQuote, getRfpWorkspace } from "@/orchestrator";

export const dynamic = "force-dynamic";

const DraftQuoteBodySchema = z
  .object({
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
    const parsed = DraftQuoteBodySchema.safeParse(rawBody);
    const llmMode = getLlmModeFromRequest(
      request,
      parsed.success ? parsed.data?.llmMode : undefined,
    );

    const { db } = await getDefaultDatabase();
    await draftQuote(db, rfpId, { llmMode });

    const workspace = await getRfpWorkspace(db, rfpId, llmMode);
    return NextResponse.json(workspace);
  } catch (err) {
    return handleApiError(err);
  }
}
