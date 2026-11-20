import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeTiktok, type FakeTiktok } from "@/services/connectors/tiktok-ads/__tests__/fake-tiktok";

const s = vi.hoisted(() => ({
  fake: null as unknown as FakeTiktok,
  country: "US" as string | null,
  budget: null as null | { left_usd: number; days_left: number; margin: number },
  budgetFails: false,
  videos: [{ artifact_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", filename: "ugc-1.mp4", created_at: "2026-10-09T00:00:00Z" }],
  emitted: [] as Array<{ cls: string; body: Record<string, unknown> }>,
  ask: null as null | { plan: Record<string, unknown> | null; line: string; source?: "ask" | "decision" },
}));
vi.mock("@/services/approvals/approval-envelope", () => ({ founderAskFor: async () => s.ask }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => true }));

vi.mock("@/services/connectors/composio/account", () => ({
  resolveOwnedComposioAccount: async () => ({ tenant_id: "T", toolkit: "tiktok_ads", connected_account_id: "ca1", auth_config_id: "ac1" }),
}));
vi.mock("@/services/connectors/composio/api", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/composio/api")>()),
  composioProxy: (a: never) => s.fake.proxy(a),
}));
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
  readActiveAdBudget: async () => {
    if (s.budgetFails) throw new Error("db down");
    return s.budget ? { ...s.budget, margin: s.budget.margin } : null;
  },
  budgetMargin: (b: { margin?: number }) => b.margin ?? 1,
}));
vi.mock("@/services/ad-locations/country", () => ({
  businessCountry: async () => (s.country ? { code: s.country, name: s.country } : null),
  countryName: (c: string) => ({ US: "United States", NZ: "New Zealand" } as Record<string, string>)[c] ?? c,
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
vi.mock("@/services/connectors/tiktok-ads/zavi-videos", () => ({
  listZaviVideos: async () => s.videos,
  signedZaviVideoUrl: async (_t: string, id: string) => {
    if (!s.videos.some((v) => v.artifact_id === id)) {
      const { ExpectedToolError } = await import("@/services/tools/types");
      throw new ExpectedToolError("tiktok_ads_no_usable_video", "No Zavi video");
    }
    return { url: `https://store.test/${id}.mp4?token=x`, filename: "ugc-1.mp4" };
  },
}));

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>>, fail: new Set<string>() }));
vi.mock("@/services/tenant-client", async (orig) => {
  type Row = Record<string, unknown>;
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const run = () => (db.fail.has(table) ? { data: null, error: { message: "db down" } } : { data: (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
    const b: Record<string, unknown> = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      maybeSingle: async () => {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      upsert: async (row: Row) => {
        if (db.fail.has(table)) return { error: { message: "db down" } };
        const t = (db.tables[table] ??= []);
        const i = t.findIndex((r) => r.advertiser_id === row.advertiser_id && r.source_key === row.source_key);
        if (i >= 0) t[i] = { ...t[i], ...row };
        else t.push(row);
        return { error: null };
      },
    };
    return b;
  }
  return { ...(await orig<typeof import("@/services/tenant-client")>()), asTenantId: (x: string) => x, tenantClient: () => ({ from }) };
});

const pending = vi.hoisted(() => ({ recorded: [] as Array<Record<string, unknown>>, rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/services/growth/pending-tests", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/pending-tests")>()),
  readPendingTests: async () => pending.rows,
  recordPendingTest: async (_t: string, t: Record<string, unknown>) => {
    pending.recorded.push(t);
    return { status: "recorded", expires_at: "2026-10-18T12:00:00.000Z" };
  },
}));

const cgo = vi.hoisted(() => ({ approves: false, calls: [] as string[] }));
vi.mock("@/services/growth/cgo-ads", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-ads")>()),
  cgoApproveChannelAction: async (_t: string, id: string) => {
    cgo.calls.push(id);
    return cgo.approves;
  },
}));

import { tiktokAdsLaunchReadinessTool, tiktokAdsProposeLaunchTool } from "../launch";
import { tiktokAdsSearchLocationsTool, tiktokAdsTargetingOptionsTool } from "../read_tools";
import { TIKTOK_AGE_GROUPS, readTiktokTargetingForTenant } from "@/services/connectors/tiktok-ads/targeting";
import { describeTiktokAction } from "../_exec-action";
import { listTikTokAdsTools } from "@/services/mcp/internal/tiktok-ads";
import type { LaunchReadiness } from "@/services/connectors/tiktok-ads/launch-readiness";

