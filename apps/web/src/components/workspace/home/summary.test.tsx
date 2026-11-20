
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeSummary, EMPTY_SUMMARY } from "./summary";
import { SpendCard } from "./SpendCard";
import { KpiStrip } from "./KpiStrip";

describe("normalizeSummary", () => {
  it("coerces non-array array fields to []", () => {
    const out = normalizeSummary({
      active_runs_today: "nope",
      spend_week: null,
      suggested_next: 5,
      recent_activity: { not: "an array" },
    });
    expect(out.active_runs_today).toEqual([]);
    expect(out.spend_week).toEqual([]);
    expect(out.suggested_next).toEqual([]);
    expect(out.recent_activity).toEqual([]);
  });

  it("coerces top-level + nested numbers to finite values", () => {
    const out = normalizeSummary({
      spend_total_usd: null,
      pending_approvals_count: "3",
      spend_week: [{ date: "2026-06-19", usd: "x" }],
      recent_activity: [{ agent_slug: "pm", finished_at: null, cost_usd: null }],
    });
    expect(out.spend_total_usd).toBe(0);
    expect(out.pending_approvals_count).toBe(0);
    expect(out.spend_week[0].usd).toBe(0);
    expect(out.recent_activity[0].cost_usd).toBe(0);
  });

  it("passes a valid payload through", () => {
    const valid = {
      ...EMPTY_SUMMARY,
      spend_total_usd: 12.5,
      spend_week: [{ date: "d", usd: 3 }],
    };
    const out = normalizeSummary(valid);
    expect(out.spend_total_usd).toBe(12.5);
    expect(out.spend_week).toEqual([{ date: "d", usd: 3 }]);
  });

  it("a non-object payload becomes the empty summary", () => {
    expect(normalizeSummary(null)).toEqual(EMPTY_SUMMARY);
    expect(normalizeSummary("boom")).toEqual(EMPTY_SUMMARY);
  });

  it("real-empty stays empty (must NOT be treated as an error)", () => {
    expect(normalizeSummary(EMPTY_SUMMARY)).toEqual(EMPTY_SUMMARY);
  });

  it("preserves a valid presentation_status on active runs, drops an unknown one", () => {
    const out = normalizeSummary({
      active_runs_today: [
        { id: "a", agent_slug: "engineer", status: "parse_failed", presentation_status: "answered" },
        { id: "b", agent_slug: "engineer", status: "dispatch_error", presentation_status: "bogus" },
        { id: "c", agent_slug: "engineer", status: "running" },
      ],
    });
    expect(out.active_runs_today[0].presentation_status).toBe("answered");
    expect(out.active_runs_today[1].presentation_status).toBeUndefined();
    expect(out.active_runs_today[2].presentation_status).toBeUndefined();
  });

  it("drops a malformed company_md_ref (missing id/title) to null", () => {
    expect(normalizeSummary({ company_md_ref: { foo: 1 } }).company_md_ref).toBeNull();
  });

  it("coerces company_md_ref.metadata.key_facts to an array", () => {
    const out = normalizeSummary({
      company_md_ref: { id: "x", title: "T", metadata: { key_facts: "not-array" } },
    });
    expect(out.company_md_ref?.metadata?.key_facts).toBeUndefined();
  });
});

describe("Home cards render the normalized malformed-200 payload without throwing", () => {
  it("SpendCard + KpiStrip SSR clean on coerced garbage (no NaN, no throw)", () => {
    const s = normalizeSummary({
      spend_total_usd: null,
      spend_week: "x",
      active_runs_today: null,
    });
    expect(() =>
      renderToStaticMarkup(
        React.createElement(SpendCard, { totalUsd: s.spend_total_usd, buckets: s.spend_week }),
      ),
    ).not.toThrow();
    const html = renderToStaticMarkup(
      React.createElement(KpiStrip, {
        activeRunsToday: s.active_runs_today,
        pendingApprovals: s.pending_approvals_count,
        spendTotalUsd: s.spend_total_usd,
      }),
    );
    expect(html).toContain("$0.00");
    expect(html).not.toContain("NaN");
  });
});

describe("KpiStrip credits tile — low-balance alert color", () => {
  const RED = "text-[#cb2029]";
  const base = {
    activeRunsToday: [],
    pendingApprovals: 0,
    spendTotalUsd: 0,
    creditsEnforced: true,
  };
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(React.createElement(KpiStrip, { ...base, ...extra }));

  it("colors the number red when LOW (≤10% of allowance)", () => {
    expect(render({ creditsRemaining: 4000, creditsAllowance: 40000 })).toContain(RED);
  });

  it("colors the number red when DEPLETED (below the cheapest reservable run)", () => {
    expect(render({ creditsRemaining: 50, creditsAllowance: 40000 })).toContain(RED);
  });

  it("colors red for a fresh tiny-allowance free tenant (10 of 10 — the reported bug)", () => {
    expect(render({ creditsRemaining: 10, creditsAllowance: 10 })).toContain(RED);
  });

  it("stays neutral (no red) when HEALTHY", () => {
    const html = render({ creditsRemaining: 40000, creditsAllowance: 40000 });
    expect(html).not.toContain(RED);
    expect(html).toContain("text-ink");
  });

  it("null allowance never fabricates a low state (spendable balance stays neutral)", () => {
    expect(render({ creditsRemaining: 4000, creditsAllowance: null })).not.toContain(RED);
  });

  it("does not color credits when metering is not enforced (renders Spend, not Credits)", () => {
    const html = render({ creditsRemaining: 50, creditsAllowance: 40000, creditsEnforced: false });
    expect(html).not.toContain(RED);
    expect(html).toContain("$0.00");
  });
});
