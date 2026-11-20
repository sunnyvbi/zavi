
import { describe, it, expect } from "vitest";
import {
  applyStatusOverride,
  asHref,
  buildOutreachPlan,
  computeNextStep,
  investorKey,
  investorOutreachChannel,
  investorStatus,
  investorWriteKey,
  listCounts,
  mapOutreachChannel,
  normalizeDossier,
  pickForDeepRound,
  researchSentence,
  sourceLabel,
  splitTiers,
  tierLabel,
  tierOf,
  type FundraisingInvestor,
} from "./fundraising-dashboard-util";

const dossier = (over: Record<string, unknown> = {}) => ({
  who_they_are: "Partner since 2019.",
  why_this_company: "Your host-payout wedge maps to their thesis.",
  how_to_reach: { warm_path: "A warm path exists." },
  draft_message: "Subject: 90% host payout",
  pushbacks: [
    { objection: "Why won't the incumbent match it?", honest_answer: "Margin." },
  ],
  sources: [{ url: "example.com/team", claim: "Team page" }],
  ...over,
});

const inv = (over: Partial<FundraisingInvestor> = {}): FundraisingInvestor => {
  const firm = over.firm ?? "Acme Ventures";
  const name = over.name ?? "Dana Lee";
  return {
    firm,
    name,
    tier: 1,
    fit_rationale: "Marketplace thesis.",
    source: "web",
    source_url: "https://acme.vc",
    review_key: `${firm}|${name}`,
    ...over,
  };
};

const NONE: ReadonlySet<string> = new Set<string>();

describe("normalizing the agent's dossier", () => {
  it("reads the shape the agent actually emits", () => {
    const d = normalizeDossier({
      who_they_are: "Partner since 2019.",
      why_this_company: "Your payout wedge is timed.",
      how_to_reach: {
        warm_path: "A shared portfolio founder can forward.",
        best_channel: "warm intro",
        who_to_go_through: "Their Series A founder.",
      },
      draft_message: "Subject: hi",
      pushbacks: [
        { objection: "Why won't they match?", honest_answer: "Margin." },
      ],
      sources: [{ url: "acme.vc/team", claim: "Names the partner" }],
    });
    expect(d).not.toBeNull();
    expect(d?.who).toBe("Partner since 2019.");
    expect(d?.why_you).toBe("Your payout wedge is timed.");
    expect(d?.how_to_reach).toBe(
      "A shared portfolio founder can forward.\n\nBest channel: warm intro\n\nGo through: Their Series A founder.",
    );
    expect(d?.what_theyll_push_on).toBe("Why won't they match?\n\nMargin.");
    expect(d?.sources).toEqual(["acme.vc/team · Names the partner"]);
  });

  it("carries the agent's own refusal instead of inventing one", () => {
    const d = normalizeDossier({
      who_they_are: "Four-person investing team.",
      draft_message: "",
      no_draft_reason: "The page named no partner, so there is no one to write to.",
    });
    expect(d?.draft_message).toBe("");
    expect(d?.no_draft_reason).toBe(
      "The page named no partner, so there is no one to write to.",
    );
  });

  it("also accepts the pre-normalized display shape", () => {
    const d = normalizeDossier({
      who: "Partner since 2019.",
      why_you: "Timed wedge.",
      how_to_reach: "Warm path exists.",
      what_theyll_push_on: "Take rate.",
      sources: ["acme.vc/team"],
    });
    expect(d?.who).toBe("Partner since 2019.");
    expect(d?.how_to_reach).toBe("Warm path exists.");
    expect(d?.what_theyll_push_on).toBe("Take rate.");
    expect(d?.sources).toEqual(["acme.vc/team"]);
  });

  it("a thin dossier renders as blanks, never as stray punctuation", () => {
    const d = normalizeDossier({ who_they_are: "All we know." });
    expect(d?.who).toBe("All we know.");
    expect(d?.how_to_reach).toBe("");
    expect(d?.what_theyll_push_on).toBe("");
    expect(d?.sources).toEqual([]);
  });

  it("anything that is not an object reads as not-researched, never a throw", () => {
    expect(normalizeDossier(null)).toBeNull();
    expect(normalizeDossier(undefined)).toBeNull();
    expect(normalizeDossier("a string")).toBeNull();
    expect(normalizeDossier([])).toBeNull();
  });

  it("survives garbage inside the arrays", () => {
    const d = normalizeDossier({
      pushbacks: [null, 42, { objection: "Real one" }],
      sources: [null, { url: "" }, "acme.vc"],
    });
    expect(d?.what_theyll_push_on).toBe("Real one");
    expect(d?.sources).toEqual(["acme.vc"]);
  });
});

