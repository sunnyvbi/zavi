import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/components/marketing/growth-home/GrowthHeader", () => ({ GrowthHeader: () => null }));
vi.mock("@/components/marketing/growth-home/GrowthFooter", () => ({ GrowthFooter: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("@/fonts", () => ({ jakarta: { variable: "" } }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({ push: () => {} }) }));
vi.mock("@/lib/marketing/pricing", async (orig) => {
  const real = await orig<typeof import("@/lib/marketing/pricing")>();
  return { ...real, getLivePricing: async () => real.PRICING_FALLBACK };
});
vi.mock("@/lib/resolveCta", () => ({ resolveMarketingSession: async () => ({ cta: { href: "/start", label: "Start" }, email: null }) }));
vi.mock("@/lib/marketing/liveUpcar", async (orig) => ({
  ...(await orig<typeof import("@/lib/marketing/liveUpcar")>()),
  getLiveUpcar: async () => h.data,
}));

import LiveDayPage, { generateMetadata } from "./page";
import { parseLiveUpcar } from "@/lib/marketing/liveUpcar";

const clock = { start_at: "2026-10-01T00:00:00-04:00", unlock_at: "2026-10-01T00:00:00-04:00", end_at: "2026-10-30T23:59:00-04:00" };
const day9 = {
  day: "2026-10-09", kind: "CHANGE", headline: "Changed 3 budgets across Google and Meta.", channels: ["Google", "Meta"],
  work: ["Raised the Google host search budget"], why: "Host search was cheap per signup.", budget: [{ channel: "Google", from_usd: 55, to_usd: 110 }],
  spent_usd: 900, bookings: 50, hosts: 4, published_at: "2026-10-10T04:00:00.000Z", updated_at: "2026-10-10T04:00:00.000Z",
};
const payload = (over: Record<string, unknown> = {}) =>
  parseLiveUpcar({
    run: { slug: "upcar", listed: true }, locked: false, clock, budget_usd: 25000, goals: { booking_value_usd: 300000 },
    bookings_estimate_factor: 1.4,
    numbers: {
      spent_usd: 7000, spend_per_day_recent_usd: 700, runs_out_day: 30, bookings: 300, hosts: 90, booking_value_usd: 100000,
      pace: { bookings_per_week: 83, hosts_per_week: 60, booking_value_per_week: 20000 },
      by_day: [{ day: "2026-10-09", bookings: 55, hosts: 5, spent_usd: 1006, booking_value_usd: 9000 }],
    },
    now_line: { last_review_at: null, changes_today: 0, channels_today: [] },
    days: [day9, { ...day9, day: "2026-10-08", headline: "Changed 4 budgets.", published_at: null, updated_at: null }],
    ...over,
  });
const render = async (n: string) => renderToStaticMarkup(await LiveDayPage({ params: Promise.resolve({ slug: "upcar", n }) }));
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => { h.data = payload(); });

describe("/live/upcar/day/<n>", () => {
  it("renders the day: headline, what Zavi did, why, the budget move and that day's corrected figures", async () => {
    const t = text(await render("9"));
    expect(t).toContain("Day 9 of 30");
    expect(t).toContain("Changed 3 budgets across Google and Meta.");
    expect(t).toContain("Raised the Google host search budget");
    expect(t).toContain("Host search was cheap per signup.");
    expect(t).toContain("$55 → $110/day (+$55)");
    expect(t).toContain("$1,006");
    expect(t).toContain("+55");
    expect(t).toContain("← Day 8");
    expect(t).toContain("Run Zavi on my site");
    expect(t).not.toContain("estimate");
  });
  it("Article JSON-LD carries the real publish time and cannot be broken out of by entry text", async () => {
    h.data = payload({ days: [{ ...day9, headline: "Closing tag </script><script>alert(1)</script> test" }] });
    const html = await render("9");
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(ld.some((s) => s.includes("</script>"))).toBe(false);
    const article = ld.map((s) => JSON.parse(s)).find((j) => j["@type"] === "Article");
    expect(article.datePublished).toBe("2026-10-10T04:00:00.000Z");
    expect(article.headline).toContain("</script><script>alert(1)</script>");
    expect(article.mainEntityOfPage).toBe("https://www.zaviagent.com/live/upcar/day/9");
  });
  it("404s for a day with no published entry, a locked run, a padded number, or no such run", async () => {
    await expect(render("10")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render("09")).rejects.toThrow("NEXT_NOT_FOUND");
    h.data = payload({ locked: true });
    await expect(render("9")).rejects.toThrow("NEXT_NOT_FOUND");
    h.data = "not_found";
    await expect(render("9")).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("an unreachable backend is an error (5xx), never a 404", async () => {
    h.data = null;
    await expect(render("9")).rejects.toThrow("live_backend_unavailable");
  });
  it("metadata: own canonical; an unlisted run is noindex", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ slug: "upcar", n: "9" }) });
    expect(m.alternates?.canonical).toBe("https://www.zaviagent.com/live/upcar/day/9");
    expect(String(m.title)).toBe("Day 9 of 30: Changed 3 budgets across Google and Meta. · Zavi runs Upcar's growth");
    expect(m.robots).toBeUndefined();
    expect(m.openGraph?.images).toEqual([{ url: "/live/upcar/day/9/opengraph-image", width: 1200, height: 630, alt: "Day 9 of 30: Changed 3 budgets across Google and Meta." }]);
    expect(m.twitter?.images).toEqual(["/live/upcar/day/9/opengraph-image"]);
    h.data = payload({ run: { slug: "upcar", listed: false } });
    expect((await generateMetadata({ params: Promise.resolve({ slug: "upcar", n: "9" }) })).robots).toEqual({ index: false, follow: false });
  });
  it("shows the estimate note when the scoreboard would (factor over 2)", async () => {
    h.data = payload({ bookings_estimate_factor: 2.5 });
    expect(text(await render("9"))).toContain("×2.5 estimate");
  });
});
