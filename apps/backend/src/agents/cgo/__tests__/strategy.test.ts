import { describe, it, expect } from "vitest";
import { parseStrategy, renderStrategy, isMeasurableMetric } from "../strategy";

function envelope(body: unknown): string {
  return `Here is what I think.\n\n<strategy>\n${JSON.stringify(body)}\n</strategy>\n`;
}

const VALID = {
  north_star: { metric: "activation_rate", why: "signups stall", provenance: "funnel" },
  constraint: {
    statement: "Activation is binding",
    lever_family: "activation",
    evidence: "60% never complete setup",
    confidence: "high",
  },
  channel_bets: [
    { channel_slug: "email_marketing", intent: "Email the 400 signups who never finished setup, weekly for a month", rationale: "reach existing", expected_effect: "+5pt", falsifier: "Four sends and setup completion has not moved off 22%" },
    { channel_slug: "seo", intent: "Publish one comparison page a week against named rivals", rationale: "compounding", expected_effect: "traffic", falsifier: "Eight weeks and no page ranks top 20 for its own title" },
  ],
  goal: {
    objective: "Lift activation to 40%",
    target_metric: "activation_rate",
    target_value: 40,
    due_date: "2026-12-31",
  },
  gaps: ["What is your monthly budget?"],
  unmeasured: [{ lever: "involuntary churn", the_one_read_that_would_size_it: "Stripe failures" }],
};

