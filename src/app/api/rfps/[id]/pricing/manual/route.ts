import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_SANE_PRICE_PER_TON_USD, MIN_SANE_PRICE_PER_TON_USD } from "@/agents";
import { getDefaultDatabase } from "@/db";
import {
  getLlmModeFromRequest,
  handleApiError,
  HttpBadRequestError,
  parseJsonBody,
  parsePositiveIntId,
} from "@/lib/api-helpers";
import { getRfpWorkspace, setManualLanePrice } from "@/orchestrator";

export const dynamic = "force-dynamic";

const ManualPriceSchema = z.object({
  laneId: z.coerce.number().int().positive(),
  pricePerTonUsd: z.coerce
    .number()
    .min(
      MIN_SANE_PRICE_PER_TON_USD,
      `Manual price must be at least $${MIN_SANE_PRICE_PER_TON_USD}/t.`,
    )
    .max(
      MAX_SANE_PRICE_PER_TON_USD,
      `Manual price cannot exceed $${MAX_SANE_PRICE_PER_TON_USD}/t.`,
    ),
  reviewer: z.string().min(1).default("RFP Analyst"),
  note: z.string().optional(),
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
    const parsed = ManualPriceSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpBadRequestError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }

    const { db } = await getDefaultDatabase();
    await setManualLanePrice(db, rfpId, parsed.data.laneId, {
      pricePerTonUsd: parsed.data.pricePerTonUsd,
      reviewer: parsed.data.reviewer,
      note: parsed.data.note,
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
