import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  A: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  B: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  MANAGED: "900",
  CAMPAIGN_B: "222",
  GROUP_B: "42",
  AD_B: "7002",
  STAMP: Date.UTC(2026, 10, 1, 9, 30, 0),
  tenant: "" as string,
  tables: {} as Record<string, Row[]>,
  reads: [] as string[],
  tokenUses: [] as string[],
  writes: [] as unknown[],
  runs: [] as Row[],
  actions: [] as Row[],
}));

function chain(rows: Row[]) {
  const filters: Array<(r: Row) => boolean> = [];
  const q: Row = {
    select: () => q,
    order: () => q,
    limit: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    range: async () => ({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(ok, bad),
    insert: (row: Row) => ({
      select: async () => {
        const id = `run-${h.runs.length + 1}`;
        h.runs.push({ ...row, id });
        return { data: [{ id }], error: null };
      },
    }),
  };
  return q;
}

vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => ({ tenant_id: h.tenant, user_id: "user-1" }) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true }) }));
vi.mock("@/services/channels/lock", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isChannelLockedStrict: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withLinkedInAdsToken: async (tenant: string, call: (token: string) => Promise<unknown>) => {
    h.tokenUses.push(tenant);
    return call("founder-token");
  },
  getLinkedInCampaign: async (tenant: string, account: string, campaign: string) => {
    h.reads.push(`campaign:${tenant}:${account}:${campaign}`);
    return { id: campaign, name: "B's secret campaign", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: h.GROUP_B };
  },
}));
vi.mock("@/services/connectors/linkedin-ads/write", () => {
  const { MANAGED, CAMPAIGN_B, GROUP_B, AD_B, STAMP } = h;
  const campaign = { id: CAMPAIGN_B, account: `urn:li:sponsoredAccount:${MANAGED}`, name: "B's secret campaign", status: "PAUSED", changeAuditStamps: { lastModified: { time: STAMP } } };
  const group = { id: GROUP_B, account: `urn:li:sponsoredAccount:${MANAGED}`, name: "B's secret group", status: "ACTIVE", backfilled: false, changeAuditStamps: { lastModified: { time: STAMP } } };
  const creative = { creative_id: AD_B, id: `urn:li:sponsoredCreative:${AD_B}`, campaign: `urn:li:sponsoredCampaign:${CAMPAIGN_B}`, name: "B's secret ad", intendedStatus: "ACTIVE" };
  return {
    readLinkedInRawCampaign: async (tenant: string, account: string, id: string) => (h.reads.push(`campaign:${tenant}:${account}:${id}`), campaign),
    readLinkedInRawCampaignGroup: async (tenant: string, account: string, id: string) => (h.reads.push(`group:${tenant}:${account}:${id}`), group),
    listLinkedInRawCampaignsInGroupWithToken: async (_t: string, account: string, id: string) => (h.reads.push(`group-campaigns:${account}:${id}`), [campaign]),
    listLinkedInRawCreativesWithToken: async (_t: string, account: string, id: string) => (h.reads.push(`creatives:${account}:${id}`), [creative]),
    setLinkedInCreativeStatusWithToken: async (...args: unknown[]) => void h.writes.push(["ad-status", ...args]),
    archiveLinkedInEntityWithToken: async (...args: unknown[]) => void h.writes.push(["archive", ...args]),
    patchLinkedInCampaignGroupWithToken: async (...args: unknown[]) => void h.writes.push(["group-patch", ...args]),
    pauseLinkedInCampaign: async (...args: unknown[]) => void h.writes.push(["pause", ...args]),
  };
});
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({
  requestLinkedinPause: async (...args: unknown[]) => (h.writes.push(["wallet-pause", ...args]), { state: "paused" }),
  goneLinkedinCampaignIds: async () => new Set<string>(),
}));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const source = (table: string) => (table === "channel_actions" ? h.actions : table === "agent_runs" ? h.runs : (h.tables[table] ?? []));
  const tenantRpc = async (tid: string, name: string, args: Row) => {
    if (name !== "record_channel_exec_action") throw new Error(`unexpected rpc ${name}`);
    const run = h.runs.find((r) => r.id === args.p_run_id);
    if (!run) return { data: { ok: false, code: "no_run" }, error: null };
    const id = `action-${h.actions.length + 1}`;
    h.actions.push({ id, tenant_id: tid, channel_slug: run.channel_slug, run_id: run.id, status: "pending", exec_status: null, exec_result: null, ...args.p_action });
    return { data: { ok: true, id, replayed: false }, error: null };
  };
  return {
    ...real,
    asTenantId: (t: string) => t,
    globalClient: () => ({ from: (t: string) => chain(source(t)) }),
    tenantClient: (tenant: string) => ({ from: (t: string) => chain(source(t).filter((r) => !("tenant_id" in r) || r.tenant_id === tenant)) }),
    tenantRpc,
  };
});

import {
  linkedinProposeAdStatus,
  linkedinProposeArchive,
  linkedinProposeCampaignDuplicate,
  linkedinProposeGroupDuplicate,
  linkedinProposeGroupStatus,
  linkedinProposePause,
} from "@/routes/channels/linkedin-ads";
import { executeLinkedInAdStatus, executeLinkedInArchive, executeLinkedInGroupEdit } from "@/services/connectors/linkedin-ads/execute-cards";
import { executeLinkedInPause } from "@/services/connectors/linkedin-ads/execute-pause";

const { A, B, MANAGED, CAMPAIGN_B, GROUP_B, AD_B, STAMP } = h;

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}
type Handler = (req: never, res: never) => Promise<void>;
async function call(handler: Handler, params: Row, body: Row) {
  const r = res();
  await handler({ params, body } as never, r as never);
  return r;
}

