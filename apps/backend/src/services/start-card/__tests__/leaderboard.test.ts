
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StartCardProfileEvidence } from "@zavi/shared";

type Call = [string, ...unknown[]];
const H = vi.hoisted(() => ({
  calls: [] as Call[],
  result: { data: [] as unknown, error: null as unknown },
  optedOut: [] as Array<{ domain: string }>,
  suppressed: [] as Array<{ domain: string }>,
  reads: 0,
  excluded: [] as unknown,
}));

function chain(table = "start_cards"): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  let optOutRead = false;
  for (const m of ["select", "eq", "is", "not", "gt", "or", "order", "range", "in"]) {
    c[m] = (...a: unknown[]) => {
      H.calls.push([m, ...a]);
      if (m === "not" && a[0] === "revoked_at") optOutRead = true;
      return c;
    };
  }
  c.then = (res: (v: unknown) => unknown) => {
    H.reads++;
    if (table === "seed_suppressions") return Promise.resolve({ data: H.suppressed, error: null }).then(res);
    return Promise.resolve(optOutRead ? { data: H.optedOut, error: null } : H.result).then(res);
  };
  return c;
}

vi.mock("@/services/settings", () => ({
  getSetting: async () => H.excluded,
}));

vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({ from: (t: string) => (H.calls.push(["from", t]), chain(t)) }),
}));

import {
  categoryOf,
  fetchEligibleRows,
  fetchExcludedDomains,
  fetchOptedOutDomains,
  filterRows,
  LISTABLE_FILTER,
  getLeaderboardRank,
  rankedLeaderboard,
  rankRows,
  resetLeaderboardCache,
  type LeaderboardSourceRow,
} from "../leaderboard";

const has = (...call: unknown[]) => H.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));

function profile(over: Partial<StartCardProfileEvidence> = {}): LeaderboardSourceRow["profile"] {
  return {
    state: "done",
    fetched_at: null,
    evidence: {
      company_name: "X",
      category: "x",
      search_term: "x",
      country: "GB",
      country_from: "cctld",
      rivals: [],
      ...over,
    },
  };
}

let seq = 0;
function row(domain: string, total: number, out_of: number, over: Partial<LeaderboardSourceRow> = {}): LeaderboardSourceRow {
  seq += 1;
  return {
    public_id: `PUB${String(seq).padStart(13, "0")}`,
    domain,
    locale: "GB",
    score: { total, out_of, by_check: { google: null, ai: null, seo: null, design: null, compare: null } },
    created_at: `2026-10-0${Math.min(9, seq % 9 + 1)}T00:00:00.000Z`,
    profile: profile({ company_type: "saas" }),
    diagnosis: { state: "done", fetched_at: null, evidence: { constraint: { check_key: "ai", title: "No AI engine names you", why: "" }, action_this_week: { title: "a", why: "" } } },
    ...over,
  };
}

beforeEach(() => {
  H.calls = [];
  H.result = { data: [], error: null };
  seq = 0;
  resetLeaderboardCache();
});

describe("the eligible-row query", () => {
  it("reads only done, unremoved, unexpired, scored cards, newest first, and only the columns it shows", async () => {
    await fetchEligibleRows(new Date("2026-10-13T00:00:00.000Z"));
    expect(has("from", "start_cards")).toBe(true);
    expect(has("eq", "status", "done")).toBe(true);
    expect(has("is", "revoked_at", null)).toBe(true);
    expect(has("gt", "expires_at", "2026-10-13T00:00:00.000Z")).toBe(true);
    expect(has("not", "score", "is", null)).toBe(true);
    expect(has("order", "created_at", { ascending: false })).toBe(true);
    const select = H.calls.find((c) => c[0] === "select")?.[1] as string;
    expect(select).not.toMatch(/\bid\b|ip_hash|evidence|\*/);
  });
});

