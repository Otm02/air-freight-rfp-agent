import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { RfpWorkspaceClient } from "@/components/RfpWorkspaceClient";
import { getDefaultDatabase } from "@/db";
import { parseLlmMode, parsePositiveIntId } from "@/lib/api-helpers";
import { getRfpWorkspace } from "@/orchestrator";

export const dynamic = "force-dynamic";

export default async function RfpWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let rfpId: number;
  try {
    rfpId = parsePositiveIntId(id, "rfpId");
  } catch {
    notFound();
  }

  const cookieStore = await cookies();
  const llmMode = parseLlmMode(cookieStore.get("rfp_llm_mode")?.value);
  const { db } = await getDefaultDatabase();
  const workspace = await getRfpWorkspace(db, rfpId, llmMode);
  if (!workspace) {
    notFound();
  }

  return <RfpWorkspaceClient initialWorkspace={workspace} />;
}
