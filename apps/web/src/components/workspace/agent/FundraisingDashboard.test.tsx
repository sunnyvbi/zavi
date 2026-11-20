
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InvestorReadView,
  OutreachPlanView,
} from "./FundraisingInvestorViews";
import type {
  FundraisingInvestor,
  InvestorDossier,
} from "./fundraising-dashboard-util";

const dossier = (over: Record<string, unknown> = {}) => ({
  who_they_are: "Dana has been a partner since 2019.",
  why_this_company: "Hosts keep 90%+ where the incumbent pays 70-85%.",
  how_to_reach: {
    warm_path: "A warm path exists.",
    who_to_go_through: "Ask for the forward.",
  },
  draft_message: "Subject: 90% host payout\n\nDana — Upcar is P2P car rental.",
  pushbacks: [
    {
      objection: "Why won't the incumbent simply match the payout?",
      honest_answer: "Their take rate funds the insurance book.",
    },
  ],
  sources: [
    { url: "acme.vc/team", claim: "Partner list" },
    { url: "sec.gov", claim: "Form D filings" },
  ],
  ...over,
});

const inv = (over: Partial<FundraisingInvestor> = {}): FundraisingInvestor => {
  const firm = over.firm ?? "Acme Ventures";
  const name = over.name ?? "Dana Lee";
  return {
    firm,
    name,
    tier: 1,
    fit_rationale: "Marketplace dean with a supply-liquidity thesis.",
    source: "web",
    source_url: "https://acme.vc",
    review_key: `${firm}|${name}`,
    ...over,
  };
};

function payload(
  investors: FundraisingInvestor[],
  merge?: unknown,
  extra?: Record<string, unknown>,
) {
  return {
    generic: false,
    latest: {
      run_id: "run-x",
      generated_at: "2026-07-29T00:00:00Z",
      investors,
      ...(merge === undefined ? {} : { merge }),
    },
    coverage: { total: investors.length },
    ...(extra ?? {}),
  };
}

const mockState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("./dashboard-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-ui")>();
  return {
    ...actual,
    useAgentDashboard: () => ({
      data: mockState.current,
      loading: false,
      refreshing: false,
      error: null,
      refresh: () => {},
      newRowIds: new Set<string>(),
    }),
  };
});

import { FundraisingDashboard } from "./FundraisingDashboard";

function render(
  investors: FundraisingInvestor[],
  merge?: unknown,
  extra?: Record<string, unknown>,
): string {
  mockState.current = payload(investors, merge, extra);
  return renderToStaticMarkup(<FundraisingDashboard />);
}

const tier1 = (n: number, over: Partial<FundraisingInvestor> = {}) =>
  Array.from({ length: n }, (_, i) =>
    inv({ firm: `Firm ${i}`, name: `Partner ${i}`, tier: 1, ...over }),
  );

describe("the tiered list renders from the payload", () => {
  it("renders every tier with its heading, count and rows", () => {
    const html = render([
      inv({ firm: "Andreessen Horowitz", name: "Jeff Jordan", tier: 1 }),
      inv({ firm: "Primary Venture Partners", name: "Brad Svrluga", tier: 2 }),
      inv({ firm: "Maniv Mobility", name: "", tier: 3 }),
    ]);

    expect(html).toContain("Tier 1: strong fit");
    expect(html).toContain("Tier 2: solid");
    expect(html).toContain("Tier 3: broader");

    expect(html).toContain("Andreessen Horowitz");
    expect(html).toContain("Jeff Jordan");
    expect(html).toContain("Primary Venture Partners");
    expect(html).toContain("Maniv Mobility");

    expect(html).toContain("Marketplace dean with a supply-liquidity thesis.");
  });

  it("a row with no named partner says so, instead of pretending it's reachable", () => {
    const html = render([inv({ firm: "Maniv Mobility", name: "" })]);
    expect(html).toContain("no named partner");
  });

  it("shows 8 rows per tier and offers to show the rest", () => {
    const html = render(tier1(30));
    expect(html).toContain("Firm 0");
    expect(html).toContain("Firm 7");
    expect(html).not.toContain(">Firm 8<");
    expect(html).toContain(">Show more<");
  });

  it("does not offer show-all when a tier fits", () => {
    const html = render(tier1(3));
    expect(html).not.toContain(">Show more<");
  });

  it("tolerates a long list (the durable table, not one run)", () => {
    const html = render(tier1(110));
    expect(html).toContain("110</b> saved");
    expect(html).toContain(">Show more<");
  });

  it("a status other than new shows as a chip on the card; new shows nothing", () => {
    const html = render([
      inv({ firm: "Replied Co", name: "Dana", replied: true }),
      inv({ firm: "Fresh Co", name: "Sam" }),
    ]);
    expect(html).toContain("replied");
    expect(html).not.toContain(">new<");
  });
});

