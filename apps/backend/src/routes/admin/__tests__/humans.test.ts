
import { describe, it, expect, vi, beforeEach } from "vitest";

const MEMBER_1 = "11111111-1111-4111-8111-111111111111";
const MEMBER_2 = "22222222-2222-4222-8222-222222222222";

const { assertStaffMock, auditMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "staff-1", email: "ravi@upcar.ai" })),
  auditMock: vi.fn(async () => undefined),
}));
vi.mock("@/services/auth/staff-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/auth/staff-middleware")>();
  return { ...actual, assertStaff: assertStaffMock };
});
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: auditMock }));

type Result = { data: unknown; error: { code?: string; message?: string } | null; count?: number };
type Call = { table: string; ops: Array<{ op: string; args: unknown[] }> };

const { globalClientMock, state, calls, reset } = vi.hoisted(() => {
  const c: { list: Call[] } = { list: [] };
  const s: { queues: Record<string, Result[] | ((call: Call) => Result)> } = { queues: {} };
  const CHAIN = ["select", "eq", "neq", "ilike", "in", "not", "order", "range", "limit", "insert", "update", "delete", "upsert"];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      c.list.push(call);
      const result = (): Result => {
        const q = s.queues[table];
        if (typeof q === "function") return q(call);
        if (!q?.length) return { data: null, error: null };
        return q.length > 1 ? q.shift()! : q[0];
      };
      const b: Record<string, unknown> = {};
      for (const op of CHAIN) {
        b[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(result());
      b.single = () => Promise.resolve(result());
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return b;
    },
  };
  return {
    globalClientMock: vi.fn(() => client),
    state: s,
    calls: c,
    reset: () => {
      c.list = [];
      s.queues = {};
      assertStaffMock.mockClear();
      auditMock.mockClear();
    },
  };
});
vi.mock("@/services/tenant-client", () => ({ globalClient: globalClientMock }));

import { staffHumanQueue, staffHumanDetail, staffHumanSetVetting } from "../humans";

function mockRes() {
  const res = {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
  return res as any;
}
const req = (opts: { query?: unknown; body?: unknown; params?: unknown } = {}) =>
  ({ query: opts.query ?? {}, body: opts.body ?? {}, params: opts.params ?? {}, headers: {} }) as any;

function member(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    auth_user_id: `user-${i}`,
    display_name: `Applicant ${i}`,
    discipline: "ugc_creator",
    skills: [],
    rate_usd: 400,
    rate_unit: "per_deliverable",
    public_metrics: null,
    profile: {},
    vetting_state: "pending",
    rejected_reason: null,
    handle_verified_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    updated_at: null,
    ...over,
  };
}

function stageRoster(rows: unknown[], total = rows.length) {
  state.queues.human_member_handles = () => ({ data: [], error: null });
  state.queues.human_member_pii = () => ({ data: [], error: null });
  state.queues.human_members = (call) => {
    const select = String(call.ops.find((o) => o.op === "select")?.args[0] ?? "");
    if (select.trim() === "id, display_name, vetting_state") return { data: rows, error: null };
    return { data: rows, error: null, count: total };
  };
}

beforeEach(reset);

