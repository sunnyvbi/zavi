import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pre: vi.fn(), enabled: true, rpc: vi.fn(), setTenantSetting: vi.fn(), logEvent: vi.fn(async () => {}), notice: vi.fn(async (..._a: unknown[]) => true) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  preTenantRpc: (...a: unknown[]) => mocks.pre(...a),
  tenantClient: vi.fn(),
}));
vi.mock("@/services/settings", () => ({
  setTenantSetting: (...a: unknown[]) => mocks.setTenantSetting(...a),
  getBoolSettingStrictResolved: async () => mocks.enabled,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));
vi.mock("../thread-notice", () => ({ postBulkSendNotice: (...a: unknown[]) => mocks.notice(...a) }));

import { bulkFeedbackKind, recordBulkFeedback, resolveBulkRecipientTenant } from "../feedback";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEND = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.rpc.mockResolvedValue({ data: { ok: true, counted: true, tripped: false }, error: null });
});

describe("bulkFeedbackKind", () => {
  it("a spam report is a complaint; a real bounce is a hard bounce; a block or a drop is neither", () => {
    expect(bulkFeedbackKind("spamreport", undefined)).toBe("complaint");
    expect(bulkFeedbackKind("bounce", "bounce")).toBe("hard_bounce");
    expect(bulkFeedbackKind("bounce", undefined)).toBe("hard_bounce");
    expect(bulkFeedbackKind("bounce", "blocked")).toBeNull();
    expect(bulkFeedbackKind("dropped", undefined)).toBeNull();
    expect(bulkFeedbackKind("delivered", undefined)).toBeNull();
  });
});

describe("recordBulkFeedback", () => {
  it("counts against the send under its own tenant; the thresholds are not the caller's to pass", async () => {
    const out = await recordBulkFeedback({ tenantId: TENANT, sendId: SEND, email: "a@x.com", kind: "complaint" });
    expect(out).toEqual({ counted: true, tripped: false });
    expect(mocks.rpc).toHaveBeenCalledWith(TENANT, "email_bulk_record_feedback", {
      p_send_id: SEND,
      p_email: "a@x.com",
      p_kind: "complaint",
    });
    expect(mocks.setTenantSetting).not.toHaveBeenCalled();
  });

  it("crossing a threshold switches bulk email OFF for that workspace only, logs it for staff and tells the founder", async () => {
    mocks.rpc.mockImplementation(async (_t: string, name: string) =>
      name === "email_bulk_abuse_switch_off" ? { data: true, error: null } : { data: { ok: true, counted: true, tripped: true, reason: "abuse_complaints" }, error: null });
    const out = await recordBulkFeedback({ tenantId: TENANT, sendId: SEND, email: "a@x.com", kind: "complaint" });
    expect(out.tripped).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith(TENANT, "email_bulk_abuse_switch_off", {});
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "bulk_email.abuse_shutoff", tenant_id: TENANT, meta: { reason: "abuse_complaints", bulk_send_id: SEND } }),
    );
    const [, , text] = mocks.notice.mock.calls[0] as unknown as [string, string, string];
    expect(text).toMatch(/^Bulk email is now switched off for this workspace because too many people marked this email as spam\./);
    expect(JSON.stringify([mocks.logEvent.mock.calls, mocks.notice.mock.calls])).not.toContain("a@x.com");
  });

  it("the founder is told once: later complaints, or the sender tripping the same rule after its chunk, find bulk email already off and post nothing more", async () => {
    let off = false;
    mocks.rpc.mockImplementation(async (_t: string, name: string) => {
      if (name === "email_bulk_abuse_switch_off") {
        const changed = !off;
        off = true;
        return { data: changed, error: null };
      }
      return { data: { ok: true, counted: true, tripped: true, reason: "abuse_complaints" }, error: null };
    });
    await recordBulkFeedback({ tenantId: TENANT, sendId: SEND, email: "a@x.com", kind: "complaint" });
    await recordBulkFeedback({ tenantId: TENANT, sendId: SEND, email: "b@x.com", kind: "complaint" });
    const { shutOffBulkEmail } = await import("../shutoff");
    await shutOffBulkEmail(TENANT, SEND, "abuse_complaints");
    expect(mocks.rpc.mock.calls.filter((c) => c[1] === "email_bulk_abuse_switch_off")).toHaveLength(3);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][2]).toMatch(/^Bulk email is now switched off for this workspace because too many people marked this email as spam\./);
    expect(mocks.logEvent.mock.calls.filter((c) => (c as unknown as [{ code: string }])[0].code === "bulk_email.abuse_shutoff")).toHaveLength(3);
  });

  it("the switch-off is ONE conditional database write, never a read-then-write in the app", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, counted: true, tripped: true, reason: "abuse_complaints" }, error: null });
    await recordBulkFeedback({ tenantId: TENANT, sendId: SEND, email: "a@x.com", kind: "complaint" });
    expect(mocks.rpc).toHaveBeenCalledWith(TENANT, "email_bulk_abuse_switch_off", {});
    expect(mocks.setTenantSetting).not.toHaveBeenCalled();
  });

  it("ids that are not uuids count nothing and call nothing", async () => {
    expect(await recordBulkFeedback({ tenantId: "x", sendId: SEND, email: "a@x.com", kind: "complaint" })).toEqual({ counted: false, tripped: false });
    expect(await recordBulkFeedback({ tenantId: TENANT, sendId: "1; drop", email: "a@x.com", kind: "complaint" })).toEqual({ counted: false, tripped: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a send that is not this tenant's counts nothing", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: "not_found" }, error: null });
    expect(await recordBulkFeedback({ tenantId: TENANT, sendId: SEND, email: "a@x.com", kind: "hard_bounce" })).toEqual({ counted: false, tripped: false });
    expect(mocks.setTenantSetting).not.toHaveBeenCalled();
  });

  it("a failed write throws, so the webhook can ask for the batch again", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    await expect(recordBulkFeedback({ tenantId: TENANT, sendId: SEND, email: "a@x.com", kind: "complaint" })).rejects.toThrow();
  });
});

describe("resolveBulkRecipientTenant", () => {
  const SEND = "00000000-0000-4000-8000-000000000001";
  const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  beforeEach(() => mocks.pre.mockReset());

  it("asks our records by send id and address, and returns only a tenant id", async () => {
    mocks.pre.mockResolvedValue({ data: T, error: null });
    expect(await resolveBulkRecipientTenant(SEND, "a@b.example")).toBe(T);
    expect(mocks.pre).toHaveBeenCalledWith("email_bulk_resolve_recipient", { p_send_id: SEND, p_email: "a@b.example" });
    mocks.pre.mockResolvedValue({ data: null, error: null });
    expect(await resolveBulkRecipientTenant(SEND, "a@b.example")).toBeNull();
  });

  it("a send id that is not a uuid never reaches the database; a failed read throws (the webhook retries)", async () => {
    expect(await resolveBulkRecipientTenant("not-a-uuid", "a@b.example")).toBeNull();
    expect(mocks.pre).not.toHaveBeenCalled();
    mocks.pre.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(resolveBulkRecipientTenant(SEND, "a@b.example")).rejects.toThrow();
  });
});
