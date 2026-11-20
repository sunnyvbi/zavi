
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const setGlobalSetting = vi.fn().mockResolvedValue(undefined);
const setTenantSetting = vi.fn().mockResolvedValue(undefined);
const editSecretList = vi.fn().mockResolvedValue({ count: 3, changed: 1, revision: "rev-2" });
const writeStaffAudit = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: "u-1", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit }));
vi.mock("@/services/settings", async () => {
  const actual = await vi.importActual<typeof import("@/services/settings")>("@/services/settings");
  return {
    REDACTED_SETTING_VALUE: actual.REDACTED_SETTING_VALUE,
    SecretListError: actual.SecretListError,
    listSettings: vi.fn().mockResolvedValue([]),
    setGlobalSetting,
    setTenantSetting,
    editSecretList,
  };
});

type MockRes = Response & { _status: number; _json: unknown };

function mockRes(): MockRes {
  const r = {} as MockRes;
  r._status = 200;
  r.status = vi.fn((c: number) => {
    r._status = c;
    return r;
  }) as unknown as MockRes["status"];
  r.json = vi.fn((b: unknown) => {
    r._json = b;
    return r;
  }) as unknown as MockRes["json"];
  return r;
}

beforeEach(() => {
  setGlobalSetting.mockClear();
  setTenantSetting.mockClear();
  editSecretList.mockClear();
  writeStaffAudit.mockClear();
});

describe("staffSettingsPut — credential write-back guard", () => {
  it("rejects the redaction placeholder with 400 and writes NOTHING", async () => {
    const { staffSettingsPut } = await import("../settings");
    const { REDACTED_SETTING_VALUE } = await import("@/services/settings");
    const res = mockRes();
    await staffSettingsPut(
      {
        body: {
          key: "anthropic_oauth_token_pool",
          scope: "global",
          value: REDACTED_SETTING_VALUE,
        },
      } as Request,
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: { code: string } }).error.code).toBe("redacted_placeholder_write");
    expect(setGlobalSetting).not.toHaveBeenCalled();
  });

  it("rejects it with surrounding whitespace too", async () => {
    const { staffSettingsPut } = await import("../settings");
    const { REDACTED_SETTING_VALUE } = await import("@/services/settings");
    const res = mockRes();
    await staffSettingsPut(
      {
        body: {
          key: "anthropic_oauth_token_pool",
          scope: "global",
          value: `  ${REDACTED_SETTING_VALUE}  `,
        },
      } as Request,
      res,
    );
    expect(res._status).toBe(400);
    expect(setGlobalSetting).not.toHaveBeenCalled();
  });

  it("a full set goes through the locked list writer with the caller's revision, never setGlobalSetting", async () => {
    const { staffSettingsPut } = await import("../settings");
    const res = mockRes();
    await staffSettingsPut(
      {
        body: { key: "anthropic_oauth_token_pool", scope: "global", value: "oat-a,oat-b,oat-c", expected_revision: "rev-1" },
      } as Request,
      res,
    );
    expect(res._status).toBe(200);
    expect(editSecretList).toHaveBeenCalledWith(
      "anthropic_oauth_token_pool",
      { op: "set", tokens: "oat-a,oat-b,oat-c", expectedRevision: "rev-1" },
      "ravi@upcar.ai",
    );
    expect(setGlobalSetting).not.toHaveBeenCalled();
  });

  it('"" with a revision clears the credential (revert to the env fallback)', async () => {
    const { staffSettingsPut } = await import("../settings");
    const res = mockRes();
    await staffSettingsPut(
      { body: { key: "anthropic_oauth_token_pool", scope: "global", value: "", expected_revision: null } } as Request,
      res,
    );
    expect(res._status).toBe(200);
    expect(editSecretList).toHaveBeenCalledWith(
      "anthropic_oauth_token_pool",
      { op: "set", tokens: "", expectedRevision: null },
      "ravi@upcar.ai",
    );
  });

  it("a full set without expected_revision (a stale page) is refused before any write", async () => {
    const { staffSettingsPut } = await import("../settings");
    const res = mockRes();
    await staffSettingsPut(
      { body: { key: "anthropic_oauth_token_pool", scope: "global", value: "oat-a" } } as Request,
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: { code: string } }).error.code).toBe("expected_revision_required");
    expect(editSecretList).not.toHaveBeenCalled();
    expect(setGlobalSetting).not.toHaveBeenCalled();
  });
});

