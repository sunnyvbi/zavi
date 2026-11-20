
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const baseCases = [
  {
    id: "c1",
    title: "Guest can sign up",
    role: "guest",
    source: "agent-onboarding",
    created_at: "2026-06-01T00:00:00Z",
    manual_tested_at: "2026-06-10T00:00:00Z",
  },
  {
    id: "c2",
    title: "Host can edit listing price",
    role: "host",
    source: "operator-chat",
    created_at: "2026-06-02T00:00:00Z",
    manual_tested_at: null,
  },
];

function mockDashboard(data: Record<string, unknown>) {
  vi.doMock("./dashboard-ui", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./dashboard-ui")>();
    return {
      ...actual,
      useAgentDashboard: () => ({
        data,
        loading: false,
        refreshing: false,
        error: null,
        refresh: () => {},
        refreshSilent: () => {},
        newRowIds: new Set<string>(),
      }),
    };
  });
}

describe("QaDashboard — execution richness", () => {
  it("renders the real latest-run summary + pass-rate + counters when executed", async () => {
    vi.resetModules();
    mockDashboard({
      generic: false,
      counts: { total: 2, guest: 1, host: 1, public: 0 },
      cases: baseCases,
      reports: [],
      attention: [],
      execution: {
        latest: { at: "2026-06-20T00:00:00Z", ran: 7, pass: 5, fail: 1, blocked: 1, pass_rate: 83 },
        trend: [
          { at: "2026-06-06T00:00:00Z", pass_rate: 74 },
          { at: "2026-06-13T00:00:00Z", pass_rate: 80 },
          { at: "2026-06-20T00:00:00Z", pass_rate: 83 },
        ],
        red_now: 1,
        brittle: [
          {
            id: "c2",
            title: "Host can edit listing price",
            role: "host",
            consecutive_red: 4,
            last_run_at: "2026-06-20T00:00:00Z",
          },
        ],
        healed: 1,
        last_executed_at: "2026-06-20T00:00:00Z",
      },
    });
    const { QaDashboard } = await import("./QaDashboard");
    const html = renderToStaticMarkup(<QaDashboard />);

    expect(html).toContain("Latest pipeline run");
    expect(html).toContain("5 passed");
    expect(html).toContain("1 failed");
    expect(html).toContain("1 blocked");
    expect(html).toContain("Pass rate");
    expect(html).toContain("83");
    expect(html).toContain("<svg");
    expect(html).toContain("Red now");
    expect(html).toContain("Brittle");
    expect(html).toContain("failed ≥3× in a row");
    expect(html).toContain("Healed");
    expect(html).not.toContain("appears after your first run");
  });

  it("renders the honest 'first run' note (no invented data) when never executed", async () => {
    vi.resetModules();
    mockDashboard({
      generic: false,
      counts: { total: 1, guest: 1, host: 0, public: 0 },
      cases: [baseCases[0]],
      reports: [],
      attention: [],
    });
    const { QaDashboard } = await import("./QaDashboard");
    const html = renderToStaticMarkup(<QaDashboard />);

    expect(html).toContain("Live run status");
    expect(html).toContain("appears after your first run");
    expect(html).not.toContain("Latest pipeline run");
  });
});

describe("QaDashboard — live run status (render contract)", () => {
  const fixture = (in_flight: unknown) => ({
    generic: false,
    counts: { total: 2, guest: 1, host: 1, public: 0 },
    cases: baseCases,
    reports: [],
    attention: [],
    in_flight,
  });

  it("renders the progress bar with done/total + correct aria when a batch is active", async () => {
    vi.resetModules();
    mockDashboard(
      fixture({ started_at: "2026-06-22T11:54:00Z", total: 8, done: 3 }),
    );
    const { QaDashboard } = await import("./QaDashboard");
    const html = renderToStaticMarkup(<QaDashboard />);

    expect(html).toContain("Running QA pipeline");
    expect(html).toContain("3/8 tests done");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="8"');
    expect(html).toContain("Running…");
    expect(html).not.toContain("NaN");
  });

  it("clamps done to total and never emits a NaN width/aria", async () => {
    vi.resetModules();
    mockDashboard(
      fixture({ started_at: "2026-06-22T11:54:00Z", total: 4, done: 9 }),
    );
    const { QaDashboard } = await import("./QaDashboard");
    const html = renderToStaticMarkup(<QaDashboard />);
    expect(html).toContain("4/4 tests done");
    expect(html).toContain('aria-valuenow="4"');
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("width:900%");
  });

  it("renders the indeterminate bar (no NaN aria) when total is 0", async () => {
    vi.resetModules();
    mockDashboard(fixture({ started_at: "2026-06-22T11:54:00Z", total: 0, done: 0 }));
    const { QaDashboard } = await import("./QaDashboard");
    const html = renderToStaticMarkup(<QaDashboard />);
    expect(html).toContain("Running QA pipeline");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("NaN");
  });

  it("shows no live banner (button enabled) when in_flight is null", async () => {
    vi.resetModules();
    mockDashboard(fixture(null));
    const { QaDashboard } = await import("./QaDashboard");
    const html = renderToStaticMarkup(<QaDashboard />);
    expect(html).toContain("Run pipeline");
    expect(html).not.toContain("Running QA pipeline");
    expect(html).not.toContain('role="progressbar"');
  });
});
