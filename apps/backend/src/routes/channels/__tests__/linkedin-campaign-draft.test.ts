import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner" as string,
  tierAllowed: true,
  writeOn: true,
  runs: [] as Array<Record<string, any>>,
  actions: [] as Array<Record<string, any>>,
  tenants: [] as Array<Record<string, any>>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, any> }>,
  failRecord: false,
  locked: false as boolean | "unreadable",
  lockReads: 0,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: h.tierAllowed }) }));
vi.mock("@/services/channels/lock", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: async (slug: string) => {
    h.lockReads += 1;
    if (h.locked === "unreadable") throw new Error("channel lock config unavailable");
    return slug === "linkedin_ads" && h.locked;
  },
}));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", () => ({ isLinkedInAdsWriteEnabled: async () => h.writeOn }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/analytics/action-events", () => ({ trackChannelActionProposed: () => undefined }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  listLinkedInAdAccounts: async () => [{ id: "50999", name: "Acme Ads", currency: "USD", status: "ACTIVE" }],
  listLinkedInAdAccountsWithReference: async () => [{ id: "50999", name: "Acme Ads", currency: "USD", status: "ACTIVE", reference: "urn:li:organization:777" }],
  withLinkedInAdsToken: async (_tenant: string, call: (token: string) => Promise<unknown>) => call("tok"),
  linkedinAdsToken: async () => "tok",
}));
vi.mock("@/services/ads-wallet/accounts", () => ({
  accountChoices: async () => ({
    accounts: [{ id: "10000000-0000-4000-8000-000000000001", provider_account_id: "50999", funding_source: "provider", currency: "USD", disabled: false }],
    managed: [],
    selected_id: "10000000-0000-4000-8000-000000000001",
  }),
  connectCustomerAccount: async () => "10000000-0000-4000-8000-000000000001",
  assertAccountAvailableForNewCampaign: async () => undefined,
}));
vi.mock("@/services/connectors/linkedin-ads/targeting", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/linkedin-ads/targeting")>()),
  linkedinTargetingToken: async () => "tok",
  resolveLinkedinLocationNames: async (_token: string, names: string[]) => ({
    found: names.filter((n) => n === "United States").map((name) => ({ id: "urn:li:geo:103644278", name })),
    missed: names.filter((n) => n !== "United States"),
  }),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: async () => null, findCampaignBinding: async () => null }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: async () => ({ account: null }) }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const source = () => (table === "channel_actions" ? h.actions : table === "agent_runs" ? h.runs : table === "tenants" ? h.tenants : []);
    const rows = () => source().filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      neq: (col: string, v: unknown) => (filters.push((r) => r[col] !== v), b),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), b),
      is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), b),
      not: (col: string, op: string, v: unknown) => (filters.push((r) => (op === "is" ? (r[col] ?? null) !== v : true)), b),
      gte: () => b,
      lte: () => b,
      gt: () => b,
      lt: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok, bad),
      insert: (row: Row) => ({
        select: async () => {
          if (table !== "agent_runs") throw new Error(`unexpected insert into ${table}`);
          const id = randomUUID();
          h.runs.push({ ...row, id });
          return { data: [{ id }], error: null };
        },
      }),
    };
    return b;
  };
  const tenantRpc = async (tid: string, name: string, args: Record<string, any>) => {
    h.rpcCalls.push({ name, args });
    if (name === "record_channel_run_actions") {
      if (h.failRecord) return { data: null, error: { message: "boom" } };
      const run = h.runs.find((r) => r.id === args.p_run_id);
      if (!run) return { data: { inserted: 0, skipped_reason: "no_run" }, error: null };
      if (!run.channel_slug) return { data: { inserted: 0, skipped_reason: "unstamped_run" }, error: null };
      for (const flag of args.p_stale ?? []) {
        const open = h.actions.find((r) => r.id === flag.action_id && r.status === "pending" && r.exec_class == null && r.edited_body == null && !r.steps_done?.length);
        if (open) open.status = "stale";
      }
      const ids: Array<{ position: number; id: string }> = [];
      for (const a of args.p_actions.slice(0, 20)) {
        if (!String(a.title ?? "").trim()) continue;
        const id = randomUUID();
        h.actions.push({
          id, tenant_id: tid, run_id: run.id, channel_slug: run.channel_slug, position: a.position, title: a.title, title_key: a.title_key,
          body: a.body, action_type: a.action_type, card_kind: a.card_kind, target_key: a.target_key, status: "pending",
          exec_class: null, exec_status: null, exec_payload: null, edited_body: null, steps_done: [], approved_by: null,
          proposed_at: new Date().toISOString(),
        });
        ids.push({ position: a.position, id });
      }
      return { data: { inserted: ids.length, ids }, error: null };
    }
    if (name === "prepare_channel_campaign_action") {
      const row = h.actions.find((r) => r.id === args.p_action_id);
      const ok = !!row && row.status === "pending" && row.exec_status == null && row.exec_class == null
        && JSON.stringify(row.body) === JSON.stringify(args.p_expected_body)
        && row.body?.step?.responsibility === "client"
        && row.body?.step?.deliverable?.presentation?.type === "campaign_draft";
      if (!ok) return { data: { ok: false }, error: null };
      row.exec_class = "linkedin_ads.create_campaign_bundle";
      row.exec_payload = args.p_payload;
      row.body = { ...row.body, exact_change: args.p_exact_change };
      return { data: { ok: true }, error: null };
    }
    if (name === "close_dropped_channel_run_cards") return { data: 0, error: null };
    throw new Error(`unexpected rpc ${name}`);
  };
  return { ...real, tenantClient: () => ({ from: query }), tenantRpc };
});

