import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultDatabase } from "@/db";
import {
  getLlmModeFromRequest,
  handleApiError,
  HttpBadRequestError,
  parseJsonBody,
  parsePositiveIntId,
} from "@/lib/api-helpers";
import { approveAndSendQuote, getRfpWorkspace } from "@/orchestrator";

export const dynamic = "force-dynamic";

const ApproveSendSchema = z.object({
  proposalId: z.coerce.number().int().positive(),
  approvedBy: z.string().min(1).default("alice.rfp@carrier.example"),
  acceptOpenTaskIds: z.array(z.number().int().positive()).optional(),
  exceptionNote: z.string().optional(),
  llmMode: z.enum(["offline", "auto"]).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const rfpId = parsePositiveIntId(id, "rfpId");

    const body = await parseJsonBody(request);
    const parsed = ApproveSendSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpBadRequestError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }

    const { db } = await getDefaultDatabase();
    await approveAndSendQuote(db, rfpId, parsed.data.proposalId, {
      approvedBy: parsed.data.approvedBy,
      acceptOpenTaskIds: parsed.data.acceptOpenTaskIds,
      exceptionNote: parsed.data.exceptionNote,
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
