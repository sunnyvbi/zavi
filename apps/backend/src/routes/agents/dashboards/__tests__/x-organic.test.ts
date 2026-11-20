
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ refresh: vi.fn(), snapshots: vi.fn(), accounts: vi.fn() }));

const ch = vi.hoisted(() => ({ actions: [] as unknown[] }));
vi.mock("@/services/channels/channel-actions", async () => {
  const actual = await vi.importActual<typeof import("@/services/channels/channel-actions")>(
    "@/services/channels/channel-actions",
  );
  return {
    ...actual,
    listChannelActions: async () => ({ actions: ch.actions, more: 0, store: "channel_actions" as const }),
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/x-social/owned-posts", async () => {
  const actual = await vi.importActual<typeof import("@/services/x-social/owned-posts")>("@/services/x-social/owned-posts");
  return {
    ...actual,
    refreshOwnedPostsIfStale: m.refresh,
    readPostSnapshots: m.snapshots,
    readAccountSnapshots: m.accounts,
  };
});

import { bioNamesCompany, build, computeChecklist, computeMetrics, formatTotals, kindOf, profileChecks, stepToDraft, type XPostRow } from "../x-organic";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const today = new Date().toISOString().slice(0, 10);
const yday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

type Table = Record<string, unknown[]>;
function fakeSb(tables: Table) {
  const q = (table: string) => {
    let rows = (tables[table] ?? []) as Array<Record<string, unknown>>;
    const at = (r: Record<string, unknown>, k: string): unknown => {
      const [col, key] = k.split("->>");
      return key === undefined ? r[col] : (r[col] as Record<string, unknown> | null)?.[key];
    };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self,
      eq: (k: string, v: unknown) => {
        rows = rows.filter((r) => r[k] === v);
        return chain;
      },
      in: (k: string, vs: unknown[]) => {
        rows = rows.filter((r) => vs.includes(at(r, k)));
        return chain;
      },
      gte: self,
      order: self,
      limit: self,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: (v: { data: unknown[]; error: null }) => void) => res({ data: rows, error: null }),
    });
    return chain;
  };
  return { from: q } as never;
}

const ctx = (tables: Table, meteredRefresh = false, rangeDays: number | null = null) => ({
  tenantId: TENANT,
  accessToken: "t",
  ctx: { tenant_id: TENANT, log: vi.fn() } as never,
  sb: fakeSb(tables),
  refresh: meteredRefresh,
  meteredRefresh,
  rangeDays,
});

function act(
  id: string,
  run: string,
  deliverable: Record<string, unknown> | null,
  title = `Step ${id}`,
): Record<string, unknown> {
  return {
    id,
    channel_slug: "x_organic",
    run_id: run,
    position: 1,
    run_of: 1,
    blocking: false,
    action_type: deliverable?.kind === "comment" ? "reply" : "text_post",
    title,
    body: {
      step: {
        title,
        body: "Rule shape. Built to earn replies.",
        blocking: false,
        effort: "minutes",
        ...(deliverable ? { deliverable } : {}),
      },
    },
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 50,
    score_inputs: {},
    proposed_at: "2026-09-18T07:00:00Z",
    repeat_of: null,
    redo_of: null,
    executable: false,
    exec_status: null,
    edited_body: null,
    source: "channel_action",
  };
}

beforeEach(() => {
  ch.actions = [];
  m.refresh.mockReset().mockResolvedValue({ read: true });
  m.snapshots.mockReset().mockResolvedValue([]);
  m.accounts.mockReset().mockResolvedValue([]);
});

