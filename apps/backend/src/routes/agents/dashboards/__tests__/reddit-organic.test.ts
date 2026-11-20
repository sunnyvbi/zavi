import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insights: vi.fn(), ensureBrand: vi.fn(), svc: null as unknown }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => mocks.svc }));
vi.mock("@/services/channels/reddit/insights", () => ({ buildRedditInsights: mocks.insights }));
vi.mock("@/services/channels/reddit/suggest", () => ({ ensureBrandKeyword: mocks.ensureBrand }));

import { build, buildOverview } from "@/services/agents/dashboards/reddit-organic";

beforeEach(() => {
  mocks.insights.mockReset().mockRejectedValue(new Error("relation reddit_sweeps does not exist"));
  mocks.ensureBrand.mockReset().mockResolvedValue(undefined);
  mocks.svc = fakeSb({});
});

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function actionRow(
  d: { id: string; emitted_at: string; agent_run_id: string; body: unknown },
  channel_slug = "reddit_organic",
) {
  return {
    id: d.id,
    tenant_id: TENANT,
    channel_slug,
    status: "pending",
    proposed_at: d.emitted_at,
    run_id: d.agent_run_id,
    body: d.body,
  };
}

function fakeSb(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: (key: string, value: unknown) => {
          rows = rows.filter((row) => row[key] === value);
          return chain;
        },
        in: (key: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(key === "body->>channel" ? (row.body as { channel?: string })?.channel : row[key]));
          return chain;
        },
        order: self,
        limit: (count: number) => {
          rows = rows.slice(0, count);
          return chain;
        },
        then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
          resolve({ data: rows, error: null }),
      });
      return chain;
    },
  } as never;
}