import { linkedinFileCampaignDraft, linkedinPrepareAction } from "@/routes/channels/linkedin-ads";
import { readAction, assertReviewable } from "@/services/connectors/linkedin-ads/action-read";
import { reviewLinkedInCampaignAction, prepareLinkedInCampaignAction } from "@/services/connectors/linkedin-ads/action-review";
import { POST_NOT_FOUND, POST_PAGE_MISMATCH } from "@/services/connectors/linkedin-ads/post-link";
import { FOUNDER_DRAFT_RUN_STAGE } from "@/services/connectors/linkedin-ads/propose-campaign-draft";
import { linkedinCampaignDraftPresentationSchema, stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import { recordChannelRunActions } from "@/services/channels/channel-actions";

const TENANT = "tenant-a";

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

async function call(body: unknown = {}) {
  const r = res();
  await linkedinFileCampaignDraft({ params: {}, body } as never, r as never);
  return r;
}

beforeEach(() => {
  h.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "user-1" });
  h.role = "owner";
  h.tierAllowed = true;
  h.writeOn = true;
  h.runs = [];
  h.actions = [];
  h.tenants = [];
  h.rpcCalls = [];
  h.failRecord = false;
  h.locked = false;
  h.lockReads = 0;
});

function expectNothingWritten() {
  expect(h.runs).toHaveLength(0);
  expect(h.actions).toHaveLength(0);
  expect(h.rpcCalls).toHaveLength(0);
}

