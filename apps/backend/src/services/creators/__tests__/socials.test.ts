
import { describe, it, expect } from "vitest";
import { parseSocial, socialUrl } from "@zavi/shared";
import { projectSocials, toSelfReportedAudience } from "../creator-fields";

const ok = (platform: string, input: string) => {
  const r = parseSocial(platform, input);
  if (!r.ok) throw new Error(`${platform} ${input}: ${r.message}`);
  return r.value;
};

describe("parseSocial", () => {
  it("reads a dotted handle like acme.com as a handle, not a wrong-platform link", () => {
    expect(ok("instagram", "acme.com").handle).toBe("acme.com");
    expect(ok("tiktok", "@acme.com").handle).toBe("acme.com");
    expect(ok("instagram", "instagram.com/acme.com").url).toBe("https://www.instagram.com/acme.com");
    expect(ok("instagram", "https://www.instagram.com/jules").handle).toBe("jules");
    expect(parseSocial("instagram", "instagram.com").ok).toBe(false);
  });

  it("accepts a bare handle, an @handle and a profile URL, and stores the bare handle", () => {
    for (const input of ["jules", "@jules", "tiktok.com/@jules", "https://www.tiktok.com/@jules?lang=en"]) {
      expect(ok("tiktok", input)).toEqual({
        platform: "tiktok",
        handle: "jules",
        url: "https://www.tiktok.com/@jules",
      });
    }
    expect(ok("instagram", "https://instagram.com/jules.makes/").url).toBe("https://www.instagram.com/jules.makes");
    expect(ok("youtube", "https://www.youtube.com/@JulesMakes").url).toBe("https://www.youtube.com/@JulesMakes");
    expect(ok("x", "https://twitter.com/jules_m").url).toBe("https://x.com/jules_m");
    expect(ok("linkedin", "https://www.linkedin.com/in/jules-makes").url).toBe("https://www.linkedin.com/in/jules-makes");
  });

  it("refuses javascript:, data: and other schemes", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "ftp://tiktok.com/@a"]) {
      expect(parseSocial("tiktok", bad).ok, bad).toBe(false);
    }
  });

  it("refuses another host, a look-alike host and credentials in the URL", () => {
    for (const bad of [
      "https://evil.example/@jules",
      "https://tiktok.com.evil.io/@jules",
      "https://nottiktok.com/@jules",
      "https://user:pw@tiktok.com/@jules",
      "https://tiktok.com:8443/@jules",
    ]) {
      expect(parseSocial("tiktok", bad).ok, bad).toBe(false);
    }
  });

  it("refuses handles with illegal characters and unknown platforms", () => {
    expect(parseSocial("tiktok", "<script>").ok).toBe(false);
    expect(parseSocial("x", "far_too_long_for_x_handle").ok).toBe(false);
    expect(parseSocial("instagram", "https://instagram.com/p/abc123").ok).toBe(false);
    expect(parseSocial("myspace", "jules").ok).toBe(false);
    expect(parseSocial("tiktok", "").ok).toBe(false);
  });

  it("socialUrl rebuilds from a stored handle, and refuses a tampered one", () => {
    expect(socialUrl("tiktok", "jules")).toBe("https://www.tiktok.com/@jules");
    expect(socialUrl("tiktok", "javascript:alert(1)")).toBeNull();
  });
});

describe("projectSocials (what a signed-in business receives)", () => {
  it("labels every follower count self-reported and never invents a number", () => {
    expect(
      projectSocials([
        { platform: "tiktok", handle: "jules", followers: 1200 },
        { platform: "instagram", handle: "jules", followers: null },
        { platform: "x", handle: "jules", followers: -5 },
        { platform: "", handle: "x" },
        "junk",
      ]),
    ).toEqual([
      { platform: "tiktok", handle: "jules", url: "https://www.tiktok.com/@jules", followers: 1200, label: "Self-reported, not checked by Zavi" },
      { platform: "instagram", handle: "jules", url: "https://www.instagram.com/jules", followers: null, label: "Self-reported, not checked by Zavi" },
      { platform: "x", handle: "jules", url: "https://x.com/jules", followers: null, label: "Self-reported, not checked by Zavi" },
    ]);
  });

  it("keeps the audience envelope from becoming a metric row", () => {
    expect(
      toSelfReportedAudience({
        self_reported: true,
        disclaimer: "Self-reported, not checked by Zavi",
        audience: [{ platform: "tiktok", followers: 12000 }],
      }),
    ).toEqual([{ label: "tiktok followers", value: "12000", self_reported: true }]);
  });
});

describe("follower cap (one number: zod, web form, DB CHECK)", () => {
  it("is 1,000,000,000", async () => {
    const { CREATOR_FOLLOWERS_MAX } = await import("@zavi/shared");
    expect(CREATOR_FOLLOWERS_MAX).toBe(1_000_000_000);
  });

  it("rejects an over-cap audience number in the schema", async () => {
    const { humanApplicationSchema } = await import("@/services/humans/contract");
    const base = {
      display_name: "jules",
      discipline: "ugc_creator",
      rate_usd: 100,
      rate_unit: "per_deliverable",
      handles: [{ platform: "tiktok", handle: "jules" }],
      email: "j@example.com",
    };
    expect(humanApplicationSchema.safeParse({ ...base, audience: [{ platform: "tiktok", followers: 1_000_000_000 }] }).success).toBe(true);
    expect(humanApplicationSchema.safeParse({ ...base, audience: [{ platform: "tiktok", followers: 5_000_000_000 }] }).success).toBe(false);
  });
});
