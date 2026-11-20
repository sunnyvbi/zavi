import { beforeEach, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, failing: null as string | null, reads: [] as string[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const preds: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
      let sort: [string, boolean] | null = null;
      let window: [number, number] | null = null;
      const run = async () => {
        s.reads.push(table);
        if (s.failing === table) return { data: null, error: { message: "down" } };
        let rows = (s.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
        if (sort) { const [col, asc] = sort; rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)); }
        if (window) rows = rows.slice(window[0], window[1] + 1);
        return { data: rows, error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return q; },
        neq: (c: string, v: unknown) => { preds.push((r) => r[c] !== v); return q; },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return q; },
        order: (c: string, o: { ascending: boolean }) => { sort = [c, o.ascending]; return q; },
        range: (a: number, b: number) => { window = [a, b]; return run(); },
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => run().then(ok, bad),
      };
      return q;
    },
  }),
}));
import { autopilotLaunchedOwnBillingCampaigns } from "../consent";

const T = "tenant-a";
beforeEach(() => {
  s.failing = null; s.reads = [];
  s.tables = {
    ads_campaign_binding_details: [
      { tenant_id: T, id: "own-autopilot", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-founder", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-founder-relaunched", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-autopilot-uncertain", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-autopilot-refused", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "wallet-autopilot", platform: "linkedin", funding_source: "wallet" },
      { tenant_id: T, id: "chatgpt-autopilot", platform: "chatgpt", funding_source: "provider" },
      { tenant_id: "tenant-b", id: "other-tenant", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-channel-autopilot", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-channel-founder", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-channel-foreign-card", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "own-channel-founder-relaunched", platform: "linkedin", funding_source: "provider" },
      { tenant_id: T, id: "wallet-channel-autopilot", platform: "linkedin", funding_source: "wallet" },
    ],
    ads_campaign_operations: [
      { tenant_id: T, id: "d1", campaign_binding_id: "own-autopilot", kind: "activate", status: "succeeded", created_at: "2026-10-01" },
      { tenant_id: T, id: "p1", campaign_binding_id: "own-autopilot", kind: "pause", status: "succeeded", created_at: "2026-10-02" },
      { tenant_id: T, id: "d2", campaign_binding_id: "own-founder", kind: "activate", status: "succeeded", created_at: "2026-10-01" },
      { tenant_id: T, id: "d3", campaign_binding_id: "own-founder-relaunched", kind: "activate", status: "succeeded", created_at: "2026-10-01" },
      { tenant_id: T, id: "d4", campaign_binding_id: "own-founder-relaunched", kind: "activate", status: "succeeded", created_at: "2026-10-05" },
      { tenant_id: T, id: "d5", campaign_binding_id: "own-autopilot-uncertain", kind: "activate", status: "uncertain", created_at: "2026-10-03" },
      { tenant_id: T, id: "d6", campaign_binding_id: "own-autopilot-refused", kind: "activate", status: "refused", created_at: "2026-10-03" },
      { tenant_id: T, id: "d7", campaign_binding_id: "wallet-autopilot", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
      { tenant_id: T, id: "d8", campaign_binding_id: "chatgpt-autopilot", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
      { tenant_id: "tenant-b", id: "d9", campaign_binding_id: "other-tenant", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
      { tenant_id: T, id: "a1", campaign_binding_id: "own-channel-autopilot", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
      { tenant_id: T, id: "a2", campaign_binding_id: "own-channel-founder", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
      { tenant_id: T, id: "a3", campaign_binding_id: "own-channel-foreign-card", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
      { tenant_id: T, id: "a4", campaign_binding_id: "own-channel-founder-relaunched", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
      { tenant_id: T, id: "a5", campaign_binding_id: "own-channel-founder-relaunched", kind: "activate", status: "succeeded", created_at: "2026-10-06" },
      { tenant_id: T, id: "a6", campaign_binding_id: "wallet-channel-autopilot", kind: "activate", status: "succeeded", created_at: "2026-10-03" },
    ],
    decisions: [
      { tenant_id: T, id: "d1", approved_by_source: "cgo" },
      { tenant_id: T, id: "d2", approved_by_source: "founder" },
      { tenant_id: T, id: "d3", approved_by_source: "cgo" },
      { tenant_id: T, id: "d4", approved_by_source: "founder" },
      { tenant_id: T, id: "d5", approved_by_source: "cgo" },
      { tenant_id: T, id: "d6", approved_by_source: "cgo" },
      { tenant_id: T, id: "d7", approved_by_source: "cgo" },
      { tenant_id: T, id: "d8", approved_by_source: "cgo" },
      { tenant_id: "tenant-b", id: "d9", approved_by_source: "cgo" },
    ],
    channel_actions: [
      { tenant_id: T, id: "a1", approved_by_source: "cgo" },
      { tenant_id: T, id: "a2", approved_by_source: "founder" },
      { tenant_id: "tenant-b", id: "a3", approved_by_source: "cgo" },
      { tenant_id: T, id: "a4", approved_by_source: "cgo" },
      { tenant_id: T, id: "a5", approved_by_source: "founder" },
      { tenant_id: T, id: "a6", approved_by_source: "cgo" },
    ],
  };
});

it("names exactly the own-billing LinkedIn campaigns whose live launch Autopilot approved, including an unconfirmed one", async () => {
  expect((await autopilotLaunchedOwnBillingCampaigns(T)).sort()).toEqual(["own-autopilot", "own-autopilot-uncertain", "own-channel-autopilot"]);
});

it.each([
  ["decisions", "op-pending-d", { approved_by_source: "cgo" }],
  ["channel_actions", "op-pending-a", { approved_by_source: "cgo" }],
])("must catch (Review 7): an Autopilot launch still pending on the %s rail when consent is withdrawn is named, so its stop intent is recorded", async (table, id, row) => {
  s.tables.ads_campaign_binding_details!.push({ tenant_id: T, id: "own-inflight", platform: "linkedin", funding_source: "provider" });
  s.tables.ads_campaign_operations!.push({ tenant_id: T, id, campaign_binding_id: "own-inflight", kind: "activate", status: "pending", created_at: "2026-10-07" });
  s.tables[table]!.push({ tenant_id: T, id, ...row });
  expect(await autopilotLaunchedOwnBillingCampaigns(T)).toContain("own-inflight");
});

it("must not catch: a founder's relaunch still pending after Autopilot's launch is the founder's, and a refused newer attempt never hides the live older one", async () => {
  s.tables.ads_campaign_operations!.push({ tenant_id: T, id: "founder-pending", campaign_binding_id: "own-autopilot", kind: "activate", status: "pending", created_at: "2026-10-07" });
  s.tables.decisions!.push({ tenant_id: T, id: "founder-pending", approved_by_source: "founder" });
  expect(await autopilotLaunchedOwnBillingCampaigns(T)).not.toContain("own-autopilot");
  s.tables.ads_campaign_operations = s.tables.ads_campaign_operations!.filter((o) => o.id !== "founder-pending");
  s.tables.ads_campaign_operations.push({ tenant_id: T, id: "newer-refused", campaign_binding_id: "own-autopilot", kind: "activate", status: "refused", created_at: "2026-10-07" });
  s.tables.decisions!.push({ tenant_id: T, id: "newer-refused", approved_by_source: "founder" });
  expect(await autopilotLaunchedOwnBillingCampaigns(T)).toContain("own-autopilot");
});

it("must catch: a launch filed through channel_actions, whose operation id is the card id and is in no decisions row, is an Autopilot launch to stop", async () => {
  expect(s.tables.decisions!.some((d) => d.id === "a1")).toBe(false);
  expect(await autopilotLaunchedOwnBillingCampaigns(T)).toContain("own-channel-autopilot");
});

it("on the channel rail leaves a founder's card, a founder's later relaunch, a wallet campaign and another tenant's card alone", async () => {
  const ids = await autopilotLaunchedOwnBillingCampaigns(T);
  for (const id of ["own-channel-founder", "own-channel-founder-relaunched", "wallet-channel-autopilot", "own-channel-foreign-card"]) expect(ids).not.toContain(id);
});

it("leaves a campaign the founder relaunched after Autopilot alone, and never another tenant's campaign", async () => {
  const ids = await autopilotLaunchedOwnBillingCampaigns(T);
  expect(ids).not.toContain("own-founder-relaunched");
  expect(ids).not.toContain("other-tenant");
  expect(await autopilotLaunchedOwnBillingCampaigns("tenant-b")).toEqual(["other-tenant"]);
});

it.each(["ads_campaign_binding_details", "ads_campaign_operations", "decisions", "channel_actions"])("fails loudly, never answering an empty list, when %s cannot be read", async (table) => {
  s.failing = table;
  await expect(autopilotLaunchedOwnBillingCampaigns(T)).rejects.toThrow("could not be read");
});
