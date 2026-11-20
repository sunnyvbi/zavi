
import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    auth: { user_id: "u-1", tenant_id: "11111111-1111-1111-1111-111111111111", access_token: "tok-1" } as
      | { user_id: string; tenant_id: string; access_token: string }
      | null,
    filters: [] as Array<[string, unknown]>,
    rows: [] as unknown[],
    error: null as { message: string } | null,
    rpcCalls: [] as Array<[string, Record<string, unknown>]>,
    rpcError: null as { message: string } | null,
  },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => state.auth) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => {
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        state.filters.push([col, v]);
        return q;
      },
      order: () => q,
      limit: async () => ({ data: state.rows, error: state.error }),
    };
    return {
      from: () => q,
      rpc: async (name: string, args: Record<string, unknown>) => {
        state.rpcCalls.push([name, args]);
        return { error: state.rpcError };
      },
    };
  }),
}));

import { feedbackProductMine, feedbackProductSeen, isUnseenUpdate } from "../product";

const TENANT = "11111111-1111-1111-1111-111111111111";

function makeRes() {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (fn: (req: any, res: any) => Promise<void>) => {
  const res = makeRes();
  await fn({}, res);
  return res;
};

beforeEach(() => {
  state.auth = { user_id: "u-1", tenant_id: TENANT, access_token: "tok-1" };
  state.filters = [];
  state.rows = [];
  state.error = null;
  state.rpcCalls = [];
  state.rpcError = null;
});

describe("isUnseenUpdate", () => {
  it("is false for a request nobody touched", () => {
    expect(isUnseenUpdate({ status_updated_at: null, sender_seen_at: null })).toBe(false);
  });
  it("is true for a change never looked at", () => {
    expect(isUnseenUpdate({ status_updated_at: "2026-10-22T10:00:00Z", sender_seen_at: null })).toBe(true);
  });
  it("is false once looked at after the change, true for a later change", () => {
    expect(isUnseenUpdate({ status_updated_at: "2026-10-22T10:00:00Z", sender_seen_at: "2026-10-22T11:00:00Z" })).toBe(false);
    expect(isUnseenUpdate({ status_updated_at: "2026-10-22T12:00:00Z", sender_seen_at: "2026-10-22T11:00:00Z" })).toBe(true);
  });
});

describe("GET /api/feedback/product/mine", () => {
  it("filters on the session's company AND the session's user", async () => {
    await call(feedbackProductMine);
    expect(state.filters).toContainEqual(["tenant_id", TENANT]);
    expect(state.filters).toContainEqual(["created_by", "u-1"]);
  });

  it("returns status, note and an update count, and never attachment paths", async () => {
    state.rows = [
      { id: "a", body: "Fix the report", created_at: "2026-10-21T00:00:00Z", status: "done", staff_note: "Fixed.", status_updated_at: "2026-10-22T00:00:00Z", sender_seen_at: null },
      { id: "b", body: "Email time", created_at: "2026-10-16T00:00:00Z", status: "received", staff_note: null, status_updated_at: null, sender_seen_at: null },
    ];
    const res = await call(feedbackProductMine);
    const body = res.body as { requests: Array<Record<string, unknown>>; updates: number };
    expect(body.updates).toBe(1);
    expect(body.requests[0]).toEqual({ id: "a", body: "Fix the report", created_at: "2026-10-21T00:00:00Z", status: "done", staff_note: "Fixed.", updated: true });
    expect(body.requests[1].updated).toBe(false);
    expect(JSON.stringify(body)).not.toContain("attachments");
  });

  it("says it could not load on a database error", async () => {
    state.error = { message: "boom" };
    const res = await call(feedbackProductMine);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).toContain("Couldn't load your requests.");
  });

  it("does nothing without a session", async () => {
    state.auth = null;
    const res = await call(feedbackProductMine);
    expect(res.body).toBeUndefined();
    expect(state.filters).toEqual([]);
  });
});

describe("POST /api/feedback/product/seen", () => {
  it("clears the badge for the session's company only", async () => {
    const res = await call(feedbackProductSeen);
    expect(res.statusCode).toBe(200);
    expect(state.rpcCalls).toEqual([["mark_my_tenant_feedback_seen", { p_tenant_id: TENANT }]]);
  });

  it("reports a failed RPC", async () => {
    state.rpcError = { message: "unauthorized" };
    const res = await call(feedbackProductSeen);
    expect(res.statusCode).toBe(500);
  });
});
