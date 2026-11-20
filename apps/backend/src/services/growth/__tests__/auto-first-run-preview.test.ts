import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";

const h = vi.hoisted(() => ({
  tier: "free" as "free" | "starter",
  siteRead: true,
  locked: new Set<string>(["ugc", "tiktok_organic", "youtube_organic"]),
  claimed: new Set<string>(),
  midEnqueue: new Set<string>(),
  enqueues: [] as Array<{ agent_slug: string; trigger: string; cron_dedupe_key: unknown }>,
  engineCalls: [] as Array<{ slug: string; request_id: unknown }>,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => {
      const answer = async () =>
        table === "agent_runs"
          ? { data: [], error: null }
          : { data: [{ created_at: "2026-09-25T10:00:00.000000+00:00" }], error: null };
      const leaf = { limit: answer };
      const byKeys = (_c: string, keys: string[]) => ({
        limit: async () => ({ data: h.enqueues.filter((e) => keys.includes(String(e.cron_dedupe_key))), error: null }),
      });
      return { select: () => ({ limit: answer, eq: () => leaf, or: () => leaf, in: byKeys }) };
    },
  }),
}));

vi.mock("@/services/tools/growth/seo/snapshot", () => ({
  seoSnapshotShowsReadableSite: async () => h.siteRead,
}));
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: async () => ({}) }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async (s: string) => h.locked.has(s) }));

vi.mock("@/services/agents/entitlement", async () => {
  const tiers = await vi.importActual<typeof import("@/services/billing/tiers")>("@/services/billing/tiers");
  return {
    createTierGate: () => ({
      decide: async (_t: string, slug: string) => {
        const required_tier = tiers.requiredTierFor(slug);
        return {
          enforced: true,
          tier: h.tier,
          required_tier,
          allowed: tiers.tierRank(h.tier) >= tiers.tierRank(required_tier),
        };
      },
    }),
  };
});

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async (input: { agent_slug: string; trigger: string; cron_dedupe_key?: string }) => {
    h.enqueues.push({ agent_slug: input.agent_slug, trigger: input.trigger, cron_dedupe_key: input.cron_dedupe_key });
    return { run_id: `run-${input.agent_slug}` };
  }),
}));

vi.mock("@/services/channels/engine", () => ({
  runChannelRecipe: vi.fn(
    async (
      tenant_id: string,
      slug: string,
      deps: { enqueue: (i: Record<string, unknown>) => Promise<{ run_id: string }> },
      _redo: unknown,
      _extra: unknown,
      request_id: string,
    ) => {
      h.engineCalls.push({ slug, request_id });
      const claimKey = `${tenant_id}|${slug}|${request_id}`;
      if (h.midEnqueue.has(claimKey)) return { ok: true, run_id: null, channel_slug: slug, duplicate: true };
      if (h.claimed.has(claimKey)) return { ok: true, run_id: `run-${slug}`, channel_slug: slug, duplicate: true };
      h.claimed.add(claimKey);
      const { run_id } = await deps.enqueue({ slug, tenant_id, trigger: "channel_recipe", payload: {} });
      return { ok: true, run_id, channel_slug: slug };
    },
  ),
}));

import { fanOutFirstRun, pickPreviewSlugs, previewCandidates, startPreviewOnOpen } from "../auto-first-run";
import { previewRunKey, requiredTierFor, isTierGatedChannel } from "@/services/billing/tiers";
import { loadChannelRecipe } from "@/services/channels/recipe";

const EXPECTED = ["seo", "geo", "instagram_organic", "linkedin_organic", "x_organic", "reddit_organic"];

beforeEach(() => {
  h.tier = "free";
  h.siteRead = true;
  h.claimed.clear();
  h.midEnqueue.clear();
  h.enqueues.length = 0;
  h.engineCalls.length = 0;
});