const ADV = "7689989546330849300";
const ART = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const emit = async (cls: string, body: unknown) => {
  s.emitted.push({ cls, body: body as Record<string, unknown> });
  return "act1";
};
const ctx = { tenant_id: "T", emit_decision: emit, log: () => {} };
const input = (over: Record<string, unknown> = {}) => ({
  campaign_type: "TRAFFIC",
  name: "Spring test",
  location_ids: ["6252001"],
  daily_budget_usd: 25,
  video_artifact_id: ART,
  identity_id: "8f5d4c18-e601-5496-b38f-566335ea3ec3",
  ad_text: "See how it works",
  call_to_action: "LEARN_MORE",
  landing_url: "https://shop.example.com/start",
  rationale: "first readable test",
  ...over,
});
const propose = (over: Record<string, unknown> = {}) => tiktokAdsProposeLaunchTool.execute(ctx, input(over));
const refused = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
  expect(s.emitted).toEqual([]);
};

describe("launch audience choices", () => {
  it("does not offer a linked identity that explicitly cannot push new posts", async () => {
    s.fake.f.identities[0].can_push_video = false;
    const readiness = await tiktokAdsLaunchReadinessTool.execute(ctx, {}) as LaunchReadiness;
    expect(readiness.identities).toEqual([]);
    await expect(propose()).rejects.toMatchObject({ code: "tiktok_ads_no_identity" });
    expect(s.fake.f.posts).toEqual([]);
  });
  it("files advanced choices with readable weekly delivery and bid review rows", async () => {
    const selected = { excluded_audience_ids: [], operating_systems: ["IOS"], comment_disabled: true, bid_type: "BID_TYPE_CUSTOM", bid_price: 1.25, dayparting: "1".repeat(48) + "0".repeat(288) };
    await propose(selected);
    expect(s.emitted[0].body).toMatchObject(selected);
    const card = describeTiktokAction("tiktok_ads.create_launch", s.emitted[0].body);
    expect(card.rows.find(r => r.item.startsWith("Weekly delivery"))?.after).toContain("Mon: 00:00–24:00; Tue: off");
    expect(card.rows.find(r => r.item.startsWith("Bid price"))?.after).toBe("1.25");
    expect(card.rows.find(r => r.item === "Excluded audiences")?.after).toBe("None");
  });
  it("uses the live catalog for the tool and form, trimming names but preserving language codes", async () => {
    const options = await tiktokAdsTargetingOptionsTool.execute(ctx, {});
    expect(options).toMatchObject({ advertiser_id: ADV, languages: [{ id: "en", name: "English" }, { id: "es", name: "Spanish" }, { id: "zh-Hant", name: "Traditional Chinese" }, { id: "fi", name: "Finnish" }] });
    expect(await readTiktokTargetingForTenant("T")).toMatchObject({ languages: [{ id: "en", name: "English" }, { id: "es", name: "Spanish" }, { id: "zh-Hant", name: "Traditional Chinese" }, { id: "fi", name: "Finnish" }] });
  });

  it("files explicit adult defaults without depending on the language endpoint", async () => {
    s.fake.f.faults.push({ method: "GET", path: "/tool/language/", kind: "fail" });
    await propose();
    expect(s.emitted[0].body).toMatchObject({ age_groups: [...TIKTOK_AGE_GROUPS], gender: "GENDER_UNLIMITED", languages: [], language_names: [] });
    expect(s.fake.f.events).not.toContain("GET /tool/language/");
    const card = describeTiktokAction("tiktok_ads.create_launch", s.emitted[0].body);
    expect(card.rows.find((r) => r.item === "Gender")?.after).toBe("All genders");
    expect(card.rows.find((r) => r.item === "Languages")?.after).toBe("All languages");
  });

  it("files exactly the narrowed choices with canonical language names", async () => {
    await propose({ age_groups: ["AGE_25_34"], gender: "GENDER_FEMALE", languages: ["zh-Hant", "en", "en"] });
    expect(s.emitted[0].body).toMatchObject({ age_groups: ["AGE_25_34"], gender: "GENDER_FEMALE", languages: ["en", "zh-Hant"], language_names: ["English", "Traditional Chinese"] });
    const card = describeTiktokAction("tiktok_ads.create_launch", s.emitted[0].body);
    expect(card.rows.find((r) => r.item === "Gender")?.after).toBe("Female");
    expect(card.rows.find((r) => r.item === "Languages")?.after).toBe("English, Traditional Chinese");
  });

  it("refuses unknown languages before uploading a video or filing a card", async () => {
    await refused(propose({ languages: ["invented"] }), "tiktok_ads_language_not_allowed");
    expect(s.fake.f.posts).toEqual([]);
  });
});