describe("x_organic dashboard builder", () => {
  it("distinguishes the provider's current handle from an editable connection label", async () => {
    const connectedAt = daysAgoIso(3);
    const readAt = daysAgoIso(1);
    const tables = { connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "My business", connected_at: connectedAt }] };
    m.accounts.mockResolvedValue([{ captured_on: today, created_at: readAt, username: "actual_account" }]);
    expect(await build(ctx(tables))).toMatchObject({ handle: "My business", account_handle: "actual_account", account_read_at: readAt });
    m.accounts.mockResolvedValue([{ captured_on: today, created_at: daysAgoIso(4), username: "previous_account" }]);
    expect(await build(ctx(tables))).toMatchObject({ account_handle: null, account_read_at: null });
  });
  it("leaves publication time unknown until X supplies it", async () => {
    const d = await build(ctx({ social_posts: [{ id: "p", tenant_id: TENANT, channel: "x", status: "published", external_post_id: "p", approved_payload_snapshot: { payload: { text: "Published" } }, metrics: { public: { impression_count: 90, reply_count: 10, like_count: 8 }, non_public: { user_profile_clicks: 2, url_link_clicks: 4 } }, created_at: daysAgoIso(45), updated_at: daysAgoIso(0) }] }));
    expect((d.top_posts as XPostRow[])[0].posted_at).toBeNull();
    expect((d.metrics as Array<{ key: string; value: number | null; basis: string }>).filter(m => m.key !== "new_follows").every(m => m.value === null && m.basis === "none")).toBe(true);
    const signals = (d.checklist as { signals: Array<{ key: string; status: string; note: string }> }).signals;
    for (const key of ["cadence", "reply_rate"]) {
      expect(signals.find(s => s.key === key)).toMatchObject({ status: "unknown" });
      expect(signals.find(s => s.key === key)?.note).toContain("dates are unavailable");
    }
  });
  it("keeps the provider's publication date after a refresh and excludes older posts from 7 days", async () => {
    const original = daysAgoIso(20);
    const ledger = { id: "published", tenant_id: TENANT, channel: "x", status: "published", external_post_id: "old", external_url: "https://x.com/i/web/status/old", approved_payload_snapshot: { payload: { text: "An older post" } }, created_at: original, updated_at: daysAgoIso(0) };
    m.snapshots.mockResolvedValue([{ external_post_id: "old", captured_on: today, posted_at: original, metrics: { public: { impression_count: 10 } } }]);
    const tables = { social_posts: [ledger], connector_metadata: [{ tenant_id: TENANT, slug: "x_social" }] };
    const month = await build(ctx(tables));
    expect((month.top_posts as XPostRow[])[0].posted_at).toBe(original);
    const week = await build(ctx(tables, false, 7));
    expect(week.top_posts).toEqual([]);
  });
  it.each([
    [{}, null, null],
    [{ url_link_clicks: 0 }, 0, null],
    [{ user_profile_clicks: 1 }, null, 1],
    [{ url_link_clicks: 0, user_profile_clicks: 0 }, 0, 0],
  ])("keeps independently returned private counters: %j", async (non_public, linkClicks, profileClicks) => {
    m.snapshots.mockResolvedValue([{ external_post_id: "a", captured_on: today, posted_at: daysAgoIso(1),
      metrics: { public: { impression_count: 10 }, non_public } }]);
    const d = await build(ctx({ connector_metadata: [{ tenant_id: TENANT, slug: "x_social" }] }));
    expect((d.top_posts as XPostRow[])[0].private_metrics_available).toBe(linkClicks !== null && profileClicks !== null);
    const clicks = (d.metrics as Array<{ key: string; value: number | null }>).filter(m => ["link_clicks", "profile_visits"].includes(m.key));
    expect(clicks).toHaveLength(2);
    expect(clicks.find(m => m.key === "link_clicks")?.value).toBe(linkClicks);
    expect(clicks.find(m => m.key === "profile_visits")?.value).toBe(profileClicks);
  });

  it("counts a post with no link as zero link clicks when X returned its private block", async () => {
    m.snapshots.mockResolvedValue([{ external_post_id: "a", captured_on: today, posted_at: daysAgoIso(1), has_link: false,
      metrics: { public: { impression_count: 10 }, non_public: { user_profile_clicks: 2 } } }]);
    const d = await build(ctx({ connector_metadata: [{ tenant_id: TENANT, slug: "x_social" }] }));
    const clicks = d.metrics as Array<{ key: string; value: number | null }>;
    expect(clicks.find(m => m.key === "link_clicks")?.value).toBe(0);
    expect(clicks.find(m => m.key === "profile_visits")?.value).toBe(2);
  });

  it("not connected: honest header, no read attempted, empty sections", async () => {
    const d = await build(ctx({}));
    expect(d).toMatchObject({ connected: false, handle: null, read: { read: false, reason: "not_connected" }, actions_waiting: 0 });
    expect(m.refresh).not.toHaveBeenCalled();
    expect(d.top_posts).toEqual([]);
    expect(d.attention).toEqual([]);
    expect(d.drafts).toEqual([]);
    const metrics = d.metrics as Array<{ key: string; value: number | null; basis: string }>;
    expect(metrics.map((x) => x.key)).toEqual(["impressions", "engagement_rate", "profile_visits", "link_clicks", "new_follows", "replies", "likes", "reposts"]);
    expect(metrics.every((x) => x.value === null && x.basis === "none")).toBe(true);
  });

  it("merges ledger rows with account posts by X id, accrues the window, splits drafts from attention", async () => {
    ch.actions = [
      {
        ...act("d3", "r1", null, "Reply under @lovecoach's thread"),
        body: { step: { title: "Reply under @lovecoach's thread", body: "Their audience is your buyer.", blocking: false, effort: "minutes", evidence: ["web_search site:x.com lovecoach"] } },
      },
    ];
    m.snapshots.mockResolvedValue([
      { external_post_id: "1", captured_on: yday, posted_at: daysAgoIso(5), text: "ledger post", url: "https://x.com/i/web/status/1", format: "post", has_link: true, metrics: { non_public: { impression_count: 100 }, public: { like_count: 5, reply_count: 1, retweet_count: 0, bookmark_count: 2 } } },
      { external_post_id: "1", captured_on: today, posted_at: daysAgoIso(5), text: "ledger post", url: "https://x.com/i/web/status/1", format: "post", has_link: true, metrics: { non_public: { impression_count: 160 }, public: { like_count: 8, reply_count: 1, retweet_count: 1, bookmark_count: 2 } } },
      { external_post_id: "2", captured_on: today, posted_at: daysAgoIso(4), text: "hand-written", url: "https://x.com/i/web/status/2", format: "thread", has_link: false, metrics: { non_public: { impression_count: 40 }, public: { like_count: 4 } } },
    ]);
    const d = await build(
      ctx({
        connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "@coupleapp" }],
        tenant_agent_schedules: [{ tenant_id: TENANT, agent_slug: "x_organic", cron_expression: "0 13 * * *", timezone: "Asia/Calcutta", enabled: true, last_fired_at: null }],
        social_posts: [
          { id: "p1", tenant_id: TENANT, channel: "x", status: "published", external_url: "https://x.com/i/web/status/1", external_post_id: "1", approved_payload_snapshot: { payload: { text: "ledger post" } }, metrics: null, scheduled_at: null, created_at: "2026-09-08T09:00:00Z", updated_at: "2026-09-08T10:00:00Z" },
          { id: "p2", tenant_id: TENANT, channel: "x_image", status: "approved", external_url: null, external_post_id: null, approved_payload_snapshot: { payload: { text: "queued image" } }, metrics: null, scheduled_at: null, created_at: "2026-09-10T09:00:00Z", updated_at: "2026-09-10T09:00:00Z" },
        ],
        decisions: [
          { id: "d1", tenant_id: TENANT, status: "proposed", decision_class: "social.publish.v2", emitted_at: "2026-09-10T08:00:00Z", agent_run_id: "r1", body: { channel: "x", payload: { text: "draft one", thread: ["two"] }, rationale: "receipt post", scheduled_at: null } },
          { id: "d2", tenant_id: TENANT, status: "proposed", decision_class: "social.publish.v2", emitted_at: "2026-09-10T08:00:00Z", agent_run_id: "r1", body: { channel: "linkedin", payload: { text: "not x" } } },
        ],
        agent_runs: [
          { id: "r1", tenant_id: TENANT, agent_slug: "x_organic", started_at: "2026-09-10T06:00:00Z" },
          { id: "r-seo", tenant_id: TENANT, agent_slug: "seo", started_at: "2026-09-10T06:00:00Z" },
        ],
      }),
    );
    expect(d).toMatchObject({ connected: true, handle: "@coupleapp" });
    expect(m.refresh).toHaveBeenCalledWith(TENANT, expect.objectContaining({ force: false }));

    const posts = d.top_posts as Array<Record<string, unknown>>;
    expect(posts.filter((p) => p.external_post_id === "1")).toHaveLength(1);
    expect(posts.find((p) => p.external_post_id === "1")).toMatchObject({ source: "zavi", views: 160, likes: 8, reposts: 1, engagements: 12, format: "post" });
    expect(posts.find((p) => p.external_post_id === "2")).toMatchObject({ source: "account", format: "thread", views: 40 });
    expect(posts.map((p) => p.external_post_id)).toEqual(["1", "2"]);
    expect(posts.find((p) => p.id === "p2")).toBeUndefined();

    const metrics = Object.fromEntries((d.metrics as Array<{ key: string; value: number | null; delta: number | null; basis: string }>).map((x) => [x.key, x]));
    expect(metrics.impressions).toMatchObject({ value: 100, delta: null, basis: "period" });
    expect(metrics.likes).toMatchObject({ value: 7, basis: "period" });
    expect(metrics.reposts).toMatchObject({ value: 1, basis: "period" });
    expect(metrics.new_follows).toMatchObject({ value: null, basis: "none" });

    const drafts = d.drafts as Array<Record<string, unknown>>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ decision_id: "d1", channel: "x", text: "draft one", thread: ["two"], rationale: "receipt post" });

    const attention = d.attention as Array<Record<string, unknown>>;
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ key: "step:d3", mode: "approval", status: "open", decision_id: "d3", effort: "minutes" });
    expect(d.actions_waiting).toBe(2);
  });

  it("a refused read keeps the last numbers and names the reason", async () => {
    m.refresh.mockResolvedValue({ read: false, reason: "out", error_code: "x_out_of_credits" });
    m.snapshots.mockResolvedValue([
      { external_post_id: "9", captured_on: yday, posted_at: daysAgoIso(3), text: "old", url: null, format: "post", has_link: false, metrics: { non_public: { impression_count: 5 } } },
    ]);
    const d = await build(ctx({ connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "@c" }] }, true));
    expect(m.refresh).toHaveBeenCalledWith(TENANT, expect.objectContaining({ force: true }));
    expect(d.read).toMatchObject({ error_code: "x_out_of_credits" });
    expect((d.top_posts as unknown[]).length).toBe(1);
  });

  it("profile checks come off the account snapshot, and a dismissal is honoured only until a newer snapshot", async () => {
    const acct = (created_at: string) => ({
      captured_on: today, created_at, username: "coupleapp", name: "Couple App", description: "", url: null, location: null, verified: null,
      profile_image_url: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
      profile_banner_url: null, pinned_post_id: null, followers_count: 100, following_count: 1, post_count: 3,
    });
    m.accounts.mockResolvedValue([acct("2026-09-18T06:00:00Z")]);
    const tables = {
      connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "@coupleapp" }],
      tenants: [{ id: TENANT, display_name: "Couple App" }],
      social_profile_check_dismissals: [
        { tenant_id: TENANT, channel: "x", check_key: "avatar", dismissed_at: "2026-09-18T09:00:00Z" },
        { tenant_id: TENANT, channel: "x", check_key: "header", dismissed_at: "2026-09-17T09:00:00Z" },
      ],
    };
    const d = await build(ctx(tables));
    const byKey = Object.fromEntries((d.attention as Array<{ key: string; status: string; mode: string; link: string | null }>).map((a) => [a.key, a]));
    expect(byKey.bio).toMatchObject({ mode: "manual", status: "open", link: "https://x.com/coupleapp" });
    expect(byKey.avatar).toMatchObject({ mode: "manual", status: "done" });
    expect(byKey.header).toMatchObject({ mode: "manual", status: "open" });
    expect(byKey.pinned).toMatchObject({ mode: "manual", status: "open" });
    expect(d.actions_waiting).toBe(3);
  });
});

