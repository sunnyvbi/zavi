
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-1111-1111-111111111111";
const BUILD = "44444444-4444-4444-8444-444444444444";
const CHANGE = "55555555-5555-4555-8555-555555555555";

const { requireAuthMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(async (_req: unknown, _res: unknown) => ({ user_id: "u-1", tenant_id: "11111111-1111-1111-1111-111111111111", access_token: "tok-1" })),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

type Filter = [string, string, unknown];
const { db } = vi.hoisted(() => ({
  db: {
    rpcArgs: [] as Array<[string, Record<string, unknown>]>,
    rpcResult: { data: { feedback_id: "fb-1", agent_slug: "engineer", tenant_id: "11111111-1111-1111-1111-111111111111" }, error: null } as {
      data: unknown;
      error: { message: string } | null;
    },
    filters: [] as Filter[],
    rows: [] as Array<{ target_id: string; rating: number | null; comment: string | null; build_reasons?: string[] | null }>,
    readError: null as { message: string } | null,
    selects: [] as string[],
    missingColumn: null as { code?: string; message: string } | null,
  },
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      db.rpcArgs.push([name, args]);
      return { single: async () => db.rpcResult };
    },
    from: (table: string) => {
      let cols = "";
      const q = {
        select: (c: string) => ((cols = c), db.selects.push(c), q),
        eq: (col: string, v: unknown) => (db.filters.push([table, `eq:${col}`, v]), q),
        in: async (col: string, v: unknown) => {
          db.filters.push([table, `in:${col}`, v]);
          if (db.missingColumn && cols.includes("build_reasons")) return { data: null, error: db.missingColumn };
          const rows = db.missingColumn ? db.rows.map(({ build_reasons: _drop, ...r }) => r) : db.rows;
          return { data: db.readError ? null : rows, error: db.readError };
        },
      };
      return q;
    },
  })),
}));
const { writeNoteMock, deleteNotesMock, memoryCalls } = vi.hoisted(() => {
  const memoryCalls: string[] = [];
  return {
    memoryCalls,
    writeNoteMock: vi.fn(async (_tenant: string, _note: Record<string, unknown>) => {
      memoryCalls.push("write");
    }),
    deleteNotesMock: vi.fn(async (_tenant: string, _source: string, _ref: string, _actor?: string | null) => {
      memoryCalls.push("delete");
      return 1;
    }),
  };
});
vi.mock("@/services/memory", () => ({ writeNote: writeNoteMock, deleteNotesBySourceRef: deleteNotesMock }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn() }));
const { flagMock } = vi.hoisted(() => ({ flagMock: vi.fn(async (_key: string, _tenant: string) => true) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: flagMock }));

import { feedbackMine, feedbackSubmit } from "../submit";

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
const call = async (fn: (req: any, res: any) => Promise<void>, req: Record<string, unknown>) => {
  const res = makeRes();
  await fn(req, res);
  return res;
};

beforeEach(() => {
  db.rpcArgs = [];
  db.filters = [];
  db.rows = [];
  db.readError = null;
  db.selects = [];
  db.missingColumn = null;
  db.rpcResult = { data: { feedback_id: "fb-1", agent_slug: "engineer", tenant_id: TENANT }, error: null };
  flagMock.mockReset();
  flagMock.mockImplementation(async () => true);
  writeNoteMock.mockClear();
  deleteNotesMock.mockClear();
  memoryCalls.length = 0;
});

