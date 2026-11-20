import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner" as string,
  tierAllowed: true,
  wallet: null as null | { funding_source: string },
  campaign: null as Row | null,
  group: null as Row | null,
  groupCampaigns: [] as Row[],
  creatives: [] as Row[],
  reads: [] as string[],
  statusCalls: [] as unknown[],
  runs: [] as Row[],
  actions: [] as Row[],
  rpcCalls: [] as Array<{ name: string; args: Row }>,
}));

vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountInUse: async (_t: string, account: string) => account === ACCOUNT }));
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
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withLinkedInAdsToken: async (_t: string, call: (token: string) => Promise<unknown>) => call("tok"),
}));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({
  readLinkedInRawCampaign: async (_t: string, account: string, campaign: string) => {
    h.reads.push(`campaign:${account}:${campaign}`);
    return h.campaign && String(h.campaign.account) === `urn:li:sponsoredAccount:${account}` && String(h.campaign.id) === campaign ? h.campaign : null;
  },
  readLinkedInRawCampaignGroup: async (_t: string, account: string, group: string) => {
    h.reads.push(`group:${account}:${group}`);
    return h.group && String(h.group.account) === `urn:li:sponsoredAccount:${account}` && String(h.group.id) === group ? h.group : null;
  },
  listLinkedInRawCampaignsInGroupWithToken: async (_token: string, account: string, group: string) => {
    h.reads.push(`group-campaigns:${account}:${group}`);
    return h.groupCampaigns;
  },
  listLinkedInRawCreativesWithToken: async (_token: string, account: string, campaign: string) => {
    h.reads.push(`creatives:${account}:${campaign}`);
    return h.creatives.filter((c) => c.campaign === `urn:li:sponsoredCampaign:${campaign}`);
  },
  setLinkedInCreativeStatusWithToken: async (...args: unknown[]) => {
    h.statusCalls.push(args);
  },
}));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: async () => h.wallet }));
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
  const tenantRpc = async (tid: string, name: string, args: Row) => {
    h.rpcCalls.push({ name, args });
    if (name !== "record_channel_exec_action") throw new Error(`unexpected rpc ${name}`);
    const run = h.runs.find((r) => r.id === args.p_run_id);
    if (!run) return { data: { ok: false, code: "no_run" }, error: null };
    const a = args.p_action;
    const id = `action-${h.actions.length + 1}`;
    h.actions.push({ id, tenant_id: tid, channel_slug: run.channel_slug, run_id: run.id, status: "pending", exec_status: null, exec_result: null, ...a });
    return { data: { ok: true, id, replayed: false }, error: null };
  };
  return { ...real, tenantClient: () => ({ from: query }), tenantRpc };
});

import {
  linkedinProposeAdStatus,
  linkedinProposeArchive,
  linkedinProposeCampaignDuplicate,
  linkedinProposeGroupDuplicate,
  linkedinProposeGroupStatus,
} from "@/routes/channels/linkedin-ads";
import { linkedinAdStatusBodySchema, linkedinArchiveBodySchema, linkedinDuplicateBodySchema, linkedinGroupEditBodySchema } from "@/services/tools/linkedin-ads/_change-bodies";
import { executeLinkedInAdStatus } from "@/services/connectors/linkedin-ads/execute-cards";

const TENANT = "tenant-a";
const ACCOUNT = "50999";
const CAMPAIGN = "507000111";
const GROUP = "608000222";
const AD_A = "701";
const AD_B = "702";
const STAMP = Date.UTC(2026, 10, 1, 9, 30, 0);

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
const archive = (body: Row = { account_id: ACCOUNT }, campaignId = CAMPAIGN) => call(linkedinProposeArchive, { campaignId }, body);
const groupStatus = (body: Row, groupId = GROUP) => call(linkedinProposeGroupStatus, { groupId }, body);
const adStatus = (body: Row, creativeId = AD_A) => call(linkedinProposeAdStatus, { creativeId }, body);
const copyCampaign = (body: Row = { account_id: ACCOUNT }, campaignId = CAMPAIGN) => call(linkedinProposeCampaignDuplicate, { campaignId }, body);
const copyGroup = (body: Row = { account_id: ACCOUNT }, groupId = GROUP) => call(linkedinProposeGroupDuplicate, { groupId }, body);

