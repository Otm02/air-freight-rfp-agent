import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { ensureDatabaseSchema } from "./migrate";
import { schema } from "./schema";

export * from "./schema";
export { ensureDatabaseSchema } from "./migrate";

export type AppDatabase = LibSQLDatabase<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  client: Client;
  close: () => void;
}

function ensureLocalDbParentDir(url: string): void {
  if (!url.startsWith("file:")) {
    return;
  }
  const rawPath = url.slice("file:".length);
  if (!rawPath || rawPath === ":memory:" || rawPath.startsWith(":memory:")) {
    return;
  }
  const dir = path.dirname(path.resolve(rawPath));
  fs.mkdirSync(dir, { recursive: true });
}

export async function createDatabase(
  url: string = process.env.DATABASE_URL ?? "file:./data/rfp.db",
): Promise<DatabaseHandle> {
  ensureLocalDbParentDir(url);
  const client = createClient({ url });
  await ensureDatabaseSchema(client);

  const isMemory = url === ":memory:" || url.includes(":memory:");
  const isUnc =
    process.cwd().startsWith("\\\\") || url.includes("wsl.localhost");
  if (!isMemory && !isUnc) {
    try {
      await client.execute("PRAGMA journal_mode = WAL;");
    } catch {
      // Ignore WAL fallback on filesystems that disallow shared-memory locking
    }
  }

  const db = drizzle(client, { schema });
  return {
    db,
    client,
    close: () => client.close(),
  };
}

let defaultDbPromise: Promise<DatabaseHandle> | null = null;

export function getDefaultDatabase(): Promise<DatabaseHandle> {
  if (!defaultDbPromise) {
    defaultDbPromise = createDatabase();
  }
  return defaultDbPromise;
}