describe("GET /api/admin/humans — the vetting queue", () => {
  it("pages a 45-applicant queue oldest-first with an exact total", async () => {
    const rows = Array.from({ length: 45 }, (_, i) => member(i + 1));
    stageRoster(rows.slice(0, 25), 45);
    const res = mockRes();
    await staffHumanQueue(req(), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.total).toBe(45);
    expect(res.payload.limit).toBe(25);
    expect(res.payload.items).toHaveLength(25);

    const queueCall = calls.list.filter((c) => c.table === "human_members").at(-1)!;
    expect(queueCall.ops.find((o) => o.op === "order")!.args).toEqual(["created_at", { ascending: true }]);
    expect(queueCall.ops.find((o) => o.op === "range")!.args).toEqual([0, 24]);
    expect(String(queueCall.ops.find((o) => o.op === "select")!.args[1] && JSON.stringify(queueCall.ops.find((o) => o.op === "select")!.args[1]))).toContain("exact");
  });

  it("honours limit/offset/newest and filters by state + discipline", async () => {
    stageRoster([member(40)], 45);
    const res = mockRes();
    await staffHumanQueue(
      req({ query: { limit: "10", offset: "20", sort: "newest", vetting_state: "under_review", discipline: "ugc_creator" } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const queueCall = calls.list.filter((c) => c.table === "human_members").at(-1)!;
    expect(queueCall.ops.find((o) => o.op === "order")!.args).toEqual(["created_at", { ascending: false }]);
    expect(queueCall.ops.find((o) => o.op === "range")!.args).toEqual([20, 29]);
    const eqs = queueCall.ops.filter((o) => o.op === "eq").map((o) => o.args);
    expect(eqs).toContainEqual(["vetting_state", "under_review"]);
    expect(eqs).toContainEqual(["discipline", "ugc_creator"]);
  });

  it("rejects an out-of-range limit instead of returning an unbounded page", async () => {
    const res = mockRes();
    await staffHumanQueue(req({ query: { limit: "5000" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("validation");
  });

  it("has_collision=true with an empty collision set returns an empty page, not everything", async () => {
    stageRoster([member(1), member(2)], 2);
    const res = mockRes();
    await staffHumanQueue(req({ query: { has_collision: "true" } }), res);
    expect(res.payload).toEqual({ items: [], total: 0, limit: 25, offset: 0 });
  });

  it("has_collision=true narrows to the colliding ids", async () => {
    const rows = [member(1, { id: MEMBER_1 }), member(2, { id: MEMBER_2 })];
    state.queues.human_member_handles = () => ({ data: [], error: null });
    state.queues.human_member_pii = () => ({
      data: [
        { human_member_id: MEMBER_1, legal_name: "Nina Rao", email: "ni.na@gmail.com", tin_sha256: null, payout_ref_hash: null },
        { human_member_id: MEMBER_2, legal_name: "Other Person", email: "nina+alt@gmail.com", tin_sha256: null, payout_ref_hash: null },
      ],
      error: null,
    });
    state.queues.human_members = (call) => {
      const select = String(call.ops.find((o) => o.op === "select")?.args[0] ?? "");
      if (select.trim() === "id, display_name, vetting_state") return { data: rows, error: null };
      return { data: rows, error: null, count: 2 };
    };
    const res = mockRes();
    await staffHumanQueue(req({ query: { has_collision: "true" } }), res);
    expect(res.statusCode).toBe(200);
    const queueCall = calls.list.filter((c) => c.table === "human_members").at(-1)!;
    const inOp = queueCall.ops.find((o) => o.op === "in")!;
    expect(inOp.args[0]).toBe("id");
    expect(new Set(inOp.args[1] as string[])).toEqual(new Set([MEMBER_1, MEMBER_2]));
    expect(res.payload.items[0].collision_count).toBeGreaterThan(0);
  });
});

describe("GET /api/admin/human/:id — detail + collisions", () => {
  it("names which existing human member each field collides with", async () => {
    const detail = member(1, { id: MEMBER_1 });
    state.queues.human_members = (call) => {
      const select = String(call.ops.find((o) => o.op === "select")?.args[0] ?? "");
      if (select.trim() === "id, display_name, vetting_state") {
        return {
          data: [
            { id: MEMBER_1, display_name: "Applicant 1", vetting_state: "pending" },
            { id: MEMBER_2, display_name: "Applicant 2", vetting_state: "approved" },
          ],
          error: null,
        };
      }
      return { data: detail, error: null };
    };
    state.queues.human_member_handles = (call) =>
      call.ops.some((o) => o.op === "eq")
        ? { data: [{ id: "h1", human_member_id: MEMBER_1, platform: "tiktok", handle: "ninacreates" }], error: null }
        : {
            data: [
              { human_member_id: MEMBER_1, platform: "tiktok", handle: "ninacreates" },
              { human_member_id: MEMBER_2, platform: "instagram", handle: "NinaCreates" },
            ],
            error: null,
          };
    state.queues.human_member_pii = (call) =>
      call.ops.some((o) => o.op === "eq")
        ? { data: { human_member_id: MEMBER_1, legal_name: "Nina Rao", email: "nina@example.com" }, error: null }
        : {
            data: [
              { human_member_id: MEMBER_1, legal_name: "Nina Rao", email: "nina@example.com", tin_sha256: "\\xabc", payout_ref_hash: null },
              { human_member_id: MEMBER_2, legal_name: "nina rao", email: "other@example.com", tin_sha256: "\\xabc", payout_ref_hash: null },
            ],
            error: null,
          };

    const res = mockRes();
    await staffHumanDetail(req({ params: { id: MEMBER_1 } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload.member.id).toBe(MEMBER_1);

    const fields = res.payload.collisions.map((c: { field: string }) => c.field).sort();
    expect(fields).toEqual(["handle_cross_platform", "legal_name", "tin_sha256"]);
    for (const c of res.payload.collisions) {
      expect(c.collides_with).toEqual([
        { human_member_id: MEMBER_2, display_name: "Applicant 2", vetting_state: "approved" },
      ]);
    }
    const tin = res.payload.collisions.find((c: { field: string }) => c.field === "tin_sha256");
    expect(tin.value).toBe("(redacted)");
    expect(JSON.stringify(res.payload)).not.toContain("\\xabc");
  });

  it("404s an unknown applicant and 400s a non-UUID id", async () => {
    state.queues.human_members = () => ({ data: null, error: null });
    const missing = mockRes();
    await staffHumanDetail(req({ params: { id: MEMBER_1 } }), missing);
    expect(missing.statusCode).toBe(404);

    const bad = mockRes();
    await staffHumanDetail(req({ params: { id: "not-a-uuid" } }), bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.payload.error.code).toBe("invalid_id");
  });
});

describe("PATCH /api/admin/human/:id/vetting", () => {
  function stageUpdate(over: Record<string, unknown> = {}) {
    const seen: { patch: Record<string, unknown> | null } = { patch: null };
    state.queues.human_members = (call) => {
      const update = call.ops.find((o) => o.op === "update");
      if (!update) return { data: null, error: null };
      seen.patch = update.args[0] as Record<string, unknown>;
      return { data: { ...member(1, { id: MEMBER_1 }), ...seen.patch, ...over }, error: null };
    };
    return seen;
  }

  it("REFUSES a rejection with no reason (400) and writes nothing", async () => {
    const seen = stageUpdate();
    const res = mockRes();
    await staffHumanSetVetting(req({ params: { id: MEMBER_1 }, body: { state: "rejected" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("reason_required");
    expect(seen.patch).toBeNull();
    expect(calls.list).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("REFUSES a whitespace-only rejection reason", async () => {
    const seen = stageUpdate();
    const res = mockRes();
    await staffHumanSetVetting(req({ params: { id: MEMBER_1 }, body: { state: "rejected", reason: "   \n  " } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("reason_required");
    expect(seen.patch).toBeNull();
  });

  it("accepts a rejection WITH a reason and stores it", async () => {
    const seen = stageUpdate();
    const res = mockRes();
    await staffHumanSetVetting(
      req({ params: { id: MEMBER_1 }, body: { state: "rejected", reason: "  Metrics screenshot unreadable  " } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(seen.patch).toMatchObject({ vetting_state: "rejected", rejected_reason: "Metrics screenshot unreadable" });
    expect(seen.patch!.handle_verified_at).toBeUndefined();
  });

  it("approve stamps handle_verified_at and clears any prior rejection reason", async () => {
    const seen = stageUpdate();
    const res = mockRes();
    await staffHumanSetVetting(req({ params: { id: MEMBER_1 }, body: { state: "approved" } }), res);
    expect(res.statusCode).toBe(200);
    expect(seen.patch!.vetting_state).toBe("approved");
    expect(seen.patch!.rejected_reason).toBeNull();
    expect(typeof seen.patch!.handle_verified_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(seen.patch!.handle_verified_at)))).toBe(false);
    expect(res.payload.member.handle_verified_at).toBe(seen.patch!.handle_verified_at);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "human_vetting_set", target_table: "human_members", target_id: MEMBER_1 }),
    );
  });

  it("under_review does NOT stamp handle_verified_at", async () => {
    const seen = stageUpdate();
    const res = mockRes();
    await staffHumanSetVetting(req({ params: { id: MEMBER_1 }, body: { state: "under_review" } }), res);
    expect(res.statusCode).toBe(200);
    expect(seen.patch!.vetting_state).toBe("under_review");
    expect(seen.patch!.handle_verified_at).toBeUndefined();
  });

  it("refuses a state that is not staff-settable", async () => {
    const res = mockRes();
    await staffHumanSetVetting(req({ params: { id: MEMBER_1 }, body: { state: "pending" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("validation");
    expect(calls.list).toHaveLength(0);
  });
});