describe("POST /api/feedback reasons on a build", () => {
  const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

  it("refuses a reason outside the list, a duplicate or more than six with 400, before the RPC", async () => {
    for (const reasons of [["look", "colour"], ["look", "look"], ["look", "layout", "copy", "missing", "broken", "slow", "look"], "look", [null]]) {
      const res = await call(feedbackSubmit, { body: { target_type: "conductor_run", target_id: BUILD, rating: -1, reasons } });
      expect(res.statusCode).toBe(400);
    }
    expect(db.rpcArgs).toEqual([]);
  });

  it("writes the rating and reasons atomically without trusting caller-supplied tenant or feedback ids", async () => {
    db.rpcResult = { data: { feedback_id: "fb-rpc", agent_slug: "engineer", tenant_id: TENANT }, error: null };
    const res = await call(feedbackSubmit, {
      body: { target_type: "conductor_run", target_id: BUILD, rating: -1, reasons: ["look", "copy"], tenant_id: OTHER_TENANT, feedback_id: "fb-theirs", id: "fb-theirs" },
    });
    expect(res.statusCode).toBe(200);
    expect(db.rpcArgs).toEqual([["submit_build_feedback", {
      p_target_id: BUILD,
      p_rating: -1,
      p_comment: null,
      p_build_reasons: ["look", "copy"],
    }]]);
    expect(JSON.stringify(db.rpcArgs)).not.toContain(OTHER_TENANT);
    expect(JSON.stringify(db.rpcArgs)).not.toContain("fb-theirs");
  });

  it("a thumbs up ignores reasons and clears any earlier ones", async () => {
    const res = await call(feedbackSubmit, { body: { target_type: "conductor_run", target_id: BUILD, rating: 1, reasons: ["look"] } });
    expect(res.statusCode).toBe(200);
    expect(db.rpcArgs[0]).toEqual(["submit_build_feedback", { p_target_id: BUILD, p_rating: 1, p_comment: null, p_build_reasons: [] }]);
    expect(flagMock).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ carryover: false });
  });

  it("a run in another workspace is refused by the atomic RPC", async () => {
    db.rpcResult = { data: null, error: { message: "target not found" } };
    const res = await call(feedbackSubmit, { body: { target_type: "conductor_run", target_id: BUILD, rating: -1, reasons: ["look"] } });
    expect(res.statusCode).toBe(400);
  });

  it("reasons on an agent run are ignored and use the existing RPC", async () => {
    const res = await call(feedbackSubmit, { body: { target_type: "agent_run", target_id: BUILD, rating: -1, reasons: ["look"] } });
    expect(res.statusCode).toBe(200);
    expect(db.rpcArgs[0]![0]).toBe("submit_agent_feedback");
    expect(db.rpcArgs[0]![1]).not.toHaveProperty("p_build_reasons");
  });

  it("says the next change will use the reasons only when the tenant's carry-over is on and readable", async () => {
    const body = { target_type: "conductor_run", target_id: BUILD, rating: -1, reasons: ["layout"] };
    expect((await call(feedbackSubmit, { body })).body).toMatchObject({ carryover: true });
    expect(flagMock).toHaveBeenCalledWith("site_build_feedback_carryover", TENANT);
    flagMock.mockImplementation(async () => false);
    expect((await call(feedbackSubmit, { body })).body).toMatchObject({ carryover: false });
    flagMock.mockImplementation(async () => {
      throw new Error("settings down");
    });
    const failed = await call(feedbackSubmit, { body });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toMatchObject({ carryover: false });
  });
});

describe("POST /api/feedback on a build", () => {
  it("passes the conductor_run target to the RPC and returns the rating's id", async () => {
    const res = await call(feedbackSubmit, { body: { target_type: "conductor_run", target_id: BUILD, rating: 1 } });
    expect(res.statusCode).toBe(200);
    expect(db.rpcArgs).toEqual([["submit_build_feedback", { p_target_id: BUILD, p_rating: 1, p_comment: null, p_build_reasons: [] }]]);
  });

  it("a thumbs-down with a reason is stored on the rating, never written into the workspace's memory", async () => {
    const res = await call(feedbackSubmit, { body: { target_type: "conductor_run", target_id: BUILD, rating: -1, comment: "The hero says nothing about what we sell" } });
    expect(res.statusCode).toBe(200);
    expect(db.rpcArgs[0]![1]).toMatchObject({ p_rating: -1, p_comment: "The hero says nothing about what we sell" });
    expect(writeNoteMock).not.toHaveBeenCalled();
  });

  it("a run outside the caller's workspace is refused as not found (400)", async () => {
    db.rpcResult = { data: null, error: { message: "target not found" } };
    const res = await call(feedbackSubmit, { body: { target_type: "conductor_run", target_id: BUILD, rating: 1 } });
    expect(res.statusCode).toBe(400);
    db.rpcResult = { data: { feedback_id: "fb-1", agent_slug: "engineer", tenant_id: TENANT }, error: null };
  });

  it("an unknown target type is refused before the RPC", async () => {
    const res = await call(feedbackSubmit, { body: { target_type: "site", target_id: BUILD, rating: 1 } });
    expect(res.statusCode).toBe(400);
    expect(db.rpcArgs).toEqual([]);
  });
});

