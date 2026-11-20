import { beforeEach, describe, expect, it, vi } from "vitest";
const armStop = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => (_a[2] ? { ok: true as boolean, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." as string | null, why: "" } : { ok: true as boolean, line: null as string | null, why: "" })));
vi.mock("@/services/growth/test-stops", async (orig) => ({ ...(await orig<typeof import("@/services/growth/test-stops")>()), armCreatedTestStop: async (...a: unknown[]) => (await armStop(...a)) ?? (a[2] ? { ok: true, line: "Runs $48/day until Nov 3, planned about $480. Zavi pauses it if spend gets there." } : { ok: true, line: null }) }));
const testEndMock = vi.hoisted(() => ({ end: null as null | { decision_id: string; channel: string | null; ends_on: string } }));
vi.mock("@/services/growth/cgo-test-end", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-test-end")>()),
  cgoTestEndForRun: vi.fn(async () => testEndMock.end),
}));
import { makeFakeTiktok, type FakeTiktok } from "./fake-tiktok";
const noFriction = vi.hoisted(() => ({ on: true }));
vi.mock("@/services/growth/ads-no-friction-flag", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/ads-no-friction-flag")>()),
  adsNoFrictionEnabled: async () => noFriction.on,
}));
import { TIKTOK_AGE_GROUPS } from "../targeting";

const s = vi.hoisted(() => ({
  fake: null as unknown as FakeTiktok,
  role: "owner" as string | null,
  lock: "on" as "on" | "locked",
  holds: new Map<string, { status: string; ref: unknown; object_id: string | null; daily: number; paused: boolean | undefined }>(),
  holdAnswer: "held" as "held" | "refused" | "no_budget",
  country: "US" as string | null,
  store: new Map<string, Record<string, unknown>>(),
  changes: [] as Array<Record<string, unknown>>,
  autopilotBudget: null as Record<string, unknown> | null,
  gate: ["allow"] as string[],
  gateCalls: 0,
}));
vi.mock("@/services/growth/cgo-ads", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-ads")>()),
  cgoAdBudget: async () => s.autopilotBudget,
}));
vi.mock("@/services/growth/unattended-policy", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/unattended-policy")>()),
  authorizeUnattended: async () => {
    const v = s.gate[Math.min(s.gateCalls++, s.gate.length - 1)];
    return v === "allow" ? { verdict: "allow", reasons: [] } : { verdict: "ask_founder", reasons: ["channel_asks_first"] };
  },
}));

vi.mock("@/services/connectors/composio/account", () => ({
  resolveOwnedComposioAccount: async () => ({ tenant_id: "T", toolkit: "tiktok_ads", connected_account_id: "ca1", auth_config_id: "ac1" }),
}));
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: (a: never) => s.fake.proxy(a) }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({
  ensureAdAccounts: async () => ({
    connected: true,
    accounts: [{ advertiser_id: "7689989546330849300", name: "Main", currency: "USD", status: "ENABLE", timezone: "Etc/GMT+8", source: "business_center" }],
    selected_id: "7689989546330849300",
    needs: "nothing",
    checked_at: "x",
  }),
}));
vi.mock("@/services/decisions/ad-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/decisions/ad-budget")>()),
  reserveAdSpend: async (d: { id: string }, a: { platform: string; op: string; object_id: string | null; daily_delta_usd: number; paused?: boolean; delivery_factor?: number }) => {
    s.fake.f.events.push(`reserve ${a.platform} ${a.op} ${a.daily_delta_usd} paused=${a.paused} factor=${a.delivery_factor ?? 1}`);
    if (s.holdAnswer === "refused") return { status: "refused", error: "cap_refuse: ad_budget_over_month" };
    if (s.holdAnswer === "no_budget") return { status: "no_budget" };
    const key = `${d.id}:${a.op}`;
    const h = s.holds.get(key);
    if (h && (h.status === "reserved" || h.status === "committed")) return { status: "held", tenant_id: "T", idem_key: key, fresh: false };
    s.holds.set(key, { status: "reserved", ref: h?.ref ?? null, object_id: h?.object_id ?? null, daily: a.daily_delta_usd, paused: a.paused });
    return { status: "held", tenant_id: "T", idem_key: key, fresh: true };
  },
  noteAdSpendRef: async (h: { status: string; idem_key: string }, ref: unknown) => {
    if (h.status === "held") s.holds.get(h.idem_key)!.ref = ref;
    return null;
  },
  dropAdSpendHold: async (h: { status: string; idem_key: string; fresh: boolean }) => {
    if (h.status === "held" && h.fresh) {
      s.holds.get(h.idem_key)!.status = "released";
      s.fake.f.events.push("release");
    }
  },
  commitAdSpend: async (h: { status: string; idem_key: string }, id: string) => {
    if (h.status !== "held") return;
    const x = s.holds.get(h.idem_key)!;
    x.status = "committed";
    x.object_id = id;
    s.fake.f.events.push(`commit ${id}`);
  },
  readActiveAdBudget: async () => null,
  budgetMargin: () => 1.25,
}));
vi.mock("@/services/decisions/ad-changes", () => ({
  recordZaviAdChange: async (_t: string, from: unknown, change: Record<string, unknown>) => void s.changes.push({ from, ...change }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => s.role }));
vi.mock("@/services/channels/lock", () => ({
  assertSpendWritesOn: async (_s: string, label: string, code: string) => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    if (s.lock === "locked") throw new ExpectedToolError(`${code}_write_disabled`, `${label} changes are switched off`);
  },
}));
vi.mock("@/services/ad-locations/country", () => ({
  businessCountry: async () => (s.country ? { code: s.country, name: s.country } : null),
  countryName: (c: string) => (c === "US" ? "United States" : c),
}));
vi.mock("@/services/onboarding/enrichment/url-guard", async (orig) => {
  const real = await orig<typeof import("@/services/onboarding/enrichment/url-guard")>();
  return {
    ...real,
    assertSafeUrl: async (u: string) => {
      const url = new URL(u);
      if (url.protocol !== "https:") throw new real.SsrfBlockedError("scheme", "ssrf_scheme");
      if (url.hostname.endsWith(".internal")) throw new real.SsrfBlockedError("private");
      return url;
    },
  };
});
vi.mock("@/services/connectors/tiktok-ads/zavi-videos", () => ({ listZaviVideos: async () => [], signedZaviVideoUrl: async () => ({ url: "https://store.test/v.mp4", filename: "v.mp4" }) }));
vi.mock("@/services/connectors/tiktok-ads/launch-store", () => ({
  launchStore: (_t: string, actionId: string) => ({
    load: async () => (s.store.get(actionId) as never) ?? null,
    save: async (ids: Record<string, unknown>) => void s.store.set(actionId, { ...ids }),
  }),
}));