describe("rankRows", () => {
  it("keeps the newest card per domain, even when an older one scored higher", () => {
    const old = row("a.com", 90, 100, { created_at: "2026-10-01T00:00:00.000Z" });
    const fresh = row("a.com", 50, 100, { created_at: "2026-10-05T00:00:00.000Z" });
    const out = rankRows([old, fresh]);
    expect(out).toHaveLength(1);
    expect(out[0].public_id).toBe(fresh.public_id);
    expect(out[0].score).toEqual({ total: 50, out_of: 100 });
  });

  it("drops a site whose newest card measured fewer than 3 checks (it does not fall back to an older card)", () => {
    const old = row("a.com", 90, 100, { created_at: "2026-10-01T00:00:00.000Z" });
    const fresh = row("a.com", 38, 40, { created_at: "2026-10-05T00:00:00.000Z" });
    expect(rankRows([old, fresh, row("b.com", 30, 60)]).map((r) => r.domain)).toEqual(["b.com"]);
  });

  it("scores every row out of 100 (an unmeasured check is 0), orders by total then domain; equal totals share a rank", () => {
    const out = rankRows([
      row("ray.net", 46, 60),
      row("collab.com", 73, 100),
      row("c.com", 60, 80),
      row("a.com", 60, 100),
      row("z.com", 90, 100),
    ]);
    expect(out.map((r) => [r.rank, r.domain, r.score.total, r.score.out_of])).toEqual([
      [1, "z.com", 90, 100],
      [2, "collab.com", 73, 100],
      [3, "a.com", 60, 100],
      [3, "c.com", 60, 100],
      [5, "ray.net", 46, 100],
    ]);
  });

  it("a row carries only what the card shows: no evidence, country unknown on the US default, missing diagnosis is null", () => {
    const [r] = rankRows([
      row("a.com", 70, 100, {
        locale: "US",
        profile: profile({ country: "US", country_from: "default_us" }),
        diagnosis: { state: "unavailable", fetched_at: null, evidence: null },
      }),
    ]);
    expect(r).toEqual({
      rank: 1,
      public_id: r.public_id,
      domain: "a.com",
      score: { total: 70, out_of: 100 },
      category: "other",
      country: null,
      constraint: null,
      is_new: true,
    });
  });

  it("a country taken from the visitor is not the business's country", () => {
    const [r] = rankRows([row("a.com", 70, 100, { locale: "IN", profile: profile({ country: "IN", country_from: "visitor" }) })]);
    expect(r.country).toBeNull();
  });
});

describe("categoryOf", () => {
  it("maps every company type; services splits on a local city; missing is Other", () => {
    const p = (company_type?: StartCardProfileEvidence["company_type"], city: string | null = null) =>
      profile({ company_type, city })!.evidence!;
    expect(categoryOf(p("ecommerce"))).toBe("ecommerce");
    expect(categoryOf(p("saas"))).toBe("saas");
    expect(categoryOf(p("marketplace"))).toBe("marketplace");
    expect(categoryOf(p("services", "Austin"))).toBe("local");
    expect(categoryOf(p("services"))).toBe("agency");
    expect(categoryOf(p("fintech"))).toBe("other");
    expect(categoryOf(p("other"))).toBe("other");
    expect(categoryOf(p(undefined))).toBe("other");
    expect(categoryOf(null)).toBe("other");
  });
});

describe("filterRows", () => {
  const ranked = () =>
    rankRows([
      row("shop.co.uk", 90, 100, { profile: profile({ company_type: "ecommerce" }) }),
      row("app.io", 80, 100, { locale: "US", profile: profile({ company_type: "saas", country: "US", country_from: "address" }) }),
      row("plumbshop.com", 70, 100, { profile: profile({ company_type: "services", city: "Leeds" }) }),
    ]);

  it("filters by category, country and a domain substring, keeping the global rank", () => {
    expect(filterRows(ranked(), { category: "saas", offset: 0, limit: 50 }).rows.map((r) => [r.rank, r.domain])).toEqual([[2, "app.io"]]);
    expect(filterRows(ranked(), { country: "US", offset: 0, limit: 50 }).rows.map((r) => r.domain)).toEqual(["app.io"]);
    expect(filterRows(ranked(), { category: "local", offset: 0, limit: 50 }).rows.map((r) => r.domain)).toEqual(["plumbshop.com"]);
    const q = filterRows(ranked(), { q: " SHOP ", offset: 0, limit: 50 });
    expect(q.total).toBe(2);
    expect(q.rows.map((r) => r.domain)).toEqual(["shop.co.uk", "plumbshop.com"]);
  });

  it("pages with offset/limit and reports the filtered total", () => {
    const out = filterRows(ranked(), { offset: 1, limit: 1 });
    expect(out.total).toBe(3);
    expect(out.rows.map((r) => r.domain)).toEqual(["app.io"]);
  });
});