describe("x_organic — every draft is a post card", () => {
  const connected = { connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "@c" }] };
  const runs = [
    { id: "old", tenant_id: TENANT, agent_slug: "x_organic", started_at: "2026-09-10T00:00:00Z" },
    { id: "new", tenant_id: TENANT, agent_slug: "x_organic", started_at: "2026-09-18T00:00:00Z" },
  ];

  it("a step whose deliverable is a post or thread becomes a draft; reply kits and the bio stay action items", async () => {
    ch.actions = [
      act("p", "new", { kind: "post", label: "Monday post", content: "Don't rent a car by checking which lot has something left." }),
      act("t", "new", { kind: "thread", label: "Tuesday thread", content: "Root.\n---\nPart two.\n---\nPart three." }),
      act("r", "new", { kind: "comment", label: "Reply kit", content: "When they post about..." }, "Reply kit: @turo"),
      act("b", "new", { kind: "page_copy", label: "X bio", content: "Rent from local owners." }, "Paste your new X bio"),
    ];
    const d = await build(ctx({
      ...connected,
      agent_runs: runs,
    }));
    const drafts = d.drafts as Array<Record<string, unknown>>;
    expect(drafts.map((x) => x.decision_id)).toEqual(["p", "t"]);
    expect(drafts[0]).toMatchObject({ source: "step", label: "Monday post", channel: "x", thread: null, needs_confirm: false });
    expect(drafts[1]).toMatchObject({ text: "Root.", thread: ["Part two.", "Part three."] });
    expect((d.attention as Array<{ key: string }>).map((a) => a.key)).toEqual(["step:r", "step:b"]);
  });

  it("an open card from an earlier run still shows: the ranker decides, not the run date", async () => {
    ch.actions = [
      act("live-post", "new", { kind: "post", label: "New", content: "This week's post." }),
      act("older-post", "old", { kind: "post", label: "Old", content: "Last week's post, still unposted." }),
      act("older-step", "old", null, "Reconnect X"),
    ];
    const d = await build(ctx({ ...connected, agent_runs: runs }));
    expect((d.drafts as Array<{ decision_id: string }>).map((x) => x.decision_id)).toEqual([
      "live-post",
      "older-post",
    ]);
    expect((d.attention as Array<{ key: string }>).map((a) => a.key)).toEqual(["step:older-step"]);
  });

  it("a step draft already staged or already published is dropped — posting it must not resurface it", async () => {
    ch.actions = [
      act("dup-staged", "new", { kind: "post", label: "A", content: "already staged." }),
      act("dup-out", "new", { kind: "post", label: "B", content: "Already out." }),
      act("fresh", "new", { kind: "post", label: "C", content: "Brand new." }),
    ];
    const d = await build(ctx({
      ...connected,
      agent_runs: runs,
      social_posts: [{ id: "lp", tenant_id: TENANT, channel: "x", status: "published", external_url: null, external_post_id: null, approved_payload_snapshot: { payload: { text: "Already   out." } }, metrics: null, scheduled_at: null, created_at: "2026-09-17T09:00:00Z", updated_at: "2026-09-17T10:00:00Z" }],
      decisions: [
        { id: "s1", tenant_id: TENANT, status: "proposed", decision_class: "social.publish.v2", emitted_at: "2026-09-18T08:00:00Z", agent_run_id: "new", body: { channel: "x", payload: { text: "Already staged." } } },
      ],
    }));
    expect((d.drafts as Array<{ decision_id: string }>).map((x) => x.decision_id)).toEqual(["s1", "fresh"]);
  });

  it("a staged draft is never crowded out by other channels' pending steps", async () => {
    const noise = Array.from({ length: 250 }, (_, i) => ({
      id: `seo${i}`, tenant_id: TENANT, status: "proposed", decision_class: "channel.recipe_step", emitted_at: "2026-09-18T09:00:00Z", agent_run_id: "seo-run",
      body: { step: { title: `SEO step ${i}`, body: "seo" } },
    }));
    const d = await build(ctx({
      ...connected,
      agent_runs: [...runs, { id: "seo-run", tenant_id: TENANT, agent_slug: "seo", started_at: "2026-09-18T08:00:00Z" }],
      decisions: [
        ...noise,
        { id: "old-staged", tenant_id: TENANT, status: "proposed", decision_class: "social.publish.v2", emitted_at: "2026-09-13T19:19:00Z", agent_run_id: "old", body: { channel: "x", payload: { text: "Staged days ago, still pending." } } },
      ],
    }));
    expect((d.drafts as Array<{ decision_id: string }>).map((x) => x.decision_id)).toEqual(["old-staged"]);
    expect(d.attention).toEqual([]);
  });

  it("a chat handoff run with no steps does not blank the plan", async () => {
    ch.actions = [act("live-post", "new", { kind: "post", label: "New", content: "This week's post." })];
    const d = await build(ctx({
      ...connected,
      agent_runs: [...runs, { id: "handoff", tenant_id: TENANT, agent_slug: "x_organic", started_at: "2026-09-18T12:00:00Z" }],
    }));
    expect((d.drafts as Array<{ decision_id: string }>).map((x) => x.decision_id)).toEqual(["live-post"]);
  });

  it("every action row is returned — the panel shows a few and expands in place", async () => {
    ch.actions = Array.from({ length: 10 }, (_, i) => act(`d${i}`, "new", null, `Proposal ${i}`));
    const d = await build(ctx({ ...connected, agent_runs: runs }));
    expect(d.attention as unknown[]).toHaveLength(10);
    expect(d.attention_more).toBeUndefined();
    expect(d.actions_waiting).toBe(10);
  });
});