const claims = vi.hoisted(() => ({ held: new Map<string, string>(), others: [] as string[], fail: false, released: [] as string[], loseBeforeEnable: 0 }));
vi.mock("@/services/connectors/tiktok-ads/launch-claim", () => ({
  claimLaunch: async (_t: string, adv: string, actionId: string) => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    if (claims.fail) throw new ExpectedToolError("tiktok_ads_launch_state_unreadable", "unreadable");
    const cur = claims.held.get(adv);
    if (cur && cur !== actionId) throw new ExpectedToolError("tiktok_ads_launch_in_flight", `Another TikTok launch (card ${cur}) is being carried out`);
    claims.held.set(adv, actionId);
    let checks = 0;
    return {
      token: "t1",
      verify: async () => {
        checks++;
        if (claims.loseBeforeEnable && checks >= claims.loseBeforeEnable) throw new ExpectedToolError("tiktok_ads_launch_claim_lost", "Another run took over this TikTok launch");
      },
      release: async () => { claims.released.push(actionId); if (claims.held.get(adv) === actionId) claims.held.delete(adv); },
    };
  },
  otherLaunchesExecuting: async () => claims.others,
}));

import { executeTiktokLaunch, launchTiming } from "../launch-execute";
import { launchState, scheduleStart, withLaunchUtm } from "../launch-schema";
import { describeTiktokAction } from "@/services/tools/tiktok-ads/_exec-action";

const ADV = "7689989546330849300";
const ACTION = "6f2c4d1e-9a8b-4c7d-8e6f-0a1b2c3d4e5f";
const TAG = "zv6f2c4d1e9a";

function seedVideo(spec: Partial<{ width: number; height: number; duration: number; allowed_placements: string[] }> = {}): string {
  const vid = "v10033g50000seeded";
  s.fake.f.videos.set(vid, { video_id: vid, width: 720, height: 1280, duration: 12, allowed_placements: ["PLACEMENT_TIKTOK", "PLACEMENT_PANGLE"], displayable: true, video_cover_url: "http://p16-common-sign.tiktokcdn.com/c~tplv-noop.image", ...spec });
  return vid;
}

