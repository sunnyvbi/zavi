
import { describe, it, expect, vi, beforeEach } from "vitest";

const sgMock = vi.hoisted(() => ({
  setApiKey: vi.fn(),
  send: vi.fn(async (..._args: unknown[]) => [
    { headers: { "x-message-id": "m-1" }, statusCode: 202 },
    {},
  ]),
}));
vi.mock("@sendgrid/mail", () => ({
  default: sgMock,
  setApiKey: sgMock.setApiKey,
  send: sgMock.send,
}));

vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(async (_t: string, k: string) =>
    k === "email.api_key"
      ? "SG.test"
      : k === "email.from_address"
        ? "ops@example.com"
        : "Praxis Ops",
  ),
}));

const rpcBehavior = vi.hoisted(() => ({
  is_email_suppressed: null as string | null,
  get_or_create_unsub_token: "11111111-1111-1111-1111-111111111111" as string,
  touch_domain_warmup: 0 as number,
  consume_email_send_or_reject: true as boolean,
}));
const rpc = vi.hoisted(() =>
  vi.fn(async (name: string, _args: Record<string, unknown>) => {
    const data = (rpcBehavior as Record<string, unknown>)[name];
    return { data, error: null };
  }),
);
const insert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc,
    from: (_t: string) => ({ insert }),
  }),
}));

import { emailSend } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import {
  warmupAllowance,
  effectiveCap,
  sendingDomain,
  WARMUP_GRADUATED_DAY,
} from "../safety-net";

describe("safety-net pure helpers", () => {
  it("warmup ramp doubles per day then graduates to unlimited (0)", () => {
    expect(warmupAllowance(0)).toBe(50);
    expect(warmupAllowance(1)).toBe(100);
    expect(warmupAllowance(2)).toBe(200);
    expect(warmupAllowance(WARMUP_GRADUATED_DAY)).toBe(0);
    expect(warmupAllowance(WARMUP_GRADUATED_DAY + 5)).toBe(0);
    expect(warmupAllowance(-3)).toBe(50);
  });

  it("effectiveCap takes the tighter non-zero limit; 0 means unlimited", () => {
    expect(effectiveCap(100, 50)).toBe(50);
    expect(effectiveCap(50, 100)).toBe(50);
    expect(effectiveCap(0, 200)).toBe(200);
    expect(effectiveCap(200, 0)).toBe(200);
    expect(effectiveCap(0, 0)).toBe(0);
  });

  it("sendingDomain extracts + lowercases the host, null on garbage", () => {
    expect(sendingDomain("Ops@Example.COM")).toBe("example.com");
    expect(sendingDomain("no-at-sign")).toBeNull();
    expect(sendingDomain("trailing@")).toBeNull();
  });
});

beforeEach(() => {
  sgMock.send.mockClear();
  rpc.mockClear();
  insert.mockClear();
  rpcBehavior.is_email_suppressed = null;
  rpcBehavior.touch_domain_warmup = 0;
  rpcBehavior.consume_email_send_or_reject = true;
  delete process.env.PRAXIS_COMMS_SAFETY_NET;
  delete process.env.PRAXIS_DAILY_EMAIL_CAP;
});