describe("GET /api/feedback/mine", () => {
  it("reads only the caller's own ratings in their workspace, for the asked ids", async () => {
    db.rows = [{ target_id: BUILD, rating: -1, comment: "too generic", build_reasons: ["look", "copy"] }, { target_id: CHANGE, rating: 1, comment: null, build_reasons: [] }];
    const res = await call(feedbackMine, { query: { target_type: "conductor_run", ids: `${BUILD},${CHANGE},${BUILD}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ratings: { [BUILD]: { rating: -1, comment: "too generic", reasons: ["look", "copy"] }, [CHANGE]: { rating: 1, comment: null, reasons: [] } } });
    expect(db.filters).toEqual([
      ["agent_feedback", "eq:tenant_id", TENANT],
      ["agent_feedback", "eq:created_by", "u-1"],
      ["agent_feedback", "eq:target_type", "conductor_run"],
      ["agent_feedback", "in:target_id", [BUILD, CHANGE]],
    ]);
  });

  it("refuses a missing type, no ids, a non-uuid id or too many ids", async () => {
    for (const query of [
      { ids: BUILD },
      { target_type: "conductor_run" },
      { target_type: "conductor_run", ids: "not-a-uuid" },
      { target_type: "conductor_run", ids: Array.from({ length: 51 }, () => BUILD).join(",") },
      { target_type: "nope", ids: BUILD },
    ]) {
      const res = await call(feedbackMine, { query });
      expect(res.statusCode).toBe(400);
    }
    expect(db.filters).toEqual([]);
  });

  it("before the build_reasons migration every rating type still reads, without reasons, on the caller's own filters", async () => {
    for (const missing of [
      { code: "42703", message: "column agent_feedback.build_reasons does not exist" },
      { message: "Could not find the 'build_reasons' column of 'agent_feedback' in the schema cache" },
    ]) {
      for (const target_type of ["conductor_run", "agent_run", "decision"]) {
        db.missingColumn = missing;
        db.selects = [];
        db.filters = [];
        db.rows = [{ target_id: BUILD, rating: -1, comment: "too generic", build_reasons: ["look"] }];
        const res = await call(feedbackMine, { query: { target_type, ids: BUILD } });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ratings: { [BUILD]: { rating: -1, comment: "too generic", reasons: [] } } });
        expect(db.selects).toEqual(["target_id, rating, comment, build_reasons", "target_id, rating, comment"]);
        const own = [
          ["agent_feedback", "eq:tenant_id", TENANT],
          ["agent_feedback", "eq:created_by", "u-1"],
          ["agent_feedback", "eq:target_type", target_type],
          ["agent_feedback", "in:target_id", [BUILD]],
        ];
        expect(db.filters).toEqual([...own, ...own]);
      }
    }
  });

  it("an unrelated read error is still a 500 and is not retried", async () => {
    db.readError = { message: "permission denied for table agent_feedback" };
    const res = await call(feedbackMine, { query: { target_type: "conductor_run", ids: BUILD } });
    expect(res.statusCode).toBe(500);
    expect(db.selects).toEqual(["target_id, rating, comment, build_reasons"]);
  });

  it("a read error is a 500, never an empty success", async () => {
    db.readError = { message: "boom" };
    const res = await call(feedbackMine, { query: { target_type: "conductor_run", ids: BUILD } });
    expect(res.statusCode).toBe(500);
  });
});

describe("POST /api/feedback memory note on an agent run", () => {
  const REF = `agent_run:${BUILD}:fb-1`;

  it("replaces the earlier note with the new one", async () => {
    const res = await call(feedbackSubmit, { body: { target_type: "agent_run", target_id: BUILD, rating: -1, comment: " The numbers are wrong " } });
    expect(res.statusCode).toBe(200);
    expect(memoryCalls).toEqual(["delete", "write"]);
    expect(deleteNotesMock).toHaveBeenCalledWith(TENANT, "operator_feedback", REF, "u-1");
    expect(writeNoteMock.mock.calls[0]![1]).toMatchObject({ body_markdown: "The numbers are wrong", source_ref: REF, dedup_key: REF, tags: ["agent:engineer", "feedback", "rating:-1"] });
  });

  it("a rating with no note clears the earlier note so the agent stops reading it", async () => {
    const res = await call(feedbackSubmit, { body: { target_type: "agent_run", target_id: BUILD, rating: 1, comment: null } });
    expect(res.statusCode).toBe(200);
    expect(deleteNotesMock).toHaveBeenCalledWith(TENANT, "operator_feedback", REF, "u-1");
    expect(writeNoteMock).not.toHaveBeenCalled();
  });

  it("still saves the rating and writes the new note when clearing fails", async () => {
    deleteNotesMock.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await call(feedbackSubmit, { body: { target_type: "agent_run", target_id: BUILD, rating: -1, comment: "Too long" } });
    expect(res.statusCode).toBe(200);
    expect(writeNoteMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a build rating never touches the workspace's memory", async () => {
    await call(feedbackSubmit, { body: { target_type: "conductor_run", target_id: BUILD, rating: 1, comment: null } });
    expect(deleteNotesMock).not.toHaveBeenCalled();
  });
});
