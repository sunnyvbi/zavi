import { describe, expect, it } from "vitest";

import { applyFitVerdict, channelRecipeStepEnvelopeSchema, FIT_VERDICT_KEEPERS } from "@/agents/lib/channel-recipe-step";

const step = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  body: "why",
  blocking: false,
  effort: "minutes",
  evidence: ["read this run"],
  ...extra,
});

const envelope = (fit: unknown, steps: unknown[]) =>
  channelRecipeStepEnvelopeSchema.parse({ rendered_markdown: "report", fit, steps });

describe("applyFitVerdict", () => {
  const steps = [
    step("Post the week's first carousel", { intent: "create" }),
    step("Spend this week elsewhere", { fit_verdict: true }),
    step("Switch to a professional account", { intent: "fix_setup" }),
    step("Fix the bio link", { action_type: "fix", target: { kind: "account", ref: "@x" } }),
    step("Reply to comments", { action_type: "reply" }),
  ];

  it("not_here keeps the verdict card and setup fixes, drops the rest", () => {
    const { envelope: out, dropped } = applyFitVerdict(envelope({ verdict: "not_here", reason: "buyer is on LinkedIn" }, steps));
    expect(dropped).toBe(2);
    expect(out.steps.map((s) => s.title)).toEqual([
      "Spend this week elsewhere",
      "Switch to a professional account",
      "Fix the bio link",
    ]);
  });

  it("not_here keeps only the FIRST flagged verdict card", () => {
    const { envelope: out } = applyFitVerdict(
      envelope({ verdict: "not_here", reason: "r" }, [
        step("Spend this week elsewhere", { fit_verdict: true }),
        step("Post the carousel anyway", { intent: "create", fit_verdict: true }),
      ]),
    );
    expect(out.steps.map((s) => s.title)).toEqual(["Spend this week elsewhere"]);
  });

  it("not_here with no verdict card keeps setup fixes only", () => {
    const { envelope: out } = applyFitVerdict(
      envelope({ verdict: "not_here", reason: "r" }, [steps[0], steps[2], steps[4]]),
    );
    expect(out.steps.map((s) => s.title)).toEqual(["Switch to a professional account"]);
  });

  it.each([
    ["here", { verdict: "here", reason: "r" }],
    ["unsure", { verdict: "unsure", reason: "r" }],
    ["missing", undefined],
    ["malformed", { verdict: "nope" }],
  ])("%s keeps every step", (_label, fit) => {
    const env = envelope(fit, steps);
    const { envelope: out, dropped } = applyFitVerdict(env);
    expect(dropped).toBe(0);
    expect(out).toBe(env);
    expect(out.steps).toHaveLength(5);
  });

  it("parses the fit field and the step flag", () => {
    const env = envelope({ verdict: "not_here", reason: "r" }, [steps[1]]);
    expect(env.fit).toEqual({ verdict: "not_here", reason: "r" });
    expect(env.steps[0].fit_verdict).toBe(true);
  });

  it("is defensive about a non-envelope", () => {
    expect(applyFitVerdict(null).dropped).toBe(0);
    expect(applyFitVerdict({ fit: { verdict: "not_here" } }).dropped).toBe(0);
  });
});

describe("applyFitVerdict on a LinkedIn Ads not-yet run (skills/artifact.md Shape B)", () => {
  const shapeB = [
    step("Put the buyer's role in one sentence on the homepage", { body: "Not yet: one customer is worth $200 and a readable test is $350 (14 days at $25/day). About 30 minutes this week." }),
    step("Review these two audiences for when the verdict flips", { deliverable: { kind: "list", label: "Two audiences", content: "AUDIENCE 1 ..." } }),
    step("Install the Insight Tag on the landing page", { action_type: "setup" }),
    step("Paste the copy sheet", { deliverable: { kind: "ad", label: "Copy sheet", content: "VARIANT A ..." } }),
    step("Build the campaign", { deliverable: { kind: "brief", label: "Brief", content: "..." } }),
    step("Post about the launch", { intent: "create" }),
  ];

  it("must-catch: keeps the verdict and its break-even maths, the audiences for review and the setup fix, with no flags set", () => {
    const { envelope: out, dropped } = applyFitVerdict(envelope({ verdict: "not_here", reason: "r" }, shapeB), FIT_VERDICT_KEEPERS.linkedin_ads);
    expect(out.steps.map((s) => s.title)).toEqual([
      "Put the buyer's role in one sentence on the homepage",
      "Review these two audiences for when the verdict flips",
      "Install the Insight Tag on the landing page",
    ]);
    expect(out.steps[0].body).toContain("$350");
    expect(dropped).toBe(3);
  });

  it("must-catch: agent.md's own step example (an audiences step with no flags) is never dropped to 'No new steps'", () => {
    const only = [shapeB[1]];
    const { envelope: out } = applyFitVerdict(envelope({ verdict: "not_here", reason: "r" }, only), FIT_VERDICT_KEEPERS.linkedin_ads);
    expect(out.steps).toHaveLength(1);
  });

  it("the recipe's flagged verdict card is kept too, alongside the first step", () => {
    const steps = [shapeB[0], step("What flips it", { fit_verdict: true }), shapeB[5]];
    const { envelope: out } = applyFitVerdict(envelope({ verdict: "not_here", reason: "r" }, steps), FIT_VERDICT_KEEPERS.linkedin_ads);
    expect(out.steps.map((s) => s.title)).toEqual([shapeB[0].title, "What flips it"]);
  });

  it("a copy sheet or campaign brief is dropped even in first place: a not-yet run hands over no launch work", () => {
    const steps = [shapeB[3], shapeB[1]];
    const { envelope: out } = applyFitVerdict(envelope({ verdict: "not_here", reason: "r" }, steps), FIT_VERDICT_KEEPERS.linkedin_ads);
    expect(out.steps.map((s) => s.title)).toEqual([shapeB[1].title]);
  });

  it("must-not-touch: other channels keep the old rule, so a first-place post is still dropped", () => {
    expect(FIT_VERDICT_KEEPERS.instagram_organic).toBeUndefined();
    const { envelope: out } = applyFitVerdict(envelope({ verdict: "not_here", reason: "r" }, shapeB));
    expect(out.steps.map((s) => s.title)).toEqual(["Install the Insight Tag on the landing page"]);
  });
});