const body = (over: Record<string, unknown> = {}) => ({
  advertiser_id: ADV,
  advertiser_name: "Main",
  campaign_type: "TRAFFIC",
  budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
  name: "Spring test",
  locations: [{ location_id: "6252001", country_code: "US", name: "United States" }],
  daily_budget_usd: 25,
  start_time: "2026-10-11T00:00:00.000Z",
  video: { video_id: "v10033g50000seeded", source: "zavi", artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", width: 720, height: 1280, duration_s: 12 },
  identity: { identity_id: "8f5d4c18-e601-5496-b38f-566335ea3ec3", identity_type: "BC_AUTH_TT", identity_authorized_bc_id: "7695136887945789461", display_name: "brand handle" },
  ad_text: "See how it works",
  call_to_action: "LEARN_MORE",
  landing_url: "https://shop.example.com/start?ref=bio#top",
  hold_estimate_usd: 656.25,
  rationale: "first readable test",
  ...over,
});
const row = (over: Record<string, unknown> = {}, b: unknown = body()) => ({ id: ACTION, tenant_id: "T", decision_class: "tiktok_ads.create_launch", body: b, approved_by: "u1", approved_by_source: null, exec_source: "channel_actions", agent_run_id: "r1", ...over });

const f = () => s.fake.f;
const hold = () => s.holds.get(`${ACTION}:create`);
const live = (m: Map<string, Record<string, unknown>>) => [...m.values()].filter((o) => !o.deleted);
const enables = () => f().events.filter((e) => e.endsWith(" ENABLE"));

launchTiming.sleep = async () => {};

beforeEach(() => {
  claims.held = new Map();
  claims.others = [];
  claims.fail = false;
  claims.released = [];
  claims.loseBeforeEnable = 0;
  s.fake = makeFakeTiktok();
  s.role = "owner";
  s.lock = "on";
  s.holds = new Map();
  s.holdAnswer = "held";
  s.country = "US";
  s.store = new Map();
  s.changes = [];
  s.autopilotBudget = null;
  testEndMock.end = null;
  noFriction.on = true;
  s.gate = ["allow"];
  s.gateCalls = 0;
  seedVideo();
});

describe("a launch: one tagged campaign + ad group + ad, made off, switched on campaign last", () => {
  it("never silently turns a legacy fixed-daily approval into a dynamic-daily launch", async () => {
    const legacy = body({ budget_mode: undefined });
    expect(await executeTiktokLaunch(row({}, legacy))).toMatchObject({ ok: false, code: "tiktok_ads_launch_review_required" });
    expect(f().posts).toEqual([]);
    expect(f().events.some(e => e.startsWith("reserve"))).toBe(false);
    expect(hold()).toBeUndefined();
  });
  it("sends reviewed advanced controls and enables only after matching readback", async () => {
    const chosen = { operating_systems: ["IOS"], network_types: ["WIFI"], comment_disabled: true, bid_type: "BID_TYPE_CUSTOM", bid_price: 1.5, dayparting: "1".repeat(48) + "0".repeat(288) };
    f().adgroupReadOverrides = chosen;
    const proxy = s.fake.proxy;
    s.fake.proxy = async request => {
      const response = await proxy(request);
      const url = new URL(request.endpoint, "https://business-api.tiktok.test");
      const fields = url.searchParams.get("fields");
      const data = (response.json as { data?: { list?: Record<string, unknown>[] } }).data;
      if (request.method === "GET" && url.pathname === "/adgroup/get/" && fields && data?.list) {
        const projection = new Set(JSON.parse(fields) as string[]);
        data.list = data.list.map(object => Object.fromEntries(Object.entries(object).filter(([key]) => projection.has(key))));
      }
      return response;
    };
    expect((await executeTiktokLaunch(row({}, body(chosen)))).ok).toBe(true);
    expect(f().posts.find(p => p.endpoint === "/adgroup/create/")?.body).toMatchObject(chosen);
    expect(enables().length).toBeGreaterThan(0);
  });
  it("keeps a newly created campaign off if TikTok drops a reviewed advanced setting", async () => {
    f().adgroupReadOverrides = { comment_disabled: false };
    const result = await executeTiktokLaunch(row({}, body({ comment_disabled: true })));
    expect(result).toMatchObject({ ok: false, code: "exec_partial" });
    expect(result.error).toContain("advanced");
    expect(enables()).toEqual([]);
  });
  it.each([
    { age_groups: null },
    { gender: "GENDER_MALE" },
    { languages: ["en"] },
  ])("does not activate a newly created group whose audience differs: %j", async (readback) => {
    f().adgroupReadOverrides = readback;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(r.error).toContain("audience");
    expect(enables()).toEqual([]);
    expect(hold()?.status).toBe("released");
  });

  it("sends old cards as explicit adults, every gender and every language", async () => {
    expect((await executeTiktokLaunch(row())).ok).toBe(true);
    expect(f().posts.find((p) => p.endpoint === "/adgroup/create/")?.body).toMatchObject({ age_groups: [...TIKTOK_AGE_GROUPS], gender: "GENDER_UNLIMITED", languages: [] });
    expect(f().events).not.toContain("GET /tool/language/");
  });

  it("sends all selected audience fields and rechecks selected languages before holding spend", async () => {
    const chosen = { age_groups: ["AGE_25_34"], gender: "GENDER_FEMALE", languages: ["en", "zh-Hant"] };
    expect((await executeTiktokLaunch(row({}, body(chosen)))).ok).toBe(true);
    expect(f().posts.find((p) => p.endpoint === "/adgroup/create/")?.body).toMatchObject(chosen);
    expect(f().events.indexOf("GET /tool/language/")).toBeLessThan(f().events.findIndex((e) => e.startsWith("reserve")));
  });

  it("a language no longer offered refuses approval before any hold or write", async () => {
    f().languages = f().languages.filter((l) => l.code !== "en");
    expect(await executeTiktokLaunch(row({}, body({ languages: ["en"] })))).toMatchObject({ ok: false, code: "tiktok_ads_language_not_allowed" });
    expect(f().posts).toEqual([]);
    expect(f().events.some((e) => e.startsWith("reserve"))).toBe(false);
  });

  it("MUST CATCH (live 2026-10-12): TikTok leaves each new object out of reads for a moment; the launch still finishes in ONE approval", async () => {
    f().listLag = 2;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "pending_review" } });
    expect(live(f().campaigns)).toHaveLength(1);
    expect(live(f().adgroups)).toHaveLength(1);
    expect(live(f().ads)).toHaveLength(1);
  });

  it("an object still missing after every read-back try is a doubt: switched off, never a second create", async () => {
    f().listLag = 99;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false });
    expect(live(f().campaigns).length).toBeLessThanOrEqual(1);
    expect(f().posts.filter((p) => p.endpoint === "/campaign/create/")).toHaveLength(1);
  });

  it("creates exactly one of each, all DISABLE, reads each back, enables ad -> ad group -> campaign, holds in full first", async () => {
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: true, execution_details: { execution_state: "pending_review" } });
    expect(live(f().campaigns)).toHaveLength(1);
    expect(live(f().adgroups)).toHaveLength(1);
    expect(live(f().ads)).toHaveLength(1);
    const creates = f().posts.filter((p) => /\/(campaign|adgroup)\/create\/$/.test(p.endpoint));
    for (const p of creates) expect(p.body.operation_status).toBe("DISABLE");
    const ad = f().posts.find((p) => p.endpoint === "/ad/create/")!;
    const cr = (ad.body.creatives as Array<Record<string, unknown>>)[0];
    expect(cr).toMatchObject({ operation_status: "DISABLE", identity_type: "BC_AUTH_TT", identity_authorized_bc_id: "7695136887945789461", ad_format: "SINGLE_VIDEO", video_id: "v10033g50000seeded" });
    expect((cr.image_ids as string[])[0]).toMatch(/^ad-site-i18n-sg\//);
    const c = live(f().campaigns)[0];
    const g = live(f().adgroups)[0];
    expect([c.campaign_name, g.adgroup_name, live(f().ads)[0].ad_name].every((n) => String(n).includes(TAG))).toBe(true);
    expect(c).toMatchObject({ objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE", operation_status: "ENABLE" });
    expect(g).toMatchObject({ budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET", budget: 25, location_ids: ["6252001"], placements: ["PLACEMENT_TIKTOK"], optimization_goal: "CLICK" });
    const landing = new URL(String(cr.landing_page_url));
    expect(landing.searchParams.get("ref")).toBe("bio");
    expect(landing.searchParams.get("utm_campaign")).toBe(TAG);
    expect(landing.searchParams.get("utm_source")).toBe("tiktok");
    expect(landing.hash).toBe("#top");
    const ev = f().events;
    const reserve = ev.findIndex((e) => e.startsWith("reserve"));
    expect(ev[reserve]).toBe("reserve tiktok create 25 paused=false factor=1.25");
    expect(reserve).toBeLessThan(ev.findIndex((e) => e.startsWith("POST")));
    expect(enables()).toEqual(["POST /ad/status/update/ ENABLE", "POST /adgroup/status/update/ ENABLE", "POST /campaign/status/update/ ENABLE"]);
    expect(hold()).toMatchObject({ status: "committed", object_id: g.id, ref: { kind: "tiktok_tag", advertiser_id: ADV, tag: TAG } });
    expect(f().posts.some((p) => p.body.operation_status === "DELETE")).toBe(false);
    expect(r.notice).toContain("reviewing");
    expect(r.notice).not.toMatch(/\blive\b/i);
    expect(r.notice).toContain("Measured: clicks and site visits (not sales).");
    expect(r.created).toMatchObject({ platform: "tiktok", object_type: "campaign", id: c.id });
    expect(r.execution_details?.external_ids).toMatchObject({ tag: TAG, campaign_id: c.id, adgroup_id: g.id, hold: { status: "held" } });
  });

  it("reports live only when TikTok says it is delivering, and never for review or an unknown state", async () => {
    f().review = "AD_STATUS_DELIVERY_OK";
    expect((await executeTiktokLaunch(row())).execution_details?.execution_state).toBe("live");
    s.fake = makeFakeTiktok();
    seedVideo();
    s.holds = new Map();
    s.store = new Map();
    f().review = "AD_STATUS_BALANCE_EXCEED";
    const r = await executeTiktokLaunch(row());
    expect(r.execution_details?.execution_state).toBe("on_unconfirmed");
    expect(r.notice).not.toMatch(/\blive\b|delivering\./i);
  });

  it("a disapproved ad: the campaign is switched off and confirmed off, the hold goes back, nothing is deleted, never 'live'", async () => {
    f().review = "AD_STATUS_AUDIT_DENY";
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_launch_disapproved" });
    expect(live(f().campaigns)[0].operation_status).toBe("DISABLE");
    expect(hold()?.status).toBe("released");
    expect(f().posts.some((p) => p.body.operation_status === "DELETE")).toBe(false);
    expect(r.error).not.toMatch(/\blive\b/i);
  });

  it("the card shows every choice, the amount held and what is measured", () => {
    const card = describeTiktokAction("tiktok_ads.create_launch", body());
    expect(card.actionType).toBe("create_ad");
    const rows = Object.fromEntries(card.rows.map((x) => [x.item, x.after]));
    expect(rows["Held from your ad budget"]).toBe("$656.25 for the rest of this month");
    expect(rows["Average daily budget"]).toContain("$25.00 average per day");
    expect(rows["Average daily budget"]).toContain("$31.25");
    expect(rows["Measured"]).toBe("Clicks and site visits (not sales)");
    expect(rows["Where"]).toBe("United States");
    expect(card.sentence).toContain("Measured: clicks and site visits (not sales).");
    expect(describeTiktokAction("tiktok_ads.create_launch", body({ hold_estimate_usd: null })).rows.find((x) => x.item === "Held from your ad budget")?.after).toMatch(/^Nothing/);
  });
});

async function faultThenRetry(fault: Parameters<FakeTiktok["f"]["faults"]["push"]>[0]) {
  s.fake = makeFakeTiktok();
  seedVideo();
  s.holds = new Map();
  s.store = new Map();
  f().faults.push(fault);
  const first = await executeTiktokLaunch(row());
  if (hold()?.status === "released") expect(live(f().campaigns).every((c) => c.operation_status === "DISABLE")).toBe(true);
  if (first.outcome_unknown) expect(hold()?.status).toBe("reserved");
  expect(f().posts.some((p) => p.body.operation_status === "DELETE")).toBe(false);
  const second = await executeTiktokLaunch(row());
  return { first, second };
}

describe("must-catch 1: a fault after every POST and every read, then a retry", () => {
  it("baseline counts", async () => {
    await executeTiktokLaunch(row());
    expect(f().counts.get("POST")).toBe(7);
    expect(f().counts.get("GET")).toBeGreaterThan(10);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])("the response of POST #%i is lost after TikTok applied it", async (nth) => {
    const { second } = await faultThenRetry({ method: "POST", nth: undefined, kind: "lost", path: ["/file/image/ad/upload/", "/campaign/create/", "/adgroup/create/", "/ad/create/", "/ad/status/update/", "/adgroup/status/update/", "/campaign/status/update/"][nth - 1] });
    expect(second.ok).toBe(true);
    expect(live(f().campaigns)).toHaveLength(1);
    expect(live(f().adgroups)).toHaveLength(1);
    expect(live(f().ads)).toHaveLength(1);
    expect(s.holds.size).toBe(1);
    expect(hold()).toMatchObject({ status: "committed", object_id: live(f().adgroups)[0].id, ref: { kind: "tiktok_tag", tag: TAG } });
  });

  it("every read, one at a time, fails once", async () => {
    await executeTiktokLaunch(row());
    const total = f().counts.get("GET")!;
    for (let nth = 1; nth <= total; nth++) {
      const { second } = await faultThenRetry({ method: "GET", nth, kind: "fail" });
      expect(second.ok, `GET #${nth}`).toBe(true);
      expect(live(f().campaigns), `GET #${nth}`).toHaveLength(1);
      expect(live(f().adgroups), `GET #${nth}`).toHaveLength(1);
      expect(live(f().ads), `GET #${nth}`).toHaveLength(1);
      expect(s.holds.size).toBe(1);
      expect(hold()?.status, `GET #${nth}`).toBe("committed");
    }
  });
});

describe("must-catch 2: an unknown answer during an enable or the switch-off", () => {
  it.each(["/ad/status/update/", "/adgroup/status/update/", "/campaign/status/update/"])("%s times out before applying: off confirmed, hold back, retry finishes", async (path) => {
    const { first, second } = await faultThenRetry({ method: "POST", path, kind: "lost_unapplied" });
    expect(first).toMatchObject({ ok: false, code: "tiktok_ads_launch_stopped" });
    expect(second.ok).toBe(true);
  });

  it("the campaign switch-on lands but its answer is lost, and the switch-off times out: the hold is KEPT, outcome unknown", async () => {
    f().faults.push({ method: "POST", path: "/campaign/status/update/", kind: "lost" }, { method: "POST", path: "/campaign/status/update/", kind: "lost_unapplied" });
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(live(f().campaigns)[0].operation_status).toBe("ENABLE");
    expect(hold()?.status).toBe("reserved");
    expect(f().events).not.toContain("release");
  });

  it("the switch-on lands, the read-back fails and the switch-off's read-back fails too: the hold is KEPT", async () => {
    f().faults.push({ method: "POST", path: "/campaign/status/update/", kind: "lost" });
    const proxy = s.fake.proxy;
    s.fake.proxy = (async (a: { method: string; endpoint: string; body?: Record<string, unknown> }) => {
      const r = await proxy(a as never);
      if (a.method === "POST" && a.endpoint === "/campaign/status/update/" && a.body?.operation_status === "ENABLE") {
        for (let i = 0; i < 20; i++) f().faults.push({ method: "GET", path: "/campaign/get/", kind: "fail" });
        f().faults.push({ method: "POST", path: "/campaign/status/update/", kind: "lost_unapplied" });
      }
      return r;
    }) as typeof proxy;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown", outcome_unknown: true });
    expect(hold()?.status).toBe("reserved");
    expect(f().events).not.toContain("release");
  });
});

describe("must-catch 3: the hold", () => {
  it("a refused hold creates nothing at all", async () => {
    s.holdAnswer = "refused";
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_budget_refused" });
    expect(f().posts).toEqual([]);
  });

  it("TikTok's definite refusal before delivery (no payment method) gives the hold back and creates nothing", async () => {
    f().paymentMissing = true;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_payment_required" });
    expect(r.error).toContain("Complete payment to continue");
    expect(r.error).toMatch(/payment method/);
    expect(hold()?.status).toBe("released");
    expect(live(f().campaigns)).toHaveLength(0);
  });

  it("no active ad budget: runs exactly as before, nothing held", async () => {
    s.holdAnswer = "no_budget";
    const r = await executeTiktokLaunch(row());
    expect(r.ok).toBe(true);
    expect(s.holds.size).toBe(0);
  });
});

describe("must-catch 4: refusals before any hold", () => {
  const before = async (r: Awaited<ReturnType<typeof executeTiktokLaunch>>, code: string) => {
    expect(r).toMatchObject({ ok: false, code });
    expect(f().events.some((e) => e.startsWith("reserve"))).toBe(false);
    expect(f().posts).toEqual([]);
  };

  it("ad account not ready, or not in USD", async () => {
    f().advertiser.status = "STATUS_CONTRACT_PENDING";
    await before(await executeTiktokLaunch(row()), "tiktok_ads_account_not_ready");
    f().advertiser.status = "STATUS_ENABLE";
    f().advertiser.currency = "EUR";
    await before(await executeTiktokLaunch(row()), "tiktok_ads_currency_unsupported");
  });

  it("the TikTok account is no longer linked: the fix names the Business Center steps", async () => {
    f().identities = f().identities.filter((i) => i.identity_type === "CUSTOMIZED_USER");
    const r = await executeTiktokLaunch(row());
    await before(r, "tiktok_ads_no_identity");
    expect(r.error).toContain("Business Center go to Accounts > TikTok accounts");
  });

  it("a location TikTok does not let this account target (checked live), or no country on file", async () => {
    await before(await executeTiktokLaunch(row({}, body({ locations: [{ location_id: "2635167", country_code: "GB", name: "United Kingdom" }] }))), "tiktok_ads_location_not_allowed");
    await before(await executeTiktokLaunch(row({}, body({ locations: [{ location_id: "1269750", country_code: "IN", name: "India" }] }))), "tiktok_ads_location_not_allowed");
    s.country = null;
    await before(await executeTiktokLaunch(row()), "tiktok_ads_no_country");
  });

  it("a video that is not 9:16, too long, or not allowed on TikTok", async () => {
    seedVideo({ width: 1280, height: 720 });
    await before(await executeTiktokLaunch(row()), "tiktok_ads_video_not_vertical");
    seedVideo({ duration: 75 });
    await before(await executeTiktokLaunch(row()), "tiktok_ads_video_length");
    seedVideo({ allowed_placements: ["PLACEMENT_PANGLE"] });
    await before(await executeTiktokLaunch(row()), "tiktok_ads_video_placement");
  });

  it("an unsafe landing page, a locked channel, Autopilot with no ad budget, a member, staff", async () => {
    await before(await executeTiktokLaunch(row({}, body({ landing_url: "https://admin.internal/x" }))), "tiktok_ads_landing_url_unsafe");
    s.lock = "locked";
    await before(await executeTiktokLaunch(row()), "tiktok_ads_write_disabled");
    s.lock = "on";
    const cgo = await executeTiktokLaunch(row({ approved_by_source: "cgo", approved_by: null }));
    await before(cgo, "tiktok_ads_autopilot_off");
    expect(cgo.held_for_founder).toBe(true);
    s.role = "member";
    await before(await executeTiktokLaunch(row()), "tiktok_ads_admin_required");
    s.role = "owner";
    await before(await executeTiktokLaunch(row({ approved_by_source: "staff" })), "tiktok_ads_approval_required");
  });

  it("an invalid body: a budget at TikTok's floor, a campaign type not offered, a custom identity, http", async () => {
    await before(await executeTiktokLaunch(row({}, body({ daily_budget_usd: 20 }))), "tiktok_ads_body_invalid");
    await before(await executeTiktokLaunch(row({}, body({ campaign_type: "WEB_CONVERSIONS" }))), "tiktok_ads_body_invalid");
    await before(await executeTiktokLaunch(row({}, body({ identity: { identity_id: "7695135145485434887", identity_type: "CUSTOMIZED_USER", display_name: null } }))), "tiktok_ads_body_invalid");
    await before(await executeTiktokLaunch(row({}, body({ landing_url: "http://shop.example.com" }))), "tiktok_ads_body_invalid");
  });

  it("TikTok's own 'Custom identities are no longer supported' at ad create: off confirmed, hold back, the fix names the steps", async () => {
    f().customOnly = true;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_identity_unsupported" });
    expect(r.error).toContain("Custom identities are no longer supported");
    expect(r.error).toContain("Accounts > TikTok accounts");
    expect(r.error).not.toContain("Approve again");
    expect(live(f().campaigns)[0].operation_status).toBe("DISABLE");
    expect(hold()?.status).toBe("released");
  });
});

describe("a retry resumes from the saved ids and never recreates", () => {
  it("a second run of a finished card makes nothing new", async () => {
    await executeTiktokLaunch(row());
    const posts = f().posts.filter((p) => p.endpoint.endsWith("/create/")).length;
    await executeTiktokLaunch(row());
    expect(f().posts.filter((p) => p.endpoint.endsWith("/create/")).length).toBe(posts);
    expect(live(f().campaigns)).toHaveLength(1);
  });

  it("an object the launch made and the founder deleted is never replaced under the same card", async () => {
    f().faults.push({ method: "POST", path: "/ad/create/", kind: "lost_unapplied" });
    await executeTiktokLaunch(row());
    for (const g of f().adgroups.values()) g.deleted = true;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(live(f().adgroups)).toHaveLength(0);
    expect(hold()?.status).toBe("released");
  });
});

describe("the landing page: the founder's own link is never changed, Zavi's tag is only added", () => {
  const tag = "zv0123456789";
  const q = (u: string) => new URL(u).searchParams;
  it("a link with no query gets source, medium and the tag as utm_campaign", () => {
    const u = withLaunchUtm("https://shop.example.com/start", tag);
    expect(Object.fromEntries(q(u))).toEqual({ utm_source: "tiktok", utm_medium: "paid_social", utm_campaign: tag });
  });
  it("the founder's utm_* values stay as they are; the tag rides in zavi_launch", () => {
    const u = withLaunchUtm("https://shop.example.com/?utm_source=bio&utm_medium=social&utm_campaign=fall", tag);
    expect(Object.fromEntries(q(u))).toEqual({ utm_source: "bio", utm_medium: "social", utm_campaign: "fall", zavi_launch: tag });
  });
  it("other parameters and the fragment are kept, in order", () => {
    const u = withLaunchUtm("https://shop.example.com/p?ref=bio&x=1&x=2#top", tag);
    expect(u.startsWith("https://shop.example.com/p?ref=bio&x=1&x=2&")).toBe(true);
    expect(q(u).getAll("x")).toEqual(["1", "2"]);
    expect(new URL(u).hash).toBe("#top");
    expect(q(u).get("utm_campaign")).toBe(tag);
  });
  it("only a missing utm_source is added; a founder's own zavi_launch is left alone", () => {
    expect(Object.fromEntries(q(withLaunchUtm("https://s.example.com/?utm_medium=email", tag)))).toEqual({ utm_medium: "email", utm_source: "tiktok", utm_campaign: tag });
    expect(q(withLaunchUtm("https://s.example.com/?utm_campaign=a&zavi_launch=mine", tag)).getAll("zavi_launch")).toEqual(["mine"]);
  });
});

describe("the launch is recorded as Zavi's change, only once it is really on", () => {
  it("a confirmed launch records the campaign's and ad group's switch-on and the ad group's budget, as Zavi, on this card", async () => {
    const r = await executeTiktokLaunch(row());
    expect(r.ok).toBe(true);
    const c = live(f().campaigns)[0];
    const g = live(f().adgroups)[0];
    const from = { table: "channel_actions", id: ACTION };
    expect(s.changes).toEqual([
      expect.objectContaining({ from, platform: "tiktok", object_id: c.id, level: "campaign", change_kind: "status", before_status: "PAUSED", after_status: "ACTIVE" }),
      expect.objectContaining({ from, platform: "tiktok", object_id: g.id, campaign_id: c.id, level: "ad_group", change_kind: "status", before_status: "PAUSED", after_status: "ACTIVE" }),
      expect.objectContaining({ from, platform: "tiktok", object_id: g.id, campaign_id: c.id, level: "ad_group", change_kind: "budget", before_daily_usd: null, after_daily_usd: 25 }),
    ]);
  });

  it("nothing is recorded for a disapproved, stopped or unknown launch", async () => {
    f().review = "AD_STATUS_AUDIT_DENY";
    expect((await executeTiktokLaunch(row())).ok).toBe(false);
    expect(s.changes).toEqual([]);
    for (const fault of [
      { method: "POST" as const, path: "/campaign/status/update/", kind: "lost_unapplied" as const },
      { method: "POST" as const, path: "/ad/create/", kind: "lost" as const },
    ]) {
      s.fake = makeFakeTiktok();
      seedVideo();
      s.holds = new Map();
      s.store = new Map();
      f().faults.push(fault);
      expect((await executeTiktokLaunch(row())).ok).toBe(false);
      expect(s.changes).toEqual([]);
    }
    s.fake = makeFakeTiktok();
    seedVideo();
    s.holds = new Map();
    s.store = new Map();
    f().faults.push({ method: "POST", path: "/campaign/status/update/", kind: "lost" }, { method: "POST", path: "/campaign/status/update/", kind: "lost_unapplied" });
    expect(await executeTiktokLaunch(row())).toMatchObject({ code: "exec_outcome_unknown" });
    expect(s.changes).toEqual([]);
  });
});

describe("F1: standard v1.3 schedule times are UTC for every advertiser timezone", () => {
  const start = "2026-01-15T18:00:00.000Z";
  const early = new Date("2026-01-15T10:00:00Z");
  it("UTC-8, Etc/GMT+5 (which is UTC-5), UTC+5:30, and both sides of a DST change", () => {
    expect(scheduleStart(start, early, "America/Los_Angeles")).toBe("2026-01-15 18:00:00");
    expect(scheduleStart(start, early, "Etc/GMT+5")).toBe("2026-01-15 18:00:00");
    expect(scheduleStart(start, early, "Asia/Kolkata")).toBe("2026-01-15 18:00:00");
    expect(scheduleStart("2026-03-08T09:59:00.000Z", new Date("2026-03-01T00:00:00Z"), "America/Los_Angeles")).toBe("2026-03-08 09:59:00");
    expect(scheduleStart("2026-03-08T10:01:00.000Z", new Date("2026-03-01T00:00:00Z"), "America/Los_Angeles")).toBe("2026-03-08 10:01:00");
  });
  it("never earlier than five minutes from now, and an unknown zone throws", () => {
    expect(scheduleStart("2020-01-01T00:00:00.000Z", new Date("2026-01-15T18:00:00Z"), "Etc/GMT+5")).toBe("2026-01-15 18:05:00");
    expect(() => scheduleStart(start, early, "Mars/Olympus")).toThrow();
  });
  it("the ad group is created with the requested UTC instant on a UTC-8 account", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-10T20:00:00Z"), toFake: ["Date"] });
    try {
      await executeTiktokLaunch(row({}, body({ start_time: "2026-10-11T00:00:00.000Z" })));
    } finally {
      vi.useRealTimers();
    }
    expect(f().posts.find((p) => p.endpoint === "/adgroup/create/")?.body.schedule_start_time).toBe("2026-10-11 00:00:00");
  });
  it("rejects a provider-shifted UTC start before enabling", async () => {
    f().adgroupReadOverrides = { schedule_start_time: "2027-01-01 08:00:00" };
    const result = await executeTiktokLaunch(row({}, body({ start_time: "2027-01-01T00:00:00.000Z" })));
    expect(result.ok).toBe(false);
    expect(enables()).toEqual([]);
  });
  it("verifies a user's end date even outside a CGO test", async () => {
    f().dropScheduleEnd = true;
    const result = await executeTiktokLaunch(row({}, body({ end_date: "2027-01-15" })));
    expect(result.ok).toBe(false);
    expect(enables()).toEqual([]);
  });
  it("refuses an out-of-range start before reserving money or creating objects", async () => {
    const result = await executeTiktokLaunch(row({}, body({ start_time: "2028-01-01T00:00:01.000Z" })));
    expect(result).toMatchObject({ ok: false, code: "tiktok_ads_schedule_invalid" });
    expect(f().posts).toEqual([]);
    expect(f().events.some(event => event.startsWith("reserve"))).toBe(false);
  });
  it("an account whose time zone is missing or unreadable is refused before any hold", async () => {
    for (const tz of [null, "Not/AZone"]) {
      s.fake = makeFakeTiktok();
      seedVideo();
      f().advertiser.timezone = tz;
      const r = await executeTiktokLaunch(row());
      expect(r).toMatchObject({ ok: false, code: "tiktok_ads_timezone_unknown" });
      expect(f().events.some((e) => e.startsWith("reserve"))).toBe(false);
      expect(f().posts).toEqual([]);
    }
  });
});

