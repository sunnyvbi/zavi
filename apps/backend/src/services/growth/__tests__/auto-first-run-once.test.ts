import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "11111111-1111-1111-1111-111111111111";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ slug: string; request_id: unknown; cron_dedupe_key: unknown }>,
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
      return { select: () => ({ limit: answer, eq: () => leaf, or: () => leaf }) };
    },
  }),
}));

vi.mock("@/services/tools/growth/seo/snapshot", () => ({
  seoSnapshotShowsReadableSite: async () => true,
}));

vi.mock("@/services/channels/context", () => ({ defaultChannelContext: async () => ({}) }));

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async (input: { cron_dedupe_key?: string }) => ({
    run_id: "run-1",
    cron_dedupe_key: input.cron_dedupe_key,
  })),
}));

vi.mock("@/services/channels/engine", () => ({
  runChannelRecipe: vi.fn(
    async (
      tenant_id: string,
      slug: string,
      deps: { enqueue: (i: Record<string, unknown>) => Promise<{ cron_dedupe_key?: unknown }> },
      _redo: unknown,
      _extra: unknown,
      request_id: unknown,
    ) => {
      const enq = await deps.enqueue({ slug, tenant_id, trigger: "channel_recipe", payload: {} });
      h.calls.push({ slug, request_id, cron_dedupe_key: enq.cron_dedupe_key });
      return { ok: true, run_id: "run-1", channel_slug: slug };
    },
  ),
}));

import { fanOutFirstRun, firstRunKey } from "../auto-first-run";

beforeEach(() => {
  h.calls.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fanOutFirstRun — one key per tenant, ever", () => {
  it("a later day, with a different top bet, hands the engine the SAME key", async () => {
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({ ran: true, channel_slug: "seo" });

    vi.setSystemTime(new Date("2026-09-26T12:00:00.000Z"));
    await fanOutFirstRun(T, [{ channel_slug: "reddit_organic" }]);

    expect(h.calls).toHaveLength(2);
    const keys = new Set(h.calls.flatMap((c) => [c.request_id, c.cron_dedupe_key]));
    expect([...keys]).toEqual([firstRunKey(T)]);
  });

  it("the key carries no date and no channel", () => {
    expect(firstRunKey(T)).toBe(`first-run:${T}`);
  });

  it("fits the claim's request_id bounds", () => {
    expect(firstRunKey(T).length).toBeGreaterThanOrEqual(8);
    expect(firstRunKey(T).length).toBeLessThanOrEqual(200);
  });

  it("is scoped to the tenant: two tenants never share a key", () => {
    expect(firstRunKey(T)).not.toBe(firstRunKey(OTHER));
  });
});
