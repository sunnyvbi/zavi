import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner" as string,
  tierAllowed: true,
  writeOn: true,
  campaigns: {} as Record<string, Array<{ id: string; name: string; status: string | null }>>,
  listCalls: [] as Array<[string, string]>,
  pauseCalls: [] as Array<[string, string, string]>,
  runs: [] as Array<Record<string, any>>,
  actions: [] as Array<Record<string, any>>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, any> }>,
}));

vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountInUse: async () => true, linkedinAccountStoppable: async () => true }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: h.tierAllowed }) }));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", () => ({ isLinkedInAdsWriteEnabled: async () => h.writeOn }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  getLinkedInCampaign: async (tenant: string, account: string, campaign: string) => {
    h.listCalls.push([tenant, account]);
    return (h.campaigns[account] ?? []).find((c) => c.id === campaign) ?? null;
  },
}));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({
  pauseLinkedInCampaign: async (tenant: string, account: string, campaign: string) => {
    h.pauseCalls.push([tenant, account, campaign]);
  },
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: async () => null }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const source = () => (table === "channel_actions" ? h.actions : table === "agent_runs" ? h.runs : []);
    const b: any = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), b),
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: source().find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: source().filter((r) => filters.every((f) => f(r))), error: null }).then(ok, bad),
      insert: (row: Row) => ({
        select: async () => {
          if (table !== "agent_runs") throw new Error(`unexpected insert into ${table}`);
          const id = `run-${h.runs.length + 1}`;
          h.runs.push({ ...row, id });
          return { data: [{ id }], error: null };
        },
      }),
    };
    return b;
  };
  const tenantRpc = async (tid: string, name: string, args: Record<string, any>) => {
    h.rpcCalls.push({ name, args });
    if (name !== "record_channel_exec_action") throw new Error(`unexpected rpc ${name}`);
    const run = h.runs.find((r) => r.id === args.p_run_id);
    if (!run) return { data: { ok: false, code: "no_run" }, error: null };
    if (!run.channel_slug) return { data: { ok: false, code: "unstamped_run" }, error: null };
    const a = args.p_action;
    for (const r of h.actions) {
      if (r.channel_slug === run.channel_slug && r.exec_class === a.exec_class && ["pending", "snoozed"].includes(r.status) && r.exec_payload.campaign_id === a.exec_payload.campaign_id && r.exec_status == null) {
        r.status = "stale";
      }
    }
    const id = `action-${h.actions.length + 1}`;
    h.actions.push({ id, tenant_id: tid, channel_slug: run.channel_slug, run_id: run.id, status: "pending", exec_status: null, exec_result: null, ...a });
    return { data: { ok: true, id, replayed: false }, error: null };
  };
  return { ...real, tenantClient: () => ({ from: query }), tenantRpc };
});

import { linkedinFileCampaignDraft, linkedinProposePause } from "@/routes/channels/linkedin-ads";
import { executeLinkedInPause } from "@/services/connectors/linkedin-ads/execute-pause";

const TENANT = "tenant-a";
const CAMPAIGN = "507000111";
const ACCOUNT = "50999";

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

async function call(body: Record<string, unknown> = { account_id: ACCOUNT }, campaignId = CAMPAIGN) {
  const r = res();
  await linkedinProposePause({ params: { campaignId }, body } as never, r as never);
  return r;
}

const liveCards = () => h.actions.filter((a) => a.status === "pending");

beforeEach(() => {
  h.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "user-1" });
  h.role = "owner";
  h.tierAllowed = true;
  h.writeOn = true;
  h.campaigns = { [ACCOUNT]: [{ id: CAMPAIGN, name: "Q4 CFO retarget", status: "ACTIVE" }] };
  h.listCalls = [];
  h.pauseCalls = [];
  h.runs = [];
  h.actions = [];
  h.rpcCalls = [];
});

function expectNothingWritten() {
  expect(h.runs).toHaveLength(0);
  expect(h.actions).toHaveLength(0);
  expect(h.rpcCalls).toHaveLength(0);
}

