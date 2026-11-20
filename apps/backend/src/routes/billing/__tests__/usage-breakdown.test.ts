
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  settles: [] as { run_id: string | null; amount: number | null; created_at: string }[],
  media: [] as { amount: number | null; created_at: string; agent_slug: string | null }[],
  reserveByRun: new Map<string, string>(),
  inChunkSizes: [] as number[],
  reserveErr: null as unknown,
  charges: [] as { tenant_id: string; run_id: string; refunded_daily: number; refunded_included: number; refunded_purchased: number }[],
  chargeTenants: [] as (string | undefined)[],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const state: { kind?: string; inIds?: string[]; tenant?: string } = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "kind") state.kind = val;
          if (col === "tenant_id") state.tenant = val;
          return chain;
        },
        gte: () => chain,
        order: () => {
          if (state.kind === "media") return Promise.resolve({ data: mocks.media, error: null });
          return Promise.resolve({ data: mocks.settles, error: null });
        },
        in: (_col: string, ids: string[]) => {
          if (table === "tool_charges") {
            mocks.chargeTenants.push(state.tenant);
            const rows = mocks.charges
              .filter((c) => c.tenant_id === state.tenant && ids.includes(c.run_id))
              .map(({ tenant_id: _t, ...rest }) => rest);
            return Promise.resolve({ data: rows, error: null });
          }
          state.inIds = ids;
          mocks.inChunkSizes.push(ids.length);
          if (mocks.reserveErr) {
            return Promise.resolve({ data: null, error: mocks.reserveErr });
          }
          const rows = ids
            .filter((id) => mocks.reserveByRun.has(id))
            .map((id) => ({ run_id: id, agent_slug: mocks.reserveByRun.get(id)! }));
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  }),
}));

import { billingUsageBreakdown } from "../usage-breakdown";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
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

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1" });
  mocks.settles = [];
  mocks.media = [];
  mocks.reserveByRun = new Map();
  mocks.inChunkSizes = [];
  mocks.reserveErr = null;
  mocks.charges = [];
  mocks.chargeTenants = [];
});

