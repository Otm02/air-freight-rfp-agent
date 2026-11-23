import { NextResponse } from "next/server";
import { getDefaultDatabase } from "@/db";
import {
  handleApiError,
  parseLlmMode,
  parsePositiveIntId,
} from "@/lib/api-helpers";
import { getRfpWorkspace } from "@/orchestrator";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const rfpId = parsePositiveIntId(id, "rfpId");
    const url = new URL(request.url);
    const llmMode = parseLlmMode(url.searchParams.get("llmMode"));

    const { db } = await getDefaultDatabase();
    const workspace = await getRfpWorkspace(db, rfpId, llmMode);
    if (!workspace) {
      return NextResponse.json({ error: `RFP #${rfpId} not found.` }, { status: 404 });
    }
    return NextResponse.json(workspace);
  } catch (err) {
    return handleApiError(err);
  }
}