describe("F2: live only when the ad itself delivers", () => {
  it("a parent delivering while the ad is still being created is not live", () => {
    expect(launchState({ campaign: "CAMPAIGN_STATUS_ENABLE", ad_group: "ADGROUP_STATUS_DELIVERY_OK", ad: "AD_STATUS_CREATE" })).toBe("on_unconfirmed");
    expect(launchState({ campaign: "CAMPAIGN_STATUS_ENABLE", ad_group: "ADGROUP_STATUS_DELIVERY_OK", ad: "AD_STATUS_DELIVERY_OK" })).toBe("live");
    expect(launchState({ campaign: "CAMPAIGN_STATUS_ENABLE", ad_group: "ADGROUP_STATUS_AUDIT", ad: "AD_STATUS_DELIVERY_OK" })).toBe("pending_review");
    expect(launchState({ campaign: "CAMPAIGN_STATUS_ENABLE", ad_group: "ADGROUP_STATUS_NOT_START", ad: "AD_STATUS_DELIVERY_OK" })).toBe("scheduled");
    expect(launchState({ campaign: "CAMPAIGN_STATUS_ENABLE", ad_group: "ADGROUP_STATUS_DELIVERY_OK", ad: "AD_STATUS_AUDIT_DENY" })).toBe("disapproved");
    expect(launchState({ campaign: "CAMPAIGN_STATUS_BUDGET_EXCEED", ad_group: "ADGROUP_STATUS_DELIVERY_OK", ad: "AD_STATUS_DELIVERY_OK" })).toBe("on_unconfirmed");
    expect(launchState({ campaign: "CAMPAIGN_STATUS_ENABLE", ad_group: "ADGROUP_STATUS_DELIVERY_OK", ad: "AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK" })).toBe("live");
  });
});

