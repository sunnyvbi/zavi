import { describe, it, expect } from "vitest";
import {
  findingHandoff,
  handoffFindings,
  runFindings,
  HANDOFF_TOTAL_LIMIT,
} from "./findingHandoff";
import type { RecipeFindingView } from "./recipeStep";

function finding(over: Partial<RecipeFindingView> = {}): RecipeFindingView {
  return {
    metricId: "ai_crawler_access",
    status: "failing",
    value: "4 of 6 blocked",
    numericValue: null,
    target: null,
    unit: null,
    direction: null,
    blocks: ["Nothing you publish can be cited"],
    access: "repo",
    risk: "Low.",
    doNothing: "They keep getting turned away.",
    undo: "Remove the two lines.",
    ...over,
  };
}

describe("findingHandoff — never promises Zavi will act", () => {
  it("says a repo change is the founder's to make", () => {
    const h = findingHandoff("repo");
    expect(h.detail).toMatch(/no write path to your site/);
    expect(h.detail).toMatch(/yours to make/);
  });

  it("never claims Zavi prepares, opens, or makes the change", () => {
    for (const access of ["repo", "cdn", "none", null] as const) {
      const { detail, who } = findingHandoff(access);
      const text = `${who} ${detail}`;
      expect(text).not.toMatch(/Zavi can prepare|Zavi will|open a pull request|prepare the change/i);
    }
  });
});

describe("findingHandoff — a CDN change is not a repo change", () => {
  it("says outright that connecting a repo does not help", () => {
    const h = findingHandoff("cdn");
    expect(h.detail).toMatch(/Connecting a repo does not help/);
    expect(h.who).toMatch(/CDN or DNS/);
  });

  it("names where the change actually happens", () => {
    expect(findingHandoff("cdn").detail).toMatch(/Cloudflare, Vercel or Netlify/);
  });
});

describe("findingHandoff — the other two answers", () => {
  it("says an access:none finding is not waiting on access", () => {
    expect(findingHandoff("none").who).toMatch(/No site access needed/);
  });

  it("says who acts is not established rather than guessing a default", () => {
    const h = findingHandoff(null);
    expect(h.who).toBe("Not established");
    expect(h.detail).toMatch(/did not determine which access/);
  });
});

describe("handoffFindings", () => {
  it("drops a measured finding, which needs nobody to act", () => {
    expect(handoffFindings([finding({ status: "measured" })])).toEqual([]);
  });

  it("keeps every failing finding", () => {
    const out = handoffFindings([
      finding({ metricId: "a" }),
      finding({ metricId: "b" }),
    ]);
    expect(out.map((f) => f.metricId)).toEqual(["a", "b"]);
  });

  it("keeps an unmeasured finding that carries something to act on", () => {
    const out = handoffFindings([
      finding({ metricId: "trunc", status: "unmeasured", blocks: ["a page was not read"] }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("drops an unmeasured finding carrying nothing actionable", () => {
    const out = handoffFindings([
      finding({
        status: "unmeasured",
        blocks: [],
        access: null,
        risk: null,
        doNothing: null,
        undo: null,
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("preserves the agent's ranking", () => {
    const out = handoffFindings([
      finding({ metricId: "first" }),
      finding({ metricId: "second", status: "unmeasured", access: "cdn" }),
      finding({ metricId: "third" }),
    ]);
    expect(out.map((f) => f.metricId)).toEqual(["first", "second", "third"]);
  });
});

describe("runFindings", () => {
  const withFindings = {
    body: {
      findings: [
        {
          metric_id: "ai_crawler_access",
          status: "failing",
          value: "4 of 6 blocked",
          blocks: ["Nothing you publish can be cited"],
          access: "repo",
        },
      ],
    },
  };
  const without = { body: {} };

  it("finds them on the first action that carries them", () => {
    expect(runFindings([withFindings, without])).toHaveLength(1);
  });

  it("finds them on a later action when the first no longer carries them", () => {
    expect(runFindings([without, withFindings])).toHaveLength(1);
  });

  it("returns an empty list when no action carries them", () => {
    expect(runFindings([without, without])).toEqual([]);
    expect(runFindings([])).toEqual([]);
  });
});

describe("handoffFindings — holds its own bound", () => {
  it("caps the total rows rather than trusting its caller", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      finding({ metricId: `m${i}` }),
    );
    expect(handoffFindings(many)).toHaveLength(HANDOFF_TOTAL_LIMIT);
  });
});
