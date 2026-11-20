import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/api-admin", () => ({ adminApiFetch: vi.fn() }));
import { SignupCreditCosts, type SignupCostData } from "./SignupCreditCosts";
const data: SignupCostData = {
  since: "2026-11-01T00:00:00Z",
  until: "2026-11-14T12:00:00Z",
  excluded: 5,
  workspaces: 2,
  credits: 1200,
  usd: 3,
  unfinishedRuns: 1,
  missingCostRuns: 2,
  otherRuns: 3,
  freeOrCompedCredits: null,
  rows: [
    {
      date: "2026-11-10",
      source: "filter-coffee",
      source_kind: "from",
      runs: 1,
      credits: 1200,
      done_for_you_credits: 1200,
      over_1000_runs: 1,
    },
  ],
  entries: [
    {
      run_id: "run-1",
      tenant_id: "test-workspace",
      date: "2026-11-10",
      source: "filter-coffee",
      category: "done_for_you",
      status: "success",
      credits: 1200,
      usd: 3,
      over_1000: true,
    },
  ],
};
it("shows cost totals, DFY flags, limitations and a run-level reconciliation", () => {
  const html = renderToStaticMarkup(<SignupCreditCosts initialData={data} />);
  for (const text of [
    "1,200",
    "filter-coffee",
    "test-workspace",
    "run-1",
    "done for you",
    "Free daily / comped usage",
    "allocation unavailable",
    "not proof of a budget violation",
    "2 runs without recorded cost",
    "first 14 days",
  ])
    expect(html).toContain(text);
});
it("escapes signup source text and reports an empty window without inventing spend", () => {
  const html = renderToStaticMarkup(
    <SignupCreditCosts
      initialData={{
        ...data,
        rows: [{ ...data.rows[0], source: "<img src=x onerror=alert(1)>" }],
      }}
    />,
  );
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img");
  const empty = renderToStaticMarkup(
    <SignupCreditCosts
      initialData={{ ...data, rows: [], entries: [], credits: 0, usd: 0 }}
    />,
  );
  expect(empty).toContain("No completed subsidized runs in this window.");
});
