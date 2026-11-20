import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({
  row: null as unknown,
  readError: null as { message: string } | null,
  tenants: [] as string[],
  filters: [] as Array<[string, string]>,
  auth: { tenant_id: "tenant-a", user_id: "user-a" } as unknown,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => m.auth }));
vi.mock("@/services/channels/action-media", () => ({
  signActionMedia: async (_t: string, rows: Array<Record<string, unknown>>) => rows.map((r) => ({ ...r, signed: true })),
}));
vi.mock("@/services/channels/card-timeline", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/card-timeline")>()),
  withCardTimelines: async (_t: string, views: unknown[]) => views,
}));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: (t: string) => {
    m.tenants.push(t);
    const chain = {
      eq: (c: string, v: string) => {
        m.filters.push([c, v]);
        return chain;
      },
      maybeSingle: async () => ({ data: m.row, error: m.readError }),
    };
    return { from: () => ({ select: () => chain }) };
  },
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn(), InsufficientCreditsError: class extends Error {} }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));

import { channelHistoryCardRead } from "../actions";

const ID = "11111111-1111-4111-8111-111111111111";
const closed = {
  id: ID,
  channel_slug: "meta_ads",
  run_id: "22222222-2222-4222-8222-222222222222",
  position: 1,
  run_of: 1,
  blocking: false,
  action_type: "update_ad",
  title: "Raise the budget",
  title_key: "raise the budget",
  body: { step: { title: "Raise the budget", body: "From $120 to $149 a day." } },
  status: "acted",
  note: null,
  snoozed_until: null,
  impact: null,
  impact_reason: null,
  score: 1,
  score_inputs: null,
  proposed_at: "2026-10-19T10:00:00Z",
  repeat_of: null,
  redo_of: null,
  exec_class: null,
  exec_payload: null,
  exec_status: "executed",
  exec_result: null,
  edited_body: null,
  executed_at: "2026-10-20T10:00:00Z",
};

async function read(id = ID) {
  const out = { status: 200, body: null as unknown };
  const res = {
    status(c: number) {
      out.status = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  };
  await channelHistoryCardRead({ params: { id } } as unknown as Request, res as unknown as Response);
  return out;
}

beforeEach(() => {
  m.row = closed;
  m.readError = null;
  m.tenants.length = 0;
  m.filters.length = 0;
});

describe("GET /api/channel-actions/:id/card", () => {
  it("reads a closed card through the authed tenant and returns it signed", async () => {
    const out = await read();
    expect(out.status).toBe(200);
    expect(m.tenants).toEqual(["tenant-a"]);
    expect(m.filters).toEqual([["tenant_id", "tenant-a"], ["id", ID]]);
    const card = (out.body as { card: Record<string, unknown> }).card;
    expect(card).toMatchObject({ id: ID, title: "Raise the budget", status: "acted", exec_status: "executed", executed_at: "2026-10-20T10:00:00Z", signed: true });
    expect(card).not.toHaveProperty("exec_payload");
  });

  it("answers 404 for a card that is still open", async () => {
    m.row = { ...closed, status: "pending", exec_status: null };
    expect((await read()).status).toBe(404);
  });

  it("answers 404 when the tenant has no such card", async () => {
    m.row = null;
    expect((await read()).status).toBe(404);
  });

  it("refuses an id that is not a uuid without reading", async () => {
    expect((await read("nope")).status).toBe(400);
    expect(m.tenants).toEqual([]);
  });

  it("answers 503 when the read fails", async () => {
    m.readError = { message: "boom" };
    expect((await read()).status).toBe(503);
  });
});
