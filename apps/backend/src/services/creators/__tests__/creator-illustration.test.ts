import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ globalClient: () => ({}), humanApplicantStorage: () => ({}) }));
vi.mock("@/services/media-router/router", () => ({ generateMedia: vi.fn(), downloadMedia: vi.fn(), isMediaRouterEnabled: vi.fn() }));

import {
  buildIllustrationPrompt,
  claimIllustration,
  RETRY_AFTER_MS,
  type ClaimTable,
  generateCreatorIllustration,
  nicheLabelsFrom,
  realIllustrationDeps,
  styleSeed,
  type IllustrationDeps,
  type IllustrationMember,
} from "../creator-illustration";

const ID = "33333333-0000-4000-8000-000000000033";
const AUTH = "44444444-0000-4000-8000-000000000044";

function member(over: Partial<IllustrationMember> = {}): IllustrationMember {
  return {
    id: ID,
    auth_user_id: AUTH,
    skills: ["Food and drink", "Travel"],
    vetting_state: "approved",
    photo_path: null,
    illustration_path: null,
    illustration_generated_at: null,
    ...over,
  };
}

function deps(m: IllustrationMember | null = member(), over: Partial<IllustrationDeps> = {}) {
  const d = {
    falKeyPresent: vi.fn(() => true),
    routerEnabled: vi.fn(async () => true),
    loadMember: vi.fn(async () => m),
    claim: vi.fn(async () => true),
    generate: vi.fn(async () => ({
      ok: true as const,
      url: "https://fal.media/x.png",
      mime: "image/png",
      vendor: "fal" as const,
      model: "seedream",
      cost_usd: 0.0675,
    })),
    download: vi.fn(async () => new Uint8Array([1, 2, 3])),
    upload: vi.fn(async () => "media/0b8f5c1e-1111-4111-8111-111111111111.png"),
    save: vi.fn(async () => true),
    log: vi.fn(),
    ...over,
  };
  return d;
}