const creative = (id: string, intendedStatus: string, name = `Ad ${id}`) => ({ creative_id: id, id: `urn:li:sponsoredCreative:${id}`, campaign: `urn:li:sponsoredCampaign:${CAMPAIGN}`, name, intendedStatus });

beforeEach(() => {
  h.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "user-1" });
  h.role = "owner";
  h.tierAllowed = true;
  h.wallet = null;
  h.campaign = { id: CAMPAIGN, account: `urn:li:sponsoredAccount:${ACCOUNT}`, name: "Q4 CFO retarget", status: "PAUSED", changeAuditStamps: { lastModified: { time: STAMP } } };
  h.group = { id: GROUP, account: `urn:li:sponsoredAccount:${ACCOUNT}`, name: "Spring launch", status: "ACTIVE", backfilled: false, changeAuditStamps: { lastModified: { time: STAMP } } };
  h.groupCampaigns = [h.campaign];
  h.creatives = [creative(AD_A, "ACTIVE", "Hero post"), creative(AD_B, "ACTIVE", "Second post")];
  h.reads = [];
  h.statusCalls = [];
  h.runs = [];
  h.actions = [];
  h.rpcCalls = [];
});

function expectNothingWritten() {
  expect(h.runs).toHaveLength(0);
  expect(h.actions).toHaveLength(0);
  expect(h.rpcCalls).toHaveLength(0);
}

