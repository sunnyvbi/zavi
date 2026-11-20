import { beforeEach, describe, expect, it, vi } from "vitest";

const BAKERY = "33333333-3333-4333-8333-333333333333";
const GYM = "55555555-5555-4555-8555-555555555555";
const ON = "2026-10-12T09:00:00.000Z";

const handler = vi.hoisted(() => ({ fn: null as null | ((ctx: unknown) => Promise<unknown>) }));
vi.mock("../../client", () => ({
  inngest: { createFunction: vi.fn((_cfg: unknown, _trigger: unknown, fn: (ctx: unknown) => Promise<unknown>) => ((handler.fn = fn), { id: "channel-sweep" })) },
}));
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => false }));
vi.mock("@/services/channels/lock", () => ({ readLockedChannelSlugs: async () => new Set<string>() }));
vi.mock("@/services/channels/watch", () => ({ runWatchProbes: async () => ({ probed: 0, changed: 0 }) }));
vi.mock("@/services/channels/recipe", () => ({ recipeExists: () => true, loadChannelRecipe: () => ({ meta: { cadence: "daily" } }) }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("@/services/agents/entitlement", () => ({ loadTierGateConfig: async () => ({ deferred: false, agentMin: {}, alwaysPro: [] }), resolveTenantTier: async () => "pro" }));
vi.mock("@/services/billing/tiers", () => ({ tierAllows: () => true }));
vi.mock("@/services/brand/resolve-brand-kit", () => ({ marketingUrlOf: () => "https://example.test" }));
vi.mock("@/services/channels/context", () => ({ defaultChannelContext: {} }));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => false }));
const idle = new Set<string>();
vi.mock("@/services/growth/tenant-idle", () => ({ tenantIsIdle: async (t: string) => idle.has(t) }));

const runChannelRecipe = vi.fn(async (_t: string, _slug: string, _o: unknown) => ({ ok: true as const }));
vi.mock("@/services/channels/engine", () => ({ runChannelRecipe: (t: string, s: string, o: unknown) => runChannelRecipe(t, s, o) }));

const SLUGS = ["seo", "email_marketing", "meta_ads"];
const storedRows: Record<string, Array<Record<string, unknown>>> = {};
vi.mock("@/services/channels/state", async () => {
  const { CHANNELS } = await import("@zavi/shared");
  return {
    readChannelStates: async (_svc: unknown, tenant_id: string) => ({
      error: null,
      rowCount: SLUGS.length,
      states: CHANNELS.filter((c) => SLUGS.includes(c.slug)).map((channel) => {
        const r = (storedRows[tenant_id] ?? []).find((x) => x.channel_slug === channel.slug) ?? {};
        return {
          channel,
          work_state: "idle",
          priority: 100,
          plan_selected: true,
          plan_sort_order: null,
          autorun: (r.autorun as boolean) ?? false,
          autorun_set_by: (r.autorun_set_by as string) ?? null,
          autorun_set_at: (r.autorun_set_at as string) ?? null,
          chatgpt_autopilot_consent_at: null,
          last_run_at: null,
          last_probe_at: null,
          last_probe_delta: null,
          seeded: true,
        };
      }),
    }),
  };
});

const autopilot: Record<string, { enabled: boolean; on_at: string | null } | "throw"> = {};
const changedSince: Record<string, Array<Record<string, unknown>>> = {};
vi.mock("@/services/growth/channel-autorun", async (orig) => {
  const real = (await orig()) as typeof import("@/services/growth/channel-autorun");
  const state = (t: string) => {
    const a = autopilot[t];
    if (a === "throw") throw new Error("settings down");
    return a ?? { enabled: false, on_at: null };
  };
  return {
    ...real,
    readAutopilotState: async (t: string) => state(t),
    readEffectiveAutorun: async (t: string, slug: string) => {
      const rows = [...(changedSince[t] ?? []), ...(storedRows[t] ?? [])];
      return real.resolveChannelAutorun(state(t), slug, (rows.find((r) => r.channel_slug === slug) ?? null) as never).effective;
    },
  };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        limit: async () => ({ data: table === "growth_plan" ? [{ id: "p" }] : [], error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(
            table === "tenants"
              ? { data: [{ id: BAKERY, slug: "bakery", product_url: null }, { id: GYM, slug: "gym", product_url: null }], error: null }
              : table === "connector_metadata"
                ? { data: ["google_search_console", "google_analytics", "composio.mailchimp", "meta_ads"].map((slug) => ({ slug })), error: null }
                : { data: [], error: null },
          ).then(ok),
      };
      return q;
    },
  }),
}));