describe("investor identity + status", () => {
  it("prefers the server-supplied review_key as the write key", () => {
    const row = inv({ review_key: "Acme Ventures|Dana Lee" });
    expect(investorWriteKey(row)).toBe("Acme Ventures|Dana Lee");
    expect(investorKey(row)).toBe("Acme Ventures|Dana Lee");
  });

  it("falls back to identity_key, then to a local key that is NOT a write key", () => {
    const overlay = inv({ review_key: undefined, identity_key: "k2" });
    expect(investorWriteKey(overlay)).toBe("k2");

    const legacy = inv({
      firm: "Beta Fund",
      name: "Sam Roy",
      review_key: undefined,
      identity_key: undefined,
    });
    expect(investorKey(legacy)).toBe("beta fund|sam roy");
    expect(investorWriteKey(legacy)).toBeNull();
  });

  it("derives status from persisted markers, most-advanced-fact first", () => {
    expect(investorStatus(inv())).toBe("new");
    expect(investorStatus(inv({ dossier: dossier() }))).toBe("researched");
    expect(
      investorStatus(
        inv({ dossier: dossier(), last_sent_at: "2026-07-01T00:00:00Z" }),
      ),
    ).toBe("reached out");
    expect(
      investorStatus(
        inv({
          dossier: dossier(),
          sent_markers: [{ channel: "email", sent_at: "2026-07-01T00:00:00Z" }],
        }),
      ),
    ).toBe("reached out");
    expect(
      investorStatus(
        inv({ last_sent_at: "2026-07-01T00:00:00Z", replied: true }),
      ),
    ).toBe("replied");
    expect(investorStatus(inv({ replied: true, review_state: "removed" }))).toBe(
      "passed",
    );
  });

  it("approved / saved are NOT statuses on this surface", () => {
    expect(investorStatus(inv({ review_state: "approved" }))).toBe("new");
    expect(investorStatus(inv({ review_state: "saved" }))).toBe("new");
  });
});

describe("optimistic status override", () => {
  const now = "2026-07-30T00:00:00Z";

  it("makes the clicked status the one every view derives", () => {
    const row = inv({ dossier: dossier() });
    expect(investorStatus(applyStatusOverride(row, "passed", now))).toBe(
      "passed",
    );
    expect(investorStatus(applyStatusOverride(row, "replied", now))).toBe(
      "replied",
    );
    expect(investorStatus(applyStatusOverride(row, "reached out", now))).toBe(
      "reached out",
    );
  });

  it("clearing drops every marker, falling back to the dossier-derived status", () => {
    const row = inv({
      dossier: dossier(),
      replied: true,
      review_state: "removed",
      last_sent_at: now,
      sent_markers: [{ channel: "email", sent_at: now }],
    });
    expect(investorStatus(applyStatusOverride(row, "new", now))).toBe(
      "researched",
    );
  });
});

