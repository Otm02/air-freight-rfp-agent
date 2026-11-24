import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultDatabase } from "@/db";
import { SERVICE_TYPES } from "@/domain";
import {
  getLlmModeFromRequest,
  handleApiError,
  HttpBadRequestError,
  parseJsonBody,
  parsePositiveIntId,
} from "@/lib/api-helpers";
import {
  confirmLaneRequirements,
  decideLaneDisposition,
  getRfpWorkspace,
} from "@/orchestrator";

export const dynamic = "force-dynamic";

const LaneActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm_requirements"),
    requestedServices: z.array(z.enum(SERVICE_TYPES)),
    reviewer: z.string().min(1).default("RFP Analyst"),
    note: z.string().optional(),
    llmMode: z.enum(["offline", "auto"]).optional(),
  }),
  z.object({
    action: z.literal("route_decision"),
    disposition: z.enum([
      "QUOTE_COMPLIANT",
      "QUOTE_COMPLIANT_LATE",
      "QUOTE_PARTIAL_ON_TIME",
      "DECLINE",
    ]),
    alternativeIndex: z.number().int().nonnegative().optional(),
    reviewer: z.string().min(1).default("RFP Analyst"),
    note: z.string().optional(),
    llmMode: z.enum(["offline", "auto"]).optional(),
  }),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; laneId: string }> },
) {
  try {
    const { id, laneId: rawLaneId } = await context.params;
    const rfpId = parsePositiveIntId(id, "rfpId");
    const laneId = parsePositiveIntId(rawLaneId, "laneId");

    const body = await parseJsonBody(request);
    const parsed = LaneActionSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpBadRequestError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }

    const { db } = await getDefaultDatabase();
    if (parsed.data.action === "confirm_requirements") {
      await confirmLaneRequirements(db, rfpId, laneId, {
        requestedServices: parsed.data.requestedServices,
        reviewer: parsed.data.reviewer,
        note: parsed.data.note,
      });
    } else {
      await decideLaneDisposition(db, rfpId, laneId, {
        disposition: parsed.data.disposition,
        alternativeIndex: parsed.data.alternativeIndex,
        reviewer: parsed.data.reviewer,
        note: parsed.data.note,
      });
    }

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
