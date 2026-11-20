
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBar } from "./StatusBar";

describe("StatusBar — malformed counters never throw at render", () => {
  it("renders $0.00 / 0% on an empty counters object (all fields missing)", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatusBar, { counters: {} as never }),
    );
    expect(html).toContain("$0.00");
    expect(html).toContain("0%");
  });

  it("does not throw on non-numeric fields", () => {
    expect(() =>
      renderToStaticMarkup(
        React.createElement(StatusBar, {
          counters: {
            cost_today_usd: "5.0",
            drift_pct: null,
            active_runs: undefined,
            approvals_pending: {},
          } as never,
        }),
      ),
    ).not.toThrow();
  });

  it("renders valid counters correctly", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatusBar, {
        counters: { drift_pct: 3, cost_today_usd: 12.5, active_runs: 2, approvals_pending: 1 },
      }),
    );
    expect(html).toContain("$12.50");
    expect(html).toContain("3%");
  });
});