describe("tiers", () => {
  it("buckets anything that is not an explicit 1 or 2 into tier 3", () => {
    expect(tierOf(1)).toBe(1);
    expect(tierOf(2)).toBe(2);
    expect(tierOf(3)).toBe(3);
    expect(tierOf(0)).toBe(3);
    expect(tierOf(9)).toBe(3);
  });

  it("labels tiers in the founder's words", () => {
    expect(tierLabel(1)).toBe("Tier 1: strong fit");
    expect(tierLabel(2)).toBe("Tier 2: solid");
    expect(tierLabel(3)).toBe("Tier 3: broader");
  });

  it("splits a list without dropping a row", () => {
    const list = [
      inv({ firm: "A", tier: 1 }),
      inv({ firm: "B", tier: 2 }),
      inv({ firm: "C", tier: 3 }),
      inv({ firm: "D", tier: 0 }),
    ];
    const { tier1, tier2, tier3 } = splitTiers(list);
    expect(tier1.map((i) => i.firm)).toEqual(["A"]);
    expect(tier2.map((i) => i.firm)).toEqual(["B"]);
    expect(tier3.map((i) => i.firm)).toEqual(["C", "D"]);
    expect(tier1.length + tier2.length + tier3.length).toBe(list.length);
  });
});

describe("the state line's counts", () => {
  it("counts the list, the unreachable rows, the emails, and the dossiers", () => {
    const list = [
      inv({ firm: "A", name: "Dana" }),
      inv({ firm: "B", name: "" }),
      inv({ firm: "C", name: "   " }),
      inv({
        firm: "D",
        name: "Sam",
        durable_email: "sam@d.vc",
        dossier: dossier(),
      }),
    ];
    expect(listCounts(list)).toEqual({
      total: 4,
      noPartner: 2,
      withEmail: 1,
      researched: 1,
    });
  });

  it("treats a blank durable_email as no email", () => {
    expect(listCounts([inv({ durable_email: "  " })]).withEmail).toBe(0);
    expect(listCounts([inv({ durable_email: null })]).withEmail).toBe(0);
  });

  it("says what the research depth means", () => {
    expect(researchSentence(0)).toContain("Nothing has been researched");
    expect(researchSentence(1)).toContain("One deep round done");
    expect(researchSentence(7)).toContain("7 researched deeply");
  });
});

