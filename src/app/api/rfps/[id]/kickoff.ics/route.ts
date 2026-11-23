import { desc, eq } from "drizzle-orm";
import { getDefaultDatabase, meetings } from "@/db";
import { handleApiError, parsePositiveIntId } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const rfpId = parsePositiveIntId(id, "rfpId");

    const { db } = await getDefaultDatabase();
    const [meetingRow] = await db
      .select()
      .from(meetings)
      .where(eq(meetings.rfpId, rfpId))
      .orderBy(desc(meetings.id))
      .limit(1);

    if (!meetingRow) {
      return new Response("Kickoff meeting not scheduled for this RFP.", {
        status: 404,
      });
    }

    return new Response(meetingRow.icsContent, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="rfp-${rfpId}-kickoff.ics"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
