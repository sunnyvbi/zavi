// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { ChannelDrawer, type ChannelDetail } from "./ChannelDrawer";
import { probeSummary, probeWindow } from "./channelDetail";

vi.mock("@/lib/api", () => ({
  apiFetch: vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ briefs: [] }) }),
}));
vi.mock("../agent/RedditOrganicDashboard", () => ({
  RedditOrganicDashboard: () => <div>Reddit dashboard</div>,
}));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));
afterEach(cleanup);

const seo = (CHANNELS as readonly Channel[]).find((c) => c.slug === "seo")!;
const reddit = (CHANNELS as readonly Channel[]).find(
  (c) => c.slug === "reddit_organic",
)!;

const detail = (
  workState: ChannelDetail["workState"],
  probe: Partial<Pick<ChannelDetail, "lastProbeAt" | "lastProbeDelta">> = {},
): ChannelDetail => ({
  channel: seo,
  mode: "produce",
  connected: false,
  connectors: ["google_analytics"],
  workState,
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  ...probe,
  runnable: true,
});

const renderAt = (
  ws: ChannelDetail["workState"],
  probe: Partial<Pick<ChannelDetail, "lastProbeAt" | "lastProbeDelta">> = {},
) =>
  render(
    <ChannelDrawer
      detail={detail(ws, probe)}
      actionCount={0}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    />,
  );

