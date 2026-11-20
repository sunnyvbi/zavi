import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/api-admin", () => ({ adminApiFetch: vi.fn() }));

import { OnboardingEmailsStats, OnboardingEmailsTable, type EmailStatsResp } from "./OnboardingEmailsStats";

const data: EmailStatsResp = {
  steps: [
    { step: 1, label: "Welcome to Zavi", sent: 40, visits: 10, acted: 3 },
    { step: 10, label: "First results (digest)", sent: 0, visits: 0, acted: 0 },
  ],
  denominator: { people_in_sequence: 40, excludes: "test workspaces", acted_means: "a card response or a goal" },
};

describe("OnboardingEmailsTable", () => {
  it("shows sent, came back and acted per email, with rates and the denominator", () => {
    const html = renderToStaticMarkup(<OnboardingEmailsTable data={data} />);
    expect(html).toContain("Welcome to Zavi");
    expect(html).toMatch(/10 <span[^>]*>\(25%\)<\/span>/);
    expect(html).toMatch(/3 <span[^>]*>\(30%\)<\/span>/);
    expect(html).toContain("(–)");
    expect(html).toContain("40 people in the sequence. Excludes test workspaces.");
  });

  it("the section starts in a loading state", () => {
    expect(renderToStaticMarkup(<OnboardingEmailsStats />)).toContain("Loading…");
  });
});
