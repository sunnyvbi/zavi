
import { describe, it, expect } from "vitest";
import { START_CARD_DONE_FIXTURE, type StartCardScore } from "@zavi/shared";
import { StageUnavailableError, type StageContext } from "../checks/contract";
import { runDiagnosis, lowestChecks, isGrounded, allowedFrom, numbersIn, templateFor } from "../checks/diagnosis";

const F = START_CARD_DONE_FIXTURE;
const score = F.score!;
const ctx: StageContext & { score: StartCardScore } = {
  card_id: "c",
  domain: F.domain,
  url: `https://${F.domain}/`,
  profile: F.parts.profile!.evidence!,
  parts: F.parts,
  score,
};

const reply = (o: unknown) => async () => JSON.stringify(o);

describe("lowestChecks", () => {
  it("two lowest available, ties in display order", () => {
    expect(lowestChecks(score)).toEqual(["ai", "compare"]);
    expect(lowestChecks({ total: 5, out_of: 40, by_check: { google: null, ai: null, seo: 5, design: 0, compare: null } })).toEqual([
      "design",
      "seo",
    ]);
  });
});

describe("grounding", () => {
  it("numbers must be in the evidence; commas normalised", () => {
    const allowed = allowedFrom('{"position":6,"visits":"1200"}', score);
    expect(numbersIn("1,200 visits")).toEqual(["1200"]);
    expect(isGrounded("You rank #6 and get 1,200 visits", allowed)).toBe(true);
    expect(isGrounded("You could get 40% more calls", allowed)).toBe(false);
  });
  it("sites must be in the evidence", () => {
    const allowed = allowedFrom('{"domain":"crumbhouse.example"}', score);
    expect(isGrounded("crumbhouse.example beats you", allowed)).toBe(true);
    expect(isGrounded("competitor.com beats you", allowed)).toBe(false);
  });
});

describe("runDiagnosis: pages the site already has", () => {
  const withPages = (site_pages: string[]): typeof ctx => ({
    ...ctx,
    parts: { ...ctx.parts, seo: { ...ctx.parts.seo!, evidence: { ...ctx.parts.seo!.evidence!, site_pages } } },
  });

  it("shows the model the site's pages, so it can't ask for one that exists", async () => {
    let sent = "";
    await runDiagnosis(withPages(["/turo-alternative", "/blog/upcar-vs-turo"]), {
      complete: async (_system, user) => {
        sent = user;
        return "{}";
      },
    });
    expect(JSON.parse(sent).site_pages).toEqual(["/turo-alternative", "/blog/upcar-vs-turo"]);
  });

  it("leaves the field out for an older card with no list", async () => {
    let sent = "";
    await runDiagnosis(ctx, {
      complete: async (_system, user) => {
        sent = user;
        return "{}";
      },
    });
    expect(JSON.parse(sent)).not.toHaveProperty("site_pages");
  });

  it("the Google fallback holds whether or not the page already exists", () => {
    const g = { search_term: "turo alternative", position: null, results_checked: 10 } as never;
    expect(templateFor("google", { profile: null, google: g }).action.title).toBe("Make one page your answer to “turo alternative”");
  });

  it("does not let a number in a URL through as a measurement", async () => {
    const out = await runDiagnosis(withPages(["/blog/2019-recap"]), {
      complete: reply({
        constraint: { check_key: "ai", title: "Two AI assistants don't name you", why: "Gemini and Claude named Crumbhouse, not you." },
        action_this_week: { title: "Add a meta description", why: "2019 buyers read them." },
      }),
    });
    expect(out.evidence.constraint.title).toBe("Two AI assistants don't name you");
    expect(out.evidence.action_this_week.why).not.toContain("2019");
  });
});

