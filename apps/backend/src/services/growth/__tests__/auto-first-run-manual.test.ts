import { afterEach, describe, expect, it, vi } from "vitest";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";

const h = vi.hoisted(() => ({
  runRows: [] as Array<{
    id: string;
    trigger: string;
    channel_slug: string | null;
  }>,
  enqueued: 0,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => {
      if (table !== "agent_runs") {
        const tenantRow = async () => ({
          data: [{ created_at: "2026-09-25T10:00:00.000000+00:00" }],
          error: null,
        });
        const leaf = { limit: tenantRow };
        return {
          select: () => ({ limit: tenantRow, eq: () => leaf, or: () => leaf }),
        };
      }
      type Row = { id: string; trigger: string; channel_slug: string | null };
      const rows = () => h.runRows as Row[];
      const build = (pred: (r: Row) => boolean) => ({
        limit: async () => ({ data: rows().filter(pred), error: null }),
      });
      return {
        select: () => ({
          limit: async () => ({ data: rows(), error: null }),
          eq: (col: string, val: string) =>
            build(
              (r) => (r as unknown as Record<string, unknown>)[col] === val,
            ),
          or: (expr: string) =>
            build((r) =>
              expr.split(",").some((clause) => {
                if (clause === "channel_slug.not.is.null")
                  return r.channel_slug !== null;
                const m = clause.match(/^(\w+)\.eq\.(.+)$/);
                return m
                  ? (r as unknown as Record<string, unknown>)[m[1]] === m[2]
                  : false;
              }),
            ),
        }),
      };
    },
  }),
}));
vi.mock("@/services/tools/growth/seo/snapshot", () => ({
  seoSnapshotShowsReadableSite: async () => true,
}));
vi.mock("@/services/channels/context", () => ({
  defaultChannelContext: async () => ({}),
}));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async () => ({ run_id: "run-1" })),
}));
vi.mock("@/services/channels/engine", () => ({
  runChannelRecipe: vi.fn(async (_t: string, slug: string) => {
    h.enqueued += 1;
    return { ok: true, run_id: "run-1", channel_slug: slug };
  }),
}));

import { fanOutFirstRun } from "../auto-first-run";

afterEach(() => {
  h.runRows = [];
  h.enqueued = 0;
});

describe("fanOutFirstRun — a manual run blocks the automatic one", () => {
  it("refuses when the tenant already has a channel run", async () => {
    h.runRows = [
      { id: "earlier", trigger: "channel_recipe", channel_slug: "seo" },
    ];
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({
      ran: false,
      reason: "already_ran",
    });
    expect(h.enqueued).toBe(0);
  });

  it("runs when the tenant has never had one", async () => {
    h.runRows = [];
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({
      ran: true,
      channel_slug: "seo",
    });
    expect(h.enqueued).toBe(1);
  });
});

describe("the gate uses the schema's own predicate for 'was a channel run'", () => {
  it("a CHAT-started channel run blocks the automatic one", async () => {
    h.runRows = [{ id: "from-chat", trigger: "chat", channel_slug: "seo" }];
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({
      ran: false,
      reason: "already_ran",
    });
    expect(h.enqueued).toBe(0);
  });

  it("an operator HANDOFF channel run blocks it too", async () => {
    h.runRows = [
      { id: "from-handoff", trigger: "handoff", channel_slug: "meta_ads" },
    ];
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({
      ran: false,
      reason: "already_ran",
    });
    expect(h.enqueued).toBe(0);
  });

  it("a plain chat run with no channel_slug does not block it", async () => {
    h.runRows = [{ id: "just-chat", trigger: "chat", channel_slug: null }];
    expect(await fanOutFirstRun(T, [{ channel_slug: "seo" }])).toEqual({
      ran: true,
      channel_slug: "seo",
    });
    expect(h.enqueued).toBe(1);
  });
});
