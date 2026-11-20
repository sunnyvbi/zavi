// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ consent: true, posts: [] as string[] }));
vi.mock("@/lib/consent", () => ({ hasAnalyticsConsent: () => H.consent }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (_p: string, init: { body: string }) => {
    H.posts.push(init.body);
    return { json: async () => ({ click_id: "0f0e3a3c-1d2b-4a5e-8f9a-0b1c2d3e4f50" }) };
  }),
}));
import { AFFILIATE_KEY, affiliateClick, captureAffiliateClick, viaCode, withAffiliateClick, withoutVia } from "./affiliate";

beforeEach(() => {
  window.localStorage.clear();
  H.consent = true;
  H.posts = [];
});

describe("affiliate link capture", () => {
  it("reads only a well-formed code and strips it from the URL", () => {
    expect(viaCode("https://www.zaviagent.com/pricing?via=AbCd2345")).toBe("abcd2345");
    expect(viaCode("https://www.zaviagent.com/?via=bad")).toBeNull();
    expect(viaCode("https://www.zaviagent.com/?via=abcd234l")).toBeNull();
    expect(withoutVia("https://www.zaviagent.com/pricing?via=abcd2345&utm_source=x#plans")).toBe("/pricing?utm_source=x#plans");
  });
  it("records the click under consent and keeps the backend's id; the URL is cleaned", async () => {
    window.history.replaceState(null, "", "/pricing?via=abcd2345");
    await captureAffiliateClick();
    expect(H.posts).toEqual([JSON.stringify({ code: "abcd2345" })]);
    expect(affiliateClick()).toBe("0f0e3a3c-1d2b-4a5e-8f9a-0b1c2d3e4f50");
    expect(window.location.search).toBe("");
    expect(withAffiliateClick({ tier: "starter" })).toEqual({ tier: "starter", affiliate_click: "0f0e3a3c-1d2b-4a5e-8f9a-0b1c2d3e4f50" });
  });
  it("without consent nothing is stored or sent, and the code stays in the URL for later", async () => {
    H.consent = false;
    window.history.replaceState(null, "", "/?via=abcd2345");
    await captureAffiliateClick();
    expect(H.posts).toEqual([]);
    expect(affiliateClick()).toBeNull();
    expect(window.location.search).toBe("?via=abcd2345");
  });
  it("a stored click is not sent once consent is withdrawn", () => {
    window.localStorage.setItem(AFFILIATE_KEY, JSON.stringify({ click_id: "x", at: Date.now() }));
    H.consent = false;
    expect(affiliateClick()).toBeNull();
  });
  it("a click older than 60 days is not sent", () => {
    window.localStorage.setItem(AFFILIATE_KEY, JSON.stringify({ click_id: "x", at: Date.now() - 61 * 86_400_000 }));
    expect(affiliateClick()).toBeNull();
    expect(withAffiliateClick({ a: 1 })).toEqual({ a: 1 });
  });
});