describe("LinkedIn Ads founder cards: who may file one", () => {
  it.each(["member", "viewer"])("a %s gets 403 on all five routes before LinkedIn is read or anything is written", async (role) => {
    h.role = role;
    const answers = await Promise.all([
      archive(),
      groupStatus({ account_id: ACCOUNT, status: "PAUSED" }),
      adStatus({ account_id: ACCOUNT, campaign_id: CAMPAIGN, status: "PAUSED" }),
      copyCampaign(),
      copyGroup(),
    ]);
    expect(answers.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
    expect(h.reads).toHaveLength(0);
    expectNothingWritten();
  });

  it("must catch: a plan without LinkedIn Ads can still ask for a pause of a group or an ad, but not a restart, an archive or a copy", async () => {
    h.tierAllowed = false;
    expect((await groupStatus({ account_id: ACCOUNT, status: "PAUSED" })).statusCode).toBe(201);
    h.group!.status = "PAUSED";
    h.actions = [];
    h.runs = [];
    const restart = await groupStatus({ account_id: ACCOUNT, status: "ACTIVE" });
    expect([restart.statusCode, restart.body.error.code]).toEqual([403, "channel_unavailable"]);
    expect((await adStatus({ account_id: ACCOUNT, campaign_id: CAMPAIGN, status: "PAUSED" })).statusCode).toBe(201);
    expect((await archive()).statusCode).toBe(403);
    expect((await copyCampaign()).statusCode).toBe(403);
    expect((await copyGroup()).statusCode).toBe(403);
    expect(h.actions).toHaveLength(1);
  });

  it("rejects a malformed id or body with 400 before reading LinkedIn", async () => {
    expect((await archive({ account_id: "abc" })).statusCode).toBe(400);
    expect((await archive({ account_id: ACCOUNT }, "../1")).statusCode).toBe(400);
    expect((await archive({ account_id: ACCOUNT, mode: "nuke" })).statusCode).toBe(400);
    expect((await groupStatus({ account_id: ACCOUNT, status: "ARCHIVED" })).statusCode).toBe(400);
    expect((await adStatus({ account_id: ACCOUNT, status: "PAUSED" })).statusCode).toBe(400);
    expect((await copyCampaign({ account_id: ACCOUNT, new_name: "x".repeat(256) })).statusCode).toBe(400);
    expect(h.reads).toHaveLength(0);
    expectNothingWritten();
  });

  it("refuses an ad account this workspace does not use, and files nothing", async () => {
    const r = await archive({ account_id: "77777" });
    expect([r.statusCode, r.body.error.code]).toEqual([422, "linkedin_ads_account_not_in_use"]);
    expectNothingWritten();
  });
});

describe("POST /api/channels/linkedin_ads/campaigns/:campaignId/propose-archive", () => {
  it("files one linkedin_ads.archive card whose body passes the strict schema and carries the LIVE status, whatever the request claims", async () => {
    const r = await archive({ account_id: ACCOUNT, expected_status: "ACTIVE", name: "Injected", target: "campaign_group", rationale: "Injected" });
    expect(r.statusCode).toBe(201);
    expect(h.actions).toHaveLength(1);
    const card = h.actions[0];
    expect(r.body).toEqual({ action_id: card.id, campaign: { id: CAMPAIGN, name: "Q4 CFO retarget", was: "PAUSED", mode: "archive" } });
    expect(card.exec_class).toBe("linkedin_ads.archive");
    expect(card.action_type).toBe("other");
    expect(card.channel_slug).toBe("linkedin_ads");
    expect(card.title).toBe('Archive the LinkedIn campaign "Q4 CFO retarget"');
    expect(linkedinArchiveBodySchema.parse(card.exec_payload)).toEqual({
      target: "campaign",
      id: CAMPAIGN,
      account_id: ACCOUNT,
      campaign_id: null,
      name: "Q4 CFO retarget",
      expected_status: "PAUSED",
      mode: "archive",
      rationale: "You asked Zavi to archive this campaign from the LinkedIn Ads channel page.",
    });
    expect(card.body.exact_change.rows).toEqual([{ item: 'Campaign "Q4 CFO retarget"', before: "Paused", after: "Archived" }]);
    expect(JSON.stringify(card)).not.toContain("Injected");
    expect(h.runs[0]).toMatchObject({ channel_slug: "linkedin_ads", status: "success", cost_usd: 0, payload: { stage: "linkedin_ads_founder_archive" } });
    expect(card.run_id).toBe(h.runs[0].id);
  });

  it("mode delete files a delete card for a draft, and a completed campaign archives", async () => {
    h.campaign!.status = "DRAFT";
    const r = await archive({ account_id: ACCOUNT, mode: "delete" });
    expect(r.statusCode).toBe(201);
    expect(h.actions[0].exec_payload).toMatchObject({ mode: "delete", expected_status: "DRAFT" });
    expect(h.actions[0].title).toBe('Delete the LinkedIn campaign "Q4 CFO retarget"');
    h.campaign = { ...h.campaign!, id: "507000112", status: "COMPLETED" };
    expect((await archive({ account_id: ACCOUNT }, "507000112")).statusCode).toBe(201);
    expect(h.actions[1].exec_payload).toMatchObject({ mode: "archive", expected_status: "COMPLETED" });
  });

  it("refuses a running campaign with 409 linkedin_ads_campaign_active, and an archived one, and files nothing", async () => {
    h.campaign!.status = "ACTIVE";
    const r = await archive();
    expect([r.statusCode, r.body.error.code]).toEqual([409, "linkedin_ads_campaign_active"]);
    h.campaign!.status = "ARCHIVED";
    const gone = await archive();
    expect([gone.statusCode, gone.body.error.code]).toEqual([409, "linkedin_ads_campaign_not_archivable"]);
    expectNothingWritten();
  });

  it("refuses a wallet campaign with 422 and a campaign outside the account with 404", async () => {
    h.wallet = { funding_source: "wallet" };
    const w = await archive();
    expect([w.statusCode, w.body.error.code]).toEqual([422, "linkedin_ads_wallet_campaign"]);
    h.wallet = null;
    h.campaign!.account = "urn:li:sponsoredAccount:77777";
    const missing = await archive();
    expect([missing.statusCode, missing.body.error.code]).toEqual([404, "linkedin_ads_campaign_not_found"]);
    expectNothingWritten();
  });

  it("a second ask for the same campaign is 409 linkedin_ads_archive_pending and inserts nothing, while another campaign still files", async () => {
    expect((await archive()).statusCode).toBe(201);
    const again = await archive();
    expect([again.statusCode, again.body.error.code]).toEqual([409, "linkedin_ads_archive_pending"]);
    expect(again.body.error.message).toMatch(/already waiting in Next steps/);
    expect(h.actions).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
    h.actions[0].status = "acted";
    h.actions[0].exec_status = "queued";
    expect((await archive()).statusCode).toBe(409);
    h.actions[0].exec_status = "executed";
    expect((await archive()).statusCode).toBe(201);
    expect(h.actions).toHaveLength(2);
  });
});

describe("POST /api/channels/linkedin_ads/groups/:groupId/propose-status", () => {
  it("files a group edit card whose before is the LIVE status, with the live name and LinkedIn's last-modified stamp, and ignores a crafted before", async () => {
    const r = await groupStatus({ account_id: ACCOUNT, status: "PAUSED", changes: { status: { before: "PAUSED", after: "ACTIVE" } }, name: "Injected" });
    expect(r.statusCode).toBe(201);
    const card = h.actions[0];
    expect(r.body).toEqual({ action_id: card.id, group: { id: GROUP, name: "Spring launch", was: "ACTIVE", status: "PAUSED" } });
    expect(card.exec_class).toBe("linkedin_ads.update_campaign_group");
    expect(card.action_type).toBe("update_ad");
    expect(card.title).toBe('Edit the LinkedIn campaign group "Spring launch"');
    expect(linkedinGroupEditBodySchema.parse(card.exec_payload)).toEqual({
      group_id: GROUP,
      account_id: ACCOUNT,
      name: "Spring launch",
      rationale: "You asked Zavi to pause this campaign group from the LinkedIn Ads channel page.",
      last_modified_at: new Date(STAMP).toISOString(),
      changes: { status: { before: "ACTIVE", after: "PAUSED" } },
    });
    expect(card.body.exact_change.rows).toEqual([{ item: "Status", before: "Active", after: "Paused" }]);
    expect(JSON.stringify(card)).not.toContain("Injected");
    expect(h.runs[0].payload).toEqual({ stage: "linkedin_ads_founder_group_status" });
  });

  it("restarting a paused group writes before PAUSED after ACTIVE and a restart rationale", async () => {
    h.group!.status = "PAUSED";
    h.group!.changeAuditStamps = undefined;
    const r = await groupStatus({ account_id: ACCOUNT, status: "ACTIVE" });
    expect(r.statusCode).toBe(201);
    expect(h.actions[0].exec_payload).toMatchObject({ last_modified_at: null, changes: { status: { before: "PAUSED", after: "ACTIVE" } }, rationale: expect.stringMatching(/^You asked Zavi to restart this campaign group/) });
  });

  it("refuses the backfilled default group with 422, a no-op with 409, an ended group with 409 and an unknown group with 404", async () => {
    h.group!.backfilled = true;
    const dflt = await groupStatus({ account_id: ACCOUNT, status: "PAUSED" });
    expect([dflt.statusCode, dflt.body.error.code]).toEqual([422, "linkedin_ads_default_group"]);
    h.group!.backfilled = false;
    const same = await groupStatus({ account_id: ACCOUNT, status: "ACTIVE" });
    expect([same.statusCode, same.body.error.code]).toEqual([409, "linkedin_ads_group_status_same"]);
    h.group!.status = "ARCHIVED";
    const ended = await groupStatus({ account_id: ACCOUNT, status: "ACTIVE" });
    expect([ended.statusCode, ended.body.error.code]).toEqual([409, "linkedin_ads_group_ended"]);
    const missing = await groupStatus({ account_id: ACCOUNT, status: "PAUSED" }, "1");
    expect([missing.statusCode, missing.body.error.code]).toEqual([404, "linkedin_ads_group_not_found"]);
    expectNothingWritten();
  });

  it("a second ask for the same group is 409 linkedin_ads_group_status_pending, and a pending card on another group does not block", async () => {
    expect((await groupStatus({ account_id: ACCOUNT, status: "PAUSED" })).statusCode).toBe(201);
    const again = await groupStatus({ account_id: ACCOUNT, status: "PAUSED" });
    expect([again.statusCode, again.body.error.code]).toEqual([409, "linkedin_ads_group_status_pending"]);
    expect(h.actions).toHaveLength(1);
    h.actions[0].exec_payload = { ...h.actions[0].exec_payload, group_id: "999" };
    expect((await groupStatus({ account_id: ACCOUNT, status: "PAUSED" })).statusCode).toBe(201);
    expect(h.actions).toHaveLength(2);
  });
});

describe("POST /api/channels/linkedin_ads/ads/:creativeId/propose-status", () => {
  const off = (creativeId = AD_A) => adStatus({ account_id: ACCOUNT, campaign_id: CAMPAIGN, status: "PAUSED" }, creativeId);
  const on = (creativeId = AD_A) => adStatus({ account_id: ACCOUNT, campaign_id: CAMPAIGN, status: "ACTIVE" }, creativeId);

  it("files an ad status card with the LIVE ad status and names, and the executor accepts that payload as filed", async () => {
    h.campaign!.status = "ACTIVE";
    const r = await off();
    expect(r.statusCode).toBe(201);
    const card = h.actions[0];
    expect(r.body).toEqual({ action_id: card.id, ad: { id: AD_A, name: "Hero post", campaign_id: CAMPAIGN, was: "ACTIVE", status: "PAUSED" } });
    expect(card.exec_class).toBe("linkedin_ads.set_ad_status");
    expect(card.action_type).toBe("update_ad");
    expect(card.title).toBe('Turn off the LinkedIn ad "Hero post"');
    expect(linkedinAdStatusBodySchema.parse(card.exec_payload)).toEqual({
      creative_id: AD_A,
      campaign_id: CAMPAIGN,
      account_id: ACCOUNT,
      campaign_name: "Q4 CFO retarget",
      ad_name: "Hero post",
      expected_status: "ACTIVE",
      status: "PAUSED",
      rationale: "You asked Zavi to turn off this ad from the LinkedIn Ads channel page.",
    });
    expect(card.body.exact_change.rows).toEqual([{ item: 'Ad "Hero post"', before: "On", after: "Off" }]);
    expect(h.statusCalls).toHaveLength(0);
    const out = await executeLinkedInAdStatus({ tenant_id: TENANT, body: card.exec_payload });
    expect(out).toEqual({ ok: true, notice: 'Turned the ad "Hero post" off in LinkedIn Ads.' });
    expect(h.statusCalls).toEqual([["tok", ACCOUNT, AD_A, "PAUSED"]]);
  });

  it("must catch: turning off the last ad that is on in a running campaign is 409 linkedin_ads_last_live_ad, but allowed once the campaign is paused or another ad is on", async () => {
    h.campaign!.status = "ACTIVE";
    h.creatives = [creative(AD_A, "ACTIVE", "Hero post"), creative(AD_B, "PAUSED", "Second post")];
    const r = await off();
    expect([r.statusCode, r.body.error.code]).toEqual([409, "linkedin_ads_last_live_ad"]);
    expect(r.body.error.message).toMatch(/only ad that is on/);
    expectNothingWritten();
    h.campaign!.status = "PAUSED";
    expect((await off()).statusCode).toBe(201);
    h.campaign!.status = "ACTIVE";
    h.creatives = [creative(AD_A, "ACTIVE", "Hero post"), creative(AD_B, "ACTIVE", "Second post")];
    h.actions = [];
    h.runs = [];
    expect((await off()).statusCode).toBe(201);
  });

  it("turning a paused ad on files with expected_status PAUSED, a draft ad with DRAFT, and a no-op is 409", async () => {
    h.creatives = [creative(AD_A, "PAUSED", "Hero post"), creative(AD_B, "DRAFT", "Second post")];
    expect((await on()).statusCode).toBe(201);
    expect(h.actions[0].exec_payload).toMatchObject({ expected_status: "PAUSED", status: "ACTIVE" });
    expect(h.actions[0].title).toBe('Turn on the LinkedIn ad "Hero post"');
    expect((await on(AD_B)).statusCode).toBe(201);
    expect(h.actions[1].exec_payload).toMatchObject({ expected_status: "DRAFT", status: "ACTIVE" });
    h.actions = [];
    h.runs = [];
    h.rpcCalls = [];
    const same = await off(AD_A);
    expect([same.statusCode, same.body.error.code]).toEqual([409, "linkedin_ads_ad_status_same"]);
    expectNothingWritten();
  });

  it("an ad that is not in the campaign is 404, an archived ad is 409, a wallet campaign is 422, and nothing is filed", async () => {
    const missing = await off("999");
    expect([missing.statusCode, missing.body.error.code]).toEqual([404, "linkedin_ads_ad_not_found"]);
    h.creatives = [creative(AD_A, "ARCHIVED"), creative(AD_B, "ACTIVE")];
    const archived = await on(AD_A);
    expect([archived.statusCode, archived.body.error.code]).toEqual([409, "linkedin_ads_ad_not_switchable"]);
    h.wallet = { funding_source: "wallet" };
    const wallet = await off(AD_B);
    expect([wallet.statusCode, wallet.body.error.code]).toEqual([422, "linkedin_ads_wallet_campaign"]);
    expectNothingWritten();
  });

  it("a second ask for the same ad is 409 linkedin_ads_ad_status_pending and inserts nothing", async () => {
    expect((await off()).statusCode).toBe(201);
    const again = await on();
    expect([again.statusCode, again.body.error.code]).toEqual([409, "linkedin_ads_ad_status_pending"]);
    expect(h.actions).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
    expect((await off(AD_B)).statusCode).toBe(201);
  });
});

describe("POST .../campaigns/:campaignId/propose-duplicate and .../groups/:groupId/propose-duplicate", () => {
  it("files a campaign copy card: copy_ads true, group_id null, new name defaulting to '(copy)', the source stamp from the live read", async () => {
    const r = await copyCampaign({ account_id: ACCOUNT, copy_ads: false, group_id: "5", source_name: "Injected" });
    expect(r.statusCode).toBe(201);
    const card = h.actions[0];
    expect(r.body).toEqual({ action_id: card.id, copy: { target: "campaign", source_id: CAMPAIGN, source_name: "Q4 CFO retarget", new_name: "Q4 CFO retarget (copy)" } });
    expect(card.exec_class).toBe("linkedin_ads.duplicate");
    expect(card.action_type).toBe("create_ad");
    expect(card.title).toBe('Copy the LinkedIn campaign "Q4 CFO retarget"');
    expect(linkedinDuplicateBodySchema.parse(card.exec_payload)).toEqual({
      target: "campaign",
      source_id: CAMPAIGN,
      account_id: ACCOUNT,
      source_name: "Q4 CFO retarget",
      new_name: "Q4 CFO retarget (copy)",
      group_id: null,
      campaign_id: null,
      copy_ads: true,
      source_last_modified_at: new Date(STAMP).toISOString(),
      rationale: "You asked Zavi to copy this campaign from the LinkedIn Ads channel page.",
    });
    expect(JSON.stringify(card)).not.toContain("Injected");
    expect(h.runs[0].payload).toEqual({ stage: "linkedin_ads_founder_duplicate" });
  });

  it("honours a new_name, and a group copy targets campaign_group with its own stamp", async () => {
    expect((await copyCampaign({ account_id: ACCOUNT, new_name: "  Q4 retarget v2  " })).statusCode).toBe(201);
    expect(h.actions[0].exec_payload.new_name).toBe("Q4 retarget v2");
    h.group!.changeAuditStamps = { lastModified: { time: STAMP + 1000 } };
    const r = await copyGroup();
    expect(r.statusCode).toBe(201);
    expect(r.body.copy).toEqual({ target: "campaign_group", source_id: GROUP, source_name: "Spring launch", new_name: "Spring launch (copy)" });
    expect(linkedinDuplicateBodySchema.parse(h.actions[1].exec_payload)).toMatchObject({ target: "campaign_group", source_id: GROUP, copy_ads: true, group_id: null, campaign_id: null, source_last_modified_at: new Date(STAMP + 1000).toISOString() });
    expect(h.actions[1].title).toBe('Copy the LinkedIn campaign group "Spring launch"');
    expect(h.actions[0].body.kind_label).toBe("Campaign copy");
    expect(h.actions[1].body.kind_label).toBe("Campaign group copy");
  });

  it("a wallet campaign is 422, an unknown group is 404, and nothing is filed", async () => {
    h.wallet = { funding_source: "wallet" };
    const w = await copyCampaign();
    expect([w.statusCode, w.body.error.code]).toEqual([422, "linkedin_ads_wallet_campaign"]);
    const wg = await copyGroup();
    expect([wg.statusCode, wg.body.error.code]).toEqual([422, "linkedin_ads_wallet_campaign"]);
    h.groupCampaigns = [{ ...h.campaign, status: "ARCHIVED" }];
    expect((await copyGroup()).statusCode).toBe(201);
    h.actions.length = 0;
    h.runs.length = 0;
    h.rpcCalls.length = 0;
    h.wallet = null;
    const g = await copyGroup({ account_id: ACCOUNT }, "1");
    expect([g.statusCode, g.body.error.code]).toEqual([404, "linkedin_ads_group_not_found"]);
    expectNothingWritten();
  });

  it("a second copy of the same campaign is 409 linkedin_ads_duplicate_pending, while a group that shares the number still files", async () => {
    expect((await copyCampaign()).statusCode).toBe(201);
    const again = await copyCampaign();
    expect([again.statusCode, again.body.error.code]).toEqual([409, "linkedin_ads_duplicate_pending"]);
    expect(h.actions).toHaveLength(1);
    h.group = { ...h.group!, id: CAMPAIGN };
    expect((await copyGroup({ account_id: ACCOUNT }, CAMPAIGN)).statusCode).toBe(201);
    expect(h.actions).toHaveLength(2);
  });
});
