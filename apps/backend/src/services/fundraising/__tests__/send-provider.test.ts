
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    send_mode: "off" | "test" | "live";
    updated_by: string | null;
    configError: boolean;
    founderEmail: string | null;
  } = { send_mode: "off", updated_by: "owner-uuid", configError: false, founderEmail: "founder@zavi.test" };

  const auditInserts: Array<Record<string, unknown>> = [];

  const emailSendCalls: Array<{ to: string }> = [];
  const emailSend = vi.fn(async (_tenant: string, args: { to: string }) => {
    emailSendCalls.push({ to: args.to });
    return { messageId: "msg-1" };
  });

  const maybeSingle = vi.fn(async () =>
    state.configError
      ? { data: null, error: { message: "boom" } }
      : { data: { send_mode: state.send_mode, updated_by: state.updated_by }, error: null },
  );
  const eqFn = vi.fn(() => ({ maybeSingle }));
  const selectFn = vi.fn(() => ({ eq: eqFn }));
  const insertFn = vi.fn(async (row: Record<string, unknown>) => {
    auditInserts.push(row);
    return { error: null };
  });
  const fromFn = vi.fn((tbl: string) => {
    if (tbl === "fundraising_round_config") return { select: selectFn };
    if (tbl === "fundraising_send_audit") return { insert: insertFn };
    return {};
  });
  const getUserById = vi.fn(async (_id: string) => ({
    data: state.founderEmail ? { user: { email: state.founderEmail } } : { user: null },
    error: null,
  }));
  const serviceClient = vi.fn(() => ({
    from: fromFn,
    auth: { admin: { getUserById } },
  }));

  return { state, auditInserts, emailSend, emailSendCalls, serviceClient, getUserById };
});

vi.mock("@/services/tools/email/_client", () => ({ emailSend: m.emailSend }));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { sendFundraisingEmail } from "../send-provider";

const baseParams = {
  tenant_id: "t-1",
  to: "real-investor@vc.com",
  subject: "hi",
  body: "body",
  run_id: "r-1",
};

beforeEach(() => {
  m.state.send_mode = "off";
  m.state.updated_by = "owner-uuid";
  m.state.configError = false;
  m.state.founderEmail = "founder@zavi.test";
  m.auditInserts.length = 0;
  m.emailSendCalls.length = 0;
  vi.clearAllMocks();
});

describe("sendFundraisingEmail — per-tenant send_mode gate", () => {
  it("off → blocked (send_mode_off), nothing sends", async () => {
    m.state.send_mode = "off";
    const r = await sendFundraisingEmail({ ...baseParams });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("blocked");
    expect(m.emailSendCalls).toHaveLength(0);
    const audit = m.auditInserts.at(-1)!;
    expect(audit.status).toBe("blocked");
    expect(audit.safety_result).toEqual({ reason: "send_mode_off" });
  });

  it("test → IGNORES a caller-supplied test_recipient, always resolves founder from updated_by (no pollution)", async () => {
    m.state.send_mode = "test";
    m.state.founderEmail = "owner@founder.test";
    const r = await sendFundraisingEmail({
      ...baseParams,
      test_recipient: "attacker@evil.test",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actual_recipient).toBe("owner@founder.test");
    expect(m.getUserById).toHaveBeenCalledWith("owner-uuid");
    expect(m.emailSendCalls).toEqual([{ to: "owner@founder.test" }]);
    expect(m.emailSendCalls).not.toContainEqual({ to: "attacker@evil.test" });
    expect(m.auditInserts.at(-1)!.status).toBe("test_sent");
  });

  it("test (no test_recipient) → resolves founder email from updated_by", async () => {
    m.state.send_mode = "test";
    m.state.founderEmail = "owner@founder.test";
    const r = await sendFundraisingEmail({ ...baseParams });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actual_recipient).toBe("owner@founder.test");
    expect(m.getUserById).toHaveBeenCalledWith("owner-uuid");
    expect(m.emailSendCalls).toEqual([{ to: "owner@founder.test" }]);
    expect(m.auditInserts.at(-1)!.status).toBe("test_sent");
  });

  it("test (no recipient resolvable) → blocked (no_test_recipient)", async () => {
    m.state.send_mode = "test";
    m.state.updated_by = null;
    const r = await sendFundraisingEmail({ ...baseParams });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("blocked");
    expect(m.emailSendCalls).toHaveLength(0);
    expect(m.auditInserts.at(-1)!.status).toBe("blocked");
    expect(m.auditInserts.at(-1)!.safety_result).toEqual({ reason: "no_test_recipient" });
  });

  it("live → real send to params.to, audit sent", async () => {
    m.state.send_mode = "live";
    const r = await sendFundraisingEmail({ ...baseParams });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actual_recipient).toBe("real-investor@vc.com");
    expect(m.emailSendCalls).toEqual([{ to: "real-investor@vc.com" }]);
    expect(m.auditInserts.at(-1)!.status).toBe("sent");
  });

  it("no config row (load error) → defaults to off (blocked)", async () => {
    m.state.configError = true;
    const r = await sendFundraisingEmail({ ...baseParams });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("blocked");
    expect(m.emailSendCalls).toHaveLength(0);
  });
});