describe("stepToDraft", () => {
  const dec = (deliverable: unknown) => ({ id: "x", emitted_at: null, body: { step: { title: "t", body: "Built to earn replies from the host seat. More detail here.", deliverable } } });
  it("flags an unverified fact so it cannot be one-click posted", () => {
    expect(stepToDraft(dec({ kind: "post", label: "L", content: "[CONFIRM: 10,000+ renters] The car came to them." }))).toMatchObject({ needs_confirm: true });
    expect(stepToDraft(dec({ kind: "post", label: "L", content: "The car came to them." }))).toMatchObject({ needs_confirm: false, rationale: "Built to earn replies from the host seat." });
  });
  it("is null for anything that is not a post or thread", () => {
    for (const d of [{ kind: "comment", content: "x" }, { kind: "page_copy", content: "x" }, { kind: "post", content: 5 }, { kind: "post", content: "  " }, null]) {
      expect(stepToDraft(dec(d))).toBeNull();
    }
  });
});

describe("computeChecklist", () => {
  const healthy = {
    captured_on: "2026-09-18", username: "UpcarCarRental", name: "Upcar", description: "Upcar: rent a local owner's car, delivered.",
    url: "https://upcar.ai", location: "California", verified: true, profile_image_url: "https://pbs.twimg.com/profile_images/1/a.jpg",
    profile_banner_url: "https://pbs.twimg.com/profile_banners/1/b.jpg", pinned_post_id: "5", followers_count: 1, following_count: 1, post_count: 1,
  };
  const root = (id: string, replies = 0): XPostRow => ({ id, format: "post", replies, views: 1, likes: 0, reposts: 0, bookmarks: 0, link_clicks: 0, profile_clicks: 0, engagements: 0 } as XPostRow);
  const reply = (id: string): XPostRow => ({ ...root(id), format: "reply" });

  it("scores ten, and a healthy busy account passes all of them", () => {
    const posts = [root("a", 4), root("b", 2), root("c"), reply("r1"), reply("r2"), reply("r3")];
    const c = computeChecklist(healthy, "Upcar", posts, 7);
    expect(c.total).toBe(10);
    expect(c.passed).toBe(10);
    expect(c.signals.map((x) => x.key)).toEqual(["avatar", "header", "bio", "link", "location", "pinned", "cadence", "reply_rate", "verified", "handle"]);
  });

  it("no profile read yet means unknown, not a guessed pass — and cadence still counts", () => {
    const c = computeChecklist(null, "Upcar", [root("a"), root("b"), root("c")], 7);
    expect(c.signals.find((x) => x.key === "avatar")).toMatchObject({ status: "unknown", note: "No profile read yet" });
    expect(c.signals.find((x) => x.key === "cadence")).toMatchObject({ status: "pass", note: "3 posts a week in this window" });
    expect(c.passed).toBe(1);
  });

  it("names each gap the way the founder sees it", () => {
    const bare = { ...healthy, description: "", url: null, location: null, verified: false, pinned_post_id: null, username: "DeveloperZavi", profile_image_url: "https://abs.twimg.com/sticky/default_profile_images/x.png", profile_banner_url: null };
    const c = computeChecklist(bare, "Upcar", [root("a", 10)], 30);
    const by = Object.fromEntries(c.signals.map((x) => [x.key, x]));
    expect(by.avatar).toMatchObject({ status: "fix", note: "Still the default placeholder" });
    expect(by.bio).toMatchObject({ status: "fix", note: "Bio is empty" });
    expect(by.link).toMatchObject({ status: "fix" });
    expect(by.location).toMatchObject({ status: "fix" });
    expect(by.pinned).toMatchObject({ status: "fix" });
    expect(by.verified).toMatchObject({ status: "fix", link: "https://x.com/i/premium_sign_up" });
    expect(by.handle).toMatchObject({ status: "fix", note: "@DeveloperZavi" });
    expect(by.cadence).toMatchObject({ status: "fix" });
    expect(by.reply_rate).toMatchObject({ status: "fix", note: "0 of your replies for 10 received (0%)" });
    expect(c.passed).toBe(0);
  });

  it("reply rate is unknown when nobody replied, not a fail", () => {
    const c = computeChecklist(healthy, "Upcar", [root("a")], 7);
    expect(c.signals.find((x) => x.key === "reply_rate")).toMatchObject({ status: "unknown", note: "No replies received in this window" });
  });

  it("reply rate is not judged on fewer than 5 received: one reply would flip it", () => {
    const few = computeChecklist(healthy, "Upcar", [root("a", 2), root("b", 2)], 7);
    expect(few.signals.find((x) => x.key === "reply_rate")).toMatchObject({ status: "unknown", note: "Only 4 received, too few to judge" });
    const enough = computeChecklist(healthy, "Upcar", [root("a", 3), root("b", 2), reply("r1")], 7);
    expect(enough.signals.find((x) => x.key === "reply_rate")).toMatchObject({ status: "fix", note: "1 of your replies for 5 received (20%)" });
  });
});