describe("the one next step", () => {
  const tier1 = (n: number, over: Partial<FundraisingInvestor> = {}) =>
    Array.from({ length: n }, (_, i) =>
      inv({ firm: `Firm ${i}`, name: `P ${i}`, tier: 1, ...over }),
    );

  it("0 dossiers → deep round the strongest Tier 1 names", () => {
    const step = computeNextStep({
      investors: tier1(9),
      researching: NONE,
      planBuilt: false,
    });
    expect(step.key).toBe("deep_first");
    expect(step.title).toBe("Deep round your 5 strongest Tier 1 names");
    expect(step.action).toEqual({ kind: "deep_top", count: 5 });
  });

  it("0 dossiers but only 2 Tier 1 rows → offers exactly 2", () => {
    const step = computeNextStep({
      investors: tier1(2),
      researching: NONE,
      planBuilt: false,
    });
    expect(step.title).toBe("Deep round your 2 strongest Tier 1 names");
    expect(step.action).toEqual({ kind: "deep_top", count: 2 });
  });

  it("1 dossier → deep round one more", () => {
    const list = tier1(4);
    list[0] = { ...list[0], dossier: dossier() };
    const step = computeNextStep({
      investors: list,
      researching: NONE,
      planBuilt: false,
    });
    expect(step.key).toBe("deep_one_more");
    expect(step.action).toEqual({ kind: "deep_top", count: 1 });
  });

  it("2+ dossiers → build the outreach plan", () => {
    const list = tier1(4).map((row, i) =>
      i < 2 ? { ...row, dossier: dossier() } : row,
    );
    const step = computeNextStep({
      investors: list,
      researching: NONE,
      planBuilt: false,
    });
    expect(step.key).toBe("build_plan");
    expect(step.why).toContain("2 investors researched");
    expect(step.action).toEqual({ kind: "build_plan" });
  });

  it("plan already opened, drafts unsent → you send them, then mark them", () => {
    const list = tier1(3).map((row, i) =>
      i < 2 ? { ...row, dossier: dossier() } : row,
    );
    const step = computeNextStep({
      investors: list,
      researching: NONE,
      planBuilt: true,
    });
    expect(step.key).toBe("send_yourself");
    expect(step.title).toBe("Send 2 drafts yourself, then mark them");
    expect(step.why).toContain("doesn't send");
    expect(step.action).toEqual({ kind: "open_plan" });
  });

  it("no investors at all → never claims researched work is marked", () => {
    const step = computeNextStep({
      investors: [],
      researching: NONE,
      planBuilt: false,
    });
    expect(step.key).toBe("nothing_pending");
    expect(step.why).not.toContain("Everything you've researched");
    expect(step.why).toContain("Ask the Fundraising agent in chat");
  });

  it("everything researched is marked → nothing pending", () => {
    const list = [
      inv({
        firm: "A",
        name: "Dana",
        dossier: dossier(),
        last_sent_at: "2026-07-01T00:00:00Z",
      }),
      inv({
        firm: "B",
        name: "Sam",
        dossier: dossier(),
        last_sent_at: "2026-07-01T00:00:00Z",
      }),
    ];
    const step = computeNextStep({
      investors: list,
      researching: NONE,
      planBuilt: true,
    });
    expect(step.key).toBe("nothing_pending");
    expect(step.cta).toBeNull();
    expect(step.action).toBeNull();
  });

  it("in-flight deep rounds win over every other state, with no button", () => {
    const step = computeNextStep({
      investors: tier1(4),
      researching: new Set(["Firm 0|P 0", "Firm 1|P 1"]),
      planBuilt: false,
    });
    expect(step.key).toBe("researching");
    expect(step.title).toBe("Researching 2 investors");
    expect(step.cta).toBeNull();
  });

  it("never proposes deep-rounding a passed investor", () => {
    const list = tier1(2).map((row) => ({
      ...row,
      review_state: "removed" as const,
    }));
    const step = computeNextStep({
      investors: list,
      researching: NONE,
      planBuilt: false,
    });
    expect(step.key).toBe("nothing_pending");
    expect(step.action).toBeNull();
  });

  it("an empty list has nothing to say and no button", () => {
    const step = computeNextStep({
      investors: [],
      researching: NONE,
      planBuilt: false,
    });
    expect(step.key).toBe("nothing_pending");
    expect(step.cta).toBeNull();
  });
});

describe("picking rows for a deep round", () => {
  it("takes Tier 1 first, skipping researched / in-flight / passed", () => {
    const list = [
      inv({ firm: "T3", name: "a", tier: 3 }),
      inv({ firm: "Done", name: "b", tier: 1, dossier: dossier() }),
      inv({ firm: "Busy", name: "c", tier: 1 }),
      inv({ firm: "Gone", name: "d", tier: 1, review_state: "removed" }),
      inv({ firm: "Top", name: "e", tier: 1 }),
      inv({ firm: "T2", name: "f", tier: 2 }),
    ];
    const picked = pickForDeepRound(list, new Set(["Busy|c"]), 3);
    expect(picked.map((i) => i.firm)).toEqual(["Top", "T2", "T3"]);
  });

  it("returns nothing for a non-positive count", () => {
    expect(pickForDeepRound([inv()], NONE, 0)).toEqual([]);
    expect(pickForDeepRound([inv()], NONE, -2)).toEqual([]);
  });
});

describe("the outreach plan", () => {
  it("only researched investors appear, split by whether you can reach a person", () => {
    const list = [
      inv({ firm: "Warm", name: "Dana", dossier: dossier() }),
      inv({ firm: "Cold", name: "", dossier: dossier() }),
      inv({ firm: "Unread", name: "Sam" }),
      inv({ firm: "AlsoUnread", name: "Kim" }),
    ];
    const plan = buildOutreachPlan(list);
    expect(plan.goFirst.map((i) => i.firm)).toEqual(["Warm"]);
    expect(plan.researchFirst.map((i) => i.firm)).toEqual(["Cold"]);
    expect(plan.unresearched).toBe(2);
  });
});