describe("the state chips", () => {
  it("counts the list, the unreachable rows, and the send-readiness", () => {
    const html = render([
      inv({ firm: "A", name: "Dana" }),
      inv({ firm: "B", name: "" }),
      inv({ firm: "C", name: "" }),
    ]);
    expect(html).toContain("3</b> saved");
    expect(html).toContain("2</b> no named partner");
    expect(html).toContain("0</b> with email");
    expect(html).toContain("0</b> researched");
  });

  it("says how many have an email when some do", () => {
    const html = render([
      inv({ firm: "A", name: "Dana", durable_email: "dana@a.vc" }),
      inv({ firm: "B", name: "Sam" }),
    ]);
    expect(html).toContain("1</b> with email");
  });

  it("renders a zero rather than hiding it (an empty column is information)", () => {
    const html = render([inv({ firm: "A", name: "Dana" })]);
    expect(html).toContain("0</b> researched");
  });
});

describe("the round switcher", () => {
  it("offers all five rungs, none selected until the founder picks one", () => {
    const html = render([inv({ firm: "A", name: "Dana" })]);
    for (const s of ["Angel", "Pre-seed", "Seed", "Series A", "Series B+"]) {
      expect(html).toContain(`>${s}</button>`);
    }
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain("Pick one to rank and source for it");
  });

  it("marks the persisted round as selected and warns switching re-sources", () => {
    const html = render([inv({ firm: "A", name: "Dana" })], undefined, {
      round_config: { stage: "Seed" },
    });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Switching re-sources and merges, never replaces");
  });

  it("ignores a round the contract doesn't define rather than rendering it", () => {
    const html = render([inv({ firm: "A", name: "Dana" })], undefined, {
      round_config: { stage: "Series Z" },
    });
    expect(html).not.toContain('aria-checked="true"');
  });
});

describe("the one next step", () => {
  it("0 dossiers → deep round the strongest Tier 1 names", () => {
    const html = render(tier1(9));
    expect(html).toContain("Deep round your 5 strongest Tier 1 names");
    expect(html).toContain("Deep round these 5");
  });

  it("1 dossier → deep round one more", () => {
    const list = tier1(4);
    list[0] = { ...list[0], dossier: dossier() };
    const html = render(list);
    expect(html).toContain("Deep round one more");
    expect(html).toContain("Deep round the next Tier 1");
  });

  it("2+ dossiers → build the outreach plan, and the nudge appears", () => {
    const list = tier1(4).map((row, i) =>
      i < 2 ? { ...row, dossier: dossier() } : row,
    );
    const html = render(list);
    expect(html).toContain("Build your outreach plan");
    expect(html).toContain("2 investors researched");
    expect(html).toContain("Build outreach plan");
  });

  it("the next step is a suggestion — it never disables or hides the list", () => {
    const html = render(tier1(9));
    expect(html).toContain("Tier 1: strong fit");
    expect(html).not.toContain('disabled=""');
  });

  it("an empty list renders without a next-step button and without throwing", () => {
    const html = render([]);
    expect(html).toContain("Nothing pending from Zavi");
    expect(html).toContain("No investors saved yet");
  });
});

describe("the one refine input", () => {
  it("is a plain-English input that merges rather than replaces", () => {
    const html = render(tier1(2));
    expect(html).toContain('id="fr-refine"');
    expect(html).toContain("Refine in plain English");
    expect(html).toContain("A query never replaces it");
  });

  it("surfaces the merge result, including what was dropped and why", () => {
    const html = render(tier1(2), {
      added: 9,
      already_saved: 3,
      dropped: [
        "Apex Mobility Partners — firm name never appeared on the page I fetched",
      ],
    });
    expect(html).toContain("+9 new");
    expect(html).toContain("3 already saved");
    expect(html).toContain("1 dropped");
    expect(html).toContain("couldn&#x27;t confirm the firm on a page it");
    expect(html).toContain("see what was dropped");
  });

  it("renders no merge strip when the payload carries no merge summary", () => {
    const html = render(tier1(2));
    expect(html).not.toContain("already saved");
    expect(html).not.toContain("dropped");
  });
});

