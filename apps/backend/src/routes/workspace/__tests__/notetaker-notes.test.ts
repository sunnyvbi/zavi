import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    auth: { tenant_id: "tenant-1", user_id: "user-1", access_token: "token-1" } as Record<string, string> | null,
    rows: [] as Array<Record<string, unknown>>,
    filters: [] as unknown[][],
  };
  const requireAuth = vi.fn(async () => state.auth);
  const serverClientFromBearer = vi.fn((_token: string) => {
    const preds: Array<(r: Record<string, unknown>) => boolean> = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (state.filters.push(["eq", c, v]), preds.push((r) => r[c] === v), q),
      gt: (c: string, v: unknown) => (state.filters.push(["gt", c, v]), preds.push((r) => String(r[c]) > String(v)), q),
      maybeSingle: async () => ({ data: state.rows.find((r) => preds.every((p) => p(r))) ?? null, error: null }),
    };
    return { from: (_t: string) => q };
  });
  return { state, requireAuth, serverClientFromBearer };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/supabase", () => ({ serverClientFromBearer: m.serverClientFromBearer, serviceClient: vi.fn() }));
vi.mock("@/services/meetings/join-now", () => ({ joinMeetingNow: vi.fn() }));

import { workspaceNotetakerNotes } from "../notetaker-join";

function mockRes() {
  const res: { statusCode: number; body?: unknown; status: (n: number) => unknown; json: (b: unknown) => unknown } = {
    statusCode: 200,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

const BOT = "11111111-1111-4111-8111-111111111111";
const get = async (botId = BOT) => {
  const res = mockRes();
  await workspaceNotetakerNotes({ params: { botId } } as unknown as Request, res as unknown as Response);
  return res;
};

beforeEach(() => {
  m.state.filters = [];
  m.state.rows = [
    { bot_id: BOT, tenant_id: "tenant-1", minutes: { tldr: "x" }, transcript: "A: hi", delete_after: "2999-01-01T00:00:00Z" },
    { bot_id: BOT, tenant_id: "tenant-2", minutes: null, transcript: "OTHER TENANT", delete_after: "2999-01-01T00:00:00Z" },
  ];
});

describe("GET /api/workspace/notetaker-meetings/:botId/notes", () => {
  it("returns the caller's tenant's notes through the member's own token, filtered by tenant and due date", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ notes: expect.objectContaining({ transcript: "A: hi" }) });
    expect(m.serverClientFromBearer).toHaveBeenCalledWith("token-1");
    expect(m.state.filters).toEqual(
      expect.arrayContaining([["eq", "tenant_id", "tenant-1"], ["eq", "bot_id", BOT], ["gt", "delete_after", expect.any(String)]]),
    );
  });

  it("past 30 days: notes is null", async () => {
    m.state.rows = [{ bot_id: BOT, tenant_id: "tenant-1", transcript: "old", delete_after: "2020-01-01T00:00:00Z" }];
    expect((await get()).body).toEqual({ notes: null });
  });

  it("another tenant's meeting id returns nothing", async () => {
    m.state.rows = [{ bot_id: BOT, tenant_id: "tenant-2", transcript: "OTHER TENANT", delete_after: "2999-01-01T00:00:00Z" }];
    expect((await get()).body).toEqual({ notes: null });
  });

  it("a malformed id is a 400", async () => {
    expect((await get("not-a-uuid")).statusCode).toBe(400);
  });
});