describe("reddit_organic dashboard builder", () => {
  it("returns only structured Reddit suggestions from Reddit Organic runs", async () => {
    const presentation = {
      type: "reddit_post",
      subreddit: "r/turo",
      title: "The hosting mistake that cost us a weekend",
      post_type: "text",
      style: "Postmortem",
      affiliation_disclosure: "first_line",
      rule_status: "verify_manually",
      potential: {
        level: "promising",
        confidence: "medium",
        reasons: [
          "Postmortems appear in the current sample",
          "The lesson comes from company context",
        ],
      },
    };
    const RUN_CHANNEL: Record<string, string> = {
      "reddit-run": "reddit_organic",
      "old-reddit-run": "reddit_organic",
      "other-run": "seo",
    };
    const STEP_CARDS = [
          {
            id: "d1",
            tenant_id: TENANT,
            status: "proposed",
            decision_class: "channel.recipe_step",
            emitted_at: "2026-09-14T10:00:00Z",
            agent_run_id: "reddit-run",
            body: {
              rendered_markdown: "Research summary",
              step: {
                body: "Check rules, then copy it.",
                evidence: ["source"],
                deliverable: {
                  content:
                    "Full disclosure, I run Upcar.\n\nHere is what happened.",
                  presentation,
                },
              },
            },
          },
          {
            id: "d2",
            tenant_id: TENANT,
            status: "proposed",
            decision_class: "channel.recipe_step",
            emitted_at: "2026-09-14T09:00:00Z",
            agent_run_id: "other-run",
            body: {
              step: { deliverable: { content: "not reddit", presentation } },
            },
          },
          {
            id: "older-open-card",
            tenant_id: TENANT,
            status: "proposed",
            decision_class: "channel.recipe_step",
            emitted_at: "2026-09-13T09:00:00Z",
            agent_run_id: "old-reddit-run",
            body: {
              step: {
                deliverable: {
                  content:
                    "An open card from an earlier run still belongs to the founder.",
                  presentation,
                },
              },
            },
          },
          {
            id: "d3",
            tenant_id: TENANT,
            status: "proposed",
            decision_class: "channel.recipe_step",
            emitted_at: "2026-09-14T08:00:00Z",
            agent_run_id: "reddit-run",
            body: { step: { deliverable: { content: "checklist only" } } },
          },
          {
            id: "d4",
            tenant_id: TENANT,
            status: "proposed",
            decision_class: "channel.recipe_step",
            emitted_at: "2026-09-14T07:00:00Z",
            agent_run_id: "reddit-run",
            body: {
              step: {
                body: "A host is asking a question Upcar can answer directly.",
                evidence: ["reddit__thread_read: visible thread"],
                deliverable: {
                  content:
                    "I work on Upcar. The first thing I would check is...",
                  presentation: {
                    type: "reddit_reply",
                    subreddit: "turo",
                    thread_title:
                      "How should hosts document vehicle condition?",
                    thread_url:
                      "https://www.reddit.com/r/turo/comments/example",
                    reply_style: "Direct answer",
                    rule_status: "ready",
                    potential: {
                      level: "promising",
                      confidence: "high",
                      reasons: [
                        "The question directly matches verified expertise",
                      ],
                    },
                  },
                },
              },
            },
          },
          {
            id: "d5",
            tenant_id: TENANT,
            status: "proposed",
            decision_class: "channel.recipe_step",
            emitted_at: "2026-09-14T06:00:00Z",
            agent_run_id: "reddit-run",
            body: {
              step: {
                title: "Answer the r/turo host asking about trip photos",
                body: "Use the existing Q&A workflow and check the thread again.",
                evidence: [
                  "reddit__thread_read: https://www.reddit.com/r/turo/comments/legacy123",
                ],
                deliverable: {
                  kind: "comment",
                  label: "Answer 1 for r/turo",
                  content:
                    "Full disclosure, I work on Upcar. Start with timestamped photos.",
                },
              },
            },
          },
          {
            id: "d6",
            tenant_id: TENANT,
            status: "proposed",
            decision_class: "channel.recipe_step",
            emitted_at: "2026-09-14T05:00:00Z",
            agent_run_id: "reddit-run",
            body: {
              step: {
                title: "Set up the buyer-question alerts",
                body: "Use the existing Q&A alert list.",
                blocking: false,
                effort: "minutes",
                evidence: ["buyer query set"],
                deliverable: {
                  kind: "list",
                  label: "Free alerts",
                  content: "1. turo damage photos\n2. host trip inspection",
                },
              },
            },
          },
    ];
    const data = await build({
      tenantId: TENANT,
      accessToken: "token",
      ctx: { tenant_id: TENANT } as never,
      refresh: false,
      meteredRefresh: false,
      rangeDays: null,
      sb: fakeSb({
        channel_actions: STEP_CARDS.map((d) => actionRow(d, RUN_CHANNEL[d.agent_run_id])),
        agent_runs: [
          { id: "reddit-run", tenant_id: TENANT, agent_slug: "reddit_organic" },
          {
            id: "old-reddit-run",
            tenant_id: TENANT,
            agent_slug: "reddit_organic",
          },
          { id: "other-run", tenant_id: TENANT, agent_slug: "seo" },
        ],
      }),
    });
    expect(data).toMatchObject({
      connected: false,
      manual_publish: false,
      research_summary: "Research summary",
    });
    expect(data.suggestions).toEqual([
      expect.objectContaining({
        id: "d1",
        type: "reddit_post",
        subreddit: "turo",
        title: "The hosting mistake that cost us a weekend",
        body: expect.stringContaining("Full disclosure"),
      }),
      expect.objectContaining({
        id: "older-open-card",
        type: "reddit_post",
      }),
      expect.objectContaining({
        id: "d4",
        type: "reddit_reply",
        subreddit: "turo",
        thread_title: "How should hosts document vehicle condition?",
        body: expect.stringContaining("I work on Upcar"),
        rule_status: "verify_manually",
        potential: expect.objectContaining({ confidence: "high" }),
      }),
      expect.objectContaining({
        id: "d5",
        type: "reddit_reply",
        subreddit: "turo",
        thread_url: "https://www.reddit.com/r/turo/comments/legacy123/",
        reply_style: "Existing Q&A answer",
        body: expect.stringContaining("timestamped photos"),
      }),
    ]);
    expect(data.supporting_steps).toEqual([
      expect.objectContaining({
        id: "d3",
        deliverable: expect.objectContaining({ content: "checklist only" }),
      }),
      expect.objectContaining({
        id: "d6",
        title: "Set up the buyer-question alerts",
        deliverable: expect.objectContaining({ kind: "list" }),
      }),
    ]);
  });

  it("hands the founder a canonical thread link, and never a non-thread href", async () => {
    const reply = (id: string, thread_url: string) => ({
      id,
      tenant_id: TENANT,
      status: "proposed",
      decision_class: "channel.recipe_step",
      emitted_at: "2026-09-14T10:00:00Z",
      agent_run_id: "reddit-run",
      body: {
        step: {
          deliverable: {
            content: "Full disclosure, I work on Upcar. Timestamped photos at pickup settle most claims.",
            presentation: {
              type: "reddit_reply",
              subreddit: "turo",
              thread_title: "Photos at pickup?",
              thread_url,
              reply_style: "Direct answer",
              rule_status: "verify_manually",
              potential: { level: "promising", confidence: "medium", reasons: ["Direct question"] },
            },
          },
        },
      },
    });
    const comment = (id: string, evidence: string) => ({
      id,
      tenant_id: TENANT,
      status: "proposed",
      decision_class: "channel.recipe_step",
      emitted_at: "2026-09-14T09:00:00Z",
      agent_run_id: "reddit-run",
      body: {
        step: {
          title: "Answer the r/turo host",
          evidence: [evidence],
          deliverable: { kind: "comment", label: "Answer", content: "Full disclosure, I work on Upcar. Start with photos." },
        },
      },
    });
    const data = await build({
      tenantId: TENANT,
      accessToken: "token",
      ctx: { tenant_id: TENANT } as never,
      refresh: false, meteredRefresh: false, rangeDays: null,
      sb: fakeSb({
        agent_runs: [{ id: "reddit-run", tenant_id: TENANT, agent_slug: "reddit_organic" }],
        channel_actions: [
          reply("old-host", "https://old.reddit.com/r/Turo/comments/1AB2CD/photos_at_pickup/lk9z/?utm_source=share&utm_medium=web2x"),
          reply("listing", "https://www.reddit.com/r/turo/"),
          reply("external", "https://techcrunch.com/turo"),
          comment("c-rules-first", "rules https://www.reddit.com/r/turo/about/rules/ then thread https://np.reddit.com/r/turo/comments/9xy8/x/."),
          comment("c-no-thread", "only the sub https://www.reddit.com/r/turo/"),
        ].map((d) => actionRow(d)),
      }),
    });
    const byId = Object.fromEntries(
      (data.suggestions as Array<Record<string, unknown>>).map((s) => [s.id, s]),
    );
    expect(byId["old-host"]).toMatchObject({ thread_url: "https://www.reddit.com/r/turo/comments/1ab2cd/" });
    expect(byId.listing).toBeUndefined();
    expect(byId.external).toBeUndefined();
    expect(byId["c-rules-first"]).toMatchObject({ thread_url: "https://www.reddit.com/r/turo/comments/9xy8/" });
    expect(byId["c-no-thread"]).toBeDefined();
    expect(byId["c-no-thread"]).not.toHaveProperty("thread_url");
  });

  it("reads only this tenant's reddit_organic actions", async () => {
    const card = (id: string, tenant_id: string, channel_slug: string, status: string) => ({
      id,
      tenant_id,
      channel_slug,
      status,
      proposed_at: "2026-09-14T10:00:00Z",
      run_id: "reddit-run",
      body: {
        step: {
          title: `card ${id}`,
          body: "why",
          evidence: ["source"],
          deliverable: { kind: "list", label: "l", content: `content ${id}` },
        },
      },
    });
    const data = await build({
      tenantId: TENANT,
      accessToken: "token",
      ctx: { tenant_id: TENANT } as never,
      refresh: false,
      meteredRefresh: false,
      rangeDays: null,
      sb: fakeSb({
        agent_runs: [{ id: "reddit-run", tenant_id: TENANT, agent_slug: "reddit_organic" }],
        channel_actions: [
          card("mine", TENANT, "reddit_organic", "pending"),
          card("mine-snoozed", TENANT, "reddit_organic", "snoozed"),
          card("mine-acted", TENANT, "reddit_organic", "acted"),
          card("mine-rejected", TENANT, "reddit_organic", "rejected"),
          card("other-channel", TENANT, "linkedin_organic", "pending"),
          card("other-tenant", "11111111-1111-1111-1111-111111111111", "reddit_organic", "pending"),
        ],
      }),
    });
    const ids = (data.supporting_steps as Array<Record<string, unknown>>).map((s) => s.id);
    expect(ids.sort()).toEqual(["mine", "mine-snoozed"]);
  });

  it("hides a card whose snooze has not run out, and shows it once it has", async () => {
    const card = (id: string, snoozed_until: string | null) => ({
      id,
      tenant_id: TENANT,
      channel_slug: "reddit_organic",
      status: "snoozed",
      snoozed_until,
      proposed_at: "2026-09-14T10:00:00Z",
      run_id: "reddit-run",
      body: {
        step: {
          title: `card ${id}`,
          body: "why",
          evidence: ["source"],
          deliverable: { kind: "list", label: "l", content: `content ${id}` },
        },
      },
    });
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const data = await build({
      tenantId: TENANT,
      accessToken: "token",
      ctx: { tenant_id: TENANT } as never,
      refresh: false,
      meteredRefresh: false,
      rangeDays: null,
      sb: fakeSb({
        agent_runs: [{ id: "reddit-run", tenant_id: TENANT, agent_slug: "reddit_organic" }],
        channel_actions: [
          card("still-snoozed", soon),
          card("snooze-elapsed", past),
          card("snooze-undated", null),
        ],
      }),
    });
    const ids = (data.supporting_steps as Array<Record<string, unknown>>).map((s) => s.id);
    expect(ids.sort()).toEqual(["snooze-elapsed", "snooze-undated"]);
  });

  it("stamps every card with the store its id came from", async () => {
    const data = await build({
      tenantId: TENANT,
      accessToken: "token",
      ctx: { tenant_id: TENANT } as never,
      refresh: false,
      meteredRefresh: false,
      rangeDays: null,
      sb: fakeSb({
        agent_runs: [{ id: "reddit-run", tenant_id: TENANT, agent_slug: "reddit_organic" }],
        channel_actions: [
          {
            id: "act-1",
            tenant_id: TENANT,
            channel_slug: "reddit_organic",
            status: "pending",
            snoozed_until: null,
            proposed_at: "2026-09-14T10:00:00Z",
            run_id: "reddit-run",
            body: {
              step: {
                title: "Answer this thread",
                body: "why",
                evidence: ["https://www.reddit.com/r/turo/comments/abc123/x/"],
                deliverable: {
                  kind: "comment",
                  label: "Reply",
                  content: "Here is the answer the founder can paste.",
                },
              },
            },
          },
          {
            id: "act-2",
            tenant_id: TENANT,
            channel_slug: "reddit_organic",
            status: "pending",
            snoozed_until: null,
            proposed_at: "2026-09-14T09:00:00Z",
            run_id: "reddit-run",
            body: {
              step: {
                title: "Check the subreddit rules",
                body: "why",
                evidence: ["source"],
                deliverable: { kind: "list", label: "l", content: "a checklist" },
              },
            },
          },
        ],
      }),
    });
    const rows = [
      ...(data.suggestions as Array<Record<string, unknown>>),
      ...(data.supporting_steps as Array<Record<string, unknown>>),
    ];
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.action_source).toBe("channel_action");
  });

  it("degrades to an empty manual-only panel", async () => {
    const data = await build({
      tenantId: TENANT,
      accessToken: "t",
      ctx: {} as never,
      refresh: false,
      meteredRefresh: false,
      rangeDays: null,
      sb: fakeSb({}),
    });
    expect(data).toMatchObject({
      connected: false,
      account: { connected: false, handle: null },
      manual_publish: false,
      research_summary: null,
      suggestions: [],
      supporting_steps: [],
      last_run: null,
      workspace: { keywords: [], competitors: [], communities: [] },
    });
    expect((data.overview as { kpis: unknown }).kpis).toEqual({
      reply_opportunities: 0,
      post_opportunities: 0,
      communities: 0,
      tracked_keywords: 0,
      tracked_competitors: 0,
    });
  });

  it("a Composio Reddit connection counts as connected; only the native row supplies a handle", async () => {
    const opts = { tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null };
    const composio = await build({ ...opts, sb: fakeSb({ connector_metadata: [{ tenant_id: TENANT, slug: "composio.reddit", team_name: null }] }) });
    expect(composio.account).toEqual({ connected: true, handle: null });
    const both = await build({ ...opts, sb: fakeSb({ connector_metadata: [
      { tenant_id: TENANT, slug: "composio.reddit", team_name: null },
      { tenant_id: TENANT, slug: "reddit_social", team_name: "u/zavi" },
    ] }) });
    expect(both.account).toEqual({ connected: true, handle: "u/zavi" });
  });

  it("never serializes a number for a metric it has no source for", async () => {
    const data = await build({
      tenantId: TENANT,
      accessToken: "t",
      ctx: {} as never,
      refresh: false, meteredRefresh: false, rangeDays: null,
      sb: fakeSb({}),
    });
    const overview = data.overview as { unavailable: Array<{ metric: string; reason: string }> };
    expect(overview.unavailable).toEqual([
      { metric: "impressions", reason: expect.stringContaining("only to the account that posted") },
    ]);
    const kpis = (data.overview as { kpis: Record<string, unknown> }).kpis;
    for (const m of ["mentions", "share_of_voice", "google_rank", "impressions"]) {
      expect(kpis).not.toHaveProperty(m);
    }
  });
});

