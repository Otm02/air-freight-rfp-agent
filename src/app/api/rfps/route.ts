import { NextResponse } from "next/server";
import { z } from "zod";
import { getDefaultDatabase } from "@/db";
import {
  handleApiError,
  HttpBadRequestError,
  parseLlmMode,
} from "@/lib/api-helpers";
import {
  createRfp,
  getActiveLlmInfo,
  getRfpWorkspace,
  listRfps,
} from "@/orchestrator";

export const dynamic = "force-dynamic";

const CreatePresetSchema = z.object({
  mode: z.literal("preset"),
  preset: z.enum(["showcase", "full100"]),
  title: z.string().optional(),
  customerName: z.string().optional(),
  customerEmail: z.string().optional(),
  llmMode: z.enum(["offline", "auto"]).optional(),
});

const CreateCustomSchema = z.object({
  mode: z.literal("custom"),
  title: z.string().min(1),
  customerName: z.string().min(1),
  customerEmail: z.string().email(),
  llmMode: z.enum(["offline", "auto"]).optional(),
  lanes: z
    .array(
      z.object({
        origin: z.string().min(3),
        destination: z.string().min(3),
        tons: z.coerce.number().positive(),
        maxTransitDays: z.coerce.number().int().positive(),
        rawEmail: z.string().min(3),
      }),
    )
    .min(1),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const llmMode = parseLlmMode(url.searchParams.get("llmMode"));
    const { db } = await getDefaultDatabase();
    const rfps = await listRfps(db, llmMode);
    const activeLlm = getActiveLlmInfo(llmMode);
    return NextResponse.json({ rfps, activeLlm });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const { db } = await getDefaultDatabase();
    const contentType = request.headers.get("content-type") ?? "";

    let rfpId: number;
    let llmMode: "offline" | "auto" | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new HttpBadRequestError("Missing .xlsx file upload.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      llmMode = parseLlmMode(formData.get("llmMode"));
      rfpId = await createRfp(db, {
        mode: "xlsx",
        buffer: bytes,
        fileName: file.name,
        title: String(formData.get("title") ?? "").trim() || undefined,
        customerName:
          String(formData.get("customerName") ?? "").trim() || undefined,
        customerEmail:
          String(formData.get("customerEmail") ?? "").trim() || undefined,
        llmMode,
      });
    } else {
      const body: unknown = await request.json();
      const presetParsed = CreatePresetSchema.safeParse(body);
      if (presetParsed.success) {
        llmMode = presetParsed.data.llmMode;
        rfpId = await createRfp(db, presetParsed.data);
      } else {
        const customParsed = CreateCustomSchema.safeParse(body);
        if (!customParsed.success) {
          throw new HttpBadRequestError(
            customParsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          );
        }
        llmMode = customParsed.data.llmMode;
        rfpId = await createRfp(db, customParsed.data);
      }
    }

    const workspace = await getRfpWorkspace(db, rfpId, llmMode);
    return NextResponse.json({ rfpId, workspace }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
