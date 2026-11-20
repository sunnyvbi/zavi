import { describe, expect, it, vi } from "vitest";
import { handleZaviSendEmailHook, type ZaviHookDeps } from "../send-email-hook";
import { signStandardWebhook } from "../../site-auth/webhook-signature";
import { renderOtpEmail } from "../../../email/templates/otp";

const SECRET = "v1,whsec_" + Buffer.from("zavi-test-hook-secret-0123456789").toString("base64");
const NOW = 1_800_000_000_000;

function deps(over: Partial<ZaviHookDeps> = {}) {
  const d = {
    secret: SECRET,
    supabaseUrl: "https://proj.supabase.co",
    now: () => NOW,
    sendSignupCode: vi.fn(async () => undefined),
    sendRecoveryLink: vi.fn(async () => undefined),
    sendEmailChangeLink: vi.fn(async () => undefined),
    log: vi.fn(),
    ...over,
  };
  return d;
}

function signed(payload: unknown, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload));
  const ts = String(Math.floor(NOW / 1000));
  return { body, headers: { id: "msg_1", timestamp: ts, signature: signStandardWebhook(secret, "msg_1", ts, body) } };
}

const signup = { user: { id: "u1", email: "maya@bakery.com" }, email_data: { email_action_type: "signup", token: "48203917", token_hash: "abcdef0123456789" } };

describe("handleZaviSendEmailHook", () => {
  it("sends the sign-up code to the user and answers 200", async () => {
    const d = deps();
    const { body, headers } = signed(signup);
    const r = await handleZaviSendEmailHook(d, headers, body);
    expect(r.status).toBe(200);
    expect(d.sendSignupCode).toHaveBeenCalledWith("maya@bakery.com", "48203917");
  });

  it("refuses a bad signature without sending", async () => {
    const d = deps();
    const { body, headers } = signed(signup, "v1,whsec_" + Buffer.from("another-secret-0123456789abcdef").toString("base64"));
    const r = await handleZaviSendEmailHook(d, headers, body);
    expect(r.status).toBe(401);
    expect(d.sendSignupCode).not.toHaveBeenCalled();
  });

  it("refuses a stale timestamp", async () => {
    const d = deps({ now: () => NOW + 10 * 60 * 1000 });
    const { body, headers } = signed(signup);
    expect((await handleZaviSendEmailHook(d, headers, body)).status).toBe(401);
  });

  it("is closed until the secret is configured", async () => {
    const d = deps({ secret: undefined });
    const { body, headers } = signed(signup);
    expect((await handleZaviSendEmailHook(d, headers, body)).status).toBe(503);
    expect(d.sendSignupCode).not.toHaveBeenCalled();
  });

  it("rejects a sign-up payload without a numeric code", async () => {
    const d = deps();
    const { body, headers } = signed({ ...signup, email_data: { email_action_type: "signup", token: "<b>x</b>" } });
    expect((await handleZaviSendEmailHook(d, headers, body)).status).toBe(400);
  });

  it("sends a recovery link to Supabase's verify endpoint with the redirect", async () => {
    const d = deps();
    const { body, headers } = signed({
      user: { id: "u1", email: "maya@bakery.com" },
      email_data: { email_action_type: "recovery", token_hash: "pkce_abcdef0123", redirect_to: "https://www.zaviagent.com/auth/callback" },
    });
    const r = await handleZaviSendEmailHook(d, headers, body);
    expect(r.status).toBe(200);
    const url = new URL((d.sendRecoveryLink as any).mock.calls[0][1]);
    expect(url.origin + url.pathname).toBe("https://proj.supabase.co/auth/v1/verify");
    expect(url.searchParams.get("token")).toBe("pkce_abcdef0123");
    expect(url.searchParams.get("type")).toBe("recovery");
    expect(url.searchParams.get("redirect_to")).toBe("https://www.zaviagent.com/auth/callback");
  });

  it("email change with secure change on: token_hash to the NEW address, token_hash_new to the CURRENT one", async () => {
    const d = deps();
    const { body, headers } = signed({
      user: { id: "u1", email: "maya@bakery.com", new_email: "maya@newbakery.com" },
      email_data: { email_action_type: "email_change", token_hash: "hash_for_new_123", token_hash_new: "hash_for_current_456", redirect_to: "https://www.zaviagent.com/creator/profile" },
    });
    const r = await handleZaviSendEmailHook(d, headers, body);
    expect(r.status).toBe(200);
    const calls = (d.sendEmailChangeLink as any).mock.calls as [string, string, string, string][];
    expect(calls.map((c) => [c[0], new URL(c[1]).searchParams.get("token"), c[2]])).toEqual([
      ["maya@newbakery.com", "hash_for_new_123", "new"],
      ["maya@bakery.com", "hash_for_current_456", "current"],
    ]);
    expect(new URL(calls[0][1]).searchParams.get("type")).toBe("email_change");
  });

  it("email change with secure change off sends one email, to the new address", async () => {
    const d = deps();
    const { body, headers } = signed({
      user: { id: "u1", email: "maya@bakery.com", new_email: "maya@newbakery.com" },
      email_data: { email_action_type: "email_change", token_hash: "hash_for_new_123", token_hash_new: "" },
    });
    expect((await handleZaviSendEmailHook(d, headers, body)).status).toBe(200);
    expect((d.sendEmailChangeLink as any).mock.calls.map((c: string[]) => c[0])).toEqual(["maya@newbakery.com"]);
  });

  it("a dashboard reset with only the Site URL goes through /auth/callback to the reset form", async () => {
    const d = deps();
    const { body, headers } = signed({
      user: { id: "u1", email: "maya@bakery.com" },
      email_data: { email_action_type: "recovery", token_hash: "pkce_abcdef0123", redirect_to: "https://www.zaviagent.com/", site_url: "https://www.zaviagent.com" },
    });
    expect((await handleZaviSendEmailHook(d, headers, body)).status).toBe(200);
    const url = new URL((d.sendRecoveryLink as any).mock.calls[0][1]);
    expect(url.searchParams.get("redirect_to")).toBe("https://www.zaviagent.com/auth/callback?next=%2Freset-password");
  });

  it("refuses an action Zavi never triggers, and logs it", async () => {
    const d = deps();
    const { body, headers } = signed({ user: { id: "u1", email: "maya@bakery.com" }, email_data: { email_action_type: "invite", token_hash: "abcdef0123456789" } });
    const r = await handleZaviSendEmailHook(d, headers, body);
    expect(r.status).toBe(403);
    expect(d.sendSignupCode).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalled();
  });
});

describe("renderOtpEmail signup", () => {
  it("uses sign-up words and keeps the sign-in email unchanged", () => {
    const up = renderOtpEmail({ code: "48203917", purpose: "signup" });
    expect(up.subject).toBe("Your Zavi code is 48203917: confirm your email");
    expect(up.html).toContain("48203917");
    expect(up.text).toContain("sign-up screen");
    expect(renderOtpEmail({ code: "48203917" }).subject).toBe("Your Zavi sign-in code is 48203917");
  });
});