describe("POST /api/channels/linkedin_ads/campaign-drafts", () => {
  it("refuses a channel staff locked as Coming soon and files nothing", async () => {
    h.locked = true;
    const r = await call();
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toEqual({ code: "coming_soon", message: "LinkedIn Ads is coming soon." });
    expect(h.lockReads).toBe(1);
    expectNothingWritten();
  });

  it("files nothing when the lock cannot be read", async () => {
    h.locked = "unreadable";
    const r = await call();
    expect(r.statusCode).toBe(503);
    expect(r.body.error.code).toBe("authorization_unavailable");
    expectNothingWritten();
  });

  it("refuses to prepare a draft for approval while the channel is locked", async () => {
    h.locked = true;
    const r = res();
    await linkedinPrepareAction({ params: { actionId: "a-1" }, body: {} } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("coming_soon");
    expectNothingWritten();
  });

  it("files again once the channel is unlocked", async () => {
    h.locked = true;
    expect((await call()).statusCode).toBe(403);
    h.locked = false;
    expect((await call()).statusCode).toBe(201);
    expect(h.actions).toHaveLength(1);
  });

  it("refuses a member and a viewer with 403 and files nothing", async () => {
    for (const role of ["member", "viewer"]) {
      h.role = role;
      expect((await call()).statusCode).toBe(403);
    }
    expectNothingWritten();
  });

  it("lets an admin file a draft", async () => {
    h.role = "admin";
    expect((await call()).statusCode).toBe(201);
    expect(h.actions).toHaveLength(1);
  });

  it("refuses a staff tenant override and files nothing", async () => {
    h.requireAuth.mockResolvedValue({ tenant_id: TENANT, user_id: "staff-1", tenant_overridden: true });
    const r = await call();
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("tenant_override_forbidden");
    expectNothingWritten();
  });

  it("refuses a workspace whose plan does not include LinkedIn Ads", async () => {
    h.tierAllowed = false;
    const r = await call();
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("channel_unavailable");
    expectNothingWritten();
  });

  it("refuses when LinkedIn Ads writes are switched off, and files no card or run", async () => {
    h.writeOn = false;
    const r = await call();
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("linkedin_ads_writes_off");
    expectNothingWritten();
  });

  it("files exactly one pending client campaign_draft card on a fresh stamped founder run", async () => {
    const r = await call();
    expect(r.statusCode).toBe(201);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ channel_slug: "linkedin_ads", agent_slug: "linkedin_ads", agent_definition_hash: FOUNDER_DRAFT_RUN_STAGE, status: "success", cost_usd: 0, cost_tokens: 0 });
    expect(h.rpcCalls.map((c) => c.name)).toEqual(["record_channel_run_actions", "close_dropped_channel_run_cards"]);
    expect(h.rpcCalls[0].args.p_run_id).toBe(h.runs[0].id);
    expect(h.rpcCalls[0].args.p_stale).toEqual([]);
    expect(h.actions).toHaveLength(1);
    const card = h.actions[0];
    expect(r.body).toEqual({ action_id: card.id, reused: false });
    expect(card).toMatchObject({ channel_slug: "linkedin_ads", run_id: h.runs[0].id, status: "pending", exec_class: null, action_type: "create_ad" });
    expect(card.body.step.responsibility).toBe("client");
    expect(card.body.step.deliverable.kind).toBe("ad");
    const p = card.body.step.deliverable.presentation;
    expect(linkedinCampaignDraftPresentationSchema.parse(p)).toEqual(p);
    const day = new Date().toISOString().slice(0, 10);
    expect(p).toMatchObject({ type: "campaign_draft", channel: "linkedin_ads", name: `LinkedIn campaign - ${day}`, country: "US", language: "en" });
    expect(p.group_name).toContain(day);
    expect(p).not.toHaveProperty("post_urn");
    expect(card.body.position).toBe(1);
    expect(card.body.of).toBe(1);
  });

  it("the stored card passes the real assertReviewable, review builder and prepare, unchanged", async () => {
    const { body } = await call({ name: "Q4 CFO push" });
    const row = await readAction(TENANT, body.action_id);
    expect(() => assertReviewable(row)).not.toThrow();
    const review = await reviewLinkedInCampaignAction(TENANT, body.action_id);
    expect(review.draft).toMatchObject({ name: "Q4 CFO push", country: "US", language: "en" });
    expect(review.draft.post_urn).toBeUndefined();
    expect(review.suggested.country).toBe("US");
    expect(review.accounts.map((a) => a.id)).toEqual(["50999"]);
    const postRead = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ author: "urn:li:organization:777" }) }));
    vi.stubGlobal("fetch", postRead);
    const out = await prepareLinkedInCampaignAction(TENANT, body.action_id, "user-1", {
      account_id: "50999", currency: "USD", daily_budget: "15.00", unit_cost: "6.00", country: "US", use_broad_audience: true,
      post: '<iframe src="https://www.linkedin.com/embed/feed/update/urn:li:share:7123456789012345678"></iframe>',
    }).finally(() => vi.unstubAllGlobals());
    expect(postRead.mock.calls.map(([url]) => url).filter((url) => !/\/rest\/audienceCounts\?/.test(url))).toEqual(["https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A7123456789012345678"]);
    expect(out.executable).toBe(true);
    const prepared = h.actions[0];
    expect(prepared.exec_class).toBe("linkedin_ads.create_campaign_bundle");
    expect(prepared.exec_payload).toMatchObject({ account_id: "50999", campaign: { name: "Q4 CFO push", country: "US", language: "en", associated_entity: "urn:li:organization:777" }, creative: { post_urn: "urn:li:share:7123456789012345678" } });
    expect(prepared.exec_payload.group.name).toContain("LinkedIn audience - ");
    const after = await readAction(TENANT, body.action_id);
    expect(() => assertReviewable(after)).toThrow(/changed/);
  });

  it("a plain post link LinkedIn will not serve answers 422 with the reason, and binds nothing", async () => {
    const { body } = await call({ name: "Q4 CFO push" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 999, url: "https://www.linkedin.com/feed/update/urn:li:activity:7499160133243912192/", text: async () => "" })));
    try {
      const r = res();
      await linkedinPrepareAction({ params: { actionId: body.action_id }, body: {
        account_id: "50999", currency: "USD", daily_budget: "15.00", unit_cost: "6.00", country: "US", use_broad_audience: true,
        post: "https://www.linkedin.com/posts/acme_launch-activity-7499160133243912192-kidi?utm_source=share",
      } } as never, r as never);
      expect(r.statusCode).toBe(422);
      expect(r.body.error.code).toBe("linkedin_ads_post_unreadable");
      expect(r.body.error.message).toMatch(/embed code/i);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(h.actions[0].exec_class).toBeNull();
    expect(h.rpcCalls.filter((c) => c.name === "prepare_channel_campaign_action")).toHaveLength(0);
  });

  describe("prepare tells the founder the real reason a field was refused", () => {
    const shareUrn = "urn:li:share:7123456789012345678";
    const goodBody = { use_broad_audience: true, account_id: "50999", currency: "USD", daily_budget: "15.00", unit_cost: "6.00", country: "US", post: shareUrn };
    async function prepare(body: Record<string, unknown>, author = "urn:li:organization:777") {
      const { body: filed } = await call({ name: "Q4 CFO push" });
      const postRead = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ author }) }));
      vi.stubGlobal("fetch", postRead);
      const r = res();
      try {
        await linkedinPrepareAction({ params: { actionId: filed.action_id }, body } as never, r as never);
      } finally {
        vi.unstubAllGlobals();
      }
      return { r, postRead };
    }
    function expectNothingPrepared() {
      expect(h.actions[0].exec_class).toBeNull();
      expect(h.actions[0].exec_payload).toBeNull();
      expect(h.rpcCalls.filter((c) => c.name === "prepare_channel_campaign_action")).toHaveLength(0);
    }

    it("job titles with seniority answers 400 with the shared audience message, before LinkedIn is called", async () => {
      const { r, postRead } = await prepare({ ...goodBody, audience: { titles: ["urn:li:title:1"], seniorities: ["urn:li:seniority:3"], industries: [], staffCountRanges: [] } });
      expect(r.statusCode).toBe(400);
      expect(r.body.error).toEqual({ code: "bad_request", message: "Choose job titles or seniority. LinkedIn does not allow both together." });
      expect(postRead).not.toHaveBeenCalled();
      expectNothingPrepared();
    });

    it.each([["locations", "include"], ["excluded_locations", "exclude"]])("more than 50 %s answers 400 naming the limit and the way out, before LinkedIn is called", async (field, list) => {
      const fiftyOne = Array.from({ length: 51 }, (_, i) => `urn:li:geo:${100000 + i}`);
      const { r, postRead } = await prepare({ ...goodBody, [field]: fiftyOne });
      expect(r.statusCode).toBe(400);
      expect(r.body.error).toEqual({ code: "bad_request", message: `Zavi can ${list} up to 50 places in one campaign. Remove some, or pick a wider area such as a whole country or region. Nothing was created.` });
      expect(postRead).not.toHaveBeenCalled();
      expectNothingPrepared();
    });

    it("a budget under LinkedIn's minimum answers with its own message", async () => {
      const { r } = await prepare({ ...goodBody, daily_budget: "5.00", unit_cost: "2.00" });
      expect(r.statusCode).toBe(409);
      expect(r.body.error.message).toBe("LinkedIn's minimum daily budget is 10 USD.");
      expectNothingPrepared();
    });

    it("a raw type error answers the generic copy and leaks no zod internals", async () => {
      for (const body of [{ ...goodBody, daily_budget: 15 }, { ...goodBody, audience: { titles: [42], seniorities: ["urn:li:seniority:3"] } }, { ...goodBody, extra: true }]) {
        const { r, postRead } = await prepare(body);
        expect(r.statusCode).toBe(400);
        expect(r.body.error).toEqual({ code: "bad_request", message: "Check the campaign fields and try again." });
        expect(JSON.stringify(r.body)).not.toMatch(/expected|received|invalid input|daily_budget|unrecognized/i);
        expect(postRead).not.toHaveBeenCalled();
      }
      expectNothingPrepared();
    });

    it("a post from another company page still answers 422 with the mismatch reason", async () => {
      const { r } = await prepare(goodBody, "urn:li:organization:999");
      expect(r.statusCode).toBe(422);
      expect(r.body.error.code).toBe("linkedin_ads_post_page_mismatch");
      expect(r.body.error.message).toBe(POST_PAGE_MISMATCH);
      expectNothingPrepared();
    });

    it("a post LinkedIn answers 404 for on both the ads API and its public page is refused as not found and never bound", async () => {
      const { body: filed } = await call({ name: "Q4 CFO push" });
      const postRead = vi.fn(async (url: string) => ({ ok: false, status: 404, url, json: async () => ({}), text: async () => "" }));
      vi.stubGlobal("fetch", postRead);
      const r = res();
      try {
        await linkedinPrepareAction({ params: { actionId: filed.action_id }, body: goodBody } as never, r as never);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(r.statusCode).toBe(422);
      expect(r.body.error).toEqual({ code: "linkedin_ads_post_not_found", message: POST_NOT_FOUND });
      expectNothingPrepared();
    });

    it.each([[403, 404], [404, 403], [404, 500], [500, 404]])("a post read LinkedIn answers %s for, with its public page answering %s, does not block: the payload is bound for LinkedIn's own creative check", async (status, publicStatus) => {
      const { body: filed } = await call({ name: "Q4 CFO push" });
      const postRead = vi.fn(async (url: string) => ({ ok: false, status: url.startsWith("https://www.linkedin.com/") ? publicStatus : status, url, json: async () => ({}), text: async () => "" }));
      vi.stubGlobal("fetch", postRead);
      const r = res();
      try {
        await linkedinPrepareAction({ params: { actionId: filed.action_id }, body: goodBody } as never, r as never);
      } finally {
        vi.unstubAllGlobals();
      }
      expect((postRead.mock.calls as unknown as Array<[string, RequestInit?]>).map(([url, init]) => `${init?.method ?? "GET"} ${url}`).filter((call) => !/\/rest\/audienceCounts\?/.test(call))).toEqual([
        `GET https://api.linkedin.com/rest/posts/${encodeURIComponent(shareUrn)}`,
        `GET https://www.linkedin.com/feed/update/${shareUrn}/`,
        "GET https://api.linkedin.com/rest/adAccounts/50999/creatives?q=criteria&sortOrder=DESCENDING&pageSize=100",
      ]);
      expect(r.statusCode).toBe(200);
      expect(h.actions[0].exec_class).toBe("linkedin_ads.create_campaign_bundle");
      expect(h.actions[0].exec_payload).toMatchObject({ creative: { post_urn: shareUrn }, campaign: { associated_entity: "urn:li:organization:777" } });
    });

    it("a Thought Leader post by a member is bound, not refused by Zavi", async () => {
      const { r } = await prepare(goodBody, "urn:li:person:abc");
      expect(r.statusCode).toBe(200);
      expect(h.actions[0].exec_class).toBe("linkedin_ads.create_campaign_bundle");
    });
  });

  it("returns the same waiting draft on a second ask instead of filing another", async () => {
    const first = await call();
    const second = await call();
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({ action_id: first.body.action_id, reused: true });
    expect(h.actions).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
    expect(h.rpcCalls.map((c) => c.name)).toEqual(["record_channel_run_actions", "close_dropped_channel_run_cards"]);
  });

  describe("a draft left untouched from an earlier day", () => {
    afterEach(() => { vi.useRealTimers(); });
    const pendingDrafts = () => h.actions.filter((a) => a.status === "pending" && a.body.step.deliverable?.presentation?.type === "campaign_draft");

    it("is replaced by a draft named for the founder's own today, in their time zone, and the old one is closed", async () => {
      h.tenants = [{ id: TENANT, reporting_timezone: "Asia/Kolkata", timezone: "America/Los_Angeles" }];
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-25T20:00:00Z"));
      const first = await call();
      expect(first.statusCode).toBe(201);
      expect(h.actions[0].body.step.deliverable.presentation).toMatchObject({ name: "LinkedIn campaign - 2026-10-26", group_name: "LinkedIn audience - 2026-10-26" });
      vi.setSystemTime(new Date("2026-10-26T18:00:00Z"));
      const sameDay = await call();
      expect(sameDay.body).toEqual({ action_id: first.body.action_id, reused: true });
      vi.setSystemTime(new Date("2026-11-02T19:00:00Z"));
      const later = await call();
      expect(later.statusCode).toBe(201);
      expect(later.body.reused).toBe(false);
      expect(later.body.action_id).not.toBe(first.body.action_id);
      const record = h.rpcCalls.filter((c) => c.name === "record_channel_run_actions");
      expect(record).toHaveLength(2);
      expect(record[1].args.p_stale.map((x: { action_id: string }) => x.action_id)).toEqual([first.body.action_id]);
      expect(h.actions.find((a) => a.id === first.body.action_id)!.status).toBe("stale");
      expect(pendingDrafts().map((a) => a.id)).toEqual([later.body.action_id]);
      expect(pendingDrafts()[0].body.step.deliverable.presentation).toMatchObject({ name: "LinkedIn campaign - 2026-11-03", group_name: "LinkedIn audience - 2026-11-03" });
      const review = await reviewLinkedInCampaignAction(TENANT, later.body.action_id);
      expect(review.draft.name).toBe("LinkedIn campaign - 2026-11-03");
    });

    it("never closes a founder's old draft they already started editing", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
      const first = await call();
      h.actions[0].edited_body = { step: {} };
      vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
      const later = await call();
      expect(later.statusCode).toBe(201);
      expect(h.rpcCalls.filter((c) => c.name === "record_channel_run_actions")[1].args.p_stale).toEqual([]);
      expect(h.actions.find((a) => a.id === first.body.action_id)!.status).toBe("pending");
    });
  });

  it("files a fresh draft once the waiting one was touched, prepared or closed", async () => {
    const touches: Array<(r: Row) => void> = [
      (r) => (r.edited_body = { step: {} }),
      (r) => (r.steps_done = [0]),
      (r) => (r.exec_class = "linkedin_ads.create_campaign_bundle"),
      (r) => (r.status = "snoozed"),
      (r) => (r.status = "rejected"),
    ];
    for (const touch of touches) {
      h.actions = [];
      h.runs = [];
      const first = await call();
      touch(h.actions[0]);
      const second = await call();
      expect(second.statusCode).toBe(201);
      expect(second.body.action_id).not.toBe(first.body.action_id);
      expect(h.actions).toHaveLength(2);
    }
  });

  it("does not reuse an AI-written draft card, which belongs to its run's verdict", async () => {
    const aiRun = randomUUID();
    h.runs.push({ id: aiRun, channel_slug: "linkedin_ads", agent_definition_hash: "abc123" });
    h.actions.push({
      id: randomUUID(), run_id: aiRun, channel_slug: "linkedin_ads", status: "pending", exec_class: null, exec_status: null, edited_body: null, steps_done: [],
      body: { step: { responsibility: "client", deliverable: { presentation: { type: "campaign_draft", channel: "linkedin_ads" } } } },
    });
    const r = await call();
    expect(r.statusCode).toBe(201);
    expect(r.body.reused).toBe(false);
    expect(h.actions).toHaveLength(2);
  });

  it("a crafted body cannot inject presentation, responsibility or exec fields", async () => {
    const r = await call({
      name: "Injected name",
      responsibility: "zavi",
      exec_class: "linkedin_ads.create_campaign_bundle",
      exec_payload: { account_id: "1" },
      presentation: { post_urn: "urn:li:share:1", country: "FR" },
      step: { responsibility: "zavi" },
      country: "FR",
      post_urn: "urn:li:share:1",
      tenant_id: "tenant-b",
    });
    expect(r.statusCode).toBe(201);
    const card = h.actions[0];
    expect(card.exec_class).toBeNull();
    expect(card.exec_payload).toBeNull();
    expect(card.channel_slug).toBe("linkedin_ads");
    expect(card.tenant_id).toBe(TENANT);
    expect(card.body.step.responsibility).toBe("client");
    expect(card.body.step.deliverable.presentation.country).toBe("US");
    expect(card.body.step.deliverable.presentation.name).toBe("Injected name");
    expect(JSON.stringify(card.body)).not.toContain("urn:li:share:1");
    expect(JSON.stringify(card.body)).not.toContain("FR");
  });

  it("rejects a bad name with 400 before writing anything", async () => {
    for (const name of ["ab", "x".repeat(121), "line\nbreak", { a: 1 }, 42]) {
      const r = await call({ name });
      expect(r.statusCode).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
    expectNothingWritten();
  });

  it("answers 502 without a card when the store write fails", async () => {
    h.failRecord = true;
    const r = await call();
    expect(r.statusCode).toBe(502);
    expect(h.actions).toHaveLength(0);
  });
});

