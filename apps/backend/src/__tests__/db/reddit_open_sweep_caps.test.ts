
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL ?? "";
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const RUN_FLAG = process.env.RUN_DB_TESTS_AGAINST_PROD === "1";
const IS_PROD_URL = /wmycgyjsenvgtczlupoe/.test(SUPA_URL);
const SHOULD_RUN = RUN_FLAG && IS_PROD_URL && !!SUPA_SERVICE;

const TENANT_ID = "73db45ff-457e-4541-bc8f-bdb625390204";
const MARKER_USER = "00000000-0000-4ded-8000-0000beef1701";

const JOBS = [{ key: "sub:startups", kind: "subreddit", term: "startups" }];

type Admission = {
  ok: boolean;
  reason?: string;
  sweep_id?: string;
  used_usd_7d?: number;
  cap_usd_7d?: number;
};

function svc(): SupabaseClient {
  return createClient(SUPA_URL, SUPA_SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function open(
  sb: SupabaseClient,
  est: number,
  caps: { tenant: number; fleet: number },
): Promise<Admission> {
  const { data, error } = await sb.rpc("reddit_open_sweep", {
    p_tenant_id: TENANT_ID,
    p_trigger: "manual",
    p_requested_by: MARKER_USER,
    p_jobs: JOBS,
    p_jobs_planned: JOBS.length,
    p_est_cost_usd: est,
    p_tenant_cap_usd_7d: caps.tenant,
    p_fleet_cap_usd_24h: caps.fleet,
  });
  if (error) throw new Error(`reddit_open_sweep failed: ${error.message}`);
  return data as Admission;
}

async function close(sb: SupabaseClient, sweepId: string, costUsd: number): Promise<void> {
  const { error } = await sb
    .from("reddit_sweeps")
    .update({ status: "complete", cost_usd: costUsd, finished_at: new Date().toISOString() })
    .eq("tenant_id", TENANT_ID)
    .eq("id", sweepId);
  if (error) throw new Error(`close failed: ${error.message}`);
}

async function clearMarkers(sb: SupabaseClient): Promise<void> {
  const { error } = await sb
    .from("reddit_sweeps")
    .delete()
    .eq("tenant_id", TENANT_ID)
    .eq("requested_by", MARKER_USER);
  if (error && error.code !== "PGRST116") throw new Error(`cleanup failed: ${error.message}`);
}

describe.skipIf(!SHOULD_RUN)(
  "reddit_open_sweep RPC — spend caps (PROD-gated, runs on RUN_DB_TESTS_AGAINST_PROD=1 + prod SUPABASE_URL)",
  () => {
    beforeEach(async () => {
      await clearMarkers(svc());
    });

    afterAll(async () => {
      await clearMarkers(svc());
    });

    it("refuses a second sweep while one is running", async () => {
      const sb = svc();
      const first = await open(sb, 0.01, { tenant: 100, fleet: 10_000 });
      expect(first.ok).toBe(true);
      const second = await open(sb, 0.01, { tenant: 100, fleet: 10_000 });
      expect(second).toMatchObject({ ok: false, reason: "already_running" });
      await close(sb, String(first.sweep_id), 0.01);
    });

    it("refuses a sweep that would cross the 7-day tenant cap, and counts recorded cost", async () => {
      const sb = svc();
      const spent = await open(sb, 0.9, { tenant: 1, fleet: 10_000 });
      expect(spent.ok).toBe(true);
      await close(sb, String(spent.sweep_id), 0.9);

      const over = await open(sb, 0.2, { tenant: 1, fleet: 10_000 });
      expect(over).toMatchObject({ ok: false, reason: "tenant_cap_reached" });
      expect(Number(over.used_usd_7d)).toBeCloseTo(0.9, 4);

      const under = await open(sb, 0.05, { tenant: 1, fleet: 10_000 });
      expect(under.ok).toBe(true);
      await close(sb, String(under.sweep_id), 0.05);
    });

    it("refuses when the fleet 24h cap is already committed, whatever the tenant cap allows", async () => {
      const sb = svc();
      const blocked = await open(sb, 0.01, { tenant: 100, fleet: 0 });
      expect(blocked).toMatchObject({ ok: false, reason: "fleet_cap_reached" });
    });

    it("refuses a sweep with no jobs before it charges anything", async () => {
      const sb = svc();
      const { data, error } = await sb.rpc("reddit_open_sweep", {
        p_tenant_id: TENANT_ID,
        p_trigger: "manual",
        p_requested_by: MARKER_USER,
        p_jobs: [],
        p_jobs_planned: 0,
        p_est_cost_usd: 0,
        p_tenant_cap_usd_7d: 100,
        p_fleet_cap_usd_24h: 10_000,
      });
      if (error) throw new Error(error.message);
      expect(data as Admission).toMatchObject({ ok: false, reason: "nothing_to_scan" });
    });
  },
);