describe("parseStrategy", () => {
  it("parses a well-formed envelope", () => {
    const r = parseStrategy(envelope(VALID));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.north_star.metric).toBe("activation_rate");
    expect(r.strategy.constraint.confidence).toBe("high");
    expect(r.strategy.channel_bets).toHaveLength(2);
    expect(r.strategy.goal?.target_value).toBe(40);
  });

  it("fails closed when there is no strategy block (a plain chat turn)", () => {
    const r = parseStrategy("Sure — what do you mean by activation?");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no <strategy> block/);
  });

  it("rejects a strategy with no binding constraint", () => {
    const { constraint, ...rest } = VALID;
    const r = parseStrategy(envelope(rest));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/constraint\.statement/);
  });

  it("rejects a strategy with no North Star", () => {
    const { north_star, ...rest } = VALID;
    const r = parseStrategy(envelope(rest));
    expect(r.ok).toBe(false);
  });

  it("drops an unmeasurable goal instead of persisting junk", () => {
    for (const bad of [
      { ...VALID.goal, target_value: 0 },
      { ...VALID.goal, target_value: "lots" },
      { ...VALID.goal, due_date: "end of August" },
      { ...VALID.goal, target_metric: "" },
    ]) {
      const r = parseStrategy(envelope({ ...VALID, goal: bad }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.strategy.goal).toBeNull();
    }
  });

  it("drops a goal whose target is a multiple, so the page never says 1.5 new customers", () => {
    const due = { due_date: "2027-01-29" };
    for (const bad of [
      { objective: "Grow new customers to 1.5x the week-1 baseline by Jan 29", target_metric: "new_customers", target_value: 1.5, ...due },
      { objective: "Reach 2x the week-1 signups by Jan 29", target_metric: "signups", target_value: 2, ...due },
      { objective: "Reach more bookings by Jan 29", target_metric: "new_bookings", target_value: 1.5, ...due },
      { objective: "Grow conversion to 1.5x the current 4% by Jan 29", target_metric: "conversion_rate", target_value: 1.5, ...due },
      { objective: "Double weekly signups from 10 by Jan 29", target_metric: "signups", target_value: 2, ...due },
      { objective: "Reach 3× the week-1 signups by Jan 29", target_metric: "signups", target_value: 3, ...due },
      { objective: "Reach 2 times the week-1 signups by Jan 29", target_metric: "signups", target_value: 2, ...due },
    ]) {
      const r = parseStrategy(envelope({ ...VALID, goal: bad }));
      expect(r.ok && r.strategy.goal).toBeNull();
    }
  });

  it("keeps a real number, and a fraction on a metric that can be one", () => {
    const due = { due_date: "2027-01-29" };
    for (const good of [
      { objective: "Reach 40 new customers by Jan 29, about 2x the week-1 count", target_metric: "new_customers", target_value: 40, ...due },
      { objective: "Lift conversion to 1.5% by Jan 29", target_metric: "conversion_rate", target_value: 1.5, ...due },
      { objective: "Hold ROAS at 2x by Jan 29", target_metric: "roas", target_value: 2, ...due },
      { objective: "Reach 3x LTV:CAC by Jan 29", target_metric: "ltv_cac", target_value: 3, ...due },
      { objective: "Cut time to first booking to 1.5 days by Jan 29", target_metric: "days_to_first_booking", target_value: 1.5, ...due },
      { objective: "Reach $1,250.50 MRR by Jan 29", target_metric: "mrr", target_value: 1250.5, ...due },
      { objective: "Cut payback period to 1.5 months by Jan 29", target_metric: "payback_period", target_value: 1.5, ...due },
    ]) {
      const r = parseStrategy(envelope({ ...VALID, goal: good }));
      expect(r.ok && r.strategy.goal?.target_value).toBe(good.target_value);
    }
  });

  it("caps channel bets at 3 — two or three, never ten", () => {
    const real = ["email_marketing", "seo", "google_ads", "meta_ads", "sms", "ugc"];
    const many = real.map((slug) => ({
      channel_slug: slug,
      intent: `Run a weekly ${slug} push at the stalled signups`,
      rationale: "r",
      expected_effect: "e",
      falsifier: `Four weeks of ${slug} and activation has not moved`,
    }));
    const r = parseStrategy(envelope({ ...VALID, channel_bets: many }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets).toHaveLength(3);
    expect(r.strategy.channel_bets[0].channel_slug).toBe("email_marketing");
  });

  it("drops a bet on a channel that does not exist", () => {
    const r = parseStrategy(
      envelope({
        ...VALID,
        channel_bets: [
          { channel_slug: "carrier_pigeon", intent: "Send birds to the stalled signups weekly", rationale: "r", expected_effect: "e", falsifier: "Four weeks and no bird returns" },
          { channel_slug: "seo", intent: "Publish one comparison page a week against named rivals", rationale: "r", expected_effect: "e", falsifier: "Eight weeks and no page ranks top 20" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets.map((b) => b.channel_slug)).toEqual(["seo"]);
  });

  it("drops a bet on a retired channel: nothing would run it", () => {
    const r = parseStrategy(
      envelope({
        ...VALID,
        channel_bets: [
          { channel_slug: "blog", intent: "Publish two posts a week on buyer questions", rationale: "r", expected_effect: "e", falsifier: "Eight weeks and no post ranks top 20" },
          VALID.channel_bets[1],
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets.map((b) => b.channel_slug)).toEqual(["seo"]);
  });

  it("drops a bet with no intent — a label is not an instruction", () => {
    const r = parseStrategy(
      envelope({
        ...VALID,
        channel_bets: [
          { channel_slug: "seo", rationale: "compounding", expected_effect: "traffic", falsifier: "Eight weeks and no page ranks top 20" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets).toHaveLength(0);
  });

  it("drops a bet with no falsifier — a bet nobody can call wrong is not a bet", () => {
    const r = parseStrategy(
      envelope({
        ...VALID,
        channel_bets: [
          { channel_slug: "seo", intent: "Publish one comparison page a week", rationale: "r", expected_effect: "e" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets).toHaveLength(0);
  });

  it("drops a bet whose intent is just the channel name", () => {
    const r = parseStrategy(
      envelope({
        ...VALID,
        channel_bets: [
          { channel_slug: "seo", intent: "SEO", rationale: "r", expected_effect: "e", falsifier: "Eight weeks and no page ranks top 20" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets).toHaveLength(0);
  });

  it("keeps the strategy when a bet is dropped for a thin intent", () => {
    const r = parseStrategy(
      envelope({
        ...VALID,
        channel_bets: [
          { channel_slug: "seo", intent: "SEO", rationale: "r", expected_effect: "e", falsifier: "Eight weeks and nothing ranks" },
          { channel_slug: "email_marketing", intent: "Email the 400 stalled signups weekly for a month", rationale: "r", expected_effect: "e", falsifier: "Four sends and completion has not moved" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets.map((b) => b.channel_slug)).toEqual(["email_marketing"]);
    expect(r.strategy.north_star.metric).toBe("activation_rate");
  });

  it("rejects an impossible calendar date that still matches YYYY-MM-DD", () => {
    const r = parseStrategy(envelope({ ...VALID, goal: { ...VALID.goal, due_date: "2026-02-31" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.goal).toBeNull();
  });

  it("parses the exact envelope shape documented in agent.md", () => {
    const fromPrompt = {
      north_star: { metric: "activation_rate", why: "signups stall before value", provenance: "growth__diagnose_funnel this run" },
      constraint: { statement: "Activation is binding: 60% never finish setup", lever_family: "activation", evidence: "funnel step 3 drop", confidence: "high" },
      channel_bets: [
        { channel_slug: "email_marketing", intent: "Email the 400 signups who never finished setup, once a week for a month", rationale: "reach the signups already here", expected_effect: "setup completion +5pt", falsifier: "Four sends and setup completion has not moved off 22%" },
        { channel_slug: "seo", intent: "Publish one comparison page a week against the three tools people name", rationale: "compounding top of funnel", expected_effect: "qualified signups", falsifier: "Eight weeks in and no page ranks in the top 20 for its own title" },
      ],
      goal: { objective: "Lift activation to 40%", target_metric: "activation_rate", target_value: 40, due_date: "2026-12-31" },
      gaps: ["What monthly budget can you commit?"],
      unmeasured: [{ lever: "involuntary churn", the_one_read_that_would_size_it: "Stripe failed-payment count" }],
    };
    const r = parseStrategy(envelope(fromPrompt));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.goal?.target_metric).toBe("activation_rate");
    expect(r.strategy.channel_bets).toHaveLength(2);
  });

  it("degrades an unreadable confidence to low rather than losing the strategy", () => {
    const r = parseStrategy(
      envelope({ ...VALID, constraint: { ...VALID.constraint, confidence: "pretty sure" } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.constraint.confidence).toBe("low");
  });

  it("drops a bet with no channel_slug rather than emitting a nameless bet", () => {
    const r = parseStrategy(
      envelope({ ...VALID, channel_bets: [{ rationale: "x", expected_effect: "y" }] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.channel_bets).toHaveLength(0);
  });

  it("reads questions from all three accepted shapes, top-level first", () => {
    const viaQuestions = parseStrategy(
      envelope({ ...VALID, gaps: undefined, questions: ["Budget?", "Who buys?"] }),
    );
    expect(viaQuestions.ok).toBe(true);
    if (!viaQuestions.ok) return;
    expect(viaQuestions.strategy.gaps).toEqual(["Budget?", "Who buys?"]);

    const viaClarify = parseStrategy(
      envelope({
        ...VALID,
        gaps: undefined,
        clarifications_needed: { questions: ["Mid-run question?"] },
      }),
    );
    expect(viaClarify.ok).toBe(true);
    if (!viaClarify.ok) return;
    expect(viaClarify.strategy.gaps).toEqual(["Mid-run question?"]);

    const viaLegacy = parseStrategy(envelope({ ...VALID, gaps: ["legacy?"] }));
    expect(viaLegacy.ok).toBe(true);
    if (!viaLegacy.ok) return;
    expect(viaLegacy.strategy.gaps).toEqual(["legacy?"]);
  });

  it("fails closed on malformed JSON instead of throwing", () => {
    const r = parseStrategy("<strategy>{not json,,}</strategy>");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not valid JSON/);
  });
});

describe("renderStrategy", () => {
  it("renders the constraint and the bets", () => {
    const r = parseStrategy(envelope(VALID));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const md = renderStrategy(r.strategy);
    expect(md).toContain("Activation is binding");
    expect(md).toContain("email_marketing");
    expect(md).toContain("activation_rate");
    expect(md).toContain("Stripe failures");
  });

  it("says so plainly when no measurable goal survived", () => {
    const r = parseStrategy(envelope({ ...VALID, goal: { objective: "grow" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderStrategy(r.strategy)).toContain("Not yet measurable");
  });
});

describe("isMeasurableMetric — the prod junk corpus", () => {
  it("rejects every unmeasurable metric observed in prod", () => {
    for (const junk of [
      "in USA and get 10 USA clients.",
      "Convert 3 daily rentals into monthly rentals",
      "12",
      "2000",
      "",
    ]) {
      expect(isMeasurableMetric(junk)).toBe(false);
    }
  });

  it("accepts real metric keys, including the terse ones", () => {
    for (const ok of ["mrr", "gmv", "activation_rate", "signups", "verified hosts", "ARR"]) {
      expect(isMeasurableMetric(ok)).toBe(true);
    }
  });
});

describe("post-run input contract", () => {
  const strategyJson = JSON.stringify(VALID);

  it("finds the strategy in raw_response_text, which is where it actually survives", () => {
    const raw = `Here's my read.\n\n<strategy>\n${strategyJson}\n</strategy>`;
    const asDispatcherResult = {
      output_text: "Here's my read.",
      raw_response_text: raw,
    };
    const source =
      asDispatcherResult.raw_response_text ?? asDispatcherResult.output_text ?? "";
    expect(parseStrategy(source).ok).toBe(true);
    expect(parseStrategy(asDispatcherResult.output_text).ok).toBe(false);
  });

  it("still parses when a caller supplies only output_text", () => {
    const only = { output_text: `<strategy>\n${strategyJson}\n</strategy>` };
    const source =
      (only as { raw_response_text?: string }).raw_response_text ?? only.output_text ?? "";
    expect(parseStrategy(source).ok).toBe(true);
  });
});

describe("plan detail sections", () => {
  const detail = {
    company_facts: [
      { fact: "Plans start at $9/month with a 30-day trial", source_url: "https://example.com/pricing" },
      { fact: "Has thousands of happy customers everywhere", source_url: "" },
      { fact: "Sourced to something that is not a page", source_url: "internal notes" },
    ],
    growth_moves: [
      {
        title: "Guided setup",
        lever: "Activation",
        action: "Add a 3-step setup checklist and nudges at hour 24 and 72",
        rationale: "The drop is at setup",
        expected_effect: "Setup completion from ~22% to 32% within 6 weeks",
        falsifier: "Six weeks after launch setup completion is below 26%",
      },
      { title: "Vague", lever: "magic", action: "growth", rationale: "", expected_effect: "", falsifier: "no" },
    ],
    first_steps: [
      { when: "Day 1-2", step: "Pull 8 weeks of signups and count setup completion" },
      { when: "Day 3", step: "" },
    ],
    target_rationale: "Peers reach 35-45%, so 40% is reachable; baseline from last 8 weeks.",
    would_change_plan: ["If most signups finish setup, activation is not the constraint", "hm"],
  };

  it("keeps sourced facts, falsifiable moves and real steps; drops the rest", () => {
    const r = parseStrategy(envelope({ ...VALID, ...detail }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.company_facts).toEqual([detail.company_facts[0]]);
    expect(r.strategy.growth_moves).toHaveLength(1);
    expect(r.strategy.growth_moves?.[0].lever).toBe("activation");
    expect(r.strategy.first_steps).toEqual([detail.first_steps[0]]);
    expect(r.strategy.target_rationale).toBe(detail.target_rationale);
    expect(r.strategy.would_change_plan).toEqual([detail.would_change_plan[0]]);
  });

  it("omits every detail key when the model writes none (older envelopes still parse)", () => {
    const r = parseStrategy(envelope(VALID));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const k of ["company_facts", "growth_moves", "first_steps", "target_rationale", "would_change_plan"]) {
      expect(k in r.strategy).toBe(false);
    }
  });
});

describe("guardCompanyFacts", () => {
  const research = {
    domain: "acme.com",
    research_pages: [{ url: "https://www.review.site/acme/" }],
    competitors: [{ url: "https://rival.com", source_url: "https://list.site/best-tools" }],
    dossier_facts: [{ source_url: "https://acme.com/pricing" }],
  };
  it("keeps facts citing pages the run was given or the company's own site", async () => {
    const { guardCompanyFacts } = await import("../strategy");
    const kept = guardCompanyFacts(
      [
        { fact: "Pro is $49 a month", source_url: "https://acme.com/pricing/" },
        { fact: "Reviewers praise support", source_url: "https://review.site/acme" },
        { fact: "Listed among best tools", source_url: "https://list.site/best-tools" },
        { fact: "About page says founded 2019", source_url: "https://www.acme.com/about" },
        { fact: "A page nobody fetched", source_url: "https://news.site/acme-raises" },
        { fact: "Not a URL at all", source_url: "internal notes" },
      ],
      research,
    );
    expect(kept?.map((f) => f.fact)).toEqual([
      "Pro is $49 a month",
      "Reviewers praise support",
      "Listed among best tools",
      "About page says founded 2019",
    ]);
  });
  it("returns undefined when nothing survives", async () => {
    const { guardCompanyFacts } = await import("../strategy");
    expect(guardCompanyFacts([{ fact: "x happened here", source_url: "https://elsewhere.com" }], research)).toBeUndefined();
  });
});

describe("short plan fields", () => {
  it("keeps a real summary and also-fix, drops empty or too-short ones", () => {
    const r = parseStrategy(
      envelope({ ...VALID, summary: "A bakery in Leeds with 120 reviews on Google.", also_fix: "Answer the phone after 5pm." }),
    );
    expect(r.ok && r.strategy.summary).toBe("A bakery in Leeds with 120 reviews on Google.");
    expect(r.ok && r.strategy.also_fix).toBe("Answer the phone after 5pm.");
    const thin = parseStrategy(envelope({ ...VALID, summary: "ok", also_fix: "" }));
    expect(thin.ok && "summary" in thin.strategy).toBe(false);
    expect(thin.ok && "also_fix" in thin.strategy).toBe(false);
  });
});

describe("drafted brand voice", () => {
  it("keeps a voice long enough to be useful and drops a stub", () => {
    const withVoice = parseStrategy(
      envelope({
        ...VALID,
        brand_voice: "Plain and direct. Short sentences, no exclamation marks. Calls buyers 'customers', never 'users'.",
      }),
    );
    expect(withVoice.ok && withVoice.strategy.brand_voice).toMatch(/Plain and direct/);

    const stub = parseStrategy(envelope({ ...VALID, brand_voice: "Friendly." }));
    expect(stub.ok && stub.strategy.brand_voice).toBeUndefined();
  });

  it("a voice that quotes the company's words without escaping them keeps the whole plan", () => {
    const voice = 'Plain and direct. Calls buyers "customers", never "users", and signs off with "Talk soon".';
    const raw = JSON.stringify({ ...VALID, brand_voice: "VOICE" }).replace('"VOICE"', `"${voice}"`);
    const r = parseStrategy(`<strategy>\n${raw}\n</strategy>`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.strategy.brand_voice).toBe(voice);
    expect(r.strategy.north_star.metric).toBe(VALID.north_star.metric);
  });

  it("a valid block is not marked repaired", () => {
    const r = parseStrategy(envelope(VALID));
    expect(r.ok && r.repaired).toBeFalsy();
  });
});