describe("F3: a retry never switches on an ad edited since it was made", () => {
  it.each([
    ["age_groups", []],
    ["age_groups", ["AGE_13_17", "AGE_18_24"]],
    ["gender", "GENDER_FEMALE"],
    ["languages", ["en"]],
  ])("an edited audience %s stays off on retry", async (field, value) => {
    f().faults.push({ method: "POST", path: "/ad/create/", kind: "lost_unapplied" });
    await executeTiktokLaunch(row());
    live(f().adgroups)[0][field as string] = value;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(r.error).toContain("audience");
    expect(enables()).toEqual([]);
    expect(hold()?.status).toBe("released");
  });

  it.each([
    ["landing_page_url", "https://elsewhere.example.com/"],
    ["video_id", "v10033g50000other"],
    ["identity_id", "someone-else"],
    ["ad_text", "Edited in Ads Manager"],
    ["call_to_action", "SHOP_NOW"],
  ])("an edited %s: the ad stays off, the card closes, the hold goes back", async (field, value) => {
    f().faults.push({ method: "POST", path: "/ad/status/update/", kind: "lost_unapplied" });
    expect(await executeTiktokLaunch(row())).toMatchObject({ ok: false, code: "tiktok_ads_launch_stopped" });
    const ad = live(f().ads)[0];
    ad[field] = value;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(r.error).toContain(field);
    expect(ad.operation_status).toBe("DISABLE");
    expect(live(f().campaigns)[0].operation_status).toBe("DISABLE");
    expect(enables().filter((e) => e.startsWith("POST /campaign"))).toEqual([]);
    expect(hold()?.status).toBe("released");
    expect(s.changes).toEqual([]);
  });

  it("an existing ad group whose budget was changed is not switched on either", async () => {
    f().faults.push({ method: "POST", path: "/ad/create/", kind: "lost_unapplied" });
    await executeTiktokLaunch(row());
    live(f().adgroups)[0].budget = 90;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "exec_partial" });
    expect(enables()).toEqual([]);
  });

  it("an untouched ad from an earlier attempt is reused and switched on", async () => {
    f().faults.push({ method: "POST", path: "/ad/status/update/", kind: "lost_unapplied" });
    await executeTiktokLaunch(row());
    expect((await executeTiktokLaunch(row())).ok).toBe(true);
    expect(live(f().ads)).toHaveLength(1);
  });
});

