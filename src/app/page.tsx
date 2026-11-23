import { cookies } from "next/headers";
import { RfpInboxClient } from "@/components/RfpInboxClient";
import { getDefaultDatabase } from "@/db";
import { parseLlmMode } from "@/lib/api-helpers";
import { getActiveLlmInfo, listRfps } from "@/orchestrator";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const llmMode = parseLlmMode(cookieStore.get("rfp_llm_mode")?.value);
  const { db } = await getDefaultDatabase();
  const initialRfps = await listRfps(db, llmMode);
  const activeLlm = getActiveLlmInfo(llmMode);

  return (
    <RfpInboxClient
      initialRfps={initialRfps}
      activeModelLabel={activeLlm.displayLabel}
    />
  );
}
