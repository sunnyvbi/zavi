
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardState } from "./dashboard-ui";

let mockState: DashboardState<unknown>;

vi.mock("./dashboard-ui", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-ui")>(
    "./dashboard-ui",
  );
  return {
    ...actual,
    AttentionList: () => null,
    useAgentDashboard: () => mockState,
  };
});

const { SupportLeadDashboard } = await import("./SupportLeadDashboard");

function baseState<T>(data: T): DashboardState<T> {
  return {
    data,
    loading: false,
    refreshing: false,
    error: null,
    refresh: () => {},
    newRowIds: new Set<string>(),
  };
}

function render(): string {
  return renderToStaticMarkup(React.createElement(SupportLeadDashboard));
}

const fullTriage = {
  total_cards: 6,
  runs: 2,
  funnel: {
    auto_resolve: 3,
    escalate_founder: 1,
    route_specialist: 1,
    no_op: 1,
  },
  severity: { P0: 1, P1: 2, P2: 2, P3: 1 },
  specialist_routes: [{ slug: "dispute-response", count: 1 }],
  low_confidence: 2,
  last_triage_at: "2026-06-20T10:00:00Z",
};

function connectedPayload(triage: unknown) {
  return {
    generic: false,
    connected: true,
    kpis: {
      channels_summarized: 2,
      message_volume_7d: 40,
      distinct_people: 5,
      oldest_summary_at: "2026-06-19T10:00:00Z",
    },
    top_themes: ["billing"],
    channels: [
      {
        channel_id: "C1",
        name: "support",
        message_count: 40,
        distinct_user_count: 5,
        member_count: 8,
        topics: ["billing"],
        last_summarized_at: "2026-06-20T10:00:00Z",
      },
    ],
    attention: [],
    triage,
  };
}

describe("SupportLeadDashboard — escalation funnel", () => {
  it("renders the funnel counts + severity mix + specialist routes", () => {
    mockState = baseState(connectedPayload(fullTriage)) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Escalation funnel");
    expect(html).toContain("Auto-resolved");
    expect(html).toContain("Escalated to you");
    expect(html).toContain("Routed to a specialist");
    expect(html).toContain("Severity mix");
    expect(html).toContain("Confidence gate");
    expect(html).toContain("Recommended specialist routes");
    expect(html).toContain("dispute-response");
  });

  it("a11y: severity is not color-only — each chip carries a P-level text label", () => {
    mockState = baseState(connectedPayload(fullTriage)) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("P0 · urgent");
    expect(html).toContain("P1 · high");
    expect(html).toContain("P2 · normal");
    expect(html).toContain("P3 · low");
    expect(html).toContain('aria-hidden="true"');
    const barMatch = html.match(/<div class="h-full rounded-full"[^>]*>/g) ?? [];
    expect(barMatch.length).toBeGreaterThan(0);
    for (const bar of barMatch) {
      expect(bar).not.toContain("transition");
      expect(bar).not.toContain("animate");
    }
  });

  it("empty/first-time: funnel shows the zero-state copy, no card chrome", () => {
    const emptyTriage = {
      total_cards: 0,
      runs: 0,
      funnel: { auto_resolve: 0, escalate_founder: 0, route_specialist: 0, no_op: 0 },
      severity: { P0: 0, P1: 0, P2: 0, P3: 0 },
      specialist_routes: [],
      low_confidence: 0,
      last_triage_at: null,
    };
    mockState = baseState(connectedPayload(emptyTriage)) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Escalation funnel");
    expect(html).toContain("No signals triaged in the last 7 days");
    expect(html).not.toContain("Severity mix");
  });

  it("connect path WITH triage: shows the CTA AND the funnel (separate source)", () => {
    mockState = baseState({
      generic: false,
      connected: false,
      kpis: {
        channels_summarized: 0,
        message_volume_7d: 0,
        distinct_people: 0,
        oldest_summary_at: null,
      },
      top_themes: [],
      channels: [],
      attention: [],
      triage: fullTriage,
    }) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Connect Slack to see your support pulse");
    expect(html).toContain("Escalation funnel");
    expect(html).toContain("Auto-resolved");
  });

  it("connect path with NO triage: just the CTA (no empty funnel noise)", () => {
    mockState = baseState({
      generic: false,
      connected: false,
      kpis: {
        channels_summarized: 0,
        message_volume_7d: 0,
        distinct_people: 0,
        oldest_summary_at: null,
      },
      top_themes: [],
      channels: [],
      attention: [],
      triage: { ...fullTriage, total_cards: 0, funnel: { auto_resolve: 0, escalate_founder: 0, route_specialist: 0, no_op: 0 } },
    }) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Connect Slack to see your support pulse");
    expect(html).not.toContain("Escalation funnel");
  });

  it("triage:null (read error) — pulse renders without the funnel", () => {
    mockState = baseState(connectedPayload(null)) as DashboardState<unknown>;
    const html = render();
    expect(html).toContain("Support pulse");
    expect(html).not.toContain("Escalation funnel");
  });
});