describe("a launch card whose hold a pending-test claim already took (pending-test-claim.ts)", () => {
  const seedClaim = async () => {
    const { claimIdemKey } = await import("@/services/growth/pending-test-claim");
    const key = claimIdemKey("tiktok_ads", ACTION);
    s.holds.set(key, { status: "reserved", ref: null, object_id: null, daily: 25, paused: false });
    return key;
  };

  it("approval finds the claimed hold and holds nothing twice: one hold, committed on the ad group", async () => {
    const key = await seedClaim();
    const r = await executeTiktokLaunch(row());
    expect(r.ok).toBe(true);
    expect([...s.holds.keys()]).toEqual([key]);
    expect(s.holds.get(key)).toMatchObject({ status: "committed", object_id: live(f().adgroups)[0].id, ref: { kind: "tiktok_tag", tag: TAG } });
  });

  it("a launch TikTok refuses after the hold leaves the claimed hold for the claim's own release, with a code that lets it go", async () => {
    const key = await seedClaim();
    f().paymentMissing = true;
    const r = await executeTiktokLaunch(row());
    expect(r.ok).toBe(false);
    expect(s.holds.get(key)?.status).toBe("reserved");
    expect(f().events).not.toContain("release");
    const { claimedVerdict } = await import("@/services/growth/pending-test-claim");
    expect(claimedVerdict({ status: "acted", exec_status: "failed", code: r.code ?? null }, false)).toBe("release");
  });
});