describe("reddit_organic dashboard insights", () => {
  it("is null with a short insights_error when the read fails, without touching the other fields", async () => {
    const data = await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({}) });
    expect(data.insights).toBeNull();
    expect(data.insights_error).toBe("Couldn't load Reddit insights.");
    expect(String(data.insights_error)).not.toContain("reddit_sweeps");
    expect(data).toMatchObject({ manual_publish: false, suggestions: [], last_run: null });
  });

  it("adds the read model for the authenticated tenant, with no error", async () => {
    const insights = { has_data: true, threshold: 60 };
    mocks.insights.mockResolvedValue(insights);
    const data = await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({}) });
    expect(data.insights).toBe(insights);
    expect(data.insights_error).toBeNull();
    expect(mocks.insights).toHaveBeenCalledWith(expect.anything(), TENANT);
  });

  it("tracks the brand keyword before reading the workspace, and survives its failure", async () => {
    const order: string[] = [];
    mocks.ensureBrand.mockImplementation(async () => {
      order.push("ensure");
    });
    const svc = fakeSb({});
    const from = (svc as { from: (t: string) => unknown }).from;
    (svc as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "channel_settings") order.push("workspace");
      return from(t);
    };
    mocks.svc = svc;
    await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({}) });
    expect(mocks.ensureBrand).toHaveBeenCalledWith(svc, TENANT);
    expect(order[0]).toBe("ensure");
    expect(order).toContain("workspace");

    mocks.ensureBrand.mockRejectedValue(new Error("insert failed"));
    const data = await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({}) });
    expect(data).toMatchObject({ manual_publish: false, workspace: { keywords: [] } });
  });
});