beforeEach(() => {
  db.tables = {};
  db.fail = new Set();
  s.fake = makeFakeTiktok();
  s.country = "US";
  s.budget = null;
  s.budgetFails = false;
  s.emitted = [];
  s.videos = [{ artifact_id: ART, filename: "ugc-1.mp4", created_at: "2026-10-09T00:00:00Z" }];
  cgo.approves = false;
  cgo.calls = [];
});

describe("Autopilot may approve a launch it can afford (Ravi 2026-10-14); the result says what really happened", () => {
  it("approved by Autopilot: status says so, never 'waiting'", async () => {
    cgo.approves = true;
    const out = (await propose()) as Record<string, unknown>;
    expect(cgo.calls).toEqual(["act1"]);
    expect(out.status).toBe("approved_by_autopilot");
  });

  it("left for a person: status waiting_for_approval", async () => {
    const out = (await propose()) as Record<string, unknown>;
    expect(cgo.calls).toEqual(["act1"]);
    expect(out.status).toBe("waiting_for_approval");
  });

  it("a pending-test replay is never approved here (a person approves it after its hold is claimed)", async () => {
    cgo.approves = true;
    const out = (await tiktokAdsProposeLaunchTool.execute({ ...ctx, pending_test_replay: true } as never, input())) as Record<string, unknown>;
    expect(cgo.calls).toEqual([]);
    expect(out.status).toBe("waiting_for_approval");
  });

  it("a founder's direct ask the envelope did not approve (its older card is launching, or closing it failed) stays a card: Autopilot never approves it instead", async () => {
    cgo.approves = true;
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    s.ask = { plan: { daily_usd: 25, end }, line: "Running $50 on TikTok.", source: "ask" };
    try {
      const out = (await propose()) as Record<string, unknown>;
      expect(cgo.calls).toEqual([]);
      expect(out.status).toBe("waiting_for_approval");
    } finally {
      s.ask = null;
    }
  });
  it("a run a founder-approved cgo card dispatched (q:) still reaches the Autopilot door", async () => {
    cgo.approves = true;
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    s.ask = { plan: { daily_usd: 25, end }, line: "", source: "decision" };
    try {
      await propose();
      expect(cgo.calls).toEqual(["act1"]);
    } finally {
      s.ask = null;
    }
  });

  it("a launch the founder started from a channel top-action button waits for a person and carries the human origin", async () => {
    cgo.approves = true;
    const out = (await tiktokAdsProposeLaunchTool.execute({ ...ctx, top_action_run: true } as never, input())) as Record<string, unknown>;
    expect(cgo.calls).toEqual([]);
    expect(out.status).toBe("waiting_for_approval");
    expect(JSON.stringify(s.emitted)).toContain('"origin":"user_initiated_ledger"');
  });
});

describe("tiktok_ads_launch_readiness: facts only", () => {
  it("returns the account, the TikTok accounts ads can run as (never a custom identity), videos, floors, the possible types and the allowed place", async () => {
    const r = (await tiktokAdsLaunchReadinessTool.execute(ctx, {})) as Record<string, unknown>;
    expect(r.advertiser).toMatchObject({ advertiser_id: ADV, status: "ENABLE", currency: "USD", timezone: "Etc/GMT+8" });
    expect(r.identities).toEqual([{ identity_id: "8f5d4c18-e601-5496-b38f-566335ea3ec3", identity_type: "BC_AUTH_TT", identity_authorized_bc_id: "7695136887945789461", display_name: "brand handle" }]);
    expect(r.possible_campaign_types).toEqual(["TRAFFIC"]);
    expect(r.allowed_locations).toEqual([{ location_id: "6252001", country_code: "US", name: "United States", level: "COUNTRY" }]);
    expect(r.minimum_daily_budget_usd).toEqual({ ad_group_must_exceed: 20, campaign_must_exceed: 50 });
    expect(r.videos).toHaveLength(1);
    expect(r.creation).toMatchObject({ advertiser_enabled: true, usd: true, payment: "not_readable" });
    expect(r.blockers).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/recommend/i);
  });

  it("names every missing thing with the founder's exact fix", async () => {
    s.fake.f.advertiser.status = "STATUS_CONTRACT_PENDING";
    s.fake.f.advertiser.currency = "EUR";
    s.fake.f.identities = [];
    s.videos = [];
    s.country = "NZ";
    const r = (await tiktokAdsLaunchReadinessTool.execute(ctx, {})) as LaunchReadiness;
    expect(r.blockers.map((b) => b.code)).toEqual(["tiktok_ads_account_not_ready", "tiktok_ads_currency_unsupported", "tiktok_ads_no_identity", "tiktok_ads_no_usable_video"]);
    expect(r.allowed_locations).toEqual([]);
    expect(r.notes.join(" ")).toContain("does not let this ad account target NZ");
    expect(r.blockers.find((b) => b.code === "tiktok_ads_no_identity")?.fix).toContain("Business Center go to Accounts > TikTok accounts");
    for (const b of r.blockers) expect(b.fix.length).toBeGreaterThan(10);
  });

  it("is listed on the TikTok Ads MCP server as a read; the launch proposal as a write", () => {
    const tools = listTikTokAdsTools();
    expect(tools.find((t) => t.tool_name === "launch_readiness")?.effect).toBe("read");
    expect(tools.find((t) => t.tool_name === "propose_launch")?.effect).toBe("write");
  });
});