describe("one TikTok test at a time, enforced at the write (two cards approved)", () => {
  const OTHER = "0a0b0c0d-1111-4222-8333-444455556666";

  it("another launch is being carried out on this ad account (claim held): refused before the hold, nothing created, nothing held", async () => {
    claims.held.set(ADV, OTHER);
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_launch_in_flight" });
    expect(hold()).toBeUndefined();
    expect(f().posts.filter((p) => p.endpoint.endsWith("/create/"))).toEqual([]);
  });

  it("another launch card approved and not finished: refused before the hold; the claim is released", async () => {
    claims.others = [OTHER];
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_launch_in_flight", error: expect.stringContaining(OTHER) });
    expect(hold()).toBeUndefined();
    expect(claims.held.size).toBe(0);
    expect(claims.released).toEqual([ACTION]);
  });

  it("another Zavi launch campaign already switched on no longer blocks a new launch (Ravi 2026-10-14: more tests are okay)", async () => {
    f().campaigns.set("1878696308800001", { id: "1878696308800001", campaign_name: "Zavi · Other test · campaign · zv0123456789", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE", budget: 0, operation_status: "ENABLE" });
    expect(await executeTiktokLaunch(row())).toMatchObject({ ok: true });
    expect(hold()?.status).toBe("committed");
  });

  it("what is under way cannot be read: refused, nothing held", async () => {
    claims.fail = true;
    expect(await executeTiktokLaunch(row())).toMatchObject({ ok: false, code: "tiktok_ads_launch_state_unreadable" });
    expect(hold()).toBeUndefined();
  });

  it("a successful launch releases its claim, so the next card launches too instead of meeting a stuck claim", async () => {
    expect(await executeTiktokLaunch(row())).toMatchObject({ ok: true });
    expect(claims.held.size).toBe(0);
    expect(await executeTiktokLaunch(row({ id: OTHER }))).toMatchObject({ ok: true });
  });
});

describe("Autopilot may launch within its ad budget (Ravi 2026-10-14)", () => {
  const cgoRow = () => row({ approved_by_source: "cgo", approved_by: null });
  beforeEach(() => {
    s.autopilotBudget = { monthly_usd: 1000 };
  });

  it("budget active, gate allows, spend held: launches, and the gate runs again right before the switch-on", async () => {
    const r = await executeTiktokLaunch(cgoRow());
    expect(r).toMatchObject({ ok: true });
    expect(hold()?.status).toBe("committed");
    expect(s.gateCalls).toBe(2);
  });

  it("the gate holds it: refused for the founder before any hold, nothing created", async () => {
    s.gate = ["ask"];
    const r = await executeTiktokLaunch(cgoRow());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_policy_held", held_for_founder: true });
    expect(hold()).toBeUndefined();
    expect(f().posts).toEqual([]);
  });

  it("no spend held (no active shared budget at the hold): refused, nothing created", async () => {
    s.holdAnswer = "no_budget";
    const r = await executeTiktokLaunch(cgoRow());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_budget_required", held_for_founder: true });
    expect(f().posts.filter((p) => p.endpoint.endsWith("/create/"))).toEqual([]);
  });

  it("the gate changes its mind between the hold and the switch-on: nothing is switched on, the hold is given back", async () => {
    s.gate = ["allow", "ask"];
    const r = await executeTiktokLaunch(cgoRow());
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_policy_held" });
    expect(enables()).toEqual([]);
    expect(hold()?.status).toBe("released");
  });
});

describe("the launch claim is re-checked right before every switch-on", () => {
  it("lost before the first switch-on: nothing is switched on, the campaign is confirmed off, the hold is given back", async () => {
    claims.loseBeforeEnable = 1;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false });
    expect(enables()).toEqual([]);
    expect(hold()?.status).not.toBe("committed");
  });

  it("lost between switch-ons (after the ad): stops there, never reaches the campaign, switches the campaign off", async () => {
    claims.loseBeforeEnable = 2;
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false });
    expect(enables()).toEqual(["POST /ad/status/update/ ENABLE"]);
    expect(live(f().campaigns)[0].operation_status).toBe("DISABLE");
  });
});