describe("reddit_organic dashboard workspace read", () => {
  it("reads the setup with the service client and the route's tenant, not the bearer client", async () => {
    const kw = (id: string, tenant_id: string, item: string) => ({
      id,
      tenant_id,
      channel_slug: "reddit_organic",
      field_id: "keywords",
      item,
      item_type: "problem",
      status: "tracking",
      position: 0,
      note: null,
      origin: "custom",
      detail: null,
      updated_at: "2026-09-01T00:00:00.000Z",
      updated_by: null,
    });
    mocks.svc = fakeSb({
      channel_settings: [kw("k1", TENANT, "rent my car"), kw("k2", "other-tenant", "leak")],
    });
    const data = await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({}) });
    expect((data.workspace as { keywords: Array<{ id: string }> }).keywords.map((k) => k.id)).toEqual(["k1"]);
  });

  it("is null on a good read", async () => {
    const data = await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({}) });
    expect(data.workspace_error).toBeNull();
  });

  it("on a failed read keeps the empty workspace, logs the real error, and says so in workspace_error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeSb({});
    const from = (svc as { from: (t: string) => unknown }).from;
    (svc as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "channel_settings") throw new Error("permission denied for channel_settings");
      return from(t);
    };
    mocks.svc = svc;
    const data = await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({}) });
    expect(data.workspace_error).toBe("Couldn't load your Reddit setup.");
    expect(String(data.workspace_error)).not.toContain("permission");
    expect(data).toMatchObject({ manual_publish: false, suggestions: [], workspace: { keywords: [], competitors: [], communities: [] } });
    expect(spy).toHaveBeenCalledWith("[reddit-dashboard] workspace read failed", expect.stringContaining("permission denied"));
    spy.mockRestore();
  });
});

