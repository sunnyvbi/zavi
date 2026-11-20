
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  upsertAnchor: vi.fn(),
  writeCompanyProse: vi.fn(),
  noteUpdate: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => ({ email: "staff@zaviagent.com" }),
}));
vi.mock("@/services/memory/upsert-anchor", () => ({ upsertAnchor: mocks.upsertAnchor }));
vi.mock("@/services/company/brief", () => ({ writeCompanyProse: mocks.writeCompanyProse }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) q[m] = () => q;
      q.update = (patch: unknown) => {
        mocks.noteUpdate(table, patch);
        return q;
      };
      q.maybeSingle = async () =>
        table === "admin_tasks"
          ? { data: { tenant_id: "t-1" }, error: null }
          : { data: { body_markdown: "old brief" }, error: null };
      return q;
    },
  }),
}));

import { staffAdminTaskEnrichMemory } from "../admin-tasks";

const mkRes = () => {
  const res = {
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
  return res as unknown as Response & { statusCode: number; body: any };
};

const mkReq = (slug: string) =>
  ({ params: { id: "task-1" }, body: { slug, body_markdown: "They sell fleet software." } }) as unknown as Request;

const markerUpdates = () =>
  mocks.noteUpdate.mock.calls.filter(
    ([table, patch]) =>
      table === "memory_note" && Object.hasOwn(patch as object, "last_edited_by_staff_at"),
  );

describe("staff enrich-memory on the company anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.writeCompanyProse.mockResolvedValue({ stored: true, reason: "written", error: null });
  });

  it("writes the record, never the note", async () => {
    const res = mkRes();
    await staffAdminTaskEnrichMemory(mkReq("company"), res);

    expect(mocks.upsertAnchor).not.toHaveBeenCalled();
    expect(mocks.writeCompanyProse).toHaveBeenCalledWith(
      "t-1",
      "They sell fleet software.",
      "staff",
      expect.stringContaining("staff@zaviagent.com"),
    );
    expect(res.statusCode).toBe(200);
  });

  it("does not stamp the staff marker the trigger would drop", async () => {
    const res = mkRes();
    await staffAdminTaskEnrichMemory(mkReq("company"), res);

    expect(markerUpdates()).toHaveLength(0);
  });

  it("still stamps the marker on every other anchor", async () => {
    mocks.upsertAnchor.mockResolvedValue({ note_id: "n-1" });
    const res = mkRes();
    await staffAdminTaskEnrichMemory(mkReq("ops"), res);

    expect(mocks.upsertAnchor).toHaveBeenCalled();
    expect(markerUpdates()).toHaveLength(1);
    expect(markerUpdates()[0][1]).toMatchObject({ last_edited_by_staff_email: "staff@zaviagent.com" });
  });

  it("409s when the customer outranks the staff edit, and writes no marker", async () => {
    mocks.writeCompanyProse.mockResolvedValue({ stored: false, reason: "outranked", error: null });
    const res = mkRes();
    await staffAdminTaskEnrichMemory(mkReq("company"), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("outranked_by_customer");
    expect(markerUpdates()).toHaveLength(0);
  });
});

describe("staff enrich-memory when the company edit is too long", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.writeCompanyProse.mockResolvedValue({ stored: true, reason: "written", error: null });
  });

  const longReq = (chars: number) =>
    ({
      params: { id: "task-1" },
      body: { slug: "company", body_markdown: "x".repeat(chars) },
    }) as unknown as Request;

  it("422s with the real reason, and does not attempt the write", async () => {
    const res = mkRes();
    await staffAdminTaskEnrichMemory(longReq(8001), res);

    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe("company_story_too_long");
    expect(res.body.error.message).toMatch(/8000/);
    expect(mocks.writeCompanyProse).not.toHaveBeenCalled();
  });

  it("accepts an edit exactly at the cap", async () => {
    const res = mkRes();
    await staffAdminTaskEnrichMemory(longReq(8000), res);

    expect(res.statusCode).toBe(200);
    expect(mocks.writeCompanyProse).toHaveBeenCalled();
  });

  it("does not cap the other anchors", async () => {
    mocks.upsertAnchor.mockResolvedValue({ note_id: "n-1" });
    const res = mkRes();
    await staffAdminTaskEnrichMemory(
      { params: { id: "task-1" }, body: { slug: "ops", body_markdown: "x".repeat(9000) } } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mocks.upsertAnchor).toHaveBeenCalled();
  });
});

describe("staff enrich-memory when the company write breaks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it("500s with the real reason instead of blaming the customer", async () => {
    mocks.writeCompanyProse.mockResolvedValue({
      stored: false,
      reason: "error",
      error: "connection reset",
    });
    const res = mkRes();
    await staffAdminTaskEnrichMemory(mkReq("company"), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("company_story_write_failed");
    expect(res.body.error.message).toMatch(/connection reset/);
    expect(res.body.error.code).not.toBe("outranked_by_customer");
  });
});

describe("staff enrich-memory when the company edit is blank", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.writeCompanyProse.mockResolvedValue({ stored: false, reason: "empty", error: null });
  });

  it("422s as blank, not 409 as outranked", async () => {
    const res = mkRes();
    await staffAdminTaskEnrichMemory(
      { params: { id: "task-1" }, body: { slug: "company", body_markdown: "   " } } as unknown as Request,
      res,
    );

    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe("empty_company_story");
    expect(res.body.error.code).not.toBe("outranked_by_customer");
  });
});