const AGENT_DEPS = { loadMatchPool: async () => [], matchCards: async () => null, displace: async () => 0 };

function agentRun() {
  const id = randomUUID();
  h.runs.push({ id, channel_slug: "linkedin_ads", agent_slug: "linkedin_ads", agent_definition_hash: "abc123", trigger: "manual", status: "success" });
  return id;
}

async function recordAgentRun(steps: unknown[]) {
  const runId = agentRun();
  const envelope = { rendered_markdown: "LinkedIn run", steps };
  const bodies = stepDecisionBodies(envelope);
  expect(bodies).toHaveLength(steps.length);
  return { runId, recorded: await recordChannelRunActions({ tenantId: TENANT, runId, channelSlug: "linkedin_ads", envelope, bodies, redo: null }, AGENT_DEPS) };
}

const agentDraftStep = {
  title: "Promote the CFO checklist post to finance leaders",
  body: "Your CFO checklist post is the strongest proof you have. Sponsor it to finance leaders at US software companies.",
  blocking: false,
  effort: "30 min",
  evidence: ["linkedin_ads__list_posts read the company page this run"],
  action_type: "create_ad",
  deliverable: {
    kind: "ad",
    label: "LinkedIn campaign draft",
    content: "CFO checklist push\nCFOs at US SaaS\nThe 12-point close checklist",
    presentation: {
      type: "campaign_draft",
      channel: "linkedin_ads",
      name: "CFO checklist push",
      group_name: "CFOs at US SaaS",
      rationale: `${"Finance leaders engaged with this post more than any other this quarter, and it names the exact pain the product removes. ".repeat(6)}`,
      post_urn: "urn:li:activity:7499160133243912192",
      post_preview: "The 12-point close checklist every CFO should run before quarter end.",
      country: "us",
      language: "EN",
      locations: ["United States", "Atlantis", 42],
      excluded_locations: ["California"],
      audience_suggestions: { titles: ["Chief Financial Officer", "VP Finance"], industries: ["Software Development"], job_functions: ["Finance"] },
    },
  },
};