describe("signup preview runs", () => {
  it("every live Starter channel is previewed, connected or not", async () => {
    const starterPublic = CHANNELS.filter(
      (c) =>
        isTierGatedChannel(c.slug) &&
        requiredTierFor(c.slug) === "starter" &&
        !(c as { plan_only?: boolean }).plan_only &&
        !RETIRED_CHANNEL_SLUGS.has(c.slug),
    ).map((c) => c.slug);
    expect(starterPublic.filter((s) => !h.locked.has(s)).sort()).toEqual([...EXPECTED].sort());
    expect((await previewCandidates(T)).sort()).toEqual([...EXPECTED].sort());
  });

  it("a plan_only Starter channel (Pinterest) is never previewed on signup", async () => {
    expect(requiredTierFor("pinterest_organic")).toBe("starter");
    expect(await previewCandidates(T)).not.toContain("pinterest_organic");
  });

  it("each channel's executor IS its slug, so the key names the run's own agent", () => {
    for (const slug of EXPECTED) expect(loadChannelRecipe(slug).meta.executor).toBe(slug);
  });

  it("a Free tenant gets its plan's top two Starter channels run, server-marked", async () => {
    const r = await fanOutFirstRun(T, [{ channel_slug: "x_organic" }, { channel_slug: "meta_ads" }, { channel_slug: "geo" }, { channel_slug: "seo" }]);
    expect(r).toMatchObject({ ran: true, preview_slugs: ["x_organic", "geo"] });
    expect(h.enqueues.map((e) => e.agent_slug)).toEqual(["x_organic", "geo"]);
    for (const e of h.enqueues) {
      expect(e.trigger).toBe("channel_recipe");
      expect(e.cron_dedupe_key).toBe(previewRunKey(T, e.agent_slug));
    }
    for (const c of h.engineCalls) expect(c.request_id).toBe(previewRunKey(T, c.slug));
  });

  it("no run at all when the site was not read", async () => {
    h.siteRead = false;
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({ ran: false, reason: "site_not_read" });
    expect(h.enqueues).toHaveLength(0);
  });

  it("a plan with no channel Free can preview still gets two previews, in registry order", async () => {
    const r = await fanOutFirstRun(T, [{ channel_slug: "meta_ads" }]);
    const firstTwo = (await previewCandidates(T)).slice(0, 2);
    expect(r).toMatchObject({ ran: true, preview_slugs: firstTwo });
    expect(h.enqueues.map((e) => e.agent_slug)).toEqual(firstTwo);
  });

  it("a retried apply never runs a channel twice", async () => {
    await fanOutFirstRun(T, [{ channel_slug: "seo" }]);
    await fanOutFirstRun(T, [{ channel_slug: "seo" }]);
    expect(h.enqueues).toHaveLength(2);
    expect(new Set(h.enqueues.map((e) => e.cron_dedupe_key)).size).toBe(2);
  });

  it("pickPreviewSlugs: plan order first, then the rest, deduped, cut to two", () => {
    expect(pickPreviewSlugs(["seo", "geo", "x_organic"], [{ channel_slug: "x_organic" }, { channel_slug: "x_organic" }])).toEqual(["x_organic", "seo"]);
    expect(pickPreviewSlugs([], [{ channel_slug: "seo" }])).toEqual([]);
  });
});

describe("a channel's preview runs when the founder first opens it", () => {
  const PLAN = [{ channel_slug: "seo" }, { channel_slug: "geo" }];

  it("a channel not previewed at signup runs once, on the house preview key, and never again", async () => {
    await fanOutFirstRun(T, PLAN);
    expect(await startPreviewOnOpen(T, "reddit_organic")).toEqual({ started: true, reason: "started" });
    expect(await startPreviewOnOpen(T, "reddit_organic")).toEqual({ started: false, reason: "already_previewed" });
    expect(h.enqueues.map((e) => e.agent_slug)).toEqual(["seo", "geo", "reddit_organic"]);
    expect(h.enqueues[2]!.cron_dedupe_key).toBe(previewRunKey(T, "reddit_organic"));
  });

  it("a second tab racing the first start reports that it started nothing", async () => {
    const claim = `${T}|reddit_organic|${previewRunKey(T, "reddit_organic")}`;
    h.midEnqueue.add(claim);
    expect(await startPreviewOnOpen(T, "reddit_organic")).toEqual({ started: false, reason: "already_starting" });
    h.midEnqueue.delete(claim);
    h.claimed.add(claim);
    expect(await startPreviewOnOpen(T, "reddit_organic")).toEqual({ started: false, reason: "already_previewed" });
    expect(h.enqueues).toHaveLength(0);
  });

  it("a channel previewed at signup does not run again", async () => {
    await fanOutFirstRun(T, PLAN);
    expect(await startPreviewOnOpen(T, "seo")).toEqual({ started: false, reason: "already_previewed" });
    expect(h.enqueues).toHaveLength(2);
  });

  it("nothing runs for a tier that can run the channel, a channel Free never previews, or an unread site", async () => {
    expect(await startPreviewOnOpen(T, "meta_ads")).toMatchObject({ started: false, reason: "not_previewable" });
    expect(await startPreviewOnOpen(T, "pinterest_organic")).toMatchObject({ started: false, reason: "not_previewable" });
    h.siteRead = false;
    expect(await startPreviewOnOpen(T, "seo")).toMatchObject({ started: false, reason: "site_not_read" });
    h.siteRead = true;
    h.tier = "starter";
    expect(await startPreviewOnOpen(T, "seo")).toMatchObject({ started: false, reason: "not_previewable" });
    expect(h.enqueues).toHaveLength(0);
  });

  it("a tenant whose plan runs Starter channels keeps the single paid first run", async () => {
    h.tier = "starter";
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({ ran: true, channel_slug: "seo" });
    expect(h.enqueues).toHaveLength(1);
    expect(h.enqueues[0]!.cron_dedupe_key).toBe(`first-run:${T}`);
  });

  it("the key fits the claim's request_id bounds (8-200)", () => {
    for (const slug of EXPECTED) {
      const k = previewRunKey(T, slug);
      expect(k.length).toBeGreaterThanOrEqual(8);
      expect(k.length).toBeLessThanOrEqual(200);
    }
  });
});