describe("source display", () => {
  it("names where the row came from in plain words", () => {
    expect(sourceLabel("investor_db")).toBe("from the investor DB");
    expect(sourceLabel("web")).toBe("found on the web");
    expect(sourceLabel("investor_directory")).toBe("found on the web");
  });
});

describe("asHref", () => {
  it("pulls the first usable URL out of a compound hint", () => {
    expect(asHref("https://acme.vc/team")).toBe("https://acme.vc/team");
    expect(asHref("acme.vc / @acmevc")).toBe("https://acme.vc");
    expect(asHref("@acmevc")).toBeNull();
    expect(asHref("   ")).toBeNull();
  });
});

describe("the outreach channel is never guessed", () => {
  it("maps a channel the dossier states unambiguously", () => {
    expect(mapOutreachChannel("LinkedIn")).toBe("linkedin");
    expect(mapOutreachChannel("LinkedIn DM")).toBe("linkedin");
    expect(mapOutreachChannel("linked-in")).toBe("linkedin");
    expect(mapOutreachChannel("Email")).toBe("email");
    expect(mapOutreachChannel("cold e-mail to her direct address")).toBe("email");
    expect(mapOutreachChannel("Twitter")).toBe("twitter");
    expect(mapOutreachChannel("DM on X")).toBe("twitter");
    expect(mapOutreachChannel("warm intro")).toBe("warm_intro");
    expect(mapOutreachChannel("A warm introduction from a portfolio founder")).toBe(
      "warm_intro",
    );
  });

  it("refuses to pick when the text names two channels, or none", () => {
    expect(mapOutreachChannel("warm intro, otherwise email")).toBeNull();
    expect(mapOutreachChannel("email or LinkedIn")).toBeNull();
    expect(mapOutreachChannel("their contact form")).toBeNull();
    expect(mapOutreachChannel("")).toBeNull();
    expect(mapOutreachChannel("   ")).toBeNull();
  });

  it("reads best_channel off a real dossier, and nothing else", () => {
    expect(
      investorOutreachChannel(
        inv({ dossier: dossier({ how_to_reach: { best_channel: "LinkedIn" } }) }),
      ),
    ).toBe("linkedin");

    expect(
      investorOutreachChannel(
        inv({ dossier: dossier({ how_to_reach: { warm_path: "Jane can forward it." } }) }),
      ),
    ).toBeNull();

    expect(investorOutreachChannel(inv())).toBeNull();
  });

  it("keeps the stated channel on the normalized dossier AND in the prose", () => {
    const d = normalizeDossier({
      how_to_reach: { best_channel: "LinkedIn", warm_path: "Jane forwards it." },
    });
    expect(d?.best_channel).toBe("LinkedIn");
    expect(d?.how_to_reach).toContain("Best channel: LinkedIn");
  });
});

describe("mapOutreachChannel — negation makes it ask, never assume", () => {
  it("refuses to derive from a phrase that rules a channel OUT", () => {
    expect(mapOutreachChannel("not email")).toBeNull();
    expect(mapOutreachChannel("never email her, she doesn't read it")).toBeNull();
    expect(mapOutreachChannel("avoid LinkedIn")).toBeNull();
    expect(mapOutreachChannel("no warm intro available")).toBeNull();
    expect(mapOutreachChannel("don't use Twitter")).toBeNull();
  });

  it("still derives cleanly from an unambiguous positive statement", () => {
    expect(mapOutreachChannel("LinkedIn")).toBe("linkedin");
    expect(mapOutreachChannel("best reached by email")).toBe("email");
    expect(mapOutreachChannel("warm intro through a portfolio founder")).toBe(
      "warm_intro",
    );
  });

  it("still asks when two channels are named", () => {
    expect(mapOutreachChannel("intro or email")).toBeNull();
    expect(mapOutreachChannel("not email — use LinkedIn")).toBeNull();
  });
});