describe("generateCreatorIllustration", () => {
  it("generates, stores under the creator's own prefix, and records the key once", async () => {
    const d = deps();
    const r = await generateCreatorIllustration(ID, d);
    expect(r).toEqual({ outcome: "generated", cost_usd: 0.0675 });
    expect(d.claim).toHaveBeenCalledWith(ID, { retryFailed: false, now: expect.any(Date) });
    expect(vi.mocked(d.claim).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.generate).mock.invocationCallOrder[0]);
    expect(d.upload).toHaveBeenCalledWith(AUTH, expect.any(Uint8Array), "image/png");
    const saved = vi.mocked(d.save).mock.calls[0][1];
    expect(saved).not.toContain(AUTH);
    expect(saved).not.toContain(ID);
  });

  it("skips a creator who has a photo, without claiming or calling the vendor", async () => {
    const d = deps(member({ photo_path: `${AUTH}/p.jpg` }));
    expect((await generateCreatorIllustration(ID, d)).outcome).toBe("has_photo");
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("skips a creator who already has one, or whose one attempt was already claimed", async () => {
    for (const m of [member({ illustration_path: `${AUTH}/i.png` }), member({ illustration_generated_at: "2026-09-28T00:00:00Z" })]) {
      const d = deps(m);
      expect((await generateCreatorIllustration(ID, d)).outcome).toBe("already_generated");
      expect(d.generate).not.toHaveBeenCalled();
    }
  });

  it("a lost claim (a racing worker got it) never calls the vendor", async () => {
    const d = deps(member(), { claim: vi.fn(async () => false) });
    expect((await generateCreatorIllustration(ID, d)).outcome).toBe("claim_lost");
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("no FAL_KEY: no generation and no claim burned, and it logs", async () => {
    const d = deps(member(), { falKeyPresent: vi.fn(() => false) });
    expect((await generateCreatorIllustration(ID, d)).outcome).toBe("no_fal_key");
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalled();
  });

  it("the real FAL_KEY check reads the env", () => {
    const prev = process.env.FAL_KEY;
    try {
      delete process.env.FAL_KEY;
      expect(realIllustrationDeps.falKeyPresent()).toBe(false);
      process.env.FAL_KEY = "  ";
      expect(realIllustrationDeps.falKeyPresent()).toBe(false);
      process.env.FAL_KEY = "k";
      expect(realIllustrationDeps.falKeyPresent()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = prev;
    }
  });

  it("media router switched off: no vendor call and the one attempt is not consumed", async () => {
    const d = deps(member(), { routerEnabled: vi.fn(async () => false) });
    expect((await generateCreatorIllustration(ID, d)).outcome).toBe("router_disabled");
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("skips a creator who is not live", async () => {
    const d = deps(member({ vetting_state: "pending" }));
    expect((await generateCreatorIllustration(ID, d)).outcome).toBe("not_live");
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("a vendor failure leaves the claim in place (no automatic second attempt)", async () => {
    const d = deps(member(), {
      generate: vi.fn(async () => ({ ok: false as const, reason: "vendor_error" as const, error: "500" })),
    });
    expect((await generateCreatorIllustration(ID, d)).outcome).toBe("vendor_failed");
    expect(d.save).not.toHaveBeenCalled();
  });

  it("the backfill may retry a failed attempt; the event path may not", async () => {
    const m = member({ illustration_generated_at: "2026-09-28T00:00:00Z" });
    const d = deps(m);
    expect((await generateCreatorIllustration(ID, d, { retryFailed: true })).outcome).toBe("generated");
    expect(d.claim).toHaveBeenCalledWith(ID, { retryFailed: true, now: expect.any(Date) });
  });
});

describe("buildIllustrationPrompt", () => {
  const PII = {
    display_name: "Maya Rodriguez",
    bio: "I film cozy morning routines in my Austin apartment",
    handle: "@mayafilms",
    city: "Austin",
  };

  it("uses the niche labels and says no people, no faces, no hands, no text", () => {
    const p = buildIllustrationPrompt(ID, ["Food and drink", "Travel"]);
    expect(p).toContain("food and drink");
    expect(p).toContain("travel");
    expect(p).toMatch(/No people/);
    expect(p).toMatch(/no faces/);
    expect(p).toMatch(/no hands/);
    expect(p).toMatch(/no text/);
  });

  it("carries nothing about the creator beyond niche labels, even if skills hold junk", () => {
    const p = buildIllustrationPrompt(ID, ["Beauty", PII.display_name, PII.bio, PII.handle, PII.city]);
    expect(p).toContain("beauty");
    for (const v of Object.values(PII)) expect(p.toLowerCase()).not.toContain(v.toLowerCase());
  });

  it("only allowed niche labels survive", () => {
    expect(nicheLabelsFrom(["beauty", "Beauty", "Crypto", "TECH"])).toEqual(["Beauty", "Tech"]);
  });

  it("the style seed is stable per member and varies across members", () => {
    expect(styleSeed(ID)).toBe(styleSeed(ID));
    const seeds = new Set(Array.from({ length: 40 }, (_, i) => styleSeed(`member-${i}`)));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

function fakeTable(row: Record<string, unknown>): ClaimTable {
  return {
    update(values) {
      const conds: Array<(r: Record<string, unknown>) => boolean> = [];
      const q = {
        eq: (c: string, v: unknown) => (conds.push((r) => r[c] === v), q),
        is: (c: string, _v: null) => (conds.push((r) => r[c] == null), q),
        or: (f: string) => {
          const cutoff = f.match(/illustration_generated_at\.lt\.(.+)$/)![1];
          conds.push((r) => r.illustration_generated_at == null || String(r.illustration_generated_at) < cutoff);
          return q;
        },
        select: async () => {
          if (!conds.every((c) => c(row))) return { data: [], error: null };
          Object.assign(row, values);
          return { data: [{ id: row.id }], error: null };
        },
      };
      return q;
    },
  };
}

describe("claimIllustration (the once-marker, one conditional UPDATE)", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const base = () => ({ id: ID, photo_path: null, illustration_path: null, illustration_generated_at: null as string | null });

  it("race: a live event claim, then a backfill retry at the same moment, only one wins", async () => {
    const row = base();
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: false, now })).toBe(true);
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: true, now })).toBe(false);
  });

  it("race: a backfill retry first, then the live event, only one wins", async () => {
    const row = { ...base(), illustration_generated_at: new Date(now.getTime() - RETRY_AFTER_MS - 1).toISOString() };
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: true, now })).toBe(true);
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: false, now })).toBe(false);
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: true, now })).toBe(false);
  });

  it("a retry never takes a claim younger than the cutoff, the event path never retakes any", async () => {
    const row = { ...base(), illustration_generated_at: new Date(now.getTime() - 60_000).toISOString() };
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: true, now })).toBe(false);
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: false, now })).toBe(false);
  });

  it("never claims a creator with a photo", async () => {
    const row = { ...base(), photo_path: "media/x.jpg" };
    expect(await claimIllustration(fakeTable(row), ID, { retryFailed: true, now })).toBe(false);
  });
});
