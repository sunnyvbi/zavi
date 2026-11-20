
import { describe, it, expect } from "vitest";
import { detectGoalJunk, classifyMetricMode } from "../goal-metric-vocab";

describe("detectGoalJunk", () => {
  const junkCases: Array<{
    name: string;
    input: Parameters<typeof detectGoalJunk>[0];
  }> = [
    {
      name: "prod row: objective 'hhhhh' (short + all-same-char)",
      input: { objective: "hhhhh", target_metric: "mrr", target_value: 10 },
    },
    {
      name: "prod row: target_metric 'yy' (all-same-char)",
      input: { objective: "Grow revenue to 50k", target_metric: "yy", target_value: 10 },
    },
    {
      name: "objective shorter than 8 chars",
      input: { objective: "grow it", target_metric: "mrr", target_value: 10 },
    },
    {
      name: "objective all one repeated char (long)",
      input: { objective: "aaaaaaaaaaaa", target_metric: "mrr", target_value: 10 },
    },
    {
      name: "objective all one repeated char with spaces",
      input: { objective: "hhhh hhhh hhhh", target_metric: "mrr", target_value: 10 },
    },
    {
      name: "objective letters-only with no vowels (mash)",
      input: { objective: "sdfgh jklqw rtzp", target_metric: "mrr", target_value: 10 },
    },
    {
      name: "target_metric shorter than 2 chars",
      input: { objective: "Grow bookings this quarter", target_metric: "y", target_value: 10 },
    },
    {
      name: "target_metric empty",
      input: { objective: "Grow bookings this quarter", target_metric: "", target_value: 10 },
    },
    {
      name: "target_metric all one repeated char (xxx)",
      input: { objective: "Grow bookings this quarter", target_metric: "xxx", target_value: 10 },
    },
    {
      name: "target_value zero",
      input: { objective: "Grow bookings this quarter", target_metric: "bookings", target_value: 0 },
    },
    {
      name: "target_value negative",
      input: { objective: "Grow bookings this quarter", target_metric: "bookings", target_value: -5 },
    },
    {
      name: "target_value NaN",
      input: { objective: "Grow bookings this quarter", target_metric: "bookings", target_value: NaN },
    },
    {
      name: "target_value Infinity",
      input: {
        objective: "Grow bookings this quarter",
        target_metric: "bookings",
        target_value: Infinity,
      },
    },
    { name: "partial: junk objective alone", input: { objective: "hhhhh" } },
    { name: "partial: junk metric alone", input: { target_metric: "yy" } },
    { name: "partial: junk value alone", input: { target_value: 0 } },
  ];

  it.each(junkCases)("rejects $name", ({ input }) => {
    const reason = detectGoalJunk(input);
    expect(reason).toBeTypeOf("string");
    expect((reason as string).length).toBeGreaterThan(0);
  });

  const realCases: Array<{
    name: string;
    input: Parameters<typeof detectGoalJunk>[0];
  }> = [
    {
      name: "classic MRR goal",
      input: { objective: "Grow MRR to $50k by end of Q3", target_metric: "mrr", target_value: 50000 },
    },
    {
      name: "vowel-free metric abbreviation (mrr) is fine",
      input: { objective: "Reach fifty thousand in monthly revenue", target_metric: "mrr", target_value: 50000 },
    },
    {
      name: "digit-bearing vowel-free objective (10x GMV) is fine",
      input: { objective: "10x GMV 4 Q3", target_metric: "gmv", target_value: 100000 },
    },
    {
      name: "terse but real goal",
      input: { objective: "Double weekly signups", target_metric: "signups", target_value: 200 },
    },
    {
      name: "custom manual metric",
      input: {
        objective: "Publish more customer case studies",
        target_metric: "case studies published",
        target_value: 12,
      },
    },
    {
      name: "two-char real metric (2 distinct chars)",
      input: { objective: "Improve marketing efficiency", target_metric: "ac", target_value: 3 },
    },
    { name: "partial: real objective alone", input: { objective: "Grow bookings in Texas" } },
    { name: "partial: real value alone", input: { target_value: 42 } },
    { name: "empty input (nothing to check)", input: {} },
  ];

  it.each(realCases)("passes $name", ({ input }) => {
    expect(detectGoalJunk(input)).toBeNull();
  });
});

describe("classifyMetricMode", () => {
  const autoCases: string[] = [
    "signups",
    "Sign-ups",
    "new users",
    "registrations",
    "activation",
    "bookings",
    "trips per week",
    "reservations",
    "orders",
    "mrr",
    "MRR",
    "arr",
    "gross revenue",
  ];

  it.each(autoCases.map((m) => ({ metric: m })))(
    "maps '$metric' to auto",
    ({ metric }) => {
      expect(classifyMetricMode(metric)).toBe("auto");
    },
  );

  const manualCases: string[] = [
    "weekly sign up rate",
    "activation_rate",
    "checkout conversion rate",
    "CVR",
    "CTR",
    "average order value (aov)",
    "funnel conversion",
    "monthly revenue",
    "CAC",
    "blended cac",
    "roas",
    "ad spend",
    "case studies published",
    "nps",
    "employee headcount",
    "podcast episodes",
    "brand mentions",
    "Facebook followers",
    "yy",
  ];

  it.each(manualCases.map((m) => ({ metric: m })))(
    "maps '$metric' to manual_reported",
    ({ metric }) => {
      expect(classifyMetricMode(metric)).toBe("manual_reported");
    },
  );

  it("never returns 'unmapped' (reserved for the column default)", () => {
    for (const m of [...autoCases, ...manualCases, ""]) {
      expect(classifyMetricMode(m)).not.toBe("unmapped");
    }
  });
});