describe("POST /api/channels/linkedin_ads/campaigns/:campaignId/propose-pause", () => {
  it("refuses a member with 403 before reading LinkedIn or writing anything", async () => {
    h.role = "member";
    const r = await call();
    expect(r.statusCode).toBe(403);
    expect(h.listCalls).toHaveLength(0);
    expectNothingWritten();
  });

  it("still files the pause after the plan drops LinkedIn Ads, because a pause only stops spend", async () => {
    h.tierAllowed = false;
    const r = await call();
    expect(r.statusCode).toBe(201);
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]).toMatchObject({ exec_class: "linkedin_ads.set_status", status: "pending", exec_payload: { campaign_id: CAMPAIGN, status: "PAUSED" } });
  });

  it("still refuses a member after the plan drops LinkedIn Ads", async () => {
    h.tierAllowed = false;
    h.role = "member";
    expect((await call()).statusCode).toBe(403);
    expectNothingWritten();
  });

  it("still refuses a new campaign draft after the plan drops LinkedIn Ads", async () => {
    h.tierAllowed = false;
    const r = res();
    await linkedinFileCampaignDraft({ params: {}, body: {} } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("channel_unavailable");
    expectNothingWritten();
  });

  it("still files the pause when LinkedIn Ads writes are switched off on the server, because a pause only stops spend", async () => {
    h.writeOn = false;
    const r = await call();
    expect(r.statusCode).toBe(201);
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]).toMatchObject({ exec_class: "linkedin_ads.set_status", status: "pending", exec_payload: { campaign_id: CAMPAIGN, status: "PAUSED" } });
    expect(h.pauseCalls).toHaveLength(0);
  });

  it("refuses a campaign LinkedIn reports as PAUSED, and files no card", async () => {
    h.campaigns[ACCOUNT][0].status = "PAUSED";
    const r = await call();
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("linkedin_ads_campaign_not_active");
    expect(h.listCalls).toEqual([[TENANT, ACCOUNT]]);
    expectNothingWritten();
  });

  it("refuses a campaign that is not in the named ad account, and files no card", async () => {
    h.campaigns = { "77777": [{ id: CAMPAIGN, name: "Other account", status: "ACTIVE" }] };
    const r = await call();
    expect(r.statusCode).toBe(404);
    expect(r.body.error.code).toBe("linkedin_ads_campaign_not_found");
    expectNothingWritten();
  });

  it("rejects a non-numeric campaign or account id before reading LinkedIn", async () => {
    expect((await call({ account_id: "abc" })).statusCode).toBe(400);
    expect((await call({ account_id: ACCOUNT }, "../1")).statusCode).toBe(400);
    expect(h.listCalls).toHaveLength(0);
    expectNothingWritten();
  });

  it("files exactly one linkedin_ads.set_status PAUSED card on a stamped linkedin_ads run, and the executor accepts its payload", async () => {
    const r = await call();
    expect(r.statusCode).toBe(201);
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.actions).toHaveLength(1);
    const card = h.actions[0];
    expect(r.body).toEqual({ action_id: card.id, campaign: { id: CAMPAIGN, name: "Q4 CFO retarget" } });
    expect(card.exec_class).toBe("linkedin_ads.set_status");
    expect(card.action_type).toBe("pause_ad");
    expect(card.channel_slug).toBe("linkedin_ads");
    expect(card.exec_payload).toMatchObject({ campaign_id: CAMPAIGN, account_id: ACCOUNT, status: "PAUSED", name: "Q4 CFO retarget" });
    expect(card.title).toBe('Pause the LinkedIn campaign "Q4 CFO retarget"');
    expect(card.body.exact_change.rows).toEqual([{ item: 'Campaign "Q4 CFO retarget"', before: "Active", after: "Paused" }]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ channel_slug: "linkedin_ads", status: "success", cost_usd: 0 });
    expect(card.run_id).toBe(h.runs[0].id);

    const out = await executeLinkedInPause({ tenant_id: TENANT, body: card.exec_payload });
    expect(out).toEqual({ ok: true, notice: 'Paused "Q4 CFO retarget" in LinkedIn Ads.' });
    expect(h.pauseCalls).toEqual([[TENANT, ACCOUNT, CAMPAIGN]]);
  });

  it("a crafted body asking for ACTIVE, another campaign or another name still files only PAUSED for the URL's campaign as LinkedIn names it", async () => {
    h.campaigns[ACCOUNT].push({ id: "999", name: "Other", status: "PAUSED" });
    const r = await call({ account_id: ACCOUNT, status: "ACTIVE", campaign_id: "999", name: "Injected", rationale: "x", exec_class: "linkedin_ads.create_campaign_bundle" });
    expect(r.statusCode).toBe(201);
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0].exec_class).toBe("linkedin_ads.set_status");
    expect(h.actions[0].exec_payload).toMatchObject({ campaign_id: CAMPAIGN, status: "PAUSED", name: "Q4 CFO retarget" });
    expect(JSON.stringify(h.actions[0].exec_payload)).not.toContain("Injected");
  });

  it("refuses a second ask while the first card is still waiting, and leaves the first card open", async () => {
    expect((await call()).statusCode).toBe(201);
    const first = h.actions[0].id;
    const r = await call();
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("linkedin_ads_pause_pending");
    expect(h.actions).toHaveLength(1);
    expect(liveCards().map((c) => c.id)).toEqual([first]);
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
  });

  it("refuses while an approved pause for the campaign is queued, which the store's own dedupe would not catch", async () => {
    h.actions.push({ id: "queued-1", channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", status: "acted", exec_status: "queued", exec_result: null, exec_payload: { campaign_id: CAMPAIGN, account_id: ACCOUNT, status: "PAUSED", name: "Q4 CFO retarget" } });
    const r = await call();
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("linkedin_ads_pause_pending");
    expect(h.actions).toHaveLength(1);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("does not block on a pause for another campaign, or on one that already ran", async () => {
    h.actions.push(
      { id: "other", channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", status: "pending", exec_status: null, exec_result: null, exec_payload: { campaign_id: "111", account_id: ACCOUNT, status: "PAUSED", name: "Other" } },
      { id: "done", channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", status: "acted", exec_status: "executed", exec_result: null, exec_payload: { campaign_id: CAMPAIGN, account_id: ACCOUNT, status: "PAUSED", name: "Q4 CFO retarget" } },
    );
    const r = await call();
    expect(r.statusCode).toBe(201);
    expect(h.actions.find((a) => a.id === "other")?.status).toBe("pending");
    expect(h.actions).toHaveLength(3);
  });
});
