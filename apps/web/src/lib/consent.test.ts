
import { describe, expect, it } from "vitest";
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_VERSION,
  allowsAnalytics,
  cookieAttributes,
  isAnalyticsStorageKey,
  parseConsent,
  serializeConsent,
} from "./consent";

const TS = "2026-09-21T10:00:00.000Z";
const yes = `${CONSENT_COOKIE}=${serializeConsent({ analytics: true }, TS)}`;
const no = `${CONSENT_COOKIE}=${serializeConsent({ analytics: false }, TS)}`;

describe("parseConsent", () => {
  it("is unset for an empty cookie string", () => {
    expect(parseConsent("")).toEqual({ status: "unset" });
  });

  it("round-trips a valid cookie, either way", () => {
    expect(parseConsent(yes)).toEqual({ status: "set", prefs: { analytics: true }, ts: TS });
    expect(parseConsent(no)).toEqual({ status: "set", prefs: { analytics: false }, ts: TS });
  });

  it("finds the cookie when it is not first, and ignores lookalike names", () => {
    const other = `sb-abc-auth-token=xyz; not_${CONSENT_COOKIE}=${encodeURIComponent(
      JSON.stringify({ v: CONSENT_VERSION, analytics: true, ts: TS }),
    )}; ${yes}; foo=bar`;
    expect(parseConsent(other).status).toBe("set");
    const lookalikeOnly = `not_${CONSENT_COOKIE}=${serializeConsent({ analytics: true }, TS)}`;
    expect(parseConsent(lookalikeOnly)).toEqual({ status: "unset" });
  });

  it("treats a previous version as unset — stale consent is no consent", () => {
    const stale = `${CONSENT_COOKIE}=${encodeURIComponent(
      JSON.stringify({ v: CONSENT_VERSION - 1, analytics: true, ts: TS }),
    )}`;
    expect(parseConsent(stale)).toEqual({ status: "unset" });
  });

  it("never throws on garbage", () => {
    for (const v of ["{", "%", "%E0%A4%A", "null", "1", '"str"', "{}", '{"v":1}']) {
      expect(parseConsent(`${CONSENT_COOKIE}=${v}`)).toEqual({ status: "unset" });
    }
  });

  it("rejects a value with the right version but the wrong shape", () => {
    const bad = `${CONSENT_COOKIE}=${encodeURIComponent(
      JSON.stringify({ v: CONSENT_VERSION, analytics: "yes", ts: TS }),
    )}`;
    expect(parseConsent(bad)).toEqual({ status: "unset" });
  });
});

describe("cookieAttributes", () => {
  it("shares the cookie across zaviagent.com subdomains, Secure over https", () => {
    for (const host of ["www.zaviagent.com", "zaviagent.com", "growth.zaviagent.com", "WWW.ZaviAgent.com"]) {
      const a = cookieAttributes(host, "https:");
      expect(a).toContain("; Domain=.zaviagent.com");
      expect(a).toContain("; Secure");
    }
  });

  it("is host-only on Amplify previews and localhost, and not Secure over http", () => {
    expect(cookieAttributes("main.d1234.amplifyapp.com", "https:")).not.toContain("Domain=");
    expect(cookieAttributes("main.d1234.amplifyapp.com", "https:")).toContain("; Secure");
    expect(cookieAttributes("localhost", "http:")).not.toContain("Domain=");
    expect(cookieAttributes("localhost", "http:")).not.toContain("Secure");
  });

  it("does not treat a lookalike domain as ours", () => {
    expect(cookieAttributes("zaviagent.com.evil.example", "https:")).not.toContain("Domain=");
    expect(cookieAttributes("notzaviagent.com", "https:")).not.toContain("Domain=");
  });

  it("always sets 180 days, Path=/ and SameSite=Lax", () => {
    const a = cookieAttributes("www.zaviagent.com", "https:");
    expect(CONSENT_MAX_AGE_SECONDS).toBe(180 * 86400);
    expect(a).toContain(`; Max-Age=${CONSENT_MAX_AGE_SECONDS}`);
    expect(a).toContain("; Path=/");
    expect(a).toContain("; SameSite=Lax");
  });
});

describe("isAnalyticsStorageKey — what the withdrawal purge may delete", () => {
  it("matches the SDK keys and our own dedupe keys", () => {
    for (const k of [
      "ph_phc_abc123_posthog",
      "__ph_opt_in_out_phc_abc123",
      "mp_abc123_mixpanel",
      "__mp_opt_in_out_abc123",
      "__mpced_abc",
      "mp_pv:/pricing",
      "mp_signup:user-id",
      "mp_login:user-id",
      "ph_pv:https://www.zaviagent.com/",
      "_ga",
      "_ga_ABC123XYZ",
      "_gid",
      "_gat_gtag_G_ABC123",
    ]) {
      expect(isAnalyticsStorageKey(k), k).toBe(true);
    }
  });

  it("does NOT match the session, the consent cookie, or any first-party key", () => {
    for (const k of [
      "zavi_consent_v1",
      "sb-wmycgyjsenvgtczlupoe-auth-token",
      "sb-wmycgyjsenvgtczlupoe-auth-token-code-verifier",
      "zavi:dark",
      "zavi:cookie-banner-dismissed",
      "praxis_pending_build",
      "praxis:connect-return",
      "__epv_run",
      "",
      "posthog",
      "amp_x",
      "_gallery",
    ]) {
      expect(isAnalyticsStorageKey(k), k).toBe(false);
    }
  });
});

describe("allowsAnalytics (opt-out)", () => {
  it("runs analytics when no choice is stored and no GPC is sent", () => {
    expect(allowsAnalytics(parseConsent(""))).toBe(true);
  });

  it("follows a stored choice", () => {
    expect(allowsAnalytics(parseConsent(yes))).toBe(true);
    expect(allowsAnalytics(parseConsent(no))).toBe(false);
  });
});

describe("parseConsent across a CONSENT_VERSION bump", () => {
  const old = (analytics: boolean) =>
    `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify({ v: CONSENT_VERSION - 1, analytics, ts: TS }))}`;
  it("re-asks someone who said yes under an older version", () => {
    expect(parseConsent(old(true))).toEqual({ status: "unset" });
  });
  it("keeps a no from an older version, so analytics stay off", () => {
    expect(parseConsent(old(false))).toEqual({ status: "set", prefs: { analytics: false }, ts: TS });
  });
});