describe("bioNamesCompany", () => {
  const bio = "Smart car rentals delivered to verified professionals, no lines, no hidden fees. Owners earn more with Upcar.";
  it("the account's own name counts, not only the workspace's", () => {
    expect(bioNamesCompany(bio, ["UpcarAI", "Upcar"])).toBe(true);
    expect(bioNamesCompany(bio, ["UpcarAI"])).toBe(false);
  });
  it("ignores punctuation and spacing; still fails a bio that names nobody", () => {
    expect(bioNamesCompany("We are couple-app, for two.", ["Couple App"])).toBe(true);
    expect(bioNamesCompany("We do things.", ["Couple App", "Couple"])).toBe(false);
  });
  it("with no usable name there is nothing to hold the bio to", () => {
    expect(bioNamesCompany("anything", [null, "", "ab"])).toBe(true);
  });
  it("the real case passes the checklist and raises no attention row", () => {
    const acct = { captured_on: "2026-09-18", username: "UpcarCarRental", name: "Upcar", description: bio, url: "https://t.co/x", location: "san francisco", verified: false, profile_image_url: "https://pbs.twimg.com/a.jpg", profile_banner_url: "https://pbs.twimg.com/b.jpg", pinned_post_id: "1", followers_count: 3, following_count: 1, post_count: 4 };
    expect(computeChecklist(acct, "UpcarAI", [], 30).signals.find((x) => x.key === "bio")).toMatchObject({ status: "pass", note: "Bio names the company" });
    expect(profileChecks(acct, "UpcarAI", null).map((c) => c.key)).not.toContain("bio");
  });
});

