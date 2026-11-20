
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GrowthLeaderboardResponse, GrowthLeaderboardRow } from "@zavi/shared";

const H = vi.hoisted(() => ({
  pages: [] as Array<Record<string, unknown>>,
  respond: (_p: Record<string, unknown>): GrowthLeaderboardResponse | null => null,
  throws: false,
}));

vi.mock("@/components/marketing/growth-home/GrowthHeader", () => ({ GrowthHeader: () => null }));
vi.mock("@/components/marketing/growth-home/GrowthFooter", () => ({ GrowthFooter: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/start-card/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/start-card/api")>();
  return {
    ...real,
    getLeaderboard: vi.fn(async (p: Record<string, unknown>) => {
      H.pages.push(p);
      if (H.throws) throw new Error("backend down");
      return H.respond(p);
    }),
  };
});

import GrowthLeaderboardPage from "./page";

function row(rank: number, over: Partial<GrowthLeaderboardRow> = {}): GrowthLeaderboardRow {
  return {
    rank,
    public_id: `PUB${String(rank).padStart(13, "0")}`,
    domain: `site${rank}.example`,
    score: { total: 100 - rank, out_of: 100 },
    category: "saas",
    country: "US",
    constraint: `Problem ${rank}`,
    is_new: true,
    ...over,
  };
}

function board(count: number, over: (i: number) => Partial<GrowthLeaderboardRow> = () => ({})) {
  const all = Array.from({ length: count }, (_, i) => row(i + 1, over(i + 1)));
  return (p: Record<string, unknown>): GrowthLeaderboardResponse => {
    const offset = Number(p.offset ?? 0);
    const limit = Number(p.limit ?? 50);
    return { total: all.length, rows: all.slice(offset, offset + limit), generated_at: "2026-10-13T00:00:00.000Z" };
  };
}

async function html(searchParams: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await GrowthLeaderboardPage({ searchParams: Promise.resolve(searchParams) }));
}

const count = (out: string, needle: string) => out.split(needle).length - 1;

beforeEach(() => {
  H.pages = [];
  H.throws = false;
  H.respond = board(0);
});

