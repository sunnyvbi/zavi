
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rpc: vi.fn(),
  artifact: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    rpc: mocks.rpc,
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => mocks.artifact;
      return q;
    },
  })),
}));

import { artifactsApply } from "../decide";

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

const mkReq = () => ({ params: { id: "art-1" } }) as unknown as Request;

describe("applying an extracted artifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ access_token: "tok", user_id: "u1" });
    mocks.rpc.mockResolvedValue({ error: null });
  });

  it("refuses a company memory_update before the RPC can mark it applied", async () => {
    mocks.artifact = { data: { kind: "memory_update", target_slug: "company" }, error: null };
    const res = mkRes();
    await artifactsApply(mkReq(), res);

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("company_is_a_projection");
    expect(res.body.error.message).toMatch(/Company Details/i);
    expect(res.body.error.message).toMatch(/chat/i);
  });

  it("still applies a memory_update for any other anchor", async () => {
    mocks.artifact = { data: { kind: "memory_update", target_slug: "ops" }, error: null };
    const res = mkRes();
    await artifactsApply(mkReq(), res);

    expect(mocks.rpc).toHaveBeenCalledWith("apply_extracted_artifact", { p_artifact_id: "art-1" });
    expect(res.statusCode).toBe(200);
  });

  it("fails closed when the artifact cannot be read, rather than applying blind", async () => {
    mocks.artifact = { data: null, error: { message: "timeout" } };
    const res = mkRes();
    await artifactsApply(mkReq(), res);

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("artifact_read_failed");
  });

  it("404s on a missing artifact instead of calling the RPC", async () => {
    mocks.artifact = { data: null, error: null };
    const res = mkRes();
    await artifactsApply(mkReq(), res);

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  it("does not catch a skill_patch that happens to target a `company` agent", async () => {
    mocks.artifact = { data: { kind: "skill_patch", target_slug: "company" }, error: null };
    const res = mkRes();
    await artifactsApply(mkReq(), res);

    expect(mocks.rpc).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

describe("the artifact-level guard", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../../../../../supabase/migrations/20260913170000_company_artifact_cannot_be_applied.sql",
    ),
    "utf8",
  );

  it("fires before update, per row, on the artifact table", () => {
    expect(sql).toMatch(/before update on extracted_artifacts/i);
    expect(sql).toMatch(/for each row/i);
  });

  it("raises rather than skipping, so the caller cannot be told it worked", () => {
    expect(sql).toMatch(/raise exception/i);
    expect(sql).not.toMatch(/return null/i);
  });

  it("is scoped to a memory_update on `company` entering `applied`", () => {
    expect(sql).toMatch(/new\.kind = 'memory_update'/);
    expect(sql).toMatch(/new\.target_slug = 'company'/);
    expect(sql).toMatch(/new\.status = 'applied'/);
    expect(sql).toMatch(/old\.status is distinct from 'applied'/);
  });

  it("pins search_path including pg_temp", () => {
    expect(sql).toMatch(/set search_path = public, pg_temp/i);
  });

  it("tells the caller where the edit belongs", () => {
    expect(sql).toMatch(/company_story/);
  });
});