describe("ChannelDrawer — the four empty states are distinguishable", () => {
  it("running says work is in flight, with how long it has been going", async () => {
    renderAt("running");
    expect(await screen.findByText(/Cooking up new suggestions for /i)).toBeTruthy();
    expect(screen.getByTestId("running-badge").textContent).toBe("Cooking");
  });

  it("needs_review SAYS THE RUN FAILED — it must not read as 'nothing yet'", async () => {
    renderAt("needs_review");
    expect(await screen.findByText(/didn't finish/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing yet/i)).toBeNull();
  });

  it("delivered with no steps says no steps are pending and never claims a result", async () => {
    renderAt("delivered");
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(screen.queryByText(/found nothing/i)).toBeNull();
    expect(screen.queryByText(/Nothing yet/i)).toBeNull();
  });

  it("idle is the only state that says nobody has asked yet", async () => {
    renderAt("idle");
    expect(await screen.findByText(/No suggestions for .* yet/i)).toBeTruthy();
  });

  it("renders no run button in any work state", () => {
    for (const ws of ["idle", "running", "needs_review", "delivered"] as const) {
      const view = renderAt(ws);
      expect(
        view.queryByRole("button", {
          name: /Have Zavi work on this|Working|Find Reddit opportunities|Coming soon/i,
        }),
      ).toBeNull();
      view.unmount();
    }
  });
});

describe("ChannelDrawer — Reddit keeps the existing action lane", () => {
  it("renders existing Q&A controls on the generic page", async () => {
    render(
      <ChannelDrawer
        detail={{ ...detail("delivered"), channel: reddit, connectors: [] }}
        actionCount={1}
          error={null}
        onClose={() => {}}
        onOpenConnectors={() => {}}
      >
        <li>Existing Q&amp;A approval control</li>
      </ChannelDrawer>,
    );
    await act(async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      }
    });
    expect(screen.getByText("Existing Q&A approval control")).toBeTruthy();
  });

  it("titles the Reddit drawer with the channel's own name, with Close and no platform pill", () => {
    render(
      <ChannelDrawer
        detail={{ ...detail("delivered"), channel: reddit, connectors: [] }}
        actionCount={0}
        error={null}
        onClose={() => {}}
        onOpenConnectors={() => {}}
      />,
    );
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.textContent).toBe(reddit.name);
    const header = title.parentElement!.parentElement!;
    expect(header.textContent).toBe(reddit.name);
    expect(header.querySelector("button[aria-label='Close']")).toBeTruthy();
  });

  it("leaves other channels' headers unchanged", () => {
    render(
      <ChannelDrawer
        detail={detail("delivered")}
        actionCount={0}
        error={null}
        onClose={() => {}}
        onOpenConnectors={() => {}}
      />,
    );
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.textContent).toBe(seo.name);
    expect(title.parentElement!.parentElement!.textContent).toBe(seo.name);
  });
});
describe("the change probe reader", () => {
  const at = new Date().toISOString();
  const read = (probe: Partial<Pick<ChannelDetail, "lastProbeAt" | "lastProbeDelta">>) =>
    detail("idle", probe);

  it("says nothing when the channel has never been probed", () => {
    expect(probeSummary(read({}))).toBeNull();
  });

  it("says nothing when the channel honestly declares no signals", () => {
    expect(
      probeSummary(
        read({
          lastProbeAt: at,
          lastProbeDelta: { verdict: "unavailable", signals: [], reason: "no_signals_declared" },
        }),
      ),
    ).toBeNull();
  });

  it("says so when the probe could not check, rather than saying no change", () => {
    expect(
      probeSummary(
        read({
          lastProbeAt: at,
          lastProbeDelta: { verdict: "unavailable", signals: [], reason: "no_baseline" },
        }),
      ),
    ).toMatch(/Couldn't check/);
  });

  it("reads 'No change' when the probe ran and nothing moved", () => {
    expect(
      probeSummary(
        read({
          lastProbeAt: at,
          lastProbeDelta: {
            verdict: "unchanged",
            signals: [{ key: "ads_spend_7d", prev: 100, now: 101, delta: 1, tripped: false }],
          },
        }),
      ),
    ).toMatch(/No change/);
  });

  it("names what moved, with direction", () => {
    const summary = probeSummary(
      read({
        lastProbeAt: at,
        lastProbeDelta: {
          verdict: "changed",
          signals: [
            { key: "ads_spend_7d", prev: 100, now: 122, delta: 22, tripped: true },
            { key: "ads_cpa_7d", prev: 50, now: 34, delta: -31, tripped: true },
          ],
        },
      }),
    );
    expect(summary).toMatch(/Spend \+22%/);
    expect(summary).toMatch(/CPA -31%/);
  });

  it("does not claim 'No change' when both readings are the same window", () => {
    const summary = probeSummary(
      read({
        lastProbeAt: at,
        lastProbeDelta: { verdict: "unavailable", signals: [], reason: "same_window" },
      }),
    );
    expect(summary).toMatch(/Couldn't check/);
    expect(summary).not.toMatch(/No change/);
  });

  it("does not append a percent sign to an absolute-change signal", () => {
    const summary = probeSummary(
      read({
        lastProbeAt: at,
        lastProbeDelta: {
          verdict: "changed",
          signals: [
            {
              key: "ads_spend_7d",
              prev: 10,
              now: 50,
              delta: 40,
              compare: "abs_change",
              tripped: true,
            },
          ],
        },
      }),
    );
    expect(summary).toMatch(/Spend \+40(?!%)/);
    expect(summary).not.toMatch(/\+40%/);
  });

  it("gives the window the delta was measured over, not when we looked", () => {
    expect(
      probeWindow(
        read({
          lastProbeAt: at,
          lastProbeDelta: {
            verdict: "changed",
            signals: [
              {
                key: "ads_spend_7d",
                prev: 100,
                now: 122,
                delta: 22,
                prev_at: "2026-08-28",
                now_at: "2026-09-04",
                tripped: true,
              },
            ],
          },
        }),
      ),
    ).toMatch(/Aug 2[78] → Sep [34]/);
  });

  it("has no window to give when the verdict carries none", () => {
    expect(
      probeWindow(
        read({
          lastProbeAt: at,
          lastProbeDelta: {
            verdict: "changed",
            signals: [{ key: "ads_spend_7d", prev: 100, now: 122, delta: 22, tripped: true }],
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("every watched metric key has a human label", () => {
  it("reads back no raw metric identifiers", () => {
    const KEYS = ["ads_spend_7d", "ads_cpa_7d", "google_ads_spend_7d", "google_ads_cpa_7d"];
    const summary = probeSummary(
      detail("idle", {
        lastProbeAt: new Date().toISOString(),
        lastProbeDelta: {
          verdict: "changed",
          signals: KEYS.map((key) => ({ key, prev: 100, now: 122, delta: 22, tripped: true })),
        },
      }),
    );
    for (const key of KEYS) {
      expect(summary, `raw key leaked: ${key}`).not.toContain(key);
    }
  });
});
describe("ChannelDrawer — the generic facts rows are gone", () => {
  const metaAds = (CHANNELS as readonly Channel[]).find((c) => c.slug === "meta_ads")!;

  const seoDetail: ChannelDetail = {
    channel: seo,
    mode: "produce",
    connected: false,
    connectors: ["google_search_console"],
    workState: "idle",
    lastRunAt: new Date().toISOString(),
    lastProbeAt: null,
    lastProbeDelta: null,
    runnable: true,
  };

  const renderDetail = (d: ChannelDetail, onOpenConnectors = () => {}) =>
    render(
      <ChannelDrawer
        detail={d}
        actionCount={0}
          error={null}
        onClose={() => {}}
        onOpenConnectors={onOpenConnectors}
      />,
    );

  it("drops the KPI row that named numbers this channel cannot measure", () => {
    renderDetail(seoDetail);
    expect(screen.queryByText("Measured on")).toBeNull();
    for (const kpi of seo.measured_on) expect(screen.queryByText(kpi)).toBeNull();
  });

  it("Google Ads takes the generic page", () => {
    const googleAds = (CHANNELS as readonly Channel[]).find((c) => c.slug === "google_ads")!;
    const view = renderDetail({ ...seoDetail, channel: googleAds });
    expect(view.queryByText("Google Ads panel")).toBeNull();
  });

  it("drops those rows on every other channel too", () => {
    const view = renderDetail({ ...seoDetail, channel: metaAds });
    expect(view.queryByText("Measured on")).toBeNull();
    expect(view.queryByText("Account")).toBeNull();
    expect(view.queryByText("Last worked")).toBeNull();
  });

  it("draws no second connect ask on Overview", () => {
    renderDetail(seoDetail);
    expect(screen.queryByText(/Connect Search Console/i)).toBeNull();
    expect(screen.queryByText(/Connect an account to get real numbers here/i)).toBeNull();
  });

});