describe("runDiagnosis", () => {
  it("keeps a grounded model answer on an allowed check", async () => {
    const out = await runDiagnosis(ctx, {
      complete: reply({
        constraint: { check_key: "ai", title: "Two AI assistants don't name you", why: "Gemini and Claude named Crumbhouse, not you." },
        action_this_week: { title: "Add a meta description", why: "Your homepage has none, and assistants quote short descriptions." },
      }),
    });
    expect(out.evidence.constraint).toEqual({
      check_key: "ai",
      title: "Two AI assistants don't name you",
      why: "Gemini and Claude named Crumbhouse, not you.",
    });
    expect(out.evidence.action_this_week.title).toBe("Add a meta description");
    expect(out.cost_usd).toBeGreaterThan(0);
  });

  it("a check_key outside the two lowest → the lowest check's template", async () => {
    const out = await runDiagnosis(ctx, {
      complete: reply({
        constraint: { check_key: "google", title: "Google is your problem", why: "You rank #6." },
        action_this_week: { title: "x", why: "y" },
      }),
    });
    expect(out.evidence.constraint.check_key).toBe("ai");
    expect(out.evidence.constraint.title).toBe("Some AI assistants don't name you");
    expect(out.evidence.constraint.why).toContain("Gemini, Claude did not mention you");
  });

  it("an invented number refuses the text", async () => {
    const out = await runDiagnosis(ctx, {
      complete: reply({
        constraint: { check_key: "compare", title: "You lose 37% of buyers to rivals", why: "Rivals win." },
        action_this_week: { title: "Do a thing", why: "It helps." },
      }),
    });
    expect(out.evidence.constraint.title).not.toContain("37");
    expect(out.evidence.constraint.check_key).toBe("ai");
  });

  it("an unsourced site refuses the text", async () => {
    const out = await runDiagnosis(ctx, {
      complete: reply({
        constraint: { check_key: "compare", title: "bigbakery.com is ahead", why: "They rank higher." },
        action_this_week: { title: "Do a thing", why: "It helps." },
      }),
    });
    expect(out.evidence.constraint.title).not.toContain("bigbakery.com");
  });

  it("a rival named when the model was not shown rivals refuses the text", async () => {
    const s: StartCardScore = { ...score, by_check: { google: 20, ai: 20, seo: 5, design: 6, compare: 20 } };
    const out = await runDiagnosis({ ...ctx, score: s }, {
      complete: reply({
        constraint: { check_key: "seo", title: "Crumbhouse has better basics", why: "Your homepage has no meta description." },
        action_this_week: { title: "Add a meta description", why: "Your homepage has none." },
      }),
    });
    expect(out.evidence.constraint.title).not.toContain("Crumbhouse");
    expect(out.evidence.constraint.check_key).toBe("seo");
  });

  it("the model's action is dropped when its constraint was refused", async () => {
    const out = await runDiagnosis(ctx, {
      complete: reply({
        constraint: { check_key: "seo", title: "t", why: "w" },
        action_this_week: { title: "Model action", why: "Grounded." },
      }),
    });
    expect(out.evidence.action_this_week.title).not.toBe("Model action");
  });

  it("no model (throws) → templates from evidence, still done", async () => {
    const out = await runDiagnosis(ctx, {
      complete: async () => {
        throw new Error("down");
      },
    });
    expect(out.evidence.constraint.check_key).toBe("ai");
    expect(out.evidence.action_this_week.title.length).toBeGreaterThan(0);
  });

  it("every template only cites numbers in the evidence", async () => {
    for (const key of ["google", "seo", "design", "compare"] as const) {
      const s: StartCardScore = { ...score, by_check: { google: 20, ai: 20, seo: 20, design: 20, compare: 20, [key]: 0 } };
      const out = await runDiagnosis({ ...ctx, score: s }, { complete: async () => "no json" });
      expect(out.evidence.constraint.check_key).toBe(key);
      const allowed = allowedFrom(JSON.stringify({ parts: F.parts, profile: ctx.profile }), s);
      expect(isGrounded(out.evidence.constraint.title + " " + out.evidence.constraint.why, allowed)).toBe(true);
    }
  });

  it("no available check → unavailable", async () => {
    await expect(
      runDiagnosis({ ...ctx, score: { total: 0, out_of: 0, by_check: { google: null, ai: null, seo: null, design: null, compare: null } } }),
    ).rejects.toBeInstanceOf(StageUnavailableError);
  });
});
