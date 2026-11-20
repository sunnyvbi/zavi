import { describe, it, expect, afterEach, vi } from "vitest";
import { isAllowedResetRedirect } from "../send-reset";

const CB = "/auth/callback?next=%2Freset-password";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAllowedResetRedirect", () => {
  it("allows Zavi apex + subdomains on the callback path", () => {
    expect(isAllowedResetRedirect(`https://www.zaviagent.com${CB}`)).toBe(true);
    expect(isAllowedResetRedirect(`https://zaviagent.com${CB}`)).toBe(true);
    expect(isAllowedResetRedirect("https://app.zaviagent.com/auth/callback")).toBe(true);
  });

  it("allows localhost for dev (http ok)", () => {
    expect(isAllowedResetRedirect(`http://localhost:3000${CB}`)).toBe(true);
    expect(isAllowedResetRedirect(`http://localhost:3010${CB}`)).toBe(true);
    expect(isAllowedResetRedirect(`http://127.0.0.1:3010${CB}`)).toBe(true);
  });

  it("refuses localhost on a production backend, so a real user is never emailed one", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAllowedResetRedirect(`http://localhost:3010${CB}`)).toBe(false);
    expect(isAllowedResetRedirect(`https://localhost:3010${CB}`)).toBe(false);
    expect(isAllowedResetRedirect(`http://127.0.0.1:3010${CB}`)).toBe(false);
    expect(isAllowedResetRedirect(`https://www.zaviagent.com${CB}`)).toBe(true);
  });

  it("requires https for Zavi hosts (rejects plaintext http — MITM on reset flow)", () => {
    expect(isAllowedResetRedirect(`http://zaviagent.com${CB}`)).toBe(false);
    expect(isAllowedResetRedirect(`http://www.zaviagent.com${CB}`)).toBe(false);
  });

  it("rejects attacker hosts (incl. lookalike + suffix tricks)", () => {
    expect(isAllowedResetRedirect(`https://evil.com${CB}`)).toBe(false);
    expect(isAllowedResetRedirect(`https://zaviagent.com.evil.com${CB}`)).toBe(false);
    expect(isAllowedResetRedirect(`https://notzaviagent.com${CB}`)).toBe(false);
    expect(isAllowedResetRedirect(`https://zaviagent.evil.com${CB}`)).toBe(false);
  });

  it("rejects non-http(s) + garbage", () => {
    expect(isAllowedResetRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedResetRedirect("ftp://zaviagent.com/auth/callback")).toBe(false);
    expect(isAllowedResetRedirect("not a url")).toBe(false);
    expect(isAllowedResetRedirect("")).toBe(false);
  });

  it("parks the token nowhere but the callback — an analytics-tracked page is refused", () => {
    expect(isAllowedResetRedirect("https://zaviagent.com/login")).toBe(false);
    expect(isAllowedResetRedirect("https://www.zaviagent.com/")).toBe(false);
    expect(isAllowedResetRedirect("https://www.zaviagent.com/pricing")).toBe(false);
    expect(isAllowedResetRedirect("https://www.zaviagent.com/auth/callback/../login")).toBe(false);
  });

  it("refuses a redirect carrying any query param other than next", () => {
    expect(isAllowedResetRedirect("https://www.zaviagent.com/auth/callback?x=1")).toBe(false);
    expect(
      isAllowedResetRedirect("https://www.zaviagent.com/auth/callback?next=%2Fa&utm=b"),
    ).toBe(false);
    expect(
      isAllowedResetRedirect("https://www.zaviagent.com/auth/callback?token_hash=abc"),
    ).toBe(false);
  });

  it("refuses a next that would bounce the authenticated user off-origin", () => {
    expect(
      isAllowedResetRedirect("https://www.zaviagent.com/auth/callback?next=https%3A%2F%2Fevil.com"),
    ).toBe(false);
    expect(
      isAllowedResetRedirect("https://www.zaviagent.com/auth/callback?next=%2F%2Fevil.com"),
    ).toBe(false);
    expect(
      isAllowedResetRedirect("https://www.zaviagent.com/auth/callback?next=%2F%5Cevil.com"),
    ).toBe(false);
  });

  it("refuses a fragment, which the emailed link has no reason to carry", () => {
    expect(isAllowedResetRedirect(`https://www.zaviagent.com${CB}#access_token=x`)).toBe(false);
  });
});
