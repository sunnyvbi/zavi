
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

const T = "t-1";
const store: {
  channel_actions: Array<Record<string, unknown>>;
  agent_runs: Array<Record<string, unknown>>;
} = { channel_actions: [], agent_runs: [] };
const selects: Array<{ table: string; cols: string }> = [];

vi.mock("@/services/tenant-client", () => {
  const chain = (table: string) => {
    let cols: string[] | null = null;
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let cap = Infinity;
    const self: Record<string, unknown> = {};
    self.select = (c: string) => {
      selects.push({ table, cols: c });
      cols = c.split(",").map((x) => x.trim());
      return self;
    };
    self.eq = (k: string, v: unknown) => {
      filters.push((r) => r[k] === v);
      return self;
    };
    self.in = (k: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(r[k]));
      return self;
    };
    self.like = (k: string, pat: string) => {
      const prefix = pat.replace(/%$/, "");
      filters.push((r) => String(r[k] ?? "").startsWith(prefix));
      return self;
    };
    self.not = (k: string, op: string, v: unknown) => {
      expect(op).toBe("is");
      expect(v).toBeNull();
      filters.push((r) => r[k] !== null && r[k] !== undefined);
      return self;
    };
    for (const m of ["order", "gte", "is", "neq", "range"]) self[m] = () => self;
    self.limit = (n: number) => {
      cap = n;
      return self;
    };
    const rows = () =>
      ((store as Record<string, Array<Record<string, unknown>>>)[table] ?? [])
        .filter((r) => filters.every((f) => f(r)))
        .slice(0, cap)
        .map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r));
    self.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve);
    return self;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: (table: string) => chain(table) }),
    tenantRpc: vi.fn(async () => ({ data: null, error: null })),
  };
});

const plan = vi.hoisted(() => ({ includes: new Set<string>() }));
vi.mock("@/services/growth/preview-plan", () => ({
  planIncludesChannel: vi.fn(async (_t: string, slug: string) => plan.includes.has(slug)),
}));
vi.mock("@/services/channels/preview-run-starts", () => ({
  previewRunStarts: vi.fn(async () => new Map()),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "t-1", user_id: "u-1", access_token: "tok" })),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn(), InsufficientCreditsError: class InsufficientCreditsError extends Error {} }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));

import type { Request, Response } from "express";
import { listChannelActions, lockedPreviewCounts } from "../channel-actions";
import { channelActionsList } from "@/routes/channels/actions";

function dryRun(slug: string, types: string[] | null) {
  return {
    id: `run-${slug}`,
    agent_slug: slug,
    cron_dedupe_key: `first-run-preview:${T}:${slug}`,
    preview_action_types: types,
    output_text: "SECRET-OUTPUT",
  };
}

function openAction(id: string) {
  return {
    id,
    tenant_id: T,
    channel_slug: "seo",
    run_id: "paid-run",
    position: 1,
    run_of: 1,
    blocking: false,
    action_type: "fix",
    title: "Visible title",
    title_key: "visible-title",
    body: { step: { title: "ok" } },
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 1,
    score_inputs: {},
    proposed_at: "2026-09-23T10:00:00Z",
    repeat_of: null,
    redo_of: null,
    exec_class: null,
    exec_payload: null,
    exec_status: null,
    edited_body: null,
  };
}

beforeEach(() => {
  selects.length = 0;
  plan.includes = new Set();
  store.channel_actions = [];
  store.agent_runs = [dryRun("seo", ["fix", "fix", "page"])];
});

describe("listChannelActions on a plan-locked channel with a dry preview", () => {
  it("returns the count and types the dry run stored", async () => {
    const out = await listChannelActions(T, "seo");
    expect(out).toEqual({
      actions: [],
      more: 0,
      store: "channel_actions",
      locked_preview: { count: 3, types: ["fix", "fix", "page"] },
    });
  });

  it("reads only preview_action_types from the run, never its output", async () => {
    const json = JSON.stringify(await listChannelActions(T, "seo"));
    expect(json).not.toContain("SECRET");
    const runReads = selects.filter((s) => s.table === "agent_runs").map((s) => s.cols);
    expect(runReads).toEqual(["preview_action_types"]);
  });

  it("an out-of-vocabulary type reads as other, and the list caps at 20", async () => {
    store.agent_runs = [dryRun("seo", Array.from({ length: 25 }, (_, i) => (i === 0 ? "<script>" : "fix")))];
    const out = await listChannelActions(T, "seo");
    expect(out.locked_preview?.count).toBe(20);
    expect(out.locked_preview?.types[0]).toBe("other");
  });

  it("no locked preview once the plan includes the channel", async () => {
    plan.includes = new Set(["seo"]);
    store.channel_actions = [openAction("b1")];
    const out = await listChannelActions(T, "seo");
    expect(out.locked_preview).toBeUndefined();
    expect(out.actions.map((a) => a.id)).toEqual(["b1"]);
  });

  it("no locked preview when the dry run found nothing, or there is none", async () => {
    store.agent_runs = [dryRun("seo", [])];
    expect((await listChannelActions(T, "seo")).locked_preview).toBeUndefined();
    store.agent_runs = [];
    expect((await listChannelActions(T, "seo")).locked_preview).toBeUndefined();
  });
});

describe("lockedPreviewCounts (the row's 'N actions waiting')", () => {
  it("counts each locked channel's dry preview, skipping channels the plan includes", async () => {
    store.agent_runs = [dryRun("seo", ["fix", "page"]), dryRun("x_organic", ["post"]), dryRun("geo", [])];
    plan.includes = new Set(["x_organic"]);
    expect(await lockedPreviewCounts(T)).toEqual({ seo: 2 });
  });

  it("ignores runs that are not dry (no stored types)", async () => {
    store.agent_runs = [dryRun("seo", null)];
    expect(await lockedPreviewCounts(T)).toEqual({});
  });
});

describe("GET /api/channels/:slug/actions on a plan-locked channel", () => {
  it("answers exactly {actions:[], more:0, store, completed:[], locked_preview:{count, types}}", async () => {
    const r = {
      _status: 200,
      _body: undefined as unknown,
      status(n: number) {
        r._status = n;
        return r;
      },
      json(b: unknown) {
        r._body = b;
        return r;
      },
    };
    await channelActionsList({ params: { slug: "seo" }, query: {} } as unknown as Request, r as unknown as Response);
    expect(r._status).toBe(200);
    expect(r._body).toEqual({
      actions: [],
      more: 0,
      store: "channel_actions",
      completed: [],
      locked_preview: { count: 3, types: ["fix", "fix", "page"] },
    });
  });
});
