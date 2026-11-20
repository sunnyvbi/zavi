// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { ChannelPanel } from "../ChannelPanel";
import { PLATFORMS } from "../../actions/platforms";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div data-testid="schedule-view" /> }));

const tenant = vi.hoisted(() => ({ name: "t0", n: 0 }));
vi.mock("@/components/workspace/WorkspaceShell", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, useWorkspaceOptional: () => ({ tenantName: tenant.name }) };
});

const channel = (slug: string) => (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

type Over = {
  workspace_v2?: boolean;
  keywordTypes?: string[];
  competitors?: number;
  sweepStatus?: string;
};

function payload(over: Over = {}): unknown {
  const types = over.keywordTypes ?? ["brand"];
  return {
    connected: true,
    manual_publish: true,
    research_summary: null,
    suggestions: [],
    ...(over.workspace_v2 === undefined ? {} : { workspace_v2: over.workspace_v2 }),
    workspace: {
      keywords: types.map((type, i) => ({
        id: `k${i}`,
        term: `term${i}`,
        type,
        origin: "custom",
        status: "tracking",
      })),
      competitors: Array.from({ length: over.competitors ?? 0 }, (_, i) => ({
        id: `c${i}`,
        name: `rival${i}`,
        origin: "custom",
        status: "tracking",
      })),
      communities: [],
    },
    insights: {
      has_data: false,
      sweep: {
        enabled: true,
        last: {
          id: "s1",
          status: over.sweepStatus ?? "complete",
          trigger: "manual",
          started_at: "2026-09-19T00:00:00.000Z",
          finished_at: over.sweepStatus === "running" ? null : "2026-09-19T00:05:00.000Z",
          posts_scanned: 1,
          comments_scanned: 1,
          communities_scanned: 1,
          error_code: null,
        },
        budget: { used_usd_7d: 0, cap_usd_7d: 10, exhausted: false },
        stale: false,
      },
    },
  };
}

function route(dash: unknown) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/dashboard")) return ok(dash);
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history")) return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/settings")) return ok({ fields: {} });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
  });
}

const detailFor = (slug: string): ChannelDetail => ({
  channel: channel(slug),
  mode: "produce",
  connected: true,
  connectors: ["reddit"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

async function mount(slug: string) {
  const view = render(
    <ChannelPanel detail={detailFor(slug)} actionCount={0} onOpenConnectors={() => {}} />,
  );
  await settle();
  return view;
}

const callsTo = (fragment: string) =>
  apiFetch.mock.calls.filter((c) => String(c[0]).includes(fragment));

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  tenant.n += 1;
  tenant.name = `tenant-${tenant.n}`;
  route(payload());
});

describe("the per-tenant kill switch is honoured by the generic page", () => {
  it("is declared on the row, not read in the panel", () => {
    expect(PLATFORMS.reddit_organic.payload?.offWhen).toBeTypeOf("function");
    expect(PLATFORMS.reddit_organic.payload?.offWhen?.({ workspace_v2: false })).toBe(true);
    expect(PLATFORMS.reddit_organic.payload?.offWhen?.({})).toBe(false);
  });

  it("switched off: no settings fields, no scan offered, and nothing is spent", async () => {
    route(payload({ workspace_v2: false, keywordTypes: [] }));
    await mount("reddit_organic");

    await act(async () => {
      screen.getByRole("tab", { name: /Settings/i }).click();
    });
    expect(callsTo("/api/channels/reddit_organic/settings")).toHaveLength(0);
    expect(screen.queryByText("Keywords")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save settings/i })).toBeNull();
    expect(screen.getByTestId("channel-scan")).toBeTruthy();
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    expect(screen.getByLabelText("Refresh")).toBeTruthy();
    await act(async () => {
      screen.getByLabelText("Refresh").click();
    });
    expect(callsTo("/api/reddit/sweep")).toHaveLength(0);
    expect(callsTo("/api/reddit/workspace/suggest")).toHaveLength(0);
  });

  it("switched off: the channel itself is still on the page", async () => {
    route(payload({ workspace_v2: false, keywordTypes: [] }));
    await mount("reddit_organic");
    expect(screen.getByTestId("action-section")).toBeTruthy();
    await act(async () => {
      screen.getByRole("tab", { name: /Settings/i }).click();
    });
    expect(screen.getByTestId("channel-run-note")).toBeTruthy();
  });

  it("switched on: the Settings tab is there", async () => {
    route(payload({ workspace_v2: true }));
    await mount("reddit_organic");
    expect(screen.getByRole("tab", { name: /Settings/i })).toBeTruthy();
  });

  it("reads the YouTube campaign table without running payload seeding", async () => {
    expect(PLATFORMS.youtube_ads.payload).toBeUndefined();
    expect(PLATFORMS.youtube_ads.extras).toContain("campaign_table");
    route({ platform: "youtube_ads", campaigns: [], totals: null });
    await mount("youtube_ads");
    expect(callsTo("/api/agents/youtube_ads/dashboard")).toHaveLength(1);
    expect(apiFetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
  });
});

describe("opening the channel never suggests on its own", () => {
  it("spends nothing on an empty workspace, on either tab, across a re-read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route(payload({ keywordTypes: ["brand"], competitors: 0, sweepStatus: "running" }));
      render(
        <ChannelPanel
          detail={detailFor("reddit_organic")}
          actionCount={0}
          onOpenConnectors={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(callsTo("/api/reddit/workspace/suggest")).toHaveLength(0);

      fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(callsTo("/api/reddit/workspace/suggest")).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(callsTo("/api/reddit/workspace/suggest")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suggests only when the founder presses Suggest", async () => {
    route(payload({ keywordTypes: ["brand"], competitors: 0 }));
    await mount("reddit_organic");
    fireEvent.click(screen.getByRole("tab", { name: /Settings/i }));
    await settle();
    expect(callsTo("/api/reddit/workspace/suggest")).toHaveLength(0);

    fireEvent.click(screen.getAllByRole("button", { name: /^Suggest$/ })[0]);
    await settle();

    const posts = callsTo("/api/reddit/workspace/suggest");
    expect(posts).toHaveLength(1);
    expect((posts[0][1] as { method?: string })?.method).toBe("POST");
  });
});

describe("the page re-reads itself while a sweep is running", () => {
  it("polls while running, stops when it finishes, and stops on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route(payload({ sweepStatus: "running", keywordTypes: ["brand", "product"] }));
      const view = render(
        <ChannelPanel
          detail={detailFor("reddit_organic")}
          actionCount={0}
          onOpenConnectors={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      const before = callsTo("/api/agents/reddit_organic/dashboard").length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      const running = callsTo("/api/agents/reddit_organic/dashboard").length;
      expect(running).toBeGreaterThan(before);

      route(payload({ sweepStatus: "complete", keywordTypes: ["brand", "product"] }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      const settled = callsTo("/api/agents/reddit_organic/dashboard").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(callsTo("/api/agents/reddit_organic/dashboard").length).toBe(settled);

      view.unmount();
      const atUnmount = callsTo("/api/agents/reddit_organic/dashboard").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(callsTo("/api/agents/reddit_organic/dashboard").length).toBe(atUnmount);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the generic page draws no duplicate React key", () => {
  it("logs no same-key error on a channel page", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mount("google_ads");
      const sameKey = spy.mock.calls.filter((c) => String(c[0]).includes("same key"));
      expect(sameKey).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
