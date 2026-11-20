import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;
const DAY = 86_400_000;

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner" as string,
  tierAllowed: true,
  live: null as Record<string, unknown> | null,
  readCalls: [] as Array<[string, string, string]>,
  resumeCalls: [] as Array<[string, string, string, unknown]>,
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
vi.mock("@/services/channels/lock", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isChannelLockedStrict: async () => false }));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({
  readLinkedInRawCampaign: async (tenant: string, account: string, campaign: string) => {
    h.readCalls.push([tenant, account, campaign]);
    return h.live && String(h.live.account) === `urn:li:sponsoredAccount:${account}` && String(h.live.id) === campaign ? h.live : null;
  },
  resumeLinkedInCampaign: async (tenant: string, account: string, campaign: string, schedule: unknown) => {
    h.resumeCalls.push([tenant, account, campaign, schedule]);
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
    const id = `action-${h.actions.length + 1}`;
    h.actions.push({ id, tenant_id: tid, channel_slug: run.channel_slug, run_id: run.id, status: "pending", exec_status: null, exec_result: null, ...a });
    return { data: { ok: true, id, replayed: false }, error: null };
  };
  return { ...real, tenantClient: () => ({ from: query }), tenantRpc };
});

import { linkedinProposeResume } from "@/routes/channels/linkedin-ads";
import { executeLinkedInResume } from "@/services/connectors/linkedin-ads/execute-change";
import { channelApproveNeedsAdmin } from "@/services/channels/approve-needs-admin";

const TENANT = "tenant-a";
const CAMPAIGN = "507000111";
const ACCOUNT = "50999";
const START = Date.now() - 40 * DAY;

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
  await linkedinProposeResume({ params: { campaignId }, body } as never, r as never);
  return r;
}

beforeEach(() => {
  h.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "user-1" });
  h.role = "owner";
  h.tierAllowed = true;
  h.live = { id: CAMPAIGN, account: `urn:li:sponsoredAccount:${ACCOUNT}`, name: "Q4 CFO retarget", status: "PAUSED", dailyBudget: { amount: "40", currencyCode: "USD" }, runSchedule: { start: START, end: Date.now() + 30 * DAY } };
  h.readCalls = [];
  h.resumeCalls = [];
  h.runs = [];
  h.actions = [];
  h.rpcCalls = [];
});

function expectNothingWritten() {
  expect(h.runs).toHaveLength(0);
  expect(h.actions).toHaveLength(0);
  expect(h.rpcCalls).toHaveLength(0);
}

