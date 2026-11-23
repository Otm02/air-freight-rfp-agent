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
  url: string;
  close: () => void;
}

const globalForDb = globalThis as typeof globalThis & {
  __airFreightRfpDb?: Promise<DatabaseHandle>;
};

export function resolveDefaultDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim();
  const isUnc = process.cwd().startsWith("\\\\");
  if (isUnc && process.env.FORCE_FILE_DB !== "1") {
    // Windows libsql hits SQLITE_BUSY file-locking errors over WSL 9p UNC mounts.
    return ":memory:";
  }
  return configured || "file:./data/rfp.db";
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
  url: string = resolveDefaultDatabaseUrl(),
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
    url,
    close: () => client.close(),
  };
}

export function getDefaultDatabase(): Promise<DatabaseHandle> {
  if (!globalForDb.__airFreightRfpDb) {
    const primaryUrl = resolveDefaultDatabaseUrl();
    globalForDb.__airFreightRfpDb = createDatabase(primaryUrl).catch(
      async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code)
            : "";
        if (
          primaryUrl !== ":memory:" &&
          (code === "SQLITE_BUSY" || msg.includes("SQLITE_BUSY"))
        ) {
          console.warn(
            `[db] SQLITE_BUSY opening "${primaryUrl}"; falling back to ":memory:".`,
          );
          return createDatabase(":memory:");
        }
        throw err;
      },
    );
  }
  return globalForDb.__airFreightRfpDb;
}