const plainStep = {
  title: "Install the LinkedIn Insight Tag on the pricing page",
  body: "Without the tag no demo request can be counted.",
  blocking: true,
  effort: "minutes",
  evidence: ["fetched the pricing page this run"],
  action_type: "setup",
};

describe("a LinkedIn campaign draft Zavi wrote on a run", () => {
  it("is filed as the founder's draft with its review action, and review prefills the audience and lists the places it could not add", async () => {
    const { recorded } = await recordAgentRun([agentDraftStep]);
    expect(recorded.ids).toHaveLength(1);
    expect(h.actions.filter((a) => a.status === "pending")).toHaveLength(1);
    const card = h.actions[0];
    expect(card.id).toBe(recorded.ids[0].id);
    expect(card.body.step.responsibility).toBe("client");
    const p = card.body.step.deliverable.presentation;
    expect(p).toMatchObject({ type: "campaign_draft", channel: "linkedin_ads", name: "CFO checklist push", country: "US", language: "en" });
    expect(p.rationale.length).toBeLessThanOrEqual(500);
    expect(p.post_urn).toBeUndefined();
    expect(p.locations).toEqual(["United States", "Atlantis"]);
    expect(p.audience_suggestions).toEqual({ titles: ["Chief Financial Officer", "VP Finance"], seniorities: [], industries: ["Software Development"], staffCountRanges: [] });
    expect(linkedinCampaignDraftPresentationSchema.parse(p)).toEqual(p);

    expect(() => assertReviewable({ ...card, approved_by: null } as never)).not.toThrow();
    const review = await reviewLinkedInCampaignAction(TENANT, card.id);
    expect(review.draft.audience_suggestions?.titles).toEqual(["Chief Financial Officer", "VP Finance"]);
    expect(review.draft.audience_suggestions?.industries).toEqual(["Software Development"]);
    expect(review.suggested.locations).toEqual([{ id: "urn:li:geo:103644278", name: "United States" }]);
    expect(review.suggested.unresolved_locations).toEqual(["Atlantis", "California (exclude)"]);

    const postRead = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ author: "urn:li:organization:777" }) }));
    vi.stubGlobal("fetch", postRead);
    const out = await prepareLinkedInCampaignAction(TENANT, card.id, "user-1", {
      account_id: "50999", currency: "USD", daily_budget: "15.00", unit_cost: "6.00", country: "US", use_broad_audience: true,
      post: '<iframe src="https://www.linkedin.com/embed/feed/update/urn:li:share:7123456789012345678"></iframe>',
    }).finally(() => vi.unstubAllGlobals());
    expect(out.executable).toBe(true);
    expect(h.actions[0].exec_class).toBe("linkedin_ads.create_campaign_bundle");
    expect(h.rpcCalls.filter((c) => c.name === "prepare_channel_campaign_action")).toHaveLength(1);
  });

  it("keeps its review action through a founder press, a second run and each run's close, as the only draft of its own", async () => {
    const { runId: first } = await recordAgentRun([agentDraftStep]);
    const agentCard = h.actions[0];
    const pressed = await call();
    expect(pressed.statusCode).toBe(201);
    const { runId: second } = await recordAgentRun([plainStep]);
    expect(h.rpcCalls.filter((c) => c.name === "close_dropped_channel_run_cards").map((c) => c.args.p_run_id)).toEqual([first, h.runs[1].id, second]);
    expect(h.rpcCalls.filter((c) => c.name === "record_channel_run_actions").every((c) => c.args.p_stale.length === 0)).toBe(true);

    const pending = h.actions.filter((a) => a.status === "pending");
    expect(pending).toHaveLength(3);
    const drafts = pending.filter((a) => a.body.step.deliverable?.presentation?.type === "campaign_draft");
    expect(drafts.map((a) => a.run_id).sort()).toEqual([first, h.runs[1].id].sort());
    const still = h.actions.find((a) => a.id === agentCard.id)!;
    expect(still).toMatchObject({ status: "pending", exec_class: null, exec_status: null });
    expect(still.body.step.responsibility).toBe("client");
    expect(still.body.step.deliverable.presentation.audience_suggestions.titles).toEqual(["Chief Financial Officer", "VP Finance"]);
    expect(() => assertReviewable({ ...still, approved_by: null } as never)).not.toThrow();
    expect((await reviewLinkedInCampaignAction(TENANT, still.id)).draft.name).toBe("CFO checklist push");

    const again = await call();
    expect(again.body).toEqual({ action_id: pressed.body.action_id, reused: true });
    expect(h.actions.filter((a) => a.body.step.deliverable?.presentation?.type === "campaign_draft")).toHaveLength(2);
  });

  it("a run that names no responsibility, or claims the draft as Zavi's, still files a draft the founder reviews", async () => {
    for (const responsibility of [undefined, "zavi", "someone"]) {
      h.actions = [];
      h.runs = [];
      await recordAgentRun([{ ...agentDraftStep, ...(responsibility ? { responsibility } : {}) }]);
      expect(h.actions[0].body.step.responsibility).toBe("client");
    }
  });

  it("leaves a step that is not a LinkedIn draft as the run wrote it", async () => {
    await recordAgentRun([plainStep, { ...plainStep, title: "Check the Insight Tag fires", responsibility: "zavi" }]);
    expect(h.actions.map((a) => a.body.step.responsibility)).toEqual([undefined, "zavi"]);
  });
});
