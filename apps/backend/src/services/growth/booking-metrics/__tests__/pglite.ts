import { createRequire } from "node:module";
import { join } from "node:path";
import type { ReadSession } from "@/services/data-gateway/session";

export type Pg = {
  exec: (q: string) => Promise<unknown>;
  query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  close: () => Promise<void>;
};

export async function openPglite(): Promise<Pg | null> {
  const spec = "@electric-sql/pglite";
  let mod: { PGlite: new () => Pg } | null = null;
  try {
    mod = (await import( spec)) as { PGlite: new () => Pg };
  } catch {
    if (process.env.PGLITE_DIR) mod = createRequire(join(process.env.PGLITE_DIR, "package.json"))(spec);
  }
  if (!mod) {
    if (process.env.CI) throw new Error("@electric-sql/pglite is a devDependency and must be installed in CI");
    return null;
  }
  return new mod.PGlite();
}

export function pgSession(db: Pg): ReadSession {
  return {
    dialect: "postgres",
    async query(text: string, params?: unknown[]) {
      const r = await db.query(text, params ?? []);
      return { rows: r.rows, fields: [], truncated: false };
    },
    mongo: () => {
      throw new Error("not mongo");
    },
    dynamo: () => {
      throw new Error("not dynamo");
    },
    sessionTimeZone: () => undefined,
    largestTableRows: async () => null,
    close: async () => undefined,
  };
}
