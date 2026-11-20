
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./dashboard-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-ui")>();
  return {
    ...actual,
    useAgentDashboard: () => ({
      data: { agent_slug: "browser-operator", generic: true },
      loading: false,
      refreshing: false,
      error: null,
      refresh: () => {},
      newRowIds: new Set<string>(),
    }),
  };
});

import { BrowserOperatorDashboard } from "./BrowserOperatorDashboard";

describe("BrowserOperatorDashboard", () => {
  const html = renderToStaticMarkup(<BrowserOperatorDashboard />);

  it("renders the forensic-evidence framing (title + the three evidence surfaces)", () => {
    expect(html).toContain("Browser Operator");
    expect(html).toContain("Screenshot evidence");
    expect(html).toContain("Audit log");
    expect(html).toContain("Security warnings");
  });

  it("labels deferred surfaces with a word status, not color alone (a11y)", () => {
    expect(html).toContain("Pending");
  });

  it("does not fabricate run data when the wire is generic-only", () => {
    expect(html).not.toContain("linkedin.com/jobs");
    expect(html).not.toContain("[redacted");
    expect(html).not.toContain("00:11.3");
  });

  it("does not advertise the inert connected-account / LinkedIn write flow (P1.b)", () => {
    expect(html).not.toContain("connected account");
    expect(html).not.toContain("LinkedIn");
    expect(html).not.toContain("Stripe tax");
  });
});