describe("getLeaderboardRank", () => {
  it("is listed only for the card on the board", async () => {
    const older = row("a.com", 90, 100, { created_at: "2026-10-01T00:00:00.000Z" });
    const newer = row("a.com", 80, 100, { created_at: "2026-10-05T00:00:00.000Z" });
    H.result = { data: [newer, older, row("b.com", 85, 100)], error: null };
    expect(await getLeaderboardRank(newer.public_id)).toEqual({ listed: true, rank: 2, total: 2 });
    expect(await getLeaderboardRank(older.public_id)).toEqual({ listed: false });
  });
});

describe("opt-out and the cache", () => {
  it("a domain whose owner removed ANY card stays off the board, even with an older unremoved scan", () => {
    const older = row("a.com", 90, 100, { created_at: "2026-10-01T00:00:00.000Z" });
    expect(rankRows([older, row("b.com", 80, 100)], new Set(["a.com"])).map((r) => r.domain)).toEqual(["b.com"]);
  });

  it("the opt-out read is applied on every rebuild", async () => {
    resetLeaderboardCache();
    H.result = { data: [row("a.com", 90, 100), row("b.com", 80, 100)], error: null };
    H.optedOut = [{ domain: "a.com" }];
    const { rows } = await rankedLeaderboard();
    expect(rows.map((r) => r.domain)).toEqual(["b.com"]);
    H.optedOut = [];
  });

  it("concurrent callers on a stale cache share ONE rebuild (no burst of table scans)", async () => {
    resetLeaderboardCache();
    H.result = { data: [row("a.com", 90, 100)], error: null };
    H.reads = 0;
    await Promise.all(Array.from({ length: 20 }, () => rankedLeaderboard(0)));
    expect(H.reads).toBe(3);
  });

  it("a rebuild that started before a removal does not write the removed site back into the cache", async () => {
    resetLeaderboardCache();
    H.result = { data: [row("a.com", 90, 100)], error: null };
    H.optedOut = [];
    const stale = rankedLeaderboard(0);
    resetLeaderboardCache();
    H.optedOut = [{ domain: "a.com" }];
    await stale;
    const { rows } = await rankedLeaderboard();
    expect(rows.map((r) => r.domain)).toEqual([]);
    H.optedOut = [];
  });

describe("seed-scan cards (20261101170000)", () => {
  beforeEach(() => {
    H.calls = [];
    H.result = { data: [], error: null };
  });
  it("the listing query keeps visitor cards and lists a seed card only after its notice went out", async () => {
    await fetchEligibleRows(new Date("2026-10-12T00:00:00Z"));
    expect(has("or", LISTABLE_FILTER)).toBe(true);
    expect(LISTABLE_FILTER).toBe("funding_kind.neq.seed,notice_sent_at.not.is.null");
  });
});
  it("a manual seed suppression takes a site off the board even with no revoked card, any letter case", async () => {
    H.optedOut = [{ domain: "WWW.Removed.com" }];
    H.suppressed = [{ domain: "asked-by-email.io" }];
    const out = await fetchOptedOutDomains(["removed.com", "asked-by-email.io", "listed.com"]);
    expect([...out].sort()).toEqual(["asked-by-email.io", "removed.com"]);
    expect(has("in", "domain", ["removed.com", "www.removed.com", "asked-by-email.io", "www.asked-by-email.io", "listed.com", "www.listed.com"])).toBe(true);
    H.optedOut = [];
    H.suppressed = [];
  });
});

describe("excluded domains", () => {
  beforeEach(() => {
    H.optedOut = [];
    H.suppressed = [];
    H.excluded = [];
  });

  it("reads the setting's domains, any letter case or www., skipping anything that is not a host", async () => {
    H.excluded = ["WWW.GitHub.com", " demowebshop.tricentis.com ", 42, ""];
    expect([...(await fetchExcludedDomains())].sort()).toEqual(["demowebshop.tricentis.com", "github.com"]);
  });

  it("a setting that is not a list excludes nothing", async () => {
    H.excluded = { not: "a list" };
    expect((await fetchExcludedDomains()).size).toBe(0);
  });

  it("the board drops excluded sites, keeps the rest, and ranks what is left from 1", async () => {
    H.excluded = ["github.com", "supabase.com", "acme.com"];
    H.result = {
      data: [row("github.com", 84, 100), row("www.supabase.com", 87, 100), row("acme.com", 37, 100), row("collabstr.com", 73, 100), row("upcar.ai", 51, 100)],
      error: null,
    };
    const { rows } = await rankedLeaderboard(0);
    expect(rows.map((r) => [r.rank, r.domain])).toEqual([
      [1, "collabstr.com"],
      [2, "upcar.ai"],
    ]);
  });
});