describe("POST /api/channels/linkedin_ads/campaigns/:campaignId/propose-resume", () => {
  it("refuses a member with 403 before reading LinkedIn or writing anything", async () => {
    h.role = "member";
    expect((await call()).statusCode).toBe(403);
    expect(h.readCalls).toHaveLength(0);
    expectNothingWritten();
  });

  it("refuses once the plan drops LinkedIn Ads, because a restart spends again", async () => {
    h.tierAllowed = false;
    const r = await call();
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("channel_unavailable");
    expectNothingWritten();
  });

  it("refuses a campaign LinkedIn reports as ACTIVE, and files no card", async () => {
    h.live!.status = "ACTIVE";
    const r = await call();
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("linkedin_ads_campaign_active");
    expectNothingWritten();
  });

  it("refuses a draft, archived or canceled campaign, which only a launch can start", async () => {
    for (const status of ["DRAFT", "ARCHIVED", "CANCELED"]) {
      h.live!.status = status;
      const r = await call();
      expect(r.statusCode).toBe(409);
      expect(r.body.error.code).toBe("linkedin_ads_campaign_not_restartable");
    }
    expectNothingWritten();
  });

  it("refuses a campaign that is not in the named ad account, and files no card", async () => {
    h.live!.account = "urn:li:sponsoredAccount:77777";
    const r = await call();
    expect(r.statusCode).toBe(404);
    expect(r.body.error.code).toBe("linkedin_ads_campaign_not_found");
    expectNothingWritten();
  });

  it("rejects a non-numeric id or a malformed run_until before reading LinkedIn", async () => {
    expect((await call({ account_id: "abc" })).statusCode).toBe(400);
    expect((await call({ account_id: ACCOUNT }, "../1")).statusCode).toBe(400);
    expect((await call({ account_id: ACCOUNT, run_until: "next month" })).statusCode).toBe(400);
    expect(h.readCalls).toHaveLength(0);
    expectNothingWritten();
  });

  it("files one owner-only linkedin_ads.resume_campaign card for a paused campaign, and the executor restarts it from that payload", async () => {
    const r = await call();
    expect(r.statusCode).toBe(201);
    expect(h.actions).toHaveLength(1);
    const card = h.actions[0];
    expect(r.body).toEqual({ action_id: card.id, campaign: { id: CAMPAIGN, name: "Q4 CFO retarget", was: "PAUSED", run_until: new Date((h.live!.runSchedule as { end: number }).end).toISOString() } });
    expect(card.exec_class).toBe("linkedin_ads.resume_campaign");
    expect(card.action_type).toBe("update_ad");
    expect(card.channel_slug).toBe("linkedin_ads");
    expect(card.title).toBe('Restart the LinkedIn campaign "Q4 CFO retarget"');
    expect(card.exec_payload).toMatchObject({ campaign_id: CAMPAIGN, account_id: ACCOUNT, expected_status: "PAUSED", budget: { kind: "daily", amount: "40", currency: "USD" } });
    expect(card.body.exact_change.rows[0]).toEqual({ item: 'Campaign "Q4 CFO retarget"', before: "Paused", after: "Active" });
    expect(channelApproveNeedsAdmin(card.exec_class, card.exec_payload)).toBe(true);
    expect(h.runs[0]).toMatchObject({ channel_slug: "linkedin_ads", status: "success", cost_usd: 0, payload: { stage: "linkedin_ads_founder_resume" } });
    expect(card.run_id).toBe(h.runs[0].id);
    expect(h.resumeCalls).toHaveLength(0);

    const out = await executeLinkedInResume({ tenant_id: TENANT, body: card.exec_payload });
    expect(out).toEqual({ ok: true, notice: 'Restarted "Q4 CFO retarget" in LinkedIn Ads.' });
    expect(h.resumeCalls).toEqual([[TENANT, ACCOUNT, CAMPAIGN, undefined]]);
  });

  it("a completed campaign gets a new end date 30 days out when the page sends none, and the card says so", async () => {
    h.live = { ...h.live!, status: "COMPLETED", runSchedule: { start: START, end: Date.now() - 2 * DAY } };
    const r = await call();
    expect(r.statusCode).toBe(201);
    const expected = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    expect(r.body.campaign).toMatchObject({ was: "COMPLETED", run_until: `${expected}T23:59:59.000Z` });
    const card = h.actions[0];
    expect(card.exec_payload).toMatchObject({ expected_status: "COMPLETED", run_start_at: new Date(START).toISOString(), run_end_at: `${expected}T23:59:59.000Z` });
    const endRow = card.body.exact_change.rows.find((r: { item: string }) => r.item === "End date");
    expect(endRow.before).toBe("Already passed");
    expect(endRow.after).toBe(`${new Date(`${expected}T23:59:59.000Z`).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} UTC`);
    const out = await executeLinkedInResume({ tenant_id: TENANT, body: card.exec_payload });
    expect(out).toMatchObject({ ok: true });
    expect(h.resumeCalls[0][3]).toEqual({ start: START, end: Date.parse(`${expected}T23:59:59.000Z`) });
  });

  it("honours a run_until the page sends for a completed campaign, and refuses one that has passed", async () => {
    h.live = { ...h.live!, status: "COMPLETED", runSchedule: { start: START, end: Date.now() - 2 * DAY } };
    const passed = await call({ account_id: ACCOUNT, run_until: "2020-01-01" });
    expect(passed.statusCode).toBe(422);
    expect(passed.body.error.code).toBe("linkedin_ads_end_date_passed");
    expectNothingWritten();
    const r = await call({ account_id: ACCOUNT, run_until: "2099-02-28" });
    expect(r.statusCode).toBe(201);
    expect(h.actions[0].exec_payload.run_end_at).toBe("2099-02-28T23:59:59.000Z");
  });

  it("a crafted body cannot change the class, the campaign, the name or the rationale on the card", async () => {
    const r = await call({ account_id: ACCOUNT, campaign_id: "999", name: "Injected", rationale: "Injected", exec_class: "linkedin_ads.create_campaign_bundle", expected_status: "ACTIVE" });
    expect(r.statusCode).toBe(201);
    expect(h.actions[0].exec_class).toBe("linkedin_ads.resume_campaign");
    expect(h.actions[0].exec_payload).toMatchObject({ campaign_id: CAMPAIGN, name: "Q4 CFO retarget", expected_status: "PAUSED" });
    expect(JSON.stringify(h.actions[0])).not.toContain("Injected");
  });

  it("refuses a second ask while the first restart card is still waiting or queued, but not for another campaign or one that already ran", async () => {
    expect((await call()).statusCode).toBe(201);
    const r = await call();
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("linkedin_ads_resume_pending");
    expect(h.actions).toHaveLength(1);
    h.actions[0].status = "acted";
    h.actions[0].exec_status = "queued";
    expect((await call()).body.error.code).toBe("linkedin_ads_resume_pending");
    h.actions[0].exec_status = "executed";
    h.actions.push({ id: "other", channel_slug: "linkedin_ads", exec_class: "linkedin_ads.resume_campaign", status: "pending", exec_status: null, exec_result: null, exec_payload: { campaign_id: "111", account_id: ACCOUNT } });
    h.actions.push({ id: "pause", channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", status: "pending", exec_status: null, exec_result: null, exec_payload: { campaign_id: CAMPAIGN, account_id: ACCOUNT, status: "PAUSED" } });
    expect((await call()).statusCode).toBe(201);
    expect(h.actions).toHaveLength(4);
  });
});
