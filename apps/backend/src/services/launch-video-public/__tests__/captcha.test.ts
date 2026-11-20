import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyTurnstile, turnstileSiteKey } from "../captcha";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = "sk-test";
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const fetchOk = (body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => body } as unknown as Response),
  );

describe("verifyTurnstile", () => {
  it("passes a token Cloudflare accepts", async () => {
    fetchOk({ success: true });
    expect(await verifyTurnstile({ token: "t", ip: "1.2.3.4" })).toEqual({ ok: true });
  });

  it("refuses a token Cloudflare rejects", async () => {
    fetchOk({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyTurnstile({ token: "t", ip: null })).toEqual({ ok: false, reason: "rejected" });
  });

  it("refuses a missing token without calling Cloudflare", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await verifyTurnstile({ token: null, ip: null })).toEqual({ ok: false, reason: "missing_token" });
    expect(f).not.toHaveBeenCalled();
  });

  it("REFUSES when enabled without a secret, rather than waving traffic through", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await verifyTurnstile({ token: "t", ip: null })).toEqual({ ok: false, reason: "misconfigured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("treats a blank secret as missing, not as a secret", async () => {
    process.env.TURNSTILE_SECRET_KEY = "   ";
    expect(await verifyTurnstile({ token: "t", ip: null })).toEqual({ ok: false, reason: "misconfigured" });
  });

  it("FAILS CLOSED when Cloudflare is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect(await verifyTurnstile({ token: "t", ip: null })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("FAILS CLOSED on a non-2xx from siteverify", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response));
    expect(await verifyTurnstile({ token: "t", ip: null })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("sends the secret and token, and omits remoteip when there is no IP", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) } as unknown as Response);
    vi.stubGlobal("fetch", f);
    await verifyTurnstile({ token: "tok", ip: null });
    const body = f.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("secret")).toBe("sk-test");
    expect(body.get("response")).toBe("tok");
    expect(body.has("remoteip")).toBe(false);
  });

  it("includes remoteip when an IP is known", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) } as unknown as Response);
    vi.stubGlobal("fetch", f);
    await verifyTurnstile({ token: "tok", ip: "9.9.9.9" });
    expect((f.mock.calls[0][1].body as URLSearchParams).get("remoteip")).toBe("9.9.9.9");
  });
});

describe("turnstileSiteKey", () => {
  it("returns null when unset or blank, so the page never renders a keyless widget", () => {
    delete process.env.TURNSTILE_SITE_KEY;
    expect(turnstileSiteKey()).toBeNull();
    process.env.TURNSTILE_SITE_KEY = "  ";
    expect(turnstileSiteKey()).toBeNull();
  });

  it("returns the trimmed key when set", () => {
    process.env.TURNSTILE_SITE_KEY = " 0x4AAA ";
    expect(turnstileSiteKey()).toBe("0x4AAA");
  });
});
