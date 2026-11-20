import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractOwnerChatFacts } from "@/services/company/owner-chat-facts";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261119160300_owner_chat_fact_keys.sql";
const modules = process.env.SITES_SQL_TEST_MODULES;
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

describe.skipIf(!modules)("owner chat fact keys", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(join(modules as string, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`create type tenant_fact_key as enum ('domain', 'markets');
      create table tenant_fact (tenant_id uuid, key tenant_fact_key, value_text text not null, primary key (tenant_id, key));`);
    await db.exec(readFileSync(join(MIGRATIONS, FILE), "utf8"));
  });
  afterAll(() => db?.close());

  it("runs twice and lets each new key hold a row, one per tenant and key", async () => {
    await db.exec(readFileSync(join(MIGRATIONS, FILE), "utf8"));
    const t = "11111111-1111-4111-8111-111111111111";
    const keys = Object.keys(extractOwnerChatFacts("Basic clean is $140. We serve San Jose. Open Mon-Fri 9am to 5pm."));
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      await db.query("insert into tenant_fact values ($1, $2, 'x')", [t, key]);
      await expect(db.query("insert into tenant_fact values ($1, $2, 'y')", [t, key])).rejects.toThrow();
    }
    const { rows } = await db.query("select count(*)::int as n from tenant_fact");
    expect(rows[0].n).toBe(3);
  });

  it("the key set stays closed", async () => {
    await expect(db.query("insert into tenant_fact values ('11111111-1111-4111-8111-111111111112', 'discount', 'x')")).rejects.toThrow();
  });
});