describe("buildOverview", () => {
  const ws = {
    keywords: [
      { id: "k1", term: "rent out my car", type: "problem", origin: "custom", status: "tracking", why: null, created_at: "" },
      { id: "k2", term: "turo", type: "competitor", origin: "custom", status: "paused", why: null, created_at: "" },
    ],
    competitors: [],
    communities: [
      { id: "c1", name: "carsharing", selected: true, rules_verdict: "unclear", rules_verdict_at: "x", created_at: "" },
      { id: "c2", name: "Frugal", selected: false, rules_verdict: null, rules_verdict_at: null, created_at: "" },
    ],
  } as never;

  it("merges run suggestions with saved communities, case-insensitively, busiest first", () => {
    const o = buildOverview(
      [
        { type: "reddit_reply", subreddit: "r/SmallBusiness" },
        { type: "reddit_reply", subreddit: "smallbusiness" },
        { type: "reddit_post", subreddit: "Carsharing" },
      ],
      ws,
    );
    expect(o.kpis).toMatchObject({
      reply_opportunities: 2,
      post_opportunities: 1,
      communities: 3,
      tracked_keywords: 1,
    });
    expect(o.top_communities.map((c) => [c.name, c.reply_opportunities, c.post_opportunities, c.saved])).toEqual([
      ["SmallBusiness", 2, 0, false],
      ["carsharing", 0, 1, true],
      ["Frugal", 0, 0, true],
    ]);
    expect(o.top_communities[1].rules_verdict).toBe("unclear");
  });
});

