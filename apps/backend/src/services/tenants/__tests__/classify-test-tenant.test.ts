
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserById = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn().mockReturnValue({ maybeSingle });
const select = vi.fn().mockReturnValue({ eq });
const update = vi.fn();
const from = vi.fn().mockReturnValue({ select, update });
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ auth: { admin: { getUserById } }, from }),
}));
const logEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (i: unknown) => logEvent(i) }));

import { isTestTenantEmail, auditTenantKind, TEST_TENANT_EMAIL_DOMAINS } from "../classify-test-tenant";

describe("isTestTenantEmail", () => {
  it("matches each Praxis test domain (case-insensitive)", () => {
    for (const d of TEST_TENANT_EMAIL_DOMAINS) {
      expect(isTestTenantEmail(`qa-123@${d}`)).toBe(true);
      expect(isTestTenantEmail(`QA-123@${d.toUpperCase()}`)).toBe(true);
    }
  });

  it("does NOT match real domains — incl plus-aliases (default-safe)", () => {
    expect(isTestTenantEmail("reethikabaddula@gmail.com")).toBe(false);
    expect(isTestTenantEmail("rravi149@gmail.com")).toBe(false);
    expect(isTestTenantEmail("rravi149+indiantutor3@gmail.com")).toBe(false);
    expect(isTestTenantEmail("ravi+apna@upcar.ai")).toBe(false);
    expect(isTestTenantEmail("john@notthepraxis.ai")).toBe(false);
    expect(isTestTenantEmail("a@sub.thepraxis.ai")).toBe(false);
  });

  it("handles null / empty / malformed safely", () => {
    expect(isTestTenantEmail(null)).toBe(false);
    expect(isTestTenantEmail(undefined)).toBe(false);
    expect(isTestTenantEmail("")).toBe(false);
    expect(isTestTenantEmail("no-at-sign")).toBe(false);
    expect(isTestTenantEmail("@thepraxis.ai")).toBe(true);
  });
});

describe("auditTenantKind", () => {
  beforeEach(() => {
    getUserById.mockReset();
    maybeSingle.mockReset();
    from.mockClear();
    update.mockClear();
    logEvent.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("real-domain owner (incl. plus-alias): no DB read, no write, nothing logged", async () => {
    const r = await auditTenantKind("t-1", "u-1", "rravi149+x@gmail.com");
    expect(r).toBe("real_owner");
    expect(getUserById).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("test-domain owner whose row landed kind='test': ok, silent, no write", async () => {
    maybeSingle.mockResolvedValue({ data: { kind: "test" }, error: null });
    const r = await auditTenantKind("t-2", "u-2", "qa@example.com");
    expect(r).toBe("ok");
    expect(from).toHaveBeenCalledWith("tenants");
    expect(update).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("test-domain owner whose row is kind='real': reports a mismatch, never writes", async () => {
    maybeSingle.mockResolvedValue({ data: { kind: "real" }, error: null });
    const r = await auditTenantKind("t-3", "u-3", "gt-x@thepraxis.ai");
    expect(r).toBe("mismatch");
    expect(update).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        code: "tenant_kind.test_owner_landed_real",
        tenant_id: "t-3",
        meta: { kind: "real" },
      }),
    );
  });

  it("falls back to the admin lookup when the token carries no email claim", async () => {
    getUserById.mockResolvedValue({ data: { user: { email: "qa@yopmail.com" } }, error: null });
    maybeSingle.mockResolvedValue({ data: { kind: "test" }, error: null });
    const r = await auditTenantKind("t-4", "u-4", null);
    expect(r).toBe("ok");
    expect(getUserById).toHaveBeenCalledWith("u-4");
  });

  it("logs (does not swallow) a read error, and never throws", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    const r = await auditTenantKind("t-5", "u-5", "qa@mailinator.com");
    expect(r).toBe("error");
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "tenant_kind.audit_read_failed", tenant_id: "t-5" }),
    );
  });

  it("never throws when the lookup itself throws (best-effort)", async () => {
    getUserById.mockRejectedValue(new Error("auth down"));
    await expect(auditTenantKind("t-6", "u-6", null)).resolves.toBe("error");
    expect(update).not.toHaveBeenCalled();
  });
});