describe("comms safety net — suppression", () => {
  it("BLOCKS a suppressed recipient before any SendGrid call", async () => {
    rpcBehavior.is_email_suppressed = "unsubscribe";
    await expect(
      emailSend("t-1", { to: "gone@example.com", subject: "s", body_text: "b" }),
    ).rejects.toMatchObject({
      name: "ExpectedToolError",
      code: "recipient_suppressed",
    });
    expect(sgMock.send).not.toHaveBeenCalled();
  });

  it("suppression is enforced even when the kill-switch is OFF", async () => {
    process.env.PRAXIS_COMMS_SAFETY_NET = "0";
    rpcBehavior.is_email_suppressed = "complaint";
    await expect(
      emailSend("t-1", { to: "gone@example.com", subject: "s", body_text: "b" }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(sgMock.send).not.toHaveBeenCalled();
  });
});

describe("comms safety net — daily send cap", () => {
  it("REJECTS an over-cap send before any SendGrid call", async () => {
    process.env.PRAXIS_DAILY_EMAIL_CAP = "5";
    rpcBehavior.consume_email_send_or_reject = false;
    await expect(
      emailSend("t-1", { to: "user@example.com", subject: "s", body_text: "b" }),
    ).rejects.toMatchObject({
      name: "ExpectedToolError",
      code: "daily_send_cap_exceeded",
    });
    expect(sgMock.send).not.toHaveBeenCalled();
  });

  it("allows a send when the cap RPC charges it (returns true)", async () => {
    process.env.PRAXIS_DAILY_EMAIL_CAP = "5";
    rpcBehavior.consume_email_send_or_reject = true;
    const res = await emailSend("t-1", {
      to: "user@example.com",
      subject: "s",
      body_text: "b",
    });
    expect(res.ok).toBe(true);
    expect(sgMock.send).toHaveBeenCalledTimes(1);
  });
});

describe("comms safety net — warm-up advances only on a real send", () => {
  const touched = () => rpc.mock.calls.filter(([name]) => name === "touch_domain_warmup").length;
  const msg = { to: "user@example.com", subject: "s", body_text: "b", from_override: "hi@brand.test" };

  it("a send over the cap does not advance the warm-up day", async () => {
    rpcBehavior.consume_email_send_or_reject = false;
    await expect(emailSend("t-1", msg)).rejects.toMatchObject({ code: "daily_send_cap_exceeded" });
    expect(touched()).toBe(0);
  });

  it("a send SendGrid refuses does not advance it", async () => {
    sgMock.send.mockRejectedValueOnce(Object.assign(new Error("bad"), { code: 400, response: { body: {} } }));
    await expect(emailSend("t-1", msg)).rejects.toMatchObject({ code: "email_send_failed" });
    expect(touched()).toBe(0);
  });

  it("a send SendGrid accepted advances it once, on the sending domain", async () => {
    await emailSend("t-1", msg);
    expect(touched()).toBe(1);
    expect(rpc.mock.calls.find(([name]) => name === "touch_domain_warmup")?.[1]).toMatchObject({ p_tenant_id: "t-1", p_domain: "brand.test" });
  });

  it("a send with no answer may have gone out, so it advances too", async () => {
    sgMock.send.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: 503 }));
    await expect(emailSend("t-1", msg)).rejects.toMatchObject({ code: "email_send_outcome_unknown" });
    expect(touched()).toBe(1);
  });

  it("keeps the daily cap and the warm-up cap apart", async () => {
    process.env.PRAXIS_DAILY_EMAIL_CAP = "5000";
    await emailSend("t-1", msg);
    expect(rpc.mock.calls.find(([name]) => name === "consume_email_send_or_reject")?.[1]).toMatchObject({ p_daily_cap: 5000, p_warmup_cap: 50 });
  });
});

describe("comms safety net — List-Unsubscribe header", () => {
  it("stamps the RFC 8058 one-click unsubscribe header pair on an allowed send", async () => {
    rpcBehavior.get_or_create_unsub_token = "abc-123-token";
    await emailSend("t-1", { to: "user@example.com", subject: "s", body_text: "b" });
    expect(sgMock.send).toHaveBeenCalledTimes(1);
    const payload = sgMock.send.mock.calls[0][0] as { headers?: Record<string, string> };
    expect(payload.headers).toBeDefined();
    expect(payload.headers!["List-Unsubscribe"]).toContain("abc-123-token");
    expect(payload.headers!["List-Unsubscribe"]).toMatch(/^<https?:\/\/.+\/api\/email\/unsubscribe\?token=.+>$/);
    expect(payload.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
