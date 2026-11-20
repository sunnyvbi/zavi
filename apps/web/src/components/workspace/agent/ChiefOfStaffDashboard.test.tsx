import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentVerdicts, Accountability } from "./ChiefOfStaffDashboard";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

describe("RecentVerdicts render contract", () => {
  it("renders each verdict with a WORD label (a11y: not color-only)", () => {
    const html = renderToStaticMarkup(
      <RecentVerdicts
        rows={[
          {
            decision_id: "d1",
            verdict: "approved",
            target: "performance-marketer",
            intent: "Ship TX reallocation",
            emitted_at: "2026-06-20T00:00:00Z",
          },
          {
            decision_id: "d2",
            verdict: "rejected",
            target: "support-lead",
            intent: "Macro rewrite",
            emitted_at: "2026-06-19T00:00:00Z",
          },
          {
            decision_id: "d3",
            verdict: "deferred",
            target: "operator",
            intent: "Close AZ gap",
            emitted_at: "2026-06-18T00:00:00Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Approved");
    expect(html).toContain("Rejected");
    expect(html).toContain("Deferred");
    expect(html).toContain("performance-marketer");
    expect(html).toContain("Ship TX reallocation");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows an empty state when there are no verdicts", () => {
    const html = renderToStaticMarkup(<RecentVerdicts rows={[]} />);
    expect(html).toContain("No verdicts yet");
  });
});

describe("Accountability render contract", () => {
  it("renders each agent's state with a WORD label (a11y: not color-only)", () => {
    const html = renderToStaticMarkup(
      <Accountability
        rows={[
          {
            target: "operator",
            state: "missed",
            intent: "Close AZ gap",
            emitted_at: "2026-06-18T00:00:00Z",
          },
          {
            target: "engineer",
            state: "delivered",
            intent: "Fix checkout 500",
            emitted_at: "2026-06-20T00:00:00Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Missed");
    expect(html).toContain("Delivered");
    expect(html).toContain("operator");
    expect(html).toContain("engineer");
    expect(html).toContain("committed vs. delivered");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows an empty state when there is nothing to track", () => {
    const html = renderToStaticMarkup(<Accountability rows={[]} />);
    expect(html).toContain("Nothing to track yet");
  });
});
