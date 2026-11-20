
import { describe, it, expect } from "vitest";

import {
  AGENT_READINESS_DISCLOSURE,
  CLS_GOOD_MAX,
  CRUX_NO_DATA_DETAIL,
  computeAgentReadiness,
  type AgentReadinessField,
  type AgentCheckId,
  type AgentReadiness,
  type AgentReadinessInput,
} from "../agent-readiness";
import { AI_CRAWLERS, SSR_WORD_FLOOR, type CrawlerAccess, type CrawlerState } from "../../geo/analyze";

const crawlers = (state: CrawlerState, over: Partial<CrawlerAccess> = {}): CrawlerAccess[] =>
  AI_CRAWLERS.map((c) => ({
    ...c,
    state,
    directive: null,
    from_wildcard: false,
    ...over,
  }));

const pages = (...counts: number[]) =>
  counts.map((visible_words, i) => ({ url: `https://example.com/p${i}`, visible_words }));

const at = (path: string, visible_words: number) => ({
  url: `https://example.com${path}`,
  visible_words,
});

const home = (visible_words: number) => at("/", visible_words);

const measured = (cls: number | string | null): AgentReadinessField => ({ state: "ok", cls });

const absences: { name: string; field: AgentReadinessField | null }[] = [
  { name: "not fetched yet (a warm in flight, or nothing stored)", field: null },
  { name: "confirmed no_data — Google looked and has nothing", field: { state: "no_data" } },
  { name: "no Google key", field: { state: "not_configured" } },
  { name: "the read failed", field: { state: "unavailable" } },
  { name: "CrUX answered without a CLS figure", field: measured(null) },
];

const check = (r: AgentReadiness, id: AgentCheckId) => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
};

const allGood: AgentReadinessInput = {
  llmsTxt: true,
  crawlers: crawlers("allowed"),
  pages: pages(400, 900),
  field: measured(0.05),
};