describe("buildOverview keeps every saved community visible", () => {
  it("lists a saved community with no opportunities even when 10 run-found ones are busier", () => {
    const suggestions = Array.from({ length: 10 }, (_, i) => ({ type: "reddit_reply", subreddit: `found${i}` }));
    const ws = {
      keywords: [],
      competitors: [],
      communities: [
        { id: "s", name: "mysaved", selected: true, rules_verdict: "banned", rules_verdict_at: "x", created_at: "" },
      ],
    } as never;
    const o = buildOverview(suggestions, ws);
    expect(o.top_communities).toHaveLength(10);
    expect(o.top_communities.map((c) => c.name)).toContain("mysaved");
    expect(o.top_communities.find((c) => c.name === "mysaved")?.rules_verdict).toBe("banned");
  });

  it("counts only reddit_post rows as post opportunities per community", () => {
    const o = buildOverview([{ type: "other", subreddit: "x_y" }, { type: "reddit_post", subreddit: "x_y" }], {
      keywords: [],
      competitors: [],
      communities: [],
    } as never);
    expect(o.top_communities[0]).toMatchObject({ name: "x_y", post_opportunities: 1, reply_opportunities: 0 });
  });
});

it("shows only this tenant's pending Reddit publish proposals", async () => {
  const own = { id: "own", tenant_id: TENANT, decision_class: "social.publish.v2", status: "proposed", emitted_at: "", body: { channel: "reddit", payload: { subreddit: "test", title: "Test", text: "Test body" } } };
  const data = await build({ tenantId: TENANT, accessToken: "t", ctx: {} as never, refresh: false, meteredRefresh: false, rangeDays: null, sb: fakeSb({ decisions: [own,
    { ...own, id: "other-tenant", tenant_id: "other" },
    { ...own, id: "finished", status: "acted" },
    { ...own, id: "other-channel", body: { channel: "x" } },
  ] }) });
  expect(data.drafts_ok).toBe(true);
  expect(data.drafts).toEqual([expect.objectContaining({ decision_id: "own", channel: "reddit", text: "Test body", subreddit: "test", title: "Test" })]);
});