describe("tiktok_ads_propose_launch: one card", () => {
  it("reuses a selected account-library video without uploading or signing another asset", async () => {
    s.videos = [];
    s.fake.f.videos.set("library-video", { video_id: "library-video", width: 720, height: 1280, duration: 12, allowed_placements: ["PLACEMENT_TIKTOK"], displayable: true, video_cover_url: "https://cdn.example/cover.jpg" });
    const out = await propose({ video_artifact_id: undefined, video_id: "library-video" });
    expect(out).toMatchObject({ video_id: "library-video", action_id: "act1" });
    expect(s.emitted[0].body.video).toMatchObject({ video_id: "library-video", source: "library" });
    expect(describeTiktokAction("tiktok_ads.create_launch", s.emitted[0].body).rows.find(r => r.item === "Video")?.after).toContain("Ad account library video library-video");
    expect(s.fake.f.posts).toEqual([]);
    expect(db.tables.tiktok_ad_video_uploads ?? []).toEqual([]);
  });
  it("refuses unreadable, invalid and conflicting library video selections before filing", async () => {
    await refused(propose({ video_artifact_id: undefined, video_id: "not-in-this-account" }), "tiktok_ads_video_unreadable");
    s.fake.f.videos.set("invalid-video", { video_id: "invalid-video", width: 1280, height: 720, duration: 12, allowed_placements: ["PLACEMENT_TIKTOK"], displayable: true });
    await refused(propose({ video_artifact_id: undefined, video_id: "invalid-video" }), "tiktok_ads_video_not_vertical");
    await refused(propose({ video_id: "library-video" }), "tiktok_ads_no_usable_video");
    expect(tiktokAdsProposeLaunchTool.input_schema.safeParse(input({ video_id: "library-video" })).success).toBe(false);
    expect(s.fake.f.posts).toEqual([]);
  });
  it("uploads the Zavi video by its durable signed URL, checks it, and files one card with every choice and the hold", async () => {
    s.budget = { left_usd: 2000, days_left: 21, margin: 1.25 };
    const out = (await propose({ age_groups: ["AGE_25_34"] })) as Record<string, unknown>;
    expect(out).toMatchObject({ action_id: "act1", status: "waiting_for_approval", hold_estimate_usd: 820.32, measured: "Measured: clicks and site visits (not sales)." });
    const upload = s.fake.f.posts.find((p) => p.endpoint === "/file/video/ad/upload/")!;
    expect(upload.body).toMatchObject({ advertiser_id: ADV, upload_type: "UPLOAD_BY_URL" });
    expect(String(upload.body.video_url)).toMatch(/^https:\/\/store\.test\//);
    expect(String(upload.body.video_url)).not.toContain("fal.media");
    expect(s.fake.f.posts.map((p) => p.endpoint)).toEqual(["/file/video/ad/upload/"]);
    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0].cls).toBe("tiktok_ads.create_launch");
    expect(s.emitted[0].body).toMatchObject({ campaign_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET", daily_budget_usd: 25, hold_estimate_usd: 820.32, age_groups: ["AGE_25_34"], video: { source: "zavi", width: 720, height: 1280, duration_s: 12 }, identity: { identity_type: "BC_AUTH_TT" } });
    const card = describeTiktokAction("tiktok_ads.create_launch", s.emitted[0].body);
    expect(card.title).toBe('Launch a TikTok traffic campaign: "Spring test"');
    expect(card.rows.find((r) => r.item === "Ages")?.after).toBe("25-34");
    expect(card.rows.find((r) => r.item === "Average daily budget")?.after).toContain("$31.25");
    const legacy = { ...s.emitted[0].body }; delete legacy.budget_mode;
    const legacyCard = describeTiktokAction("tiktok_ads.create_launch", legacy);
    expect(legacyCard.rows.find(r => r.item === "Daily budget")?.after).toContain("$25.00 a day");
    expect(legacyCard.rows.some(r => r.item === "Average daily budget")).toBe(false);
  });

  it("a founder's https link is checked by the URL guard and uploaded; a private or http link is refused", async () => {
    await propose({ video_artifact_id: undefined, video_url: "https://cdn.example.com/clip.mp4" });
    expect(s.emitted[0].body.video).toMatchObject({ source: "link", link_host: "cdn.example.com" });
    s.emitted = [];
    await refused(propose({ video_artifact_id: undefined, video_url: "https://files.internal/clip.mp4" }), "tiktok_ads_video_url_unsafe");
    await refused(propose({ video_artifact_id: undefined, video_url: "http://cdn.example.com/clip.mp4" }), "tiktok_ads_video_url_unsafe");
    await refused(propose({ video_artifact_id: undefined }), "tiktok_ads_no_usable_video");
    await refused(propose({ video_url: "https://cdn.example.com/clip.mp4" }), "tiktok_ads_no_usable_video");
    await refused(propose({ video_artifact_id: "2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" }), "tiktok_ads_no_usable_video");
  });

  it("TikTok's own 'Failed to fetch url data' on upload is a typed refusal with the fix", async () => {
    s.fake.f.unreachable.add("https://cdn.example.com/gone.mp4");
    const p = propose({ video_artifact_id: undefined, video_url: "https://cdn.example.com/gone.mp4" });
    await expect(p).rejects.toMatchObject({ code: "tiktok_ads_video_unreachable", message: expect.stringContaining("Failed to fetch url data") });
  });

  it("refuses a video that is not 9:16, outside 5-60 seconds, or not allowed on TikTok", async () => {
    const url = (u: string, spec: Record<string, unknown>) => {
      s.fake.f.uploads.set(u, { width: 720, height: 1280, duration: 12, allowed_placements: ["PLACEMENT_TIKTOK"], ...spec } as never);
      return propose({ video_artifact_id: undefined, video_url: u });
    };
    await refused(url("https://cdn.example.com/wide.mp4", { width: 1280, height: 720 }), "tiktok_ads_video_not_vertical");
    await refused(url("https://cdn.example.com/square.mp4", { width: 1080, height: 1080 }), "tiktok_ads_video_not_vertical");
    await refused(url("https://cdn.example.com/short.mp4", { duration: 4 }), "tiktok_ads_video_length");
    await refused(url("https://cdn.example.com/long.mp4", { duration: 61 }), "tiktok_ads_video_length");
    await refused(url("https://cdn.example.com/pangle.mp4", { allowed_placements: ["PLACEMENT_PANGLE"] }), "tiktok_ads_video_placement");
  });

  it("refuses before any card: not a channel run, account not ready, non-USD, no linked TikTok account, a custom identity", async () => {
    await refused(tiktokAdsProposeLaunchTool.execute({ tenant_id: "T", log: () => {} }, input()), "tiktok_ads_propose_not_channel_run");
    s.fake.f.advertiser.status = "STATUS_CONTRACT_PENDING";
    await refused(propose(), "tiktok_ads_account_not_ready");
    s.fake.f.advertiser.status = "STATUS_ENABLE";
    s.fake.f.advertiser.currency = "EUR";
    await refused(propose(), "tiktok_ads_currency_unsupported");
    s.fake.f.advertiser.currency = "USD";
    await refused(propose({ identity_id: "7695135145485434887" }), "tiktok_ads_no_identity");
    s.fake.f.identities = [];
    const p = propose();
    await expect(p).rejects.toMatchObject({ code: "tiktok_ads_no_identity", message: expect.stringContaining("Accounts > TikTok accounts") });
  });

  it("targets the places TikTok lets this account target: the country by default, states and cities from the search, never a place TikTok refuses", async () => {
    const found = (await tiktokAdsSearchLocationsTool.execute(ctx, { query: "aus" })) as { locations: Array<{ location_id: string; name: string; level: string }> };
    expect(found.locations).toEqual([{ location_id: "4671654", name: "Austin, Texas, United States", level: "CITY", country_code: "US" }]);
    const everywhere = (await tiktokAdsSearchLocationsTool.execute(ctx, { query: "an" })) as { locations: Array<{ name: string }> };
    expect(everywhere.locations.map((l) => l.name)).toEqual(["Canada"]);
    const only = (await tiktokAdsSearchLocationsTool.execute(ctx, { query: "an", country_code: "US" })) as { locations: Array<{ name: string }> };
    expect(only.locations).toEqual([]);
    await propose({ location_ids: ["4736286", "4671654"] });
    expect(s.emitted[0].body.locations).toEqual([
      { location_id: "4736286", country_code: "US", name: "Texas, United States", level: "PROVINCE" },
      { location_id: "4671654", country_code: "US", name: "Austin, Texas, United States", level: "CITY" },
    ]);
    expect(describeTiktokAction("tiktok_ads.create_launch", s.emitted[0].body).rows.find((r) => r.item === "Where")?.after).toBe("Texas, United States, Austin, Texas, United States");
    s.emitted = [];
    const p = propose({ location_ids: ["6252001", "1269750"] });
    await expect(p).rejects.toMatchObject({ code: "tiktok_ads_location_not_allowed", message: expect.stringContaining("India") });
    expect(s.emitted).toEqual([]);
  });

  it("a business country the account cannot target is no blocker when the places picked are ones it can", async () => {
    s.country = "NZ";
    await propose({ location_ids: ["6252001"] });
    expect(s.emitted[0].body.locations).toEqual([{ location_id: "6252001", country_code: "US", name: "United States", level: "COUNTRY" }]);
  });

  it("refuses a location the model invented, a campaign type not offered, an unsafe landing page, a past start", async () => {
    await refused(propose({ location_ids: ["2635167"] }), "tiktok_ads_location_not_allowed");
    await refused(propose({ campaign_type: "WEB_CONVERSIONS" }), "tiktok_ads_campaign_type_unsupported");
    await refused(propose({ landing_url: "http://shop.example.com" }), "tiktok_ads_landing_url_unsafe");
    await refused(propose({ landing_url: "https://admin.internal/x" }), "tiktok_ads_landing_url_unsafe");
    await refused(propose({ start_time: "2020-01-01T00:00:00Z" }), "tiktok_ads_start_invalid");
    s.country = null;
    await refused(propose(), "tiktok_ads_no_country");
  });

  it("a run that writes nothing, or a redo, uploads no video and files no card", async () => {
    const out = (await tiktokAdsProposeLaunchTool.execute({ ...ctx, writes_suppressed: true } as never, input())) as Record<string, unknown>;
    expect(out.status).toBe("not_filed");
    await expect(tiktokAdsProposeLaunchTool.execute({ ...ctx, redo: true } as never, input())).rejects.toMatchObject({ code: "redo_scope" });
    expect(s.fake.f.posts).toEqual([]);
    expect(s.emitted).toEqual([]);
  });

  it("floors: exactly $20.00 is refused, $20.01 passes", async () => {
    await refused(propose({ daily_budget_usd: 20 }), "tiktok_ads_budget_below_floor");
    await propose({ daily_budget_usd: 20.01 });
    expect(s.emitted).toHaveLength(1);
  });

  it("a launch the ad budget cannot hold, or an ad budget that cannot be read, is not filed and uploads nothing", async () => {
    s.budget = { left_usd: 100, days_left: 21, margin: 1.25 };
    await refused(propose(), "tiktok_ads_budget_short");
    s.budget = null;
    s.budgetFails = true;
    await refused(propose(), "tiktok_ads_budget_unreadable");
    expect(s.fake.f.posts).toEqual([]);
    expect(s.emitted).toEqual([]);
  });
});

describe("B1: a launch refused only for budget room is kept as a pending test (pending-tests.ts)", () => {
  beforeEach(() => {
    pending.recorded = [];
    pending.rows = [];
  });

  it("4: no active ad budget and a TikTok test already waiting: refused before any upload or card", async () => {
    s.budget = null;
    pending.rows = [{ id: "p1", channel_slug: "tiktok_ads", status: "pending", action_id: null, expires_at: "2099-01-01T00:00:00.000Z" }];
    await refused(propose(), "tiktok_ads_test_waiting");
    expect(s.fake.f.posts).toEqual([]);
  });

  it("G-F1: room is there but a TikTok test is already waiting: refused before any upload or card (Zavi files that one)", async () => {
    s.budget = { left_usd: 50000, days_left: 21, margin: 1.25 };
    pending.rows = [{ id: "p1", channel_slug: "tiktok_ads", status: "pending", action_id: null, expires_at: "2099-01-01T00:00:00.000Z" }];
    await refused(propose(), "tiktok_ads_test_waiting");
    expect(s.fake.f.posts).toEqual([]);
  });

  it("records the channel, the daily budget, the launch's own hold and the exact proposal, and tells the agent Zavi files the card when it fits", async () => {
    s.budget = { left_usd: 100, days_left: 21, margin: 1.25 };
    const err = (await propose().catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toMatchObject({ code: "tiktok_ads_budget_short" });
    expect(err.message).toContain("pending TikTok test (checked weekly from 2026-10-18");
    expect(err.message).toContain("files this card for approval as soon as the budget has that much left");
    expect(pending.recorded).toEqual([{ channel: "tiktok_ads", daily_budget_usd: 25, hold_usd: 820.32, proposal: expect.objectContaining({ name: "Spring test", daily_budget_usd: 25, video_artifact_id: ART }) }]);
    expect(s.emitted).toEqual([]);
    expect(s.fake.f.posts).toEqual([]);
  });

  it("a run that writes nothing (shadow, draft) or the server's own replay records nothing", async () => {
    s.budget = { left_usd: 100, days_left: 21, margin: 1.25 };
    for (const extra of [{ writes_suppressed: true }, { pending_test_replay: true }]) {
      await expect(tiktokAdsProposeLaunchTool.execute({ ...ctx, ...extra } as never, input())).rejects.toMatchObject({ code: "tiktok_ads_budget_short" });
    }
    expect(pending.recorded).toEqual([]);
  });

  it("an underfunded founder form never becomes an unattended pending test", async () => {
    s.budget = { left_usd: 100, days_left: 21, margin: 1.25 };
    cgo.approves = true;
    await refused(tiktokAdsProposeLaunchTool.execute({ ...ctx, top_action_run: true } as never, input()), "tiktok_ads_budget_short");
    expect(pending.recorded).toEqual([]);
    expect(cgo.calls).toEqual([]);
    expect(s.fake.f.posts).toEqual([]);
  });
});

describe("a launch card already open is refused before any upload or card; a live campaign no longer blocks", () => {
  const liveCampaign = (status: "ENABLE" | "DISABLE") =>
    s.fake.f.campaigns.set("1878696308800001", { id: "1878696308800001", campaign_name: "Zavi · Spring test · campaign · zv0123456789", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE", budget: 0, operation_status: status });

  it("a switched-on Zavi launch campaign does not block a new launch (Ravi 2026-10-14: more tests are okay)", async () => {
    liveCampaign("ENABLE");
    await propose();
    expect(s.emitted).toHaveLength(1);
  });

  it("a paused Zavi campaign, or a campaign Zavi did not make, does not block a new launch", async () => {
    liveCampaign("DISABLE");
    s.fake.f.campaigns.set("1878696308800002", { id: "1878696308800002", campaign_name: "Founder's own campaign", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: 50, operation_status: "ENABLE" });
    await propose();
    expect(s.emitted).toHaveLength(1);
  });

  it("an open launch card (waiting, or approved and running) blocks; a rejected or executed one does not", async () => {
    db.tables.channel_actions = [
      { id: "card-rejected", channel_slug: "tiktok_ads", exec_class: "tiktok_ads.create_launch", status: "rejected", exec_status: null },
      { id: "card-done", channel_slug: "tiktok_ads", exec_class: "tiktok_ads.create_launch", status: "acted", exec_status: "executed" },
      { id: "card-budget", channel_slug: "tiktok_ads", exec_class: "tiktok_ads.update_budget", status: "pending", exec_status: null },
    ];
    await propose();
    expect(s.emitted).toHaveLength(1);
    s.emitted = [];
    s.fake.f.posts = [];
    db.tables.channel_actions.push({ id: "card-open", channel_slug: "tiktok_ads", exec_class: "tiktok_ads.create_launch", status: "acted", exec_status: "queued" });
    const err = (await propose().catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toMatchObject({ code: "tiktok_ads_launch_in_flight" });
    expect(err.message).toContain("card-open");
    expect(s.fake.f.posts).toEqual([]);
    expect(s.emitted).toEqual([]);
  });

  it("when what is under way cannot be read, nothing is proposed or uploaded (never a guess)", async () => {
    db.fail.add("channel_actions");
    await refused(propose(), "tiktok_ads_launch_state_unreadable");
    expect(s.fake.f.posts).toEqual([]);
  });

  it("readiness says what is under way, so the agent never infers it from names: [] when nothing is", async () => {
    let r = (await tiktokAdsLaunchReadinessTool.execute(ctx, {})) as Record<string, unknown>;
    expect(r.already_launching).toEqual([]);
    liveCampaign("ENABLE");
    db.tables.channel_actions = [{ id: "card-open", channel_slug: "tiktok_ads", exec_class: "tiktok_ads.create_launch", status: "pending", exec_status: null }];
    r = (await tiktokAdsLaunchReadinessTool.execute(ctx, {})) as Record<string, unknown>;
    expect(r.already_launching).toEqual([{ kind: "open_card", action_id: "card-open" }]);
    expect(r.blockers).toEqual([]);
  });
});

describe("a retry of the same proposal reuses the video it already uploaded", () => {
  const uploads = () => s.fake.f.posts.filter((p) => p.endpoint === "/file/video/ad/upload/");

  it("the card failed to file after the upload: the retry files it with the SAME video id and no second upload", async () => {
    const failing = { ...ctx, emit_decision: async () => { throw new Error("card writer down"); } };
    await expect(tiktokAdsProposeLaunchTool.execute(failing, input())).rejects.toThrow("card writer down");
    expect(uploads()).toHaveLength(1);
    const first = String(db.tables.tiktok_ad_video_uploads?.[0]?.video_id);
    expect(db.tables.tiktok_ad_video_uploads).toEqual([expect.objectContaining({ advertiser_id: ADV, source_key: `zavi:${ART}`, video_id: first })]);
    const out = (await propose()) as Record<string, unknown>;
    expect(uploads()).toHaveLength(1);
    expect(out.video_id).toBe(first);
    expect((s.emitted[0].body.video as Record<string, unknown>).video_id).toBe(first);
  });

  it("a founder's link is keyed by the link; another video is a new upload", async () => {
    const link = { video_artifact_id: undefined, video_url: "https://cdn.example.com/clip.mp4" };
    const failing = { ...ctx, emit_decision: async () => { throw new Error("card writer down"); } };
    await expect(tiktokAdsProposeLaunchTool.execute(failing, input(link))).rejects.toThrow();
    await tiktokAdsProposeLaunchTool.execute(failing, input(link)).catch(() => undefined);
    expect(uploads()).toHaveLength(1);
    await tiktokAdsProposeLaunchTool.execute(failing, input({ video_artifact_id: undefined, video_url: "https://cdn.example.com/other.mp4" })).catch(() => undefined);
    expect(uploads()).toHaveLength(2);
  });

  it("TikTok no longer lists the earlier upload: uploaded again, and the new id remembered", async () => {
    const failing = { ...ctx, emit_decision: async () => { throw new Error("card writer down"); } };
    await tiktokAdsProposeLaunchTool.execute(failing, input()).catch(() => undefined);
    const first = String(db.tables.tiktok_ad_video_uploads[0].video_id);
    s.fake.f.videos.delete(first);
    const out = (await propose()) as Record<string, unknown>;
    expect(uploads()).toHaveLength(2);
    expect(out.video_id).not.toBe(first);
    expect(db.tables.tiktok_ad_video_uploads).toEqual([expect.objectContaining({ video_id: out.video_id })]);
  });

  it("the uploads store is down: uploads as before (fail open), never refuses the launch", async () => {
    db.fail.add("tiktok_ad_video_uploads");
    await propose();
    expect(uploads()).toHaveLength(1);
    expect(s.emitted).toHaveLength(1);
  });
});

describe("a founder's own ask is never blocked by the Autopilot month (F4)", () => {
  beforeEach(() => {
    s.ask = null;
    s.emitted = [];
  });
  it("the same short month refuses an unattended launch but files the founder's ask", async () => {
    s.budget = { left_usd: 10, days_left: 21, margin: 1 };
    await refused(propose(), "tiktok_ads_budget_short");
    const end = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    s.ask = { plan: { channel_slug: "tiktok_ads", budget_type: "daily", daily_usd: 25, total_usd: 75, end, days: 3 }, line: "Running $25.00 a day on TikTok" };
    await propose();
    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0].body).toMatchObject({ daily_budget_usd: 25, end_date: end });
    s.ask = null;
    s.budget = null;
  });
});
