import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { previewPathFor } from "@/services/creators/submission-preview";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261020140000_creator_submission_previews.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const O1 = "33333333-3333-4333-8333-333333333333";
const S1 = "44444444-4444-4444-8444-444444444444";

describe(FILE, () => {
  it("sorts after every migration before it", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261020130000_sandbox_pause_keeps_failed.sql"));
  });
});

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create table public.creator_submissions (
        id uuid primary key,
        tenant_id uuid not null,
        order_id uuid not null,
        storage_path text not null,
        check (storage_path like tenant_id::text || '/' || order_id::text || '/%')
      );
      insert into public.creator_submissions (id, tenant_id, order_id, storage_path)
      values ('${S1}', '${T1}', '${O1}', '${T1}/${O1}/orig.mov');
    `);
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => db?.close());

  const write = (patch: Record<string, string | null>) => {
    const keys = Object.keys(patch);
    return db.query(
      `update public.creator_submissions set ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")} where id = '${S1}'`,
      keys.map((k) => patch[k]),
    );
  };

  it("runs twice and leaves an existing row untouched", async () => {
    const { rows } = await db.query(`select preview_path, preview_state from public.creator_submissions where id = '${S1}'`);
    expect(rows[0]).toEqual({ preview_path: null, preview_state: null });
  });

  it("accepts the path the worker writes, marked ready", async () => {
    const path = previewPathFor({ tenant_id: T1, order_id: O1, id: S1 }, "video");
    await expect(write({ preview_state: "ready", preview_path: path })).resolves.toBeTruthy();
    await write({ preview_state: null, preview_path: null });
  });

  it("refuses a preview outside this order's preview folder", async () => {
    for (const path of [`${T2}/${O1}/preview/x.mp4`, `${T1}/${O1}/orig.mov`, `${T1}/${O1}/preview/../orig.mov`]) {
      await expect(write({ preview_state: "ready", preview_path: path }), path).rejects.toThrow(/preview_path_check/);
    }
  });

  it("ready and a path come together: never one without the other", async () => {
    await expect(write({ preview_state: "ready", preview_path: null })).rejects.toThrow(/preview_ready_check/);
    await expect(write({ preview_state: null, preview_path: `${T1}/${O1}/preview/x.mp4` })).rejects.toThrow(/preview_ready_check/);
    await expect(write({ preview_state: "pending", preview_path: `${T1}/${O1}/preview/x.mp4` })).rejects.toThrow(/preview_ready_check/);
    await expect(write({ preview_state: "pending", preview_path: null })).resolves.toBeTruthy();
    await expect(write({ preview_state: "failed", preview_path: null })).resolves.toBeTruthy();
  });

  it("counts attempts from zero and refuses a negative count", async () => {
    const { rows } = await db.query(`select preview_attempts from public.creator_submissions where id = '${S1}'`);
    expect(rows[0].preview_attempts).toBe(0);
    await expect(db.query(`update public.creator_submissions set preview_attempts = -1 where id = '${S1}'`)).rejects.toThrow(/preview_attempts_check/);
  });

  it("refuses a state it does not know", async () => {
    await expect(write({ preview_state: "done", preview_path: null })).rejects.toThrow(/preview_state_check/);
  });
});
