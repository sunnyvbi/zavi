import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const file = path.join(os.tmpdir(), `reddit-local-store-${process.pid}.json`);
process.env.REDDIT_LOCAL_STORE_FILE = file;

const realFrom = vi.fn(() => "real-builder");
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: realFrom, rpc: vi.fn(() => "real-rpc") }) }));

describe("reddit local store", () => {
  beforeAll(() => {
    process.env.REDDIT_LOCAL_STORE = "1";
  });
  afterAll(() => {
    delete process.env.REDDIT_LOCAL_STORE;
    fs.rmSync(file, { force: true });
  });

  it("routes only reddit_* tables locally and enforces unique keys like Postgres", async () => {
    const { redditDb } = await import("../db");
    const db = redditDb();
    expect(db.from("agent_runs")).toBe("real-builder");

    const ins = await db.from("reddit_keywords").insert({ tenant_id: "t", term: "Rent my car" }).select("id, term, status").single();
    expect(ins.error).toBeNull();
    expect(ins.data).toMatchObject({ term: "Rent my car", status: "tracking" });
    const dup = await db.from("reddit_keywords").insert({ tenant_id: "t", term: " rent MY car " });
    expect(dup.error?.code).toBe("23505");

    const other = await db.from("reddit_keywords").select("term").eq("tenant_id", "other");
    expect(other.data).toEqual([]);
    const upd = await db.from("reddit_keywords").update({ status: "paused" }).eq("tenant_id", "t").select("status").maybeSingle();
    expect(upd.data).toEqual({ status: "paused" });
    const cnt = await db.from("reddit_keywords").select("id", { count: "exact", head: true }).eq("tenant_id", "t");
    expect(cnt.count).toBe(1);
  });

  it("opens one sweep per tenant under the cap, like the RPC", async () => {
    const { redditDb } = await import("../db");
    const db = redditDb();
    const args = { p_tenant_id: "t", p_trigger: "manual", p_requested_by: null, p_jobs_planned: 3, p_est_cost_usd: 0.5, p_tenant_cap_usd_7d: 3, p_fleet_cap_usd_24h: 25 };
    const a = await db.rpc("reddit_open_sweep", args);
    expect(a.data).toMatchObject({ ok: true });
    const b = await db.rpc("reddit_open_sweep", args);
    expect(b.data).toMatchObject({ ok: false, reason: "already_running" });
    const none = await db.rpc("reddit_open_sweep", { ...args, p_tenant_id: "u", p_jobs_planned: 0 });
    expect(none.data).toMatchObject({ ok: false, reason: "nothing_to_scan" });
  });

  it("stores the admitted jobs and stale-fails on heartbeat_at, not started_at", async () => {
    const { redditDb } = await import("../db");
    const db = redditDb();
    const jobs = [{ kind: "term", key: "term:turo", term: "Turo" }];
    const args = { p_tenant_id: "hb", p_trigger: "manual", p_requested_by: null, p_jobs: jobs, p_jobs_planned: 4, p_est_cost_usd: 1, p_tenant_cap_usd_7d: 10, p_fleet_cap_usd_24h: 1000 };
    const a = await db.rpc("reddit_open_sweep", args);
    const id = (a.data as { sweep_id: string }).sweep_id;
    const row = await db.from("reddit_sweeps").select("jobs, heartbeat_at, status").eq("id", id).single();
    expect(row.data).toMatchObject({ jobs, status: "running" });
    expect(typeof (row.data as { heartbeat_at: unknown }).heartbeat_at).toBe("string");

    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await db.from("reddit_sweeps").update({ started_at: twoHoursAgo, jobs_done: 1, jobs_failed: 1 }).eq("id", id);
    expect((await db.rpc("reddit_open_sweep", args)).data).toMatchObject({ ok: false, reason: "already_running" });

    await db.from("reddit_sweeps").update({ heartbeat_at: twoHoursAgo }).eq("id", id);
    expect((await db.rpc("reddit_open_sweep", args)).data).toMatchObject({ ok: true });
    const stale = await db.from("reddit_sweeps").select("status, error_code, cost_usd").eq("id", id).single();
    expect(stale.data).toEqual({ status: "failed", error_code: "stale_running", cost_usd: 0.5 });
  });

  it("caps selects at 1000 rows like prod max_rows, and pages with range()", async () => {
    const { redditDb, MAX_ROWS } = await import("../db");
    const db = redditDb();
    expect(MAX_ROWS).toBe(1000);
    const many = Array.from({ length: 1205 }, (_, i) => ({ tenant_id: "rows", term: `term ${String(i).padStart(4, "0")}` }));
    expect((await db.from("reddit_keywords").insert(many)).error).toBeNull();

    const all = await db.from("reddit_keywords").select("term", { count: "exact" }).eq("tenant_id", "rows");
    expect((all.data as unknown[]).length).toBe(1000);
    expect(all.count).toBe(1205);
    expect(((await db.from("reddit_keywords").select("term").eq("tenant_id", "rows").limit(5000)).data as unknown[]).length).toBe(1000);

    const page = (from: number, to: number) =>
      db.from("reddit_keywords").select("term").eq("tenant_id", "rows").order("term", { ascending: true }).range(from, to);
    const p2 = (await page(1000, 1999)).data as Array<{ term: string }>;
    expect(p2).toHaveLength(205);
    expect(p2[0].term).toBe("term 1000");
    const small = (await page(3, 4)).data as Array<{ term: string }>;
    expect(small.map((r) => r.term)).toEqual(["term 0003", "term 0004"]);
    expect(((await page(0, 4999)).data as unknown[]).length).toBe(1000);
  });

  it("deleting a keyword or competitor nulls it on reddit_mentions (ON DELETE SET NULL)", async () => {
    const { redditDb } = await import("../db");
    const db = redditDb();
    const set = (field_id: string, item: string) =>
      db
        .from("channel_settings")
        .insert({ tenant_id: "fk", channel_slug: "reddit_organic", field_id, item, status: "tracking" })
        .select("id")
        .single();
    const kw = (await set("keywords", "rent my car")).data as { id: string };
    const co = (await set("competitors", "Turo")).data as { id: string };
    await db.from("reddit_mentions").insert([
      { tenant_id: "fk", thread_id: "th1", term: "rent my car", kind: "keyword", keyword_id: kw.id },
      { tenant_id: "fk", thread_id: "th1", term: "Turo", kind: "competitor", competitor_id: co.id },
    ]);
    const read = async () =>
      (await db.from("reddit_mentions").select("term, keyword_id, competitor_id").eq("tenant_id", "fk").order("term")).data;

    await db.from("channel_settings").delete().eq("tenant_id", "fk").eq("id", kw.id);
    expect(await read()).toEqual([
      { term: "Turo", keyword_id: null, competitor_id: co.id },
      { term: "rent my car", keyword_id: null, competitor_id: null },
    ]);

    await db.from("channel_settings").delete().eq("tenant_id", "fk").eq("id", co.id);
    expect(await read()).toEqual([
      { term: "Turo", keyword_id: null, competitor_id: null },
      { term: "rent my car", keyword_id: null, competitor_id: null },
    ]);
  });

  it("refuses to run in production", async () => {
    const { redditLocalStoreEnabled } = await import("../db");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    expect(() => redditLocalStoreEnabled()).toThrow(/dev-only/);
    process.env.NODE_ENV = prev;
  });
});