describe("billingUsageBreakdown", () => {
  it("attributes credits to real agents across MANY runs (chunked reserve lookup)", async () => {
    const agents = ["engineer", "operator", "support-lead"];
    const now = new Date().toISOString();
    for (let i = 0; i < 400; i++) {
      const runId = `run-${i}`;
      const slug = agents[i % agents.length];
      mocks.settles.push({ run_id: runId, amount: 10, created_at: now });
      mocks.reserveByRun.set(runId, slug);
    }
    const res = mockRes();
    await billingUsageBreakdown({ query: {} } as never, res as never);

    expect(res.statusCode).toBe(200);
    const b = res.body as {
      total_credits: number;
      by_agent: { agent_slug: string; credits: number }[];
    };
    expect(b.total_credits).toBe(4000);
    const slugs = b.by_agent.map((a) => a.agent_slug);
    expect(slugs).not.toContain("unknown");
    expect(new Set(slugs)).toEqual(new Set(agents));
    const eng = b.by_agent.find((a) => a.agent_slug === "engineer");
    expect(eng?.credits).toBe(1340);
    expect(mocks.inChunkSizes.length).toBeGreaterThan(1);
    expect(Math.max(...mocks.inChunkSizes)).toBeLessThanOrEqual(150);
  });

  it("falls back to 'unknown' only when a run genuinely has no reserve row", async () => {
    const now = new Date().toISOString();
    mocks.settles.push({ run_id: "run-a", amount: 5, created_at: now });
    mocks.settles.push({ run_id: "run-orphan", amount: 3, created_at: now });
    mocks.reserveByRun.set("run-a", "pm");
    const res = mockRes();
    await billingUsageBreakdown({ query: {} } as never, res as never);
    const b = res.body as { by_agent: { agent_slug: string; credits: number }[] };
    expect(b.by_agent).toEqual(
      expect.arrayContaining([
        { agent_slug: "pm", credits: 5 },
        { agent_slug: "unknown", credits: 3 },
      ]),
    );
  });

  it("500s (not silent 'unknown') when the reserve lookup errors", async () => {
    const now = new Date().toISOString();
    mocks.settles.push({ run_id: "run-a", amount: 5, created_at: now });
    mocks.reserveByRun.set("run-a", "pm");
    mocks.reserveErr = { message: "URI too long" };
    const res = mockRes();
    await billingUsageBreakdown({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("internal");
  });

  it("honors ?days=7 (window_days=7, 7 daily buckets)", async () => {
    const res = mockRes();
    await billingUsageBreakdown({ query: { days: "7" } } as never, res as never);
    const b = res.body as { window_days: number; daily: unknown[] };
    expect(b.window_days).toBe(7);
    expect(b.daily).toHaveLength(7);
  });

  it("honors ?days=90 (window_days=90, 90 daily buckets)", async () => {
    const res = mockRes();
    await billingUsageBreakdown({ query: { days: "90" } } as never, res as never);
    const b = res.body as { window_days: number; daily: unknown[] };
    expect(b.window_days).toBe(90);
    expect(b.daily).toHaveLength(90);
  });

  it("clamps an unsupported ?days to the 30-day default", async () => {
    const res = mockRes();
    await billingUsageBreakdown({ query: { days: "365" } } as never, res as never);
    const b = res.body as { window_days: number; daily: unknown[] };
    expect(b.window_days).toBe(30);
    expect(b.daily).toHaveLength(30);
  });

  it("includes media charges in the total, the daily series and by_agent", async () => {
    const today = new Date().toISOString();
    mocks.settles = [{ run_id: "r1", amount: 100, created_at: today }];
    mocks.reserveByRun = new Map([["r1", "operator"]]);
    mocks.media = [
      { amount: 320, created_at: today, agent_slug: "video.broll:bytedance/seedance-2.5/text-to-video" },
      { amount: 27, created_at: today, agent_slug: "image.photo:bytedance/seedream/v5/pro/text-to-image" },
      { amount: 4, created_at: today, agent_slug: "audio.voiceover:fal-ai/elevenlabs/tts/eleven-v3" },
    ];
    const res = mockRes();
    await billingUsageBreakdown({ query: {} } as never, res as never);
    const b = res.body as {
      total_credits: number;
      daily: { date: string; credits: number }[];
      by_agent: { agent_slug: string; credits: number }[];
    };
    expect(b.total_credits).toBe(451);
    expect(b.daily.at(-1)!.credits).toBe(451);
    const byLabel = new Map(b.by_agent.map((r) => [r.agent_slug, r.credits]));
    expect(byLabel.get("operator")).toBe(100);
    expect(byLabel.get("Video")).toBe(320);
    expect(byLabel.get("Images")).toBe(27);
    expect(byLabel.get("Voiceover")).toBe(4);
  });

  it("nets late-check refunds out of the run's settle in total, day and agent", async () => {
    const today = new Date().toISOString();
    mocks.settles = [
      { run_id: "r1", amount: 284, created_at: today },
      { run_id: "r2", amount: 50, created_at: today },
    ];
    mocks.reserveByRun = new Map([
      ["r1", "cgo"],
      ["r2", "operator"],
    ]);
    mocks.charges = [
      { tenant_id: "tnt-1", run_id: "r1", refunded_daily: 10, refunded_included: 0, refunded_purchased: 150 },
      { tenant_id: "tnt-1", run_id: "r2", refunded_daily: 0, refunded_included: 0, refunded_purchased: 80 },
      { tenant_id: "tnt-2", run_id: "r1", refunded_daily: 0, refunded_included: 0, refunded_purchased: 100 },
    ];
    const res = mockRes();
    await billingUsageBreakdown({ query: {} } as never, res as never);
    const b = res.body as {
      total_credits: number;
      daily: { date: string; credits: number }[];
      by_agent: { agent_slug: string; credits: number }[];
    };
    expect(b.total_credits).toBe(124);
    expect(b.daily.at(-1)!.credits).toBe(124);
    expect(b.by_agent).toEqual([{ agent_slug: "cgo", credits: 124 }]);
    expect(mocks.chargeTenants).toEqual(["tnt-1"]);
  });

  it("labels an unrecognised media task without throwing", async () => {
    mocks.media = [{ amount: 5, created_at: new Date().toISOString(), agent_slug: "weird.thing:model" }];
    const res = mockRes();
    await billingUsageBreakdown({ query: {} } as never, res as never);
    const b = res.body as { by_agent: { agent_slug: string; credits: number }[] };
    expect(b.by_agent.find((r) => r.agent_slug === "Media")?.credits).toBe(5);
  });
});