describe("a cgo test's launch carries the test's end", () => {
  const TEST_END = "2027-01-15";
  beforeEach(() => {
    testEndMock.end = { decision_id: "order-1", channel: "tiktok_ads", ends_on: TEST_END };
  });

  it("the ad group is created with the test's end (00:00 UTC that day) and the launch finishes", async () => {
    const r = await executeTiktokLaunch(row());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const create = f().posts.find((p) => p.endpoint === "/adgroup/create/")!.body;
    expect(create).toMatchObject({ schedule_type: "SCHEDULE_START_END", schedule_end_time: "2027-01-15 00:00:00" });
  });

  it("arms the stop on the ad group (where the budget is) before the switch-on; unarmed, nothing goes on", async () => {
    const r = await executeTiktokLaunch(row());
    expect(armStop).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ ends_on: TEST_END }), expect.objectContaining({ platform: "tiktok", level: "ad_group", billing_scope: "object" }));
    expect(r.notice).toMatch(/Zavi pauses it if spend gets there/);
  });

  it("a stop that cannot be armed: nothing is switched on and the campaign reads off", async () => {
    armStop.mockResolvedValueOnce({ ok: false, line: "", why: "refused" });
    const off = await executeTiktokLaunch(row());
    expect(off).toMatchObject({ ok: false, code: "tiktok_ads_test_stop_unarmed" });
    expect(enables()).toEqual([]);
  });

  it("a card's own sooner end is kept", async () => {
    await executeTiktokLaunch(row({}, body({ end_date: "2026-12-31" })));
    expect(f().posts.find((p) => p.endpoint === "/adgroup/create/")!.body.schedule_end_time).toBe("2026-12-31 00:00:00");
  });

  it("TikTok does not keep the end: nothing is switched on", async () => {
    f().dropScheduleEnd = true;
    const r = await executeTiktokLaunch(row());
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/not switched on/);
    expect(f().posts.some((p) => /status\/update/.test(p.endpoint) && p.body.operation_status === "ENABLE")).toBe(false);
  });

  it("the test's end cannot be read: nothing is created", async () => {
    const { cgoTestEndForRun } = await import("@/services/growth/cgo-test-end");
    vi.mocked(cgoTestEndForRun).mockRejectedValueOnce(new Error("db down"));
    const r = await executeTiktokLaunch(row());
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/could not read this test's end date/);
    expect(f().posts.some((p) => p.endpoint === "/campaign/create/")).toBe(false);
  });

  it("a retry on a later day keeps the earlier attempt's sooner end and finishes", async () => {
    f().faults.push({ method: "POST", path: "/ad/create/", kind: "lost_unapplied" });
    await executeTiktokLaunch(row());
    testEndMock.end = { decision_id: "order-1", channel: "tiktok_ads", ends_on: "2027-01-16" };
    const r = await executeTiktokLaunch(row());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(live(f().adgroups)).toHaveLength(1);
    expect(live(f().adgroups)[0].schedule_end_time).toBe("2027-01-15 00:00:00");
  });

  it("TikTok end dates switched off: no end is written (the unattended gate leaves such a test to the founder)", async () => {
    noFriction.on = false;
    const r = await executeTiktokLaunch(row());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(f().posts.find((p) => p.endpoint === "/adgroup/create/")!.body).toMatchObject({ schedule_type: "SCHEDULE_FROM_NOW" });
  });
});