import { CHANNELS } from "@zavi/shared";
import "../channel-sweep";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const sweep = () => handler.fn!({ step: { run: (_n: string, f: () => unknown) => f() }, logger }) as Promise<Record<string, unknown>>;
const ran = (t: string) => runChannelRecipe.mock.calls.filter((c) => c[0] === t).map((c) => c[1]).sort();

beforeEach(() => {
  runChannelRecipe.mockClear();
  idle.clear();
  for (const k of Object.keys(autopilot)) delete autopilot[k];
  for (const k of Object.keys(storedRows)) delete storedRows[k];
  for (const k of Object.keys(changedSince)) delete changedSince[k];
});

describe("channel-sweep and Autopilot", () => {
  it("the fixture channels exist and have a connector the sweep sees", () => {
    for (const s of SLUGS) expect(CHANNELS.some((c) => c.slug === s)).toBe(true);
  });

  it("Autopilot off for every tenant: nothing is enqueued, whatever the stored switch says", async () => {
    storedRows[BAKERY] = SLUGS.map((channel_slug) => ({ channel_slug, autorun: true, autorun_set_by: "founder" }));
    const out = await sweep();
    expect(runChannelRecipe).not.toHaveBeenCalled();
    expect(out.skipped_autopilot_off).toBe(2);
  });

  it("an unreadable Autopilot spends nothing", async () => {
    autopilot[BAKERY] = "throw";
    await sweep();
    expect(ran(BAKERY)).toEqual([]);
  });

  it("Autopilot on: every due plan channel runs although every stored switch is off; the gym (off) runs nothing", async () => {
    autopilot[BAKERY] = { enabled: true, on_at: ON };
    storedRows[BAKERY] = SLUGS.map((channel_slug) => ({ channel_slug, autorun: false, autorun_set_by: "plan" }));
    await sweep();
    expect(ran(BAKERY)).toEqual(["email_marketing", "meta_ads", "seo"]);
    expect(ran(GYM)).toEqual([]);
  });

  it("Autopilot on but nobody used the workspace for 7 days: no recipe runs; it resumes once someone does", async () => {
    autopilot[BAKERY] = { enabled: true, on_at: ON };
    idle.add(BAKERY);
    const out = await sweep();
    expect(ran(BAKERY)).toEqual([]);
    expect(out.skipped_idle).toBe(1);
    idle.clear();
    await sweep();
    expect(ran(BAKERY)).toEqual(["email_marketing", "meta_ads", "seo"]);
  });

  it("Autopilot on: a channel the founder set to ask first since the ON is skipped, an older off is not", async () => {
    autopilot[BAKERY] = { enabled: true, on_at: ON };
    storedRows[BAKERY] = [
      { channel_slug: "seo", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-12T10:00:00.000Z" },
      { channel_slug: "email_marketing", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-01T10:00:00.000Z" },
    ];
    await sweep();
    expect(ran(BAKERY)).toEqual(["email_marketing", "meta_ads"]);
  });

  it("a founder who sets a channel to ask first after the sweep's first read stops that start (live re-read)", async () => {
    autopilot[BAKERY] = { enabled: true, on_at: ON };
    storedRows[BAKERY] = SLUGS.map((channel_slug) => ({ channel_slug, autorun: false, autorun_set_by: "plan" }));
    changedSince[BAKERY] = [{ channel_slug: "meta_ads", autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-12T11:00:00.000Z" }];
    const out = await sweep();
    expect(ran(BAKERY)).toEqual(["email_marketing", "seo"]);
    expect(out.refusals).toMatchObject({ autorun_off_at_start: 1 });
  });
});