const accountBinding = (tenant_id: string, id: string) => ({ id, tenant_id, account_id: `acct-${id}`, platform: "linkedin", provider_account_id: MANAGED, currency: "USD", credential_source: "platform", credential_ref: "linkedin_ads_managed_main", credential_tenant_id: null, funding_source: "wallet", legacy_key: null });
const campaignBinding = (tenant_id: string, id: string, account_binding_id: string, provider_campaign_id: string) => ({ id, tenant_id, account_binding_id, account_id: `acct-${account_binding_id}`, platform: "linkedin", provider_campaign_id, funding_source: "wallet" });

beforeEach(() => {
  h.tenant = A;
  h.reads = [];
  h.tokenUses = [];
  h.writes = [];
  h.runs = [];
  h.actions = [];
  h.tables = {
    ads_provider_accounts: [{ platform: "linkedin", provider_account_id: MANAGED, credential_source: "platform", credential_tenant_id: null, claim_released_at: null }],
    ads_account_binding_details: [accountBinding(A, "ab-A"), accountBinding(B, "ab-B")],
    ads_campaign_binding_details: [campaignBinding(A, "cb-A", "ab-A", "111"), campaignBinding(B, "cb-B", "ab-B", CAMPAIGN_B)],
    ads_account_selections: [],
    ads_account_binding_status: [],
    ads_campaign_operations: [],
  };
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

function nothingTouched() {
  expect(h.reads).toEqual([]);
  expect(h.tokenUses).toEqual([]);
  expect(h.writes).toEqual([]);
  expect(h.runs).toEqual([]);
  expect(h.actions).toEqual([]);
}

describe("workspace A asks for founder cards on workspace B's campaign in the shared Zavi-managed LinkedIn account", () => {
  const cases: Array<[string, () => Promise<ReturnType<typeof res>>]> = [
    ["pause", () => call(linkedinProposePause, { campaignId: CAMPAIGN_B }, { account_id: MANAGED })],
    ["archive", () => call(linkedinProposeArchive, { campaignId: CAMPAIGN_B }, { account_id: MANAGED })],
    ["group status", () => call(linkedinProposeGroupStatus, { groupId: GROUP_B }, { account_id: MANAGED, status: "PAUSED" })],
    ["ad status", () => call(linkedinProposeAdStatus, { creativeId: AD_B }, { account_id: MANAGED, campaign_id: CAMPAIGN_B, status: "PAUSED" })],
    ["campaign copy", () => call(linkedinProposeCampaignDuplicate, { campaignId: CAMPAIGN_B }, { account_id: MANAGED })],
    ["group copy", () => call(linkedinProposeGroupDuplicate, { groupId: GROUP_B }, { account_id: MANAGED })],
  ];
  for (const [name, run] of cases) {
    it(`must catch: ${name} is refused as an account A does not use; nothing is read from LinkedIn and no card is filed`, async () => {
      const r = await run();
      expect(r.body.error.code).toBe("linkedin_ads_account_not_in_use");
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.body)).not.toMatch(/secret|B's/);
      nothingTouched();
    });
  }

  it("must catch: B itself cannot file founder cards on its managed campaign either, so the founder-card door never opens on the shared account", async () => {
    h.tenant = B;
    const archive = await call(linkedinProposeArchive, { campaignId: CAMPAIGN_B }, { account_id: MANAGED });
    expect(["linkedin_ads_wallet_campaign", "linkedin_ads_account_not_in_use"]).toContain(archive.body.error.code);
    const pause = await call(linkedinProposePause, { campaignId: CAMPAIGN_B }, { account_id: MANAGED });
    expect(pause.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.writes).toEqual([]);
    expect(h.actions).toEqual([]);
  });
});

describe("an approved card in workspace A whose frozen payload names B's campaign on the shared account", () => {
  it("must catch: pause, archive, group edit and ad status all refuse at execution; LinkedIn is never read or written", async () => {
    const pause = await executeLinkedInPause({ tenant_id: A, id: "card-1", body: { campaign_id: CAMPAIGN_B, account_id: MANAGED, status: "PAUSED", name: "B's secret campaign" } });
    expect(pause).toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    const archive = await executeLinkedInArchive({ tenant_id: A, body: { target: "campaign", id: CAMPAIGN_B, account_id: MANAGED, campaign_id: null, name: "B's secret campaign", expected_status: "PAUSED", mode: "archive", rationale: "A wants it gone" } });
    expect(archive).toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    const group = await executeLinkedInGroupEdit({ tenant_id: A, body: { group_id: GROUP_B, account_id: MANAGED, name: "B's secret group", rationale: "A wants it paused", last_modified_at: new Date(STAMP).toISOString(), changes: { status: { before: "ACTIVE", after: "PAUSED" } } } });
    expect(group).toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    const ad = await executeLinkedInAdStatus({ tenant_id: A, body: { creative_id: AD_B, campaign_id: CAMPAIGN_B, account_id: MANAGED, campaign_name: "B's secret campaign", ad_name: "B's secret ad", expected_status: "ACTIVE", status: "PAUSED", rationale: "A wants it off" } });
    expect(ad).toMatchObject({ ok: false, code: "linkedin_ads_account_not_in_use" });
    expect(h.reads).toEqual([]);
    expect(h.tokenUses).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("must catch: B's own approved pause of its managed campaign goes through the wallet adapter under B, never through a founder login", async () => {
    const pause = await executeLinkedInPause({ tenant_id: B, id: "card-2", body: { campaign_id: CAMPAIGN_B, account_id: MANAGED, status: "PAUSED", name: "B's campaign" } });
    expect(pause.ok).toBe(true);
    expect(h.writes).toEqual([["wallet-pause", B, "cb-B"]]);
    expect(h.tokenUses).toEqual([]);
  });
});