describe("profileChecks", () => {
  const ok = {
    captured_on: "2026-09-18", username: "coupleapp", name: "Couple App", description: "Couple App: quizzes and milestones for couples.",
    url: "https://coupleapp.com", location: null, verified: null, profile_image_url: "https://pbs.twimg.com/profile_images/1/a.jpg",
    profile_banner_url: "https://pbs.twimg.com/profile_banners/1/b.jpg", pinned_post_id: "5", followers_count: 1, following_count: 1, post_count: 1,
  };
  it("a healthy profile needs nothing", () => {
    expect(profileChecks(ok, "Couple App", null)).toEqual([]);
  });
  it("no snapshot yet means no claims", () => {
    expect(profileChecks(null, "Couple App", null)).toEqual([]);
  });
  it("names each gap the way the founder would", () => {
    const top = { text: "Your first 10 customers don't need a perfect product.", url: "https://x.com/i/web/status/7" } as XPostRow;
    const out = profileChecks({ ...ok, description: "", profile_image_url: null, profile_banner_url: null, pinned_post_id: null }, "Couple App", top);
    expect(out.map((c) => c.key)).toEqual(["bio", "avatar", "header", "pinned"]);
    expect(out[0].title).toBe("Bio does not say what Couple App is");
    expect(out[3].detail).toContain("Your first 10 customers");
    expect(out[3].link).toBe("https://x.com/i/web/status/7");
  });
  it("a bio that never mentions the company is flagged, one that does is not", () => {
    expect(profileChecks({ ...ok, description: "We do things." }, "Couple App", null).map((c) => c.key)).toEqual(["bio"]);
    expect(profileChecks({ ...ok, description: "couple app for two" }, "Couple App", null)).toEqual([]);
  });
});

