import { afterEach, describe, it, expect, vi } from "vitest";
import { getLivePillSlug, parseLiveUpcar } from "./liveUpcar";

describe("parseLiveUpcar", () => {
  it("locked payload: numbers stay null even if present", () => {
    const p = parseLiveUpcar({ locked: true, numbers: { spent_usd: 5 }, clock: {}, goals: {}, days: [] })!;
    expect(p.locked).toBe(true);
    expect(p.numbers).toBeNull();
  });
  it("never coerces null or blank to 0", () => {
    const p = parseLiveUpcar({ locked: false, numbers: { spent_usd: 100, bookings: null, hosts: "", pace: {}, by_day: [] }, clock: {}, goals: {}, days: [] })!;
    expect(p.numbers).toMatchObject({ spent_usd: 100, bookings: null, hosts: null });
  });
  it("drops unknown keys and days without a headline", () => {
    const p = parseLiveUpcar({ locked: false, numbers: null, days: [{ day: "2026-10-01", headline: "Hi", kind: "WIN", secret: 1 }, { day: "2026-10-02" }] })!;
    expect(p.days).toHaveLength(1);
    expect(p.days[0]).not.toHaveProperty("secret");
    expect(p.days[0].kind).toBe("WIN");
  });
  it("rejects non-objects", () => {
    expect(parseLiveUpcar(null)).toBeNull();
  });
});

describe("getLivePillSlug", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const answer = (pill: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ pill }))));

  it("points at a run still going", async () => {
    answer({ slug: "upcar", ended: false });
    expect(await getLivePillSlug()).toBe("upcar");
  });
  it("stops once the run has ended, but the sitemap can still name it", async () => {
    answer({ slug: "upcar", ended: true });
    expect(await getLivePillSlug()).toBeNull();
    expect(await getLivePillSlug({ evenIfEnded: true })).toBe("upcar");
  });
  it("an older backend that doesn't say keeps the pill", async () => {
    answer({ slug: "upcar" });
    expect(await getLivePillSlug()).toBe("upcar");
  });
});
