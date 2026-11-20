import type { ReaderLoadGolden } from "./runner";

export const GOLDENS: readonly ReaderLoadGolden[] = [
  {
    name: "perfmkt broad ask — pre-fix wall (must FAIL graspability)",
    question: "How are our ads doing last week, any suggestions to improve?",
    output: [
      "## Ads digest — Jul 7, 2026",
      "",
      "### Weekly summary",
      "Last 7 days, all campaigns:",
      "| Campaign | Spend | ROAS |",
      "| --- | --- | --- |",
      "| Gig Rentals | $724 | 2.09x |",
      "",
      "### Anomalies",
      "The IC-TEST ad set is the primary drag on account ROAS.",
      "### Proposed reallocation",
      "Hold scaling on all campaigns this week.",
    ].join("\n"),
    expect_pass: false,
  },
  {
    name: "perfmkt broad ask — post-fix lead (must PASS graspability)",
    question: "How are our ads doing last week, any suggestions to improve?",
    output:
      "Ads ran 2.21x ROAS last week ($1,190 spend, 17 purchases) — down slightly. " +
      "One test ad set (Gig IC-TEST) is the drag; I'll pause it ~Jul 10. " +
      "Your one decision: Bay Area — hold or pause?",
    expect_pass: true,
  },
  {
    name: "short direct answer (must PASS)",
    question: "Is the Bay Area budget doubled?",
    output: "Yes — doubled to $20/day as of this morning.",
    expect_pass: true,
  },
  {
    name: "header-first wall with no lead (must FAIL)",
    question: "How is SEO doing?",
    output: [
      "## SEO report",
      "### Rankings",
      "Position 4 for the head term.",
      "### Traffic",
      "Up 12% week over week.",
    ].join("\n"),
    expect_pass: false,
  },
];
