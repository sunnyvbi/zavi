
import { describe, it, expect } from "vitest";
import {
  CREATOR_LANES,
  RESERVED_CREATOR_SLUGS,
  creatorSlugBase,
  creatorSlugCandidate,
  SELF_REPORTED_LABEL,
  ageInYears,
  buildSelfReportedMetrics,
  businessPaysCents,
  checkCreatorDob,
  checkCreatorPackage,
  checkCreatorSlug,
  creatorFeeCents,
  creatorReceivesCents,
  isOwnMediaPath,
  normalizeCreatorSlug,
  packageFeeLine,
  parseUsdToCents,
  readSelfReportedMetrics,
} from "@zavi/shared";
import {
  OPEN_LANES,
  assertOwnMedia,
  humanApplicationSchema,
  type HumanApplicationInput,
} from "../contract";

const USER = "11111111-0000-4000-8000-000000000011";

function base(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    display_name: "julesmakes",
    discipline: "ugc_creator",
    skills: ["home"],
    rate_usd: 150,
    rate_unit: "per_deliverable",
    handles: [{ platform: "tiktok", handle: "julesmakes" }],
    portfolio_urls: [],
    screenshots: [],
    email: "jules@example.com",
    ...over,
  };
}

function creatorSignup(over: Partial<Record<string, unknown>> = {}): HumanApplicationInput {
  const parsed = humanApplicationSchema.safeParse(
    base({
      lanes: ["ugc_video"],
      date_of_birth: "1996-04-02",
      country_code: "US",
      city: "Austin",
      bio: "I make short before/after home clips for brands.",
      intro_video_path: `${USER}/intro.mp4`,
      sample_video_paths: [`${USER}/a.mp4`],
      packages: [
        {
          kind: "ugc_video",
          title: "One 30s ad video",
          price_cents: 15_000,
          delivery_days: 7,
          video_count: 1,
          video_length_seconds: 30,
          ad_rights_days: 90,
          addons: [],
        },
      ],
      ...over,
    }),
  );
  if (!parsed.success) throw new Error(`fixture invalid: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

describe("the creator slug (server-generated since 2026-09-25)", () => {
  it("still reserves the names a slug must never be", () => {
    for (const s of ["zavi", "zaviagent", "www", "settings", "admin", "billing", "stripe", "webhooks"]) {
      expect(RESERVED_CREATOR_SLUGS.has(s), `'${s}' is claimable`).toBe(true);
    }
  });

  it("builds a valid base from any display name", () => {
    expect(creatorSlugBase("Jules Makes!")).toBe("jules-makes");
    expect(creatorSlugBase("Zoë  Bäcker")).toBe("zoe-backer");
    expect(creatorSlugBase("李")).toBe("new-creator");
    expect(creatorSlugBase("ab")).toBe("new-creator");
    expect(creatorSlugBase("Admin")).toBe("new-creator");
    const long = creatorSlugBase("a".repeat(80));
    expect(long.length).toBeLessThanOrEqual(34);
    for (const name of ["Jules Makes!", "x".repeat(80), "--a--b--", "李", "Ünïcödé Ñame 99"]) {
      const b = creatorSlugBase(name);
      expect(checkCreatorSlug(b).ok, `'${b}' from '${name}'`).toBe(true);
      expect(checkCreatorSlug(creatorSlugCandidate(b, 99999)).ok).toBe(true);
    }
  });

  it("adds a numeric suffix after the first", () => {
    expect(creatorSlugCandidate("jules", 1)).toBe("jules");
    expect(creatorSlugCandidate("jules", 2)).toBe("jules-2");
  });

  it("strips a client-sent slug from the application schema (the server names the creator)", () => {
    const parsed = humanApplicationSchema.parse(base({ slug: "workspace" }));
    expect(parsed).not.toHaveProperty("slug");
  });

  it("blocks the four the build brief names explicitly", () => {
    for (const s of ["api", "admin", "creator", "c"]) {
      expect(RESERVED_CREATOR_SLUGS.has(s)).toBe(true);
    }
    for (const s of ["api", "admin", "creator", "workspace", "humans", "login"]) {
      const r = checkCreatorSlug(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("slug_reserved");
    }
  });

  it("normalizes a pasted link or an @handle to the bare name", () => {
    expect(normalizeCreatorSlug("  /JulesMakes  ")).toBe("julesmakes");
    expect(normalizeCreatorSlug("@julesmakes")).toBe("julesmakes");
  });

  it("matches the DB CHECK exactly: 3-40 chars, lowercase, no edge - or _", () => {
    expect(checkCreatorSlug("ab").ok).toBe(false);
    expect(checkCreatorSlug("a".repeat(41)).ok).toBe(false);
    expect(checkCreatorSlug("-jules").ok).toBe(false);
    expect(checkCreatorSlug("jules-").ok).toBe(false);
    expect(checkCreatorSlug("jules makes").ok).toBe(false);
    expect(checkCreatorSlug("jules.makes").ok).toBe(false);
    expect(checkCreatorSlug("JulesMakes").ok).toBe(true);
    expect(checkCreatorSlug("jules_makes-1").ok).toBe(true);
    expect(checkCreatorSlug("a".repeat(40)).ok).toBe(true);
  });

});

describe("18+ (spec item 27)", () => {
  it("refuses someone a day short of 18 and accepts them on the day", () => {
    expect(checkCreatorDob("2008-06-02", "2026-06-01").ok).toBe(false);
    expect(checkCreatorDob("2008-06-01", "2026-06-01").ok).toBe(true);
    const under = checkCreatorDob("2010-01-01", "2026-09-11");
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.code).toBe("under_18");
  });

  it("computes age on calendar dates, with no timezone in the answer", () => {
    expect(ageInYears("1996-04-02", "2026-04-01")).toBe(29);
    expect(ageInYears("1996-04-02", "2026-04-02")).toBe(30);
  });

  it("refuses a date that is not a date, and one in the future", () => {
    expect(checkCreatorDob("2026-02-31", "2026-09-11").ok).toBe(false);
    expect(checkCreatorDob("not-a-date", "2026-09-11").ok).toBe(false);
    expect(checkCreatorDob("2030-01-01", "2026-09-11").ok).toBe(false);
    expect(checkCreatorDob("", "2026-09-11").ok).toBe(false);
  });

  it("is enforced by the application schema, so no route can forget it", () => {
    const tooYoung = humanApplicationSchema.safeParse(base({ date_of_birth: "2012-01-01" }));
    expect(tooYoung.success).toBe(false);
  });

  it("lets ANY country join (spec item 27)", () => {
    for (const cc of ["US", "IN", "NG", "BR", "PH", "VN"]) {
      const parsed = humanApplicationSchema.safeParse(base({ country_code: cc }));
      expect(parsed.success, cc).toBe(true);
    }
    expect(humanApplicationSchema.safeParse(base({ country_code: "USA" })).success).toBe(false);
  });
});

const UGC_PACKAGE = {
  kind: "ugc_video",
  title: "One 30s ad video",
  price_cents: 15_000,
  delivery_days: 7,
  video_count: 1,
  video_length_seconds: 30,
  ad_rights_days: 90,
};

const AUDIENCE_PACKAGE = {
  kind: "audience_post",
  title: "One reel to my audience",
  price_cents: 40_000,
  delivery_days: 5,
  platform: "instagram",
  post_type: "Reel",
  stays_up_days: 30,
  post_count: 1,
  ad_label_required: true,
};

describe("lanes — only the UGC video lane exists", () => {
  it("has exactly one lane, and the audience post lane is not open", () => {
    expect([...CREATOR_LANES]).toEqual(["ugc_video"]);
    expect([...OPEN_LANES]).toEqual(["ugc_video"]);
    expect(OPEN_LANES.has("audience_post" as never)).toBe(false);
  });

  it("refuses a signup that picks the audience post lane, alone or next to UGC", () => {
    for (const lanes of [["audience_post"], ["ugc_video", "audience_post"], ["audience_post", "ugc_video"]]) {
      const parsed = humanApplicationSchema.safeParse(base({ lanes, packages: [UGC_PACKAGE] }));
      expect(parsed.success, lanes.join(",")).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === "lanes")).toBe(true);
      }
    }
    expect(humanApplicationSchema.safeParse(base({ lanes: ["ugc_video"], packages: [UGC_PACKAGE] })).success).toBe(true);
  });

  it("refuses an audience post package at signup even inside an otherwise valid UGC signup", () => {
    const parsed = humanApplicationSchema.safeParse(
      base({ lanes: ["ugc_video"], packages: [UGC_PACKAGE, AUDIENCE_PACKAGE] }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path)).toEqual([["packages", 1, "kind"]]);
    }
  });
});

describe("media paths — creator A cannot publish creator B's video", () => {
  it("accepts only a path under the submitter's own prefix", () => {
    expect(isOwnMediaPath(`${USER}/a.mp4`, USER)).toBe(true);
    expect(isOwnMediaPath("someone-else/a.mp4", USER)).toBe(false);
    expect(isOwnMediaPath(`${USER}/../other/a.mp4`, USER)).toBe(false);
    expect(isOwnMediaPath(`/${USER}/a.mp4`, USER)).toBe(false);
    expect(isOwnMediaPath(`${USER}/`, USER)).toBe(false);
    expect(isOwnMediaPath(`${USER}/%2e%2e/other/a.mp4`, USER)).toBe(false);
    expect(isOwnMediaPath(`${USER}/%2E%2E/%2e%2e/other-bucket/a.mp4`, USER)).toBe(false);
    expect(isOwnMediaPath(`${USER}/sub/a.mp4`, USER)).toBe(false);
    expect(isOwnMediaPath(`${USER}/a.mp4?x=1`, USER)).toBe(false);
  });

  it("throws on a foreign path at the write path, not just when minting a URL", () => {
    const input = creatorSignup({ intro_video_path: "22222222-0000-4000-8000-000000000022/intro.mp4" });
    expect(() => assertOwnMedia(input, USER)).toThrow(/not one you uploaded/);
    const samples = creatorSignup({ sample_video_paths: ["someone-else/a.mp4"] });
    expect(() => assertOwnMedia(samples, USER)).toThrow(/not one you uploaded/);
    expect(() => assertOwnMedia(creatorSignup(), USER)).not.toThrow();
  });
});

describe("package templates (spec item 10)", () => {
  it("accepts a complete ad-video package with priced add-ons", () => {
    const r = checkCreatorPackage({
      kind: "ugc_video",
      title: "Three 30s ad videos",
      price_cents: 45_000,
      delivery_days: 10,
      video_count: 3,
      video_length_seconds: 30,
      ad_rights_days: 365,
      addons: [{ code: "raw_footage", price_cents: 5_000 }],
    });
    expect(r.ok).toBe(true);
  });

  it("requires ad rights to be one of 30 / 90 / 365 days", () => {
    for (const days of [30, 90, 365]) {
      expect(
        checkCreatorPackage({
          kind: "ugc_video", title: "x", price_cents: 100, delivery_days: 7,
          video_count: 1, video_length_seconds: 30, ad_rights_days: days,
        }).ok,
      ).toBe(true);
    }
    const bad = checkCreatorPackage({
      kind: "ugc_video", title: "x", price_cents: 100, delivery_days: 7,
      video_count: 1, video_length_seconds: 30, ad_rights_days: 45,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("ad_rights_days");
  });

  it("refuses an unknown add-on code and a duplicate one", () => {
    const unknown = checkCreatorPackage({
      kind: "ugc_video", title: "x", price_cents: 100, delivery_days: 7,
      video_count: 1, video_length_seconds: 30, ad_rights_days: 30,
      addons: [{ code: "free_reshoots", price_cents: 100 }],
    });
    expect(unknown.ok).toBe(false);
    const dupe = checkCreatorPackage({
      kind: "ugc_video", title: "x", price_cents: 100, delivery_days: 7,
      video_count: 1, video_length_seconds: 30, ad_rights_days: 30,
      addons: [{ code: "raw_footage", price_cents: 100 }, { code: "raw_footage", price_cents: 200 }],
    });
    expect(dupe.ok).toBe(false);
  });

  it("refuses the audience post template by kind, whatever else the payload carries", () => {
    for (const raw of [
      AUDIENCE_PACKAGE,
      { ...UGC_PACKAGE, kind: "audience_post" },
      { ...UGC_PACKAGE, ...AUDIENCE_PACKAGE },
      { ...AUDIENCE_PACKAGE, kind: " audience_post " },
      { ...AUDIENCE_PACKAGE, kind: "AUDIENCE_POST" },
      { ...UGC_PACKAGE, kind: "influencer" },
      { ...UGC_PACKAGE, kind: undefined },
    ]) {
      const r = checkCreatorPackage(raw);
      expect(r.ok, JSON.stringify(raw.kind)).toBe(false);
      if (!r.ok) expect(r.field).toBe("kind");
    }
  });

  it("never returns an audience post field on an accepted UGC package", () => {
    const r = checkCreatorPackage({ ...AUDIENCE_PACKAGE, ...UGC_PACKAGE });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe("ugc_video");
      for (const k of ["platform", "post_type", "stays_up_days", "post_count", "ad_label_required"]) {
        expect(k in r.value, k).toBe(false);
      }
    }
  });

  it("refuses a free package and one past the DB's ceiling", () => {
    expect(checkCreatorPackage({ kind: "ugc_video", title: "x", price_cents: 0, delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 30 }).ok).toBe(false);
    expect(checkCreatorPackage({ kind: "ugc_video", title: "x", price_cents: 10_000_001, delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 30 }).ok).toBe(false);
  });

  it("refuses delivery days outside the DB CHECK (1..90)", () => {
    for (const days of [0, 91]) {
      expect(checkCreatorPackage({ kind: "ugc_video", title: "x", price_cents: 100, delivery_days: days, video_count: 1, video_length_seconds: 30, ad_rights_days: 30 }).ok).toBe(false);
    }
  });

  it("names the offending package INDEX when the schema validates a list", () => {
    const parsed = humanApplicationSchema.safeParse(
      base({
        packages: [
          { kind: "ugc_video", title: "ok", price_cents: 100, delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 30 },
          { kind: "ugc_video", title: "bad", price_cents: 100, delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 45 },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(["packages", 1, "ad_rights_days"]);
    }
  });
});

describe("the fee shown equals the fee charged (invariant 8)", () => {
  it("matches the spec's worked example exactly", () => {
    expect(creatorFeeCents(15_000)).toBe(2_250);
    expect(creatorReceivesCents(15_000)).toBe(12_750);
    expect(businessPaysCents(15_000)).toBe(16_500);
  });

  it("is one function, so the display line cannot drift from the charge", () => {
    for (const cents of [1, 99, 333, 15_000, 149_999, 10_000_000]) {
      const line = packageFeeLine(cents);
      expect(line.creator_fee_cents).toBe(creatorFeeCents(cents));
      expect(line.creator_receives_cents).toBe(creatorReceivesCents(cents));
      expect(line.creator_fee_cents + line.creator_receives_cents).toBe(cents);
    }
  });

  it("works in integer cents from a typed dollar amount, with no float drift", () => {
    expect(parseUsdToCents("150")).toBe(15_000);
    expect(parseUsdToCents("$1,499.99")).toBe(149_999);
    expect(parseUsdToCents("0.07")).toBe(7);
    expect(parseUsdToCents("abc")).toBeNull();
    expect(parseUsdToCents("1.234")).toBeNull();
  });
});

describe("audience numbers are always labelled self-reported (invariant 3)", () => {
  it("cannot be stored as a bare number — the label is part of the shape", () => {
    const metrics = buildSelfReportedMetrics([{ platform: "tiktok", followers: 12_000 }]);
    expect(metrics.self_reported).toBe(true);
    expect(metrics.disclaimer).toBe(SELF_REPORTED_LABEL);
    for (const entry of metrics.audience) expect(entry.self_reported).toBe(true);
  });

  it("re-labels a row written before the shape existed", () => {
    const legacy = readSelfReportedMetrics({ audience: [{ platform: "tiktok", followers: "12000" }] });
    expect(legacy.disclaimer).toBe(SELF_REPORTED_LABEL);
    expect(legacy.audience[0]).toEqual({ platform: "tiktok", followers: 12_000, self_reported: true });
  });

  it("never says verified or checked", () => {
    const rendered = JSON.stringify(buildSelfReportedMetrics([{ platform: "x", followers: 1 }])).toLowerCase();
    expect(rendered).toContain("self-reported");
    expect(rendered).not.toContain("verified");
    expect(rendered).not.toMatch(/"checked"\s*:\s*true/);
  });
});

describe("no shipping, anywhere (spec item 22)", () => {
  it("has no address field in the application schema", () => {
    const keys = Object.keys(humanApplicationSchema.shape).join(" ").toLowerCase();
    for (const banned of ["address", "shipping", "postal", "zip", "tracking"]) {
      expect(keys, `schema must not carry a ${banned} field`).not.toContain(banned);
    }
    expect(keys).toContain("city");
    expect(keys).toContain("country_code");
  });

  it("drops an address a caller tries to smuggle in", () => {
    const parsed = humanApplicationSchema.parse(base({ shipping_address: "1 Main St" }));
    expect(JSON.stringify(parsed)).not.toContain("1 Main St");
  });
});

describe("social handles at signup", () => {
  it("stores the bare handle when a creator pastes a profile URL", () => {
    const input = creatorSignup({
      handles: [{ platform: "tiktok", handle: "https://www.tiktok.com/@julesmakes?lang=en", followers: 1200 }],
    });
    expect(input.handles[0]).toMatchObject({ platform: "tiktok", handle: "julesmakes", followers: 1200 });
  });

  it("refuses a javascript: link or another site's URL", () => {
    for (const bad of ["javascript:alert(1)", "https://evil.example/@julesmakes", "tiktok.com.evil.io/@x"]) {
      const parsed = humanApplicationSchema.safeParse(base({ handles: [{ platform: "tiktok", handle: bad }] }));
      expect(parsed.success, bad).toBe(false);
    }
  });

  it("refuses a negative or absurd follower count", () => {
    for (const followers of [-1, 2_000_000_000, 1.5]) {
      const parsed = humanApplicationSchema.safeParse(
        base({ handles: [{ platform: "tiktok", handle: "julesmakes", followers }] }),
      );
      expect(parsed.success, String(followers)).toBe(false);
    }
  });
});
