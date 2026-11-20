
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL ?? "";
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const RUN_FLAG = process.env.RUN_DB_TESTS_AGAINST_PROD === "1";
const IS_PROD_URL = /wmycgyjsenvgtczlupoe/.test(SUPA_URL);
const SHOULD_RUN = RUN_FLAG && IS_PROD_URL && !!SUPA_SERVICE;

const TENANT_ID = "73db45ff-457e-4541-bc8f-bdb625390204";

function svc(): SupabaseClient {
  return createClient(SUPA_URL, SUPA_SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function clearSameDayLedger(sb: SupabaseClient): Promise<void> {
  const { error } = await sb
    .from("slack_summary_budget_ledger")
    .delete()
    .eq("tenant_id", TENANT_ID)
    .eq("day", today());
  if (error && error.code !== "PGRST116") {
    throw new Error(`pre-cleanup failed: ${error.message}`);
  }
}

describe.skipIf(!SHOULD_RUN)(
  "slack_summary_budget_increment RPC . atomicity (PROD-gated, runs on RUN_DB_TESTS_AGAINST_PROD=1 + prod SUPABASE_URL)",
  () => {
    beforeEach(async () => {
      await clearSameDayLedger(svc());
    });

    afterAll(async () => {
      await clearSameDayLedger(svc());
    });

    it("atomicity under parallel calls . first 30c wins, second 30c trips cap=50c", async () => {
      const sb = svc();
      const cap = 50;
      const [r1, r2] = await Promise.all([
        sb.rpc("slack_summary_budget_increment", {
          p_tenant_id: TENANT_ID,
          p_cents: 30,
          p_cap_cents: cap,
        }),
        sb.rpc("slack_summary_budget_increment", {
          p_tenant_id: TENANT_ID,
          p_cents: 30,
          p_cap_cents: cap,
        }),
      ]);

      expect(r1.error).toBeNull();
      expect(r2.error).toBeNull();

      const row1 = Array.isArray(r1.data) ? r1.data[0] : r1.data;
      const row2 = Array.isArray(r2.data) ? r2.data[0] : r2.data;

      const overs = [row1.over, row2.over].sort();
      expect(overs).toEqual([false, true]);

      const winner = row1.over === false ? row1 : row2;
      const loser = row1.over === false ? row2 : row1;
      expect(winner.new_cents).toBe(30);
      expect(loser.new_cents).toBe(30);

      const { data: ledger, error: lErr } = await sb
        .from("slack_summary_budget_ledger")
        .select("cents, count")
        .eq("tenant_id", TENANT_ID)
        .eq("day", today())
        .maybeSingle();
      expect(lErr).toBeNull();
      expect(ledger?.cents).toBe(30);
      expect(ledger?.count).toBe(1);
    });

    it("atomicity under 3-way race at the boundary . 2 winners at 20c each = 40c, 3rd trips cap=50", async () => {
      const sb = svc();
      const cap = 50;
      const results = await Promise.all([
        sb.rpc("slack_summary_budget_increment", {
          p_tenant_id: TENANT_ID,
          p_cents: 20,
          p_cap_cents: cap,
        }),
        sb.rpc("slack_summary_budget_increment", {
          p_tenant_id: TENANT_ID,
          p_cents: 20,
          p_cap_cents: cap,
        }),
        sb.rpc("slack_summary_budget_increment", {
          p_tenant_id: TENANT_ID,
          p_cents: 20,
          p_cap_cents: cap,
        }),
      ]);

      for (const r of results) {
        expect(r.error).toBeNull();
      }

      const rows = results.map((r) =>
        Array.isArray(r.data) ? r.data[0] : r.data,
      );
      const overCount = rows.filter((row) => row.over === true).length;
      const okCount = rows.filter((row) => row.over === false).length;

      expect(okCount).toBe(2);
      expect(overCount).toBe(1);

      const { data: ledger, error: lErr } = await sb
        .from("slack_summary_budget_ledger")
        .select("cents, count")
        .eq("tenant_id", TENANT_ID)
        .eq("day", today())
        .maybeSingle();
      expect(lErr).toBeNull();
      expect(ledger?.cents).toBe(40);
      expect(ledger?.count).toBe(2);
    });
  },
);