describe("computeMetrics", () => {
  const snap = (id: string, day: string, imp: number, likes = 0, clicks = 0) => ({
    external_post_id: id, captured_on: day, posted_at: null, text: id, url: null, format: "post", has_link: false,
    metrics: { non_public: { impression_count: imp, url_link_clicks: clicks, engagements: likes }, public: { like_count: likes } },
  });
  const acct = (day: string, followers: number) => ({
    captured_on: day, username: "u", name: "n", description: "d", url: null, location: null, verified: null, profile_image_url: null, profile_banner_url: null,
    pinned_post_id: null, followers_count: followers, following_count: 0, post_count: 0,
  });
  const args = { from: "2026-09-11", to: "2026-09-17", prevFrom: "2026-09-04", prevTo: "2026-09-10" };

  it("accrues the window and compares it to the previous one when history covers both", () => {
    const snapshots = [
      snap("a", "2026-09-03", 100, 1, 1),
      snap("a", "2026-09-10", 200, 3, 3),
      snap("a", "2026-09-17", 350, 4, 4),
    ];
    const accounts = [acct("2026-09-03", 50), acct("2026-09-10", 60), acct("2026-09-17", 75)];
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots, accounts, posts: [] }).map((x) => [x.key, x]));
    expect(m.impressions).toMatchObject({ value: 150, delta: 50, basis: "period" });
    expect(m.link_clicks).toMatchObject({ value: 1, delta: -50, basis: "period" });
    expect(m.likes).toMatchObject({ value: 1, delta: -50 });
    expect(m.engagement_rate).toMatchObject({ value: 0.7, delta: -1.3, basis: "period", delta_unit: "pp" });
    expect(m.new_follows).toMatchObject({ value: 15, delta: 50, basis: "period" });
  });

  it("no delta without a full previous window, and none from a zero base", () => {
    const snapshots = [snap("a", "2026-09-10", 200), snap("a", "2026-09-17", 350)];
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots, accounts: [], posts: [] }).map((x) => [x.key, x]));
    expect(m.impressions).toMatchObject({ value: 150, delta: null, basis: "period" });
    expect(m.new_follows).toMatchObject({ value: null, basis: "none" });
  });

  it("the first day falls back to lifetime totals of the window's posts and says so", () => {
    const posts = [{ views: 400, likes: 9, replies: 2, reposts: 1, link_clicks: 5, profile_clicks: 3, engagements: 20, private_metrics_available: true } as XPostRow];
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots: [snap("a", "2026-09-17", 400)], accounts: [], posts }).map((x) => [x.key, x]));
    expect(m.impressions).toMatchObject({ value: 400, delta: null, basis: "totals" });
    expect(m.engagement_rate).toMatchObject({ value: 5, basis: "totals" });
    expect(m.profile_visits).toMatchObject({ value: 3, basis: "totals" });
  });

  it("does not turn unavailable private metrics into zero totals", () => {
    const posts = [{ views: 400, likes: 9, replies: 2, reposts: 1, link_clicks: 0, profile_clicks: 0, engagements: 12, private_metrics_available: false } as XPostRow];
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots: [], accounts: [], posts }).map(x => [x.key, x]));
    expect(m.link_clicks).toMatchObject({ value: null, basis: "none" });
    expect(m.profile_visits).toMatchObject({ value: null, basis: "none" });
    expect(m.impressions.value).toBe(400);
  });

  it("does not manufacture private accrual from public-only snapshots", () => {
    const snapshots = [snap("a", "2026-09-10", 200), snap("a", "2026-09-17", 350)].map(s => ({ ...s, metrics: { public: { like_count: 4, impression_count: 350 } } }));
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots, accounts: [], posts: [] }).map(x => [x.key, x]));
    expect(m.link_clicks).toMatchObject({ value: null, delta: null, basis: "none" });
    expect(m.profile_visits).toMatchObject({ value: null, delta: null, basis: "none" });
  });

  it("keeps reported zero clicks and withholds a delta against missing private history", () => {
    const snapshots = [
      { ...snap("a", "2026-09-03", 100), metrics: { public: { impression_count: 100 } } },
      snap("a", "2026-09-10", 200, 1, 0), snap("a", "2026-09-17", 350, 2, 0),
    ];
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots, accounts: [], posts: [] }).map(x => [x.key, x]));
    expect(m.link_clicks).toMatchObject({ value: 0, delta: null, basis: "period" });
  });

  it("withholds a total when only some posts carry private counters", () => {
    const posts = [true, false].map(available => ({ views: 400, likes: 1, replies: 0, reposts: 0, link_clicks: available ? 5 : 0, profile_clicks: 0, engagements: 1, private_metrics_available: available }) as XPostRow);
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots: [], accounts: [], posts }).map(x => [x.key, x]));
    expect(m.link_clicks.value).toBeNull();
    expect(m.impressions.value).toBe(800);
  });

  it("new follows without a base before the window is measured from the first snapshot inside it, marked partial", () => {
    const accounts = [acct("2026-09-12", 60), acct("2026-09-17", 75)];
    const m = Object.fromEntries(computeMetrics({ ...args, snapshots: [], accounts, posts: [] }).map((x) => [x.key, x]));
    expect(m.new_follows).toMatchObject({ value: 15, delta: null, basis: "partial" });
  });
});