describe("staffSettingsPut — list ops and notes on the token pool", () => {
  const put = async (body: Record<string, unknown>) => {
    const { staffSettingsPut } = await import("../settings");
    const res = mockRes();
    await staffSettingsPut({ body: { key: "anthropic_oauth_token_pool", scope: "global", ...body } } as Request, res);
    return res;
  };

  it("append returns the pool size and revision", async () => {
    const res = await put({ value: "oat-new", op: "append" });
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true, count: 3, revision: "rev-2" });
    expect(editSecretList).toHaveBeenCalledWith("anthropic_oauth_token_pool", { op: "append", tokens: "oat-new" }, "ravi@upcar.ai");
  });

  it("each op maps to its edit", async () => {
    await put({ value: "oat-new", op: "append_with_note", note: "Tarun's seat" });
    await put({ value: "seat_aaaaaaaaaaaa", op: "remove" });
    await put({ value: "oat-fresh", op: "replace", target: "seat_aaaaaaaaaaaa", expected_revision: "r" });
    await put({ value: "Ravi's Max", op: "note", target: "seat_aaaaaaaaaaaa", expected_revision: "r" });
    expect(editSecretList.mock.calls.map((c) => c[1])).toEqual([
      { op: "append", tokens: "oat-new", note: "Tarun's seat" },
      { op: "remove", target: "seat_aaaaaaaaaaaa" },
      { op: "replace", target: "seat_aaaaaaaaaaaa", token: "oat-fresh", expectedRevision: "r" },
      { op: "note", target: "seat_aaaaaaaaaaaa", note: "Ravi's Max", expectedRevision: "r" },
    ]);
  });

  it("note and replace need a target and a revision", async () => {
    expect((await put({ value: "x", op: "note", expected_revision: "r" }))._status).toBe(400);
    expect((await put({ value: "x", op: "note", target: "seat_aaaaaaaaaaaa" }))._status).toBe(400);
    expect((await put({ value: "x", op: "replace", target: "seat_aaaaaaaaaaaa" }))._status).toBe(400);
    expect(editSecretList).not.toHaveBeenCalled();
  });

  it("the audit row never carries a token or the note text", async () => {
    editSecretList.mockResolvedValueOnce({ count: 2, changed: 1, revision: "r", seat: "seat_aaaaaaaaaaaa" });
    await put({ value: "oat-new-token", op: "append_with_note", note: "Ravi's Max seat" });
    await put({ value: "oat-full-replace", expected_revision: "r" });
    editSecretList.mockResolvedValueOnce({ count: 2, changed: 1, revision: "r", seat: "seat_aaaaaaaaaaaa" });
    await put({ value: "secret-ish label", op: "note", target: "seat_aaaaaaaaaaaa", expected_revision: "r" });
    const metas = JSON.stringify(writeStaffAudit.mock.calls);
    expect(metas).not.toContain("oat-new-token");
    expect(metas).not.toContain("oat-full-replace");
    expect(metas).not.toContain("Ravi's Max");
    expect(metas).not.toContain("secret-ish label");
    expect(writeStaffAudit.mock.calls[2][0].meta).toMatchObject({ op: "note", seat: "seat_aaaaaaaaaaaa", note_len: 16, deleted: false });
  });

  it("typed service errors keep their status (404 unknown, 409 stale, 503 notes down)", async () => {
    const { SecretListError } = await import("@/services/settings");
    editSecretList.mockRejectedValueOnce(new SecretListError("not_found", 404, "no entry matches \u20269999"));
    expect((await put({ value: "\u20269999", op: "remove" }))._status).toBe(404);
    editSecretList.mockRejectedValueOnce(new SecretListError("stale_revision", 409, "reload"));
    const stale = await put({ value: "oat-a", expected_revision: "old" });
    expect(stale._status).toBe(409);
    expect((stale._json as { error: { code: string } }).error.code).toBe("stale_revision");
    editSecretList.mockRejectedValueOnce(new SecretListError("notes_unavailable", 503, "no salt"));
    expect((await put({ value: "x", op: "note", target: "seat_aaaaaaaaaaaa", expected_revision: "r" }))._status).toBe(503);
    expect(writeStaffAudit).not.toHaveBeenCalled();
  });

  it("a tenant scope is rejected", async () => {
    const res = await put({ scope: "tenant", tenant_id: "00000000-0000-0000-0000-000000000000", value: "oat-x", op: "append" });
    expect(res._status).toBe(400);
    expect(editSecretList).not.toHaveBeenCalled();
  });

  it("list ops on a non-list key are rejected", async () => {
    const { staffSettingsPut } = await import("../settings");
    const res = mockRes();
    await staffSettingsPut(
      { body: { key: "memory_reranker_enabled", scope: "global", value: "x", op: "append" } } as Request,
      res,
    );
    expect(res._status).toBe(400);
    expect(editSecretList).not.toHaveBeenCalled();
  });
});
