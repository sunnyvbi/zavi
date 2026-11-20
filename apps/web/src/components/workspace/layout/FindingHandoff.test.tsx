import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FindingHandoff } from "./FindingHandoff";
import { HANDOFF_CARD_LIMIT } from "@/lib/workspace/findingHandoff";
import type { RecipeFindingView } from "@/lib/workspace/recipeStep";

function finding(over: Partial<RecipeFindingView> = {}): RecipeFindingView {
  return {
    metricId: "ai_crawler_access",
    status: "failing",
    value: "4 of 6 AI crawlers blocked",
    numericValue: null,
    target: null,
    unit: null,
    direction: null,
    blocks: ["Nothing you publish can be cited while they are blocked"],
    access: "repo",
    risk: "Low. Two named Allow rules above an existing Disallow.",
    doNothing: "The crawlers that can cite you keep getting turned away.",
    undo: "Remove the two lines.",
    ...over,
  };
}

const render = (findings: RecipeFindingView[]) =>
  renderToStaticMarkup(<FindingHandoff findings={findings} />);

describe("FindingHandoff — the three decision fields are never hidden", () => {
  it("renders risk, cost of doing nothing and undo in place", () => {
    const html = render([finding()]);
    expect(html).toContain("If you don&#x27;t");
    expect(html).toContain("Risk");
    expect(html).toContain("To undo");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
  });

  it("omits a field the agent did not emit rather than inventing one", () => {
    const html = render([finding({ risk: null, undo: null, doNothing: null })]);
    expect(html).not.toContain("To undo");
    expect(html).not.toContain("Risk");
    expect(html).toContain("4 of 6 AI crawlers blocked");
  });
});

describe("FindingHandoff — it never promises Zavi will act", () => {
  it("offers no connect-a-repo control on any finding", () => {
    for (const access of ["repo", "cdn", "none", null] as const) {
      const html = render([finding({ access })]);
      expect(html).not.toContain("Connect a repo");
      expect(html).not.toMatch(/Zavi can prepare|prepare the change/i);
    }
  });

  it("says a repo change is the founder's, and a CDN one is not reachable from a repo", () => {
    expect(render([finding({ access: "repo" })])).toContain("yours to make");
    expect(render([finding({ access: "cdn" })])).toContain(
      "Connecting a repo does not help",
    );
  });
});

describe("FindingHandoff — it cannot bury the punch list", () => {
  it(`renders at most ${HANDOFF_CARD_LIMIT} full cards`, () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      finding({ metricId: `m${i}`, value: `finding ${i}` }),
    );
    const html = render(many);
    expect(html.match(/To undo/g)?.length).toBe(HANDOFF_CARD_LIMIT);
  });

  it("still accounts for every finding beyond the cap", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      finding({ metricId: `m${i}`, value: `finding ${i}` }),
    );
    const html = render(many);
    expect(html).toContain("4 more findings");
    for (let i = 0; i < 6; i++) expect(html).toContain(`finding ${i}`);
  });

  it("uses the singular for a single overflow finding", () => {
    const three = Array.from({ length: HANDOFF_CARD_LIMIT + 1 }, (_, i) =>
      finding({ metricId: `m${i}` }),
    );
    expect(render(three)).toContain("1 more finding");
  });
});

describe("FindingHandoff — what it shows at all", () => {
  it("renders nothing when no finding needs anyone to act", () => {
    expect(render([finding({ status: "measured" })])).toBe("");
    expect(render([])).toBe("");
  });

  it("says what each finding blocks", () => {
    expect(render([finding()])).toContain(
      "Nothing you publish can be cited while they are blocked",
    );
  });

  it("keys duplicate blocks lines without collapsing them", () => {
    const html = render([finding({ blocks: ["same", "same"] })]);
    expect(html.match(/same/g)?.length).toBe(2);
  });
});