describe("x_organic — what is allowed to spend a metered read", () => {
  const connected = {
    connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "@coupleapp" }],
  };

  it("a human pressing Refresh forces the read", async () => {
    await build(ctx(connected, true));
    expect(m.refresh).toHaveBeenCalledWith(TENANT, { force: true });
  });

  it("a background refetch does NOT force it — the daily throttle still decides", async () => {
    await build(ctx(connected, false));
    expect(m.refresh).toHaveBeenCalledWith(TENANT, { force: false });
  });

  it("reports the cap reason verbatim so the panel can say whose limit it is", async () => {
    m.refresh.mockResolvedValue({ read: false, reason: "used up", error_code: "x_read_cap_reached" });
    const d = await build(ctx(connected, true));
    expect(d.read).toMatchObject({ error_code: "x_read_cap_reached" });
  });
});

describe("x_organic — today's read allowance", () => {
  it("counts down from the cap using the tenant's counter row", async () => {
    const d = await build(
      ctx({
        connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "@c" }],
        tenant_metered_read_counters: [{ tenant_id: TENANT, day: today, key: "x_metrics", reads: 1 }],
      }),
    );
    expect(d.read_budget).toEqual({ used: 1, cap: 1, remaining: 0 });
  });

  it("nothing spent yet on a fresh day", async () => {
    const d = await build(ctx({ connector_metadata: [{ tenant_id: TENANT, slug: "x_social", team_name: "@c" }] }));
    expect(d.read_budget).toEqual({ used: 0, cap: 1, remaining: 1 });
  });
});

describe("x_organic — the range picker", () => {
  it("honours a shorter window", async () => {
    const d = await build(ctx({}, false, 7));
    expect(d.window_days).toBe(7);
  });

  it("defaults to 30 when the caller asks for nothing", async () => {
    const d = await build(ctx({}, false, null));
    expect(d.window_days).toBe(30);
  });

  it("never exceeds X's 30-day metrics window", async () => {
    const d = await build(ctx({}, false, 90));
    expect(d.window_days).toBe(30);
  });

  it("offers only windows X can actually answer for", async () => {
    const d = await build(ctx({}));
    expect((d.ranges as Array<{ days: number }>).map((r) => r.days)).toEqual([7, 14, 30]);
  });
});

describe("post kinds and engagement by format", () => {
  it("names a post by what it carries, media before link", () => {
    expect(kindOf("post", true)).toBe("link");
    expect(kindOf("post", false)).toBe("text");
    expect(kindOf("photo", true)).toBe("image");
    expect(kindOf("gif", false)).toBe("video");
    expect(kindOf("poll", false)).toBe("poll");
    expect(kindOf("thread", true)).toBe("thread");
  });

  it("sums views and engagements per kind, best rate first, leaving out replies, reposts and unviewed posts", () => {
    const row = (kind: XPostRow["kind"], views: number, engagements: number) => ({ kind, views, engagements });
    expect(formatTotals([row("image", 1000, 20), row("link", 500, 25), row("image", 1000, 22), row("reply", 900, 90), row("poll", 0, 0)])).toEqual([
      { format: "link", views: 500, engagements: 25 },
      { format: "image", views: 2000, engagements: 42 },
    ]);
  });
});
