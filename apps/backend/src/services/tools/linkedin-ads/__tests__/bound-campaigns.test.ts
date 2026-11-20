import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const MIGRATIONS = join(__dirname, "../../../../../../../supabase/migrations");

function viewColumns(view: string): Set<string> | null {
  let body = "";
  for (const file of readdirSync(MIGRATIONS).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const re = new RegExp(`create (?:or replace )?view public\\.${view} as([\\s\\S]*?)\\bfrom\\b`, "gi");
    for (const m of sql.matchAll(re)) body = m[1];
  }
  if (!body) return null;
  return new Set(body.replace(/\bselect\b/i, "").split(",").map((c) => c.trim().split(/[.\s]/).pop()!));
}

const tables: Record<string, Array<Record<string, unknown>>> = {
  ads_campaign_binding_details: [
    { id: "c1", tenant_id: "t", account_binding_id: "b-managed", account_id: "a1", provider_campaign_id: "111", platform: "linkedin", funding_source: "wallet" },
    { id: "c2", tenant_id: "t", account_binding_id: "b-own", account_id: "a2", provider_campaign_id: "222", platform: "linkedin", funding_source: "provider" },
    { id: "c3", tenant_id: "t", account_binding_id: "b-gpt", account_id: "a3", provider_campaign_id: "333", platform: "chatgpt", funding_source: "wallet" },
  ],
  ads_account_binding_details: [
    { id: "b-managed", tenant_id: "t", provider_account_id: "900", platform: "linkedin", funding_source: "wallet" },
    { id: "b-own", tenant_id: "t", provider_account_id: "559880687", platform: "linkedin", funding_source: "provider" },
    { id: "b-gpt", tenant_id: "t", provider_account_id: "gpt", platform: "chatgpt", funding_source: "wallet" },
  ],
  ads_account_selections: [{ tenant_id: "t", platform: "linkedin", account_binding_id: "b-own" }],
  ads_account_binding_status: [],
};

function query(table: string) {
  const known = viewColumns(table);
  let rows = tables[table];
  let error: { message: string } | null = null;
  const q = {
    select(cols: string) {
      const missing = known ? cols.split(",").map((c) => c.trim()).filter((c) => !known.has(c)) : [];
      if (missing.length) error = { message: `column ${table}.${missing[0]} does not exist` };
      return q;
    },
    maybeSingle() { return Promise.resolve(error ? { data: null, error } : { data: rows[0] ?? null, error: null }); },
    eq(col: string, v: unknown) { rows = rows.filter((r) => r[col] === v); return q; },
    in(col: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[col])); return q; },
    order() { return q; },
    range() { return q; },
    then(resolve: (v: unknown) => void) { resolve(error ? { data: null, error } : { data: rows, error: null }); },
  };
  return q;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({ from: (t: string) => query(t) }),
}));

const reads = vi.hoisted(() => ({ calls: [] as string[], inFlight: 0, peak: 0, gate: false }));
vi.mock("@/services/ads-wallet/linkedin-launch", async (orig) => ({
  ...((await orig()) as object),
  linkedinLaunchSummary: async (_t: string, id: string) => {
    reads.calls.push(id);
    reads.inFlight += 1;
    reads.peak = Math.max(reads.peak, reads.inFlight);
    while (reads.gate) await new Promise((r) => setTimeout(r, 1));
    reads.inFlight -= 1;
    if (id === "c2") {
      const { ExpectedToolError } = await import("@/services/tools/types");
      throw new ExpectedToolError("ads_launch_conflict", "not finished");
    }
    return { name: "Pilot", status: "PAUSED", launch_blocker: null, daily_budget_cents: 1500, delivery: "in_review", delivery_note: "waiting on review" };
  },
}));

import { linkedinAdsBoundCampaigns } from "../propose_launch_campaign";
import type { ToolSpec } from "@/services/tools/types";

describe("linkedin_ads_bound_campaigns", () => {
  it("selects only columns the migrated views define and returns each campaign's provider account", async () => {
    const out = await linkedinAdsBoundCampaigns.execute(
      { tenant_id: "t" } as Parameters<ToolSpec["execute"]>[0],
      {},
    );
    expect(out).toEqual({
      campaigns: [
        { id: "c1", provider_campaign_id: "111", provider_account_id: "900", funding_source: "wallet", name: "Pilot", status: "PAUSED", launch_blocker: null, daily_budget_cents: 1500, delivery: "in_review", delivery_note: "waiting on review" },
        { id: "c2", provider_campaign_id: "222", provider_account_id: "559880687", funding_source: "provider", name: null, status: null, launch_blocker: "not finished", daily_budget_cents: null, delivery: "unread", delivery_note: expect.stringContaining("only if linkedin_ads_read_analytics shows spend") },
      ],
    });
  });
  it("reads at most 25 campaigns from LinkedIn, four at a time, and shows every other one as not read, never as gone or blocked", async () => {
    const saved = tables.ads_campaign_binding_details;
    tables.ads_campaign_binding_details = Array.from({ length: 999 }, (_, i) => ({ id: `r${i}`, tenant_id: "t", account_binding_id: "b-own", account_id: "a2", provider_campaign_id: String(1000 + i), platform: "linkedin", funding_source: "provider" }));
    reads.calls = [];
    reads.inFlight = 0;
    reads.peak = 0;
    reads.gate = true;
    const run = linkedinAdsBoundCampaigns.execute({ tenant_id: "t" } as Parameters<ToolSpec["execute"]>[0], {});
    await vi.waitFor(() => expect(reads.inFlight).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads.calls).toHaveLength(4);
    reads.gate = false;
    const out = (await run.finally(() => {
      tables.ads_campaign_binding_details = saved;
    })) as { campaigns: Array<Record<string, unknown>>; not_read_note: string };
    expect(reads.calls).toHaveLength(25);
    expect(new Set(reads.calls).size).toBe(25);
    expect(reads.peak).toBe(4);
    expect(out.campaigns).toHaveLength(999);
    expect(out.campaigns[24]).toMatchObject({ id: "r24", name: "Pilot", status: "PAUSED" });
    expect(out.campaigns[25]).toMatchObject({ id: "r25", provider_campaign_id: "1025", name: null, status: null, launch_blocker: null, delivery: "unread" });
    expect(out.not_read_note).toContain("first 25 of 999");
    expect(out.not_read_note).toContain("linkedin_ads_launch_review");
  });
  it("names no skipped campaigns when every one was read", async () => {
    const out = await linkedinAdsBoundCampaigns.execute({ tenant_id: "t" } as Parameters<ToolSpec["execute"]>[0], {});
    expect(out).not.toHaveProperty("not_read_note");
  });
});