describe("computeAgentReadiness", () => {
  it("returns all four checks, in a stable order, every time", () => {
    const ids = computeAgentReadiness(allGood).checks.map((c) => c.id);
    expect(ids).toEqual(["llms_txt", "ai_crawlers", "server_rendered", "layout_stable"]);
  });

  it("passes all four when the evidence is all good", () => {
    const r = computeAgentReadiness(allGood);
    expect(r.checks.every((c) => c.state === "pass")).toBe(true);
    expect(r.passed).toBe(4);
    expect(r.applicable).toBe(4);
  });

  it("fails all four when the evidence is all bad", () => {
    const r = computeAgentReadiness({
      llmsTxt: false,
      crawlers: crawlers("blocked", { directive: "Disallow: /" }),
      pages: pages(3, 10),
      field: measured(0.33),
    });
    expect(r.checks.every((c) => c.state === "fail")).toBe(true);
    expect(r.passed).toBe(0);
    expect(r.applicable).toBe(4);
  });

  describe("no CrUX data — the common case for a small site", () => {
    it("reports layout_stable as unknown, not as a fail", () => {
      const r = computeAgentReadiness({ ...allGood, field: { state: "no_data" } });
      expect(check(r, "layout_stable").state).toBe("unknown");
      expect(r.checks.some((c) => c.state === "fail")).toBe(false);
    });

    it("counts 3 applicable, not 4 — so the panel reads 3 of 3, never 3 of 4", () => {
      const r = computeAgentReadiness({ ...allGood, field: { state: "no_data" } });
      expect(r.passed).toBe(3);
      expect(r.applicable).toBe(3);
    });

    it("says it could not measure, and does not imply the layout is fine", () => {
      const d = check(computeAgentReadiness({ ...allGood, field: { state: "no_data" } }), "layout_stable").detail;
      expect(d).toMatch(/no real-visitor data/i);
      expect(d).not.toMatch(/\bgood\b|\bstable\b|\bfine\b/i);
    });
  });

  describe("the 'Google has none' claim belongs to a confirmed no_data and nothing else", () => {
    const layout = (field: AgentReadinessField | null) =>
      check(computeAgentReadiness({ ...allGood, field }), "layout_stable");

    it("says it on a confirmed no_data — it is TRUE there, and common for a small site", () => {
      expect(layout({ state: "no_data" }).detail).toBe(CRUX_NO_DATA_DETAIL);
    });

    it("does NOT say it when the fetch has not landed yet — the 2026-09-14 bug", () => {
      const d = layout(null).detail;
      expect(d).not.toContain(CRUX_NO_DATA_DETAIL);
      expect(d).not.toMatch(/google/i);
      expect(d).toMatch(/not measured .* yet/i);
    });

    it("does NOT say it when the read failed — that is our instrument, not Google's records", () => {
      const d = layout({ state: "unavailable" }).detail;
      expect(d).not.toContain(CRUX_NO_DATA_DETAIL);
      expect(d).toMatch(/could not read/i);
    });

    it("does NOT say it when there is no API key — we never asked anyone anything", () => {
      const d = layout({ state: "not_configured" }).detail;
      expect(d).not.toContain(CRUX_NO_DATA_DETAIL);
      expect(d).toMatch(/not switched on/i);
    });

    it("does NOT say it when CrUX answered but carried no CLS figure", () => {
      const d = layout(measured(null)).detail;
      expect(d).not.toContain(CRUX_NO_DATA_DETAIL);
      expect(d).toMatch(/answered/i);
    });

    it("exactly one of the five absences makes the claim", () => {
      const claiming = absences.filter((a) => layout(a.field).detail.includes(CRUX_NO_DATA_DETAIL));
      expect(claiming.map((a) => a.name)).toEqual([
        "confirmed no_data — Google looked and has nothing",
      ]);
    });

    it("gives each absence its own sentence — five absences, five details", () => {
      const details = absences.map((a) => layout(a.field).detail);
      expect(new Set(details).size).toBe(absences.length);
    });

    it("scores every absence identically: unknown, out of the denominator, never a fail", () => {
      for (const a of absences) {
        const r = computeAgentReadiness({ ...allGood, field: a.field });
        expect(layout(a.field).state, a.name).toBe("unknown");
        expect(r.applicable, a.name).toBe(3);
        expect(r.passed, a.name).toBe(3);
        expect(r.checks.some((c) => c.state === "fail"), a.name).toBe(false);
      }
    });

    it("never implies the layout is fine, in any absence", () => {
      for (const a of absences)
        expect(layout(a.field).detail, a.name).not.toMatch(/\bgood\b|\bstable\b|\bfine\b/i);
    });

    it("keeps the claim out of the pass and fail sentences too", () => {
      for (const cls of [0.05, 0.9, "0.33"] as const)
        expect(layout(measured(cls)).detail).not.toContain(CRUX_NO_DATA_DETAIL);
    });
  });

  describe("unknown never counts as a fail", () => {
    it("every half missing is four unknowns and a zero denominator", () => {
      const r = computeAgentReadiness({
        llmsTxt: null,
        crawlers: null,
        pages: null,
        field: null,
      });
      expect(r.checks.every((c) => c.state === "unknown")).toBe(true);
      expect(r.passed).toBe(0);
      expect(r.applicable).toBe(0);
    });

    it("passed is never greater than applicable, across every combination", () => {
      const opts = {
        llmsTxt: [true, false, null] as const,
        crawlers: [crawlers("allowed"), crawlers("blocked"), null] as const,
        pages: [pages(500), pages(1), null] as const,
        field: [measured(0.01), measured(0.9), measured(null), { state: "no_data" }, { state: "not_configured" }, { state: "unavailable" }, null] as const,
      };
      for (const llmsTxt of opts.llmsTxt)
        for (const c of opts.crawlers)
          for (const p of opts.pages)
            for (const field of opts.field) {
              const r = computeAgentReadiness({ llmsTxt, crawlers: c, pages: p, field });
              expect(r.checks).toHaveLength(4);
              expect(r.passed).toBeLessThanOrEqual(r.applicable);
              expect(r.applicable).toBe(r.checks.filter((x) => x.state !== "unknown").length);
              expect(r.passed).toBe(r.checks.filter((x) => x.state === "pass").length);
            }
    });
  });

  describe("CLS arriving as a string, which is how Google sends it", () => {
    it('reads "0.33" as a fail, not as NaN-passes-everything', () => {
      const r = computeAgentReadiness({ ...allGood, field: measured("0.33") });
      const c = check(r, "layout_stable");
      expect(c.state).toBe("fail");
      expect(c.detail).toContain("0.33");
    });

    it('reads "0.05" as a pass', () => {
      expect(check(computeAgentReadiness({ ...allGood, field: measured("0.05") }), "layout_stable").state).toBe(
        "pass",
      );
    });

    it("treats an unparseable string as unknown, never as 0", () => {
      for (const junk of ["", "   ", "n/a", "NaN"]) {
        const c = check(computeAgentReadiness({ ...allGood, field: measured(junk) }), "layout_stable");
        expect(c.state, `cls=${JSON.stringify(junk)}`).toBe("unknown");
      }
    });

    it("treats the threshold itself as a pass, on both number and string", () => {
      expect(check(computeAgentReadiness({ ...allGood, field: measured(CLS_GOOD_MAX) }), "layout_stable").state).toBe(
        "pass",
      );
      expect(check(computeAgentReadiness({ ...allGood, field: measured("0.1") }), "layout_stable").state).toBe(
        "pass",
      );
    });
  });

  describe("a missing GEO half degrades rather than throwing", () => {
    it("null crawlers + null llmsTxt leaves the SEO-side checks intact", () => {
      const r = computeAgentReadiness({ ...allGood, crawlers: null, llmsTxt: null });
      expect(check(r, "llms_txt").state).toBe("unknown");
      expect(check(r, "ai_crawlers").state).toBe("unknown");
      expect(check(r, "server_rendered").state).toBe("pass");
      expect(check(r, "layout_stable").state).toBe("pass");
      expect(r.passed).toBe(2);
      expect(r.applicable).toBe(2);
    });

    it("an empty crawler list is unknown, not 'nothing is blocked'", () => {
      expect(check(computeAgentReadiness({ ...allGood, crawlers: [] }), "ai_crawlers").state).toBe(
        "unknown",
      );
    });

    it("does not throw on an entirely absent input object", () => {
      const r = computeAgentReadiness({} as AgentReadinessInput);
      expect(r.applicable).toBe(0);
      expect(r.checks).toHaveLength(4);
    });
  });

  describe("ai_crawlers reads only the citation-class bots", () => {
    it("ignores crawlers whose block does nothing (ChatGPT-User, Google-Extended, CCBot…)", () => {
      const mixed = AI_CRAWLERS.map((c) => ({
        ...c,
        state: (c.recommended ? "allowed" : "blocked") as CrawlerState,
        directive: null,
        from_wildcard: false,
      }));
      const c = check(computeAgentReadiness({ ...allGood, crawlers: mixed }), "ai_crawlers");
      expect(c.state).toBe("pass");
      expect(c.detail).not.toContain("Bytespider");
    });

    it("names the blocked bots in the detail", () => {
      const one = AI_CRAWLERS.map((c) => ({
        ...c,
        state: (c.name === "OAI-SearchBot" ? "blocked" : "allowed") as CrawlerState,
        directive: null,
        from_wildcard: false,
      }));
      const c = check(computeAgentReadiness({ ...allGood, crawlers: one }), "ai_crawlers");
      expect(c.state).toBe("fail");
      expect(c.detail).toContain("OAI-SearchBot");
    });

    it("says so when the verdict came from the wildcard and no bot is named", () => {
      const wild = crawlers("allowed", { from_wildcard: true });
      const c = check(computeAgentReadiness({ ...allGood, crawlers: wild }), "ai_crawlers");
      expect(c.state).toBe("pass");
      expect(c.detail).toMatch(/names none of/i);
    });

    it("treats a partial disallow as access, and says which paths-bot is partial", () => {
      const c = check(
        computeAgentReadiness({ ...allGood, crawlers: crawlers("partial") }),
        "ai_crawlers",
      );
      expect(c.state).toBe("pass");
      expect(c.detail).toMatch(/some paths/i);
    });

    it("is unknown — not pass — when only some gated bots could be read", () => {
      const half = AI_CRAWLERS.map((c) => ({
        ...c,
        state: (c.name === "OAI-SearchBot" ? "unknown" : "allowed") as CrawlerState,
        directive: null,
        from_wildcard: false,
      }));
      expect(check(computeAgentReadiness({ ...allGood, crawlers: half }), "ai_crawlers").state).toBe(
        "unknown",
      );
    });
  });

  describe("server_rendered uses the GEO analyzer's own floor", () => {
    it("passes exactly at the floor", () => {
      expect(
        check(computeAgentReadiness({ ...allGood, pages: pages(SSR_WORD_FLOOR) }), "server_rendered")
          .state,
      ).toBe("pass");
    });

    it("counts one word below the floor as thin", () => {
      const c = check(
        computeAgentReadiness({ ...allGood, pages: pages(SSR_WORD_FLOOR - 1) }),
        "server_rendered",
      );
      expect(c.state).toBe("fail");
    });

    it("is unknown on an empty page list", () => {
      expect(check(computeAgentReadiness({ ...allGood, pages: [] }), "server_rendered").state).toBe(
        "unknown",
      );
    });
  });

  describe("server_rendered fails on the homepage or a majority — not on any single thin page", () => {
    it("does NOT fail a good site for one thin legal page", () => {
      const c = check(
        computeAgentReadiness({
          ...allGood,
          pages: [home(900), at("/about", 700), at("/pricing", 650), at("/terms", 12)],
        }),
        "server_rendered",
      );
      expect(c.state).toBe("pass");
    });

    it("still NAMES the thin pages on that pass — nothing is hidden", () => {
      const c = check(
        computeAgentReadiness({
          ...allGood,
          pages: [home(900), at("/about", 700), at("/pricing", 650), at("/terms", 12)],
        }),
        "server_rendered",
      );
      expect(c.detail).toContain("https://example.com/terms");
      expect(c.detail).toMatch(/3 of the 4 pages/);
      expect(c.detail).toMatch(/1 did not/);
    });

    it("names at most three, and says there are more", () => {
      const c = check(
        computeAgentReadiness({
          ...allGood,
          pages: [
            home(900),
            at("/a", 900),
            at("/b", 900),
            at("/c", 900),
            at("/d", 900),
            at("/t1", 5),
            at("/t2", 5),
            at("/t3", 5),
            at("/t4", 5),
          ],
        }),
        "server_rendered",
      );
      expect(c.state).toBe("pass");
      expect(c.detail).toContain("/t3");
      expect(c.detail).not.toContain("/t4");
      expect(c.detail).toContain("and others");
    });

    it("FAILS when the homepage is thin, even though everything else is fine", () => {
      const c = check(
        computeAgentReadiness({
          ...allGood,
          pages: [home(9), at("/about", 700), at("/pricing", 650), at("/blog", 800)],
        }),
        "server_rendered",
      );
      expect(c.state).toBe("fail");
      expect(c.detail).toMatch(/^The homepage \(https:\/\/example\.com\/\) carried under 60 words/);
    });

    it("FAILS on a majority of thin pages even when the homepage is fine", () => {
      const c = check(
        computeAgentReadiness({
          ...allGood,
          pages: [home(900), at("/a", 5), at("/b", 5), at("/c", 5), at("/d", 5)],
        }),
        "server_rendered",
      );
      expect(c.state).toBe("fail");
      expect(c.detail).toMatch(/4 of the 5 pages/);
    });

    it("half is not a majority: a 2-of-4 split with a good homepage passes", () => {
      expect(
        check(
          computeAgentReadiness({
            ...allGood,
            pages: [home(900), at("/a", 900), at("/b", 5), at("/c", 5)],
          }),
          "server_rendered",
        ).state,
      ).toBe("pass");
    });

    describe("the even split of exactly 2 pages", () => {
      it("1 thin of 2 is NOT most — passes when the homepage is the good one", () => {
        const c = check(
          computeAgentReadiness({ ...allGood, pages: [home(900), at("/login", 4)] }),
          "server_rendered",
        );
        expect(c.state).toBe("pass");
        expect(c.detail).toContain("/login");
      });

      it("1 thin of 2 FAILS when the thin one is the homepage", () => {
        const c = check(
          computeAgentReadiness({ ...allGood, pages: [home(4), at("/about", 900)] }),
          "server_rendered",
        );
        expect(c.state).toBe("fail");
        expect(c.detail).toMatch(/^The homepage/);
      });

      it("2 thin of 2 is a majority and fails", () => {
        expect(
          check(
            computeAgentReadiness({ ...allGood, pages: [at("/a", 4), at("/b", 4)] }),
            "server_rendered",
          ).state,
        ).toBe("fail");
      });
    });

    describe("when the crawl list has no obvious homepage", () => {
      const noHome = [at("/a", 900), at("/b", 900), at("/c", 4)];

      it("does not promote the first page to homepage — 1 of 3 passes", () => {
        expect(
          check(computeAgentReadiness({ ...allGood, pages: noHome }), "server_rendered").state,
        ).toBe("pass");
      });

      it("still fails on a majority", () => {
        expect(
          check(
            computeAgentReadiness({ ...allGood, pages: [at("/a", 4), at("/b", 4), at("/c", 900)] }),
            "server_rendered",
          ).state,
        ).toBe("fail");
      });

      it("uses `site` to find the front door when the root sits under a path", () => {
        const c = check(
          computeAgentReadiness({
            ...allGood,
            pages: [at("/app", 4), at("/app/docs", 900), at("/app/pricing", 900)],
            site: "https://example.com/app",
          }),
          "server_rendered",
        );
        expect(c.state).toBe("fail");
        expect(c.detail).toMatch(/^The homepage \(https:\/\/example\.com\/app\)/);
      });

      it("matches `site` across a trailing slash", () => {
        expect(
          check(
            computeAgentReadiness({
              ...allGood,
              pages: [at("/app", 4), at("/app/docs", 900), at("/app/x", 900)],
              site: "https://example.com/app/",
            }),
            "server_rendered",
          ).state,
        ).toBe("fail");
      });

      it("ignores a `site` that matches no crawled page", () => {
        expect(
          check(
            computeAgentReadiness({ ...allGood, pages: noHome, site: "https://elsewhere.test" }),
            "server_rendered",
          ).state,
        ).toBe("pass");
      });
    });
  });

  describe("copy is evidence, not advice", () => {
    it("never tells the founder what to do", () => {
      const inputs: AgentReadinessInput[] = [
        allGood,
        { llmsTxt: false, crawlers: crawlers("blocked"), pages: pages(2), field: measured("0.33") },
        { llmsTxt: null, crawlers: null, pages: null, field: null },
      ];
      for (const i of inputs)
        for (const c of computeAgentReadiness(i).checks) {
          expect(c.detail, c.id).not.toMatch(/\byou should\b|\badd an?\b|\bfix\b|\bwe recommend\b/i);
          expect(c.detail.length, c.id).toBeGreaterThan(0);
        }
    });

    it("states both halves of the llms.txt truth in every state", () => {
      for (const llmsTxt of [true, false, null] as const) {
        const d = check(computeAgentReadiness({ ...allGood, llmsTxt }), "llms_txt").detail;
        expect(d, String(llmsTxt)).toMatch(/not a Google Search ranking signal/i);
        expect(d, String(llmsTxt)).toMatch(/Agentic Browsing/i);
      }
    });

    it("the disclosure disowns the number from Google without disowning the check", () => {
      expect(AGENT_READINESS_DISCLOSURE).toMatch(/Zavi's own check, not Google's/i);
      expect(AGENT_READINESS_DISCLOSURE).toMatch(/pagespeed\.web\.dev/i);
    });
  });
});
