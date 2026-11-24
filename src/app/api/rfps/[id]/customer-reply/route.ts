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
import { getRfpWorkspace, processCustomerReply } from "@/orchestrator";

export const dynamic = "force-dynamic";

const CustomerReplySchema = z.object({
  proposalId: z.coerce.number().int().positive(),
  scenario: z
    .enum(["accept_all", "accept_some", "reject", "question", "unclear"])
    .optional(),
  customBody: z.string().optional(),
  acceptedLaneCodes: z.array(z.string()).optional(),
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
    const parsed = CustomerReplySchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpBadRequestError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }

    const { db } = await getDefaultDatabase();
    const llmMode = getLlmModeFromRequest(request, parsed.data.llmMode);
    await processCustomerReply(db, rfpId, parsed.data.proposalId, {
      scenario: parsed.data.scenario,
      customBody: parsed.data.customBody,
      acceptedLaneCodes: parsed.data.acceptedLaneCodes,
      llmMode,
    });

    const workspace = await getRfpWorkspace(db, rfpId, llmMode);
    return NextResponse.json(workspace);
  } catch (err) {
    return handleApiError(err);
  }
}