describe("/growth with data", () => {
  it("draws the podium, ranks 4+ in the table, links each site to its card, and offers the next 50", async () => {
    H.respond = board(120, (i) => (i === 5 ? { constraint: null, country: null, category: "other" } : {}));
    const out = await html();
    expect(out).toContain("120</b> sites ranked");
    expect(out).toContain("Growth leaderboard · Live");
    expect(count(out, 'data-testid="podium-slot"')).toBe(3);
    expect(out).toContain("site1.example");
    expect(count(out, 'data-testid="leaderboard-row"')).toBe(47);
    expect(out).toContain('href="/r/PUB0000000000004"');
    expect(out).toContain("Showing 1-50 of 120");
    expect(out).toContain('href="/growth?limit=100"');
    expect(out).toContain("New</span>");
    expect(out).toContain("Not measured");
    expect(out).not.toContain("Open spot");
    expect(H.pages[0]).toMatchObject({ offset: 0, limit: 50 });
  });

  it("?limit=100 asks for 100 rows in one call", async () => {
    H.respond = board(120);
    const out = await html({ limit: "100" });
    expect(H.pages).toEqual([expect.objectContaining({ offset: 0, limit: 100 })]);
    expect(out).toContain("Showing 1-100 of 120");
    expect(out).toContain('href="/growth?limit=150"');
  });

  it("passes only known filters to the backend and keeps them on the chip links", async () => {
    H.respond = board(10);
    const out = await html({ category: "saas", country: "GB", q: " shop ", limit: "abc" });
    expect(H.pages[0]).toMatchObject({ category: "saas", country: "GB", q: "shop", offset: 0, limit: 50 });
    expect(out).toContain('href="/growth?category=ecommerce&amp;country=GB&amp;q=shop"');
    expect(out).toContain('aria-current="true"');

    H.pages = [];
    await html({ category: "crypto", country: "ZZ" });
    expect(H.pages[0]).toMatchObject({ category: undefined, country: undefined });
  });

  it("always shows every category chip and every country option, labelled", async () => {
    const out = await html();
    for (const label of ["All", "E-commerce", "SaaS", "Marketplace", "Local business", "Agency", "Other"]) {
      expect(out).toContain(`${label}</a>`);
    }
    for (const label of ["All countries", "United Kingdom", "India"]) {
      expect(out).toContain(`>${label}</option>`);
    }
    expect(out).toContain('aria-label="Category"');
    expect(out).toContain('aria-label="Country"');
    expect(out).toContain('name="q"');
    expect(out).toContain('name="country"');
  });

  it("the country select sits in the search form, pre-set to the current country", async () => {
    H.respond = board(3);
    const out = await html({ country: "GB", category: "saas" });
    const form = out.slice(out.indexOf('role="search"'), out.indexOf("</form>"));
    expect(form).toContain('name="country"');
    expect(form).toContain('<option value="GB" selected="">');
    expect(form).toContain('name="category" value="saas"');
  });

  it("is noindex", async () => {
    const { metadata } = await import("./page");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe("/growth filtered", () => {
  function filteredBoard(count: number, matches: number[]) {
    const all = board(count);
    return (p: Record<string, unknown>): GrowthLeaderboardResponse => {
      if (!p.q && !p.category && !p.country) return all(p);
      const rows = matches.map((rank) => row(rank));
      return { total: rows.length, rows, generated_at: "2026-10-13T00:00:00.000Z" };
    };
  }
  const badges = (out: string) =>
    [...out.matchAll(/data-testid="podium-rank"[^>]*>([^<]*|<svg.*?<\/svg><span class="sr-only">[^<]*<\/span>)<\/span>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, ""),
    );

  it("a search keeps each site's real rank, and the crown belongs only to the real #1", async () => {
    H.respond = filteredBoard(40, [2, 7, 12, 20]);
    const out = await html({ q: "site" });
    expect(badges(out)).toEqual(["2", "7", "12"]);
    expect(out).not.toContain('<span class="sr-only">#1</span>');
    expect(out).not.toContain("lucide-crown");
    const slots = out.split('data-testid="podium-rank"').slice(1);
    expect(slots[0]).toContain("#c9ced6");
    expect(slots[1]).not.toMatch(/#f5c542|#c9ced6|#e3a578/);
    expect(out).toContain('data-testid="leaderboard-row"');
    expect(out).toMatch(/tabular-nums">20<\/td>/);
  });

  it("the real #1 keeps its crown when it matches", async () => {
    H.respond = filteredBoard(40, [1, 3]);
    const out = await html({ category: "saas" });
    expect(out).toContain('<span class="sr-only">#1</span>');
    expect(count(out, "lucide-crown")).toBe(1);
  });

  it("an open podium slot under a filter shows no rank number of its own", async () => {
    H.respond = filteredBoard(40, [2]);
    const out = await html({ q: "site2" });
    expect(badges(out)).toEqual(["2", "", ""]);
    expect(out).toContain('data-testid="no-more-matches"');
    expect(out).not.toContain('data-testid="empty-row"');
  });

  it("a board that failed to load under a filter never claims there are no matches", async () => {
    H.throws = true;
    const out = await html({ q: "site" });
    expect(out).toContain("We couldn&#x27;t load the leaderboard right now");
    expect(out).not.toContain('data-testid="no-more-matches"');
    expect(out).not.toContain("No more sites match");
    expect(out).not.toContain('data-testid="no-match"');
  });

  it.each([
    [{ q: "nothing-here" }, "No sites match this search yet."],
    [{ country: "US" }, "No sites match this filter yet."],
    [{ category: "agency", q: "x" }, "No sites match this filter yet."],
  ])("a filter with no results says so and offers a way to clear it (%o)", async (params, message) => {
    H.respond = filteredBoard(40, []);
    const out = await html(params as Record<string, string>);
    expect(out).toContain('data-testid="no-match"');
    expect(out).toContain(message);
    expect(out).toContain('href="/growth">Clear filters</a>');
    expect(out).not.toContain("Open spot");
    expect(out).not.toContain("Showing 0 of 0");
    expect(out).not.toContain('data-testid="podium-slot"');
    expect(out).toContain("40</b> sites ranked");
  });
});

describe("/growth with no data", () => {
  it("keeps the same layout with empty slots", async () => {
    const out = await html();
    expect(out).toContain("0 sites ranked yet");
    expect(count(out, 'data-testid="podium-slot"')).toBe(3);
    expect(count(out, "Open spot. Scan your site to claim it.")).toBe(3);
    expect(count(out, 'data-testid="empty-row"')).toBe(5);
    expect(out).toContain("Showing 0 of 0");
    expect(out).toContain("Get your rank");
    expect(out).toContain("Free. Sign in with Google to see it");
    expect(out).not.toContain('data-testid="your-rank"');
    expect(out).toContain("How this works.");
  });

  it("a backend error says so, never '0 sites ranked'", async () => {
    H.throws = true;
    const out = await html();
    expect(out).toContain("We couldn&#x27;t load the leaderboard right now");
    expect(out).not.toContain("0 sites ranked yet");
    expect(out).not.toContain("· Live");
  });

  it("404s while the leaderboard is switched off", async () => {
    H.respond = () => null;
    await expect(html()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