describe("the removed surfaces are gone", () => {
  it("no readiness scorecard, raise room, phases, gates or round design", () => {
    const html = render(
      tier1(4).map((row, i) => (i < 2 ? { ...row, dossier: dossier() } : row)),
    );
    for (const gone of [
      "Readiness",
      "Raise Room",
      "Warm-up",
      "Meetings",
      "Debrief",
      "Round design",
      "Meeting prep",
      "Objection",
      "Fundraising phases",
      "Done reviewing",
      "Approve Remaining",
      "Save for later",
      "Generate Pre-seed list",
      "Round: not set",
      "Follow-ups due",
      "Outreach status",
      "Evidence ledger",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("has no filter chips, view tabs or per-row dropdowns", () => {
    const html = render(tier1(4));
    expect(html).not.toContain("<select");
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("No investors match these filters");
  });

  it("offers exactly one text input on the whole list surface", () => {
    const html = render(tier1(9));
    expect(html.match(/<input/g)?.length ?? 0).toBe(1);
  });
});

describe("nothing on this surface sends anything", () => {
  it("the list surface offers no send control", () => {
    const html = render(
      tier1(4).map((row, i) => (i < 2 ? { ...row, dossier: dossier() } : row)),
    );
    expect(html).not.toContain("Send now");
    expect(html).not.toContain("Send email");
    expect(html).not.toMatch(/>\s*Send\s*</);
  });

  it("the plan says plainly that the founder sends, not Zavi", () => {
    const html = renderToStaticMarkup(
      <OutreachPlanView
        investors={[
          inv({ firm: "Warm Co", name: "Dana", dossier: dossier() }),
          inv({ firm: "Cold Co", name: "", dossier: dossier() }),
          inv({ firm: "Unread Co", name: "Sam" }),
        ]}
        onBack={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Zavi does not send anything");
    expect(html).toContain("Go first: a named partner (1)");
    expect(html).toContain("Research before contact (1)");
    expect(html).toContain("1 saved investor has no deep round");
    expect(html).not.toContain("Unread Co");
  });
});

describe("one investor's read view", () => {
  const view = (row: FundraisingInvestor, researching = false) =>
    renderToStaticMarkup(
      <InvestorReadView
        inv={row}
        researching={researching}
        onBack={() => {}}
        onDeepRound={() => {}}
        onMark={() => {}}
      />,
    );

  it("un-researched → offers the deep round instead of a half-empty dossier", () => {
    const html = view(inv({ firm: "Acme Ventures" }));
    expect(html).toContain("Why they&#x27;re on your list");
    expect(html).toContain("Deep round Acme Ventures");
    expect(html).not.toContain(">Who they are</h4>");
    expect(html).not.toContain(">Draft first message</h4>");
  });

  it("researching → says so, and does not re-offer the deep round", () => {
    const html = view(inv({ firm: "Acme Ventures" }), true);
    expect(html).toContain("Researching Acme Ventures");
    expect(html).not.toContain("Deep round Acme Ventures");
  });

  it("researched with a verified person → the full read, and Zavi still does not send", () => {
    const html = view(inv({ dossier: dossier() }));
    expect(html).toContain("Who they are");
    expect(html).toContain("Why you, specifically");
    expect(html).toContain("How to reach them");
    expect(html).toContain("Draft first message");
    expect(html).toContain("What they&#x27;ll push on");
    expect(html).toContain("Sources");
    expect(html).toContain("acme.vc/team");
    expect(html).toContain("Nothing is from");
    expect(html).toContain("Zavi does not send. Copy it and send it yourself.");
  });

  it("no verified person → the REFUSAL, never a fabricated draft", () => {
    const html = view(
      inv({ firm: "Maniv Mobility", name: "", dossier: dossier({ draft_message: "" }) }),
    );
    expect(html).toContain("no named partner");
    expect(html).toContain("No draft.");
    expect(html).toContain("Name the partner at Maniv Mobility first");
    expect(html).not.toContain("Copy it and send it yourself");
    expect(html).not.toContain("Subject: 90% host payout");
  });

  it("status is set from links here, not a per-row dropdown", () => {
    const html = view(inv({ dossier: dossier() }));
    expect(html).toContain("Currently: <span");
    expect(html).toContain("mark reached out");
    expect(html).toContain("mark replied");
    expect(html).toContain("mark passed");
    expect(html).not.toContain("<select");
  });

  it("names the channel on the control when the research stated one", () => {
    const html = view(
      inv({ dossier: dossier({ how_to_reach: { best_channel: "LinkedIn" } }) }),
    );
    expect(html).toContain("mark reached out via LinkedIn");
    expect(html).not.toContain("Which channel?");
    expect(html).not.toContain("<select");
  });

  it("the current status is not offered as a thing to re-mark", () => {
    const html = view(inv({ dossier: dossier(), replied: true }));
    expect(html).not.toContain("mark replied");
    expect(html).toContain("mark passed");
    expect(html).toContain(">clear<");
  });

  it("a row with no server-supplied key keeps its status controls inert", () => {
    const html = view(
      inv({ review_key: undefined, identity_key: undefined, dossier: dossier() }),
    );
    expect(html).not.toContain("mark reached out");
    expect(html).toContain("can&#x27;t be saved yet");
  });
});
