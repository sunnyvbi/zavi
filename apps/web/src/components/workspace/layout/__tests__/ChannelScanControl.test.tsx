// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { ChannelPanel } from "../ChannelPanel";
import { ChannelScanControl, LATCH_MAX_MS, scanAgo } from "../ChannelScanControl";
import { PLATFORMS } from "../../actions/platforms";
import { __resetAgentDashCache } from "../../agent/dashboard-ui";
import { agoShort } from "../../agent/reddit/ui";
import type { RedditPayload } from "../../agent/reddit/shared";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({
  useRealtimeChannel: () => {},
}));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

const channel = (slug: string) =>
  (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

type Sweep = NonNullable<RedditPayload["insights"]>["sweep"];

function payload(sweep: Partial<Sweep> = {}): unknown {
  return {
    connected: true,
    manual_publish: true,
    research_summary: null,
    suggestions: [],
    insights: {
      has_data: true,
      sweep: {
        enabled: true,
        last: {
          id: "s1",
          status: "complete",
          trigger: "manual",
          started_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
          finished_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
          posts_scanned: 10,
          comments_scanned: 5,
          communities_scanned: 2,
          error_code: null,
        },
        budget: { used_usd_7d: 1, cap_usd_7d: 10, exhausted: false },
        stale: false,
        ...sweep,
      },
    },
  };
}

function route(dash: unknown) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/dashboard"))
      return dash === null
        ? { ok: false, status: 500, json: async () => ({}) }
        : ok(dash);
    if (u.includes("/actions"))
      return ok({ actions: [], more: 0, store: "channel_actions" });
    if (u.includes("/history"))
      return ok({ runs: [], closed: [], pre_switch: [] });
    if (u.includes("/settings")) return ok({ fields: {} });
    return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
  });
}

function detailFor(slug: string): ChannelDetail {
  return {
    channel: channel(slug),
    mode: "produce",
    connected: true,
    connectors: ["reddit"],
    workState: "delivered",
    lastRunAt: new Date().toISOString(),
    lastProbeAt: null,
    lastProbeDelta: null,
    runnable: true,
  };
}

const sweepCalls = () =>
  apiFetch.mock.calls.filter((c) => String(c[0]) === "/api/reddit/sweep")
    .length;
const dashCalls = () =>
  apiFetch.mock.calls.filter((c) => String(c[0]).includes("/dashboard")).length;

async function mount(slug: string) {
  const view = render(
    <ChannelPanel
      detail={detailFor(slug)}
      actionCount={0}
      onOpenConnectors={() => {}}
    />,
  );
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  route(payload());
});

describe("a channel whose row declares no scan", () => {
  it("draws no control and asks for no dashboard", async () => {
    expect(PLATFORMS.google_ads.scan).toBeUndefined();

    route(null);
    await mount("google_ads");

    expect(screen.queryByTestId("channel-scan")).toBeNull();
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    const dashCalls = apiFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/api/agents/google_ads/dashboard"),
    );
    expect(dashCalls.length).toBeLessThanOrEqual(3);
  });

  it("does not fetch a dashboard when the scan control has no scan specification", async () => {
    expect(PLATFORMS.youtube_ads.scan).toBeUndefined();
    render(<ChannelScanControl slug="youtube_ads" name="YouTube Ads" scan={PLATFORMS.youtube_ads.scan} />);
    expect(screen.queryByTestId("channel-scan")).toBeNull();
    expect(
      apiFetch.mock.calls.filter((c) => String(c[0]).includes("/dashboard")),
    ).toHaveLength(0);
  });

  it("reads YouTube campaigns once without mounting a scan control", async () => {
    __resetAgentDashCache();
    route({ platform: "youtube_ads", campaigns: [], totals: null });
    await mount("youtube_ads");
    expect(screen.queryByTestId("channel-scan")).toBeNull();
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    expect(apiFetch.mock.calls.filter((call) => String(call[0]).includes("/api/agents/youtube_ads/dashboard"))).toHaveLength(1);
    expect(sweepCalls()).toBe(0);
  });
});

describe("a channel whose row declares a scan", () => {
  it("draws when it last ran, and a live Scan now button", async () => {
    await mount("reddit_organic");
    await screen.findByTestId("channel-scan");
    expect(screen.getByText("Scanned 3h ago")).toBeTruthy();
    const button = await screen.findByLabelText("Scan now");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen.queryByRole("img", {
        name: /Scanned in the last 24 hours|No successful scan/,
      }),
    ).toBeNull();
  });

  it("drops the freshness line under the compact breakpoint, keeping the button", async () => {
    await mount("reddit_organic");
    await screen.findByTestId("channel-scan");

    const ago = screen.getByText("Scanned 3h ago");
    expect(ago.className.split(/\s+/)).toContain("compact:hidden");

    const button = await screen.findByLabelText("Scan now");
    expect(button.className).not.toMatch(/compact:hidden/);
  });

  it("never re-adds a compact-only width or truncation rule to a line that is hidden there", async () => {
    await mount("reddit_organic");
    await screen.findByTestId("channel-scan");
    const ago = screen.getByText("Scanned 3h ago");
    expect(ago.className).not.toMatch(/compact:(min-w|truncate|text-)/);
  });

  it("posts to the endpoint the row names, once, however many times it is clicked", async () => {
    await mount("reddit_organic");
    const button = await screen.findByLabelText("Scan now");

    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    const posts = apiFetch.mock.calls.filter(
      (c) => String(c[0]) === "/api/reddit/sweep" && c[1]?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1].body))).toEqual({ trigger: "manual" });
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    expect(screen.getByText("Scanning…")).toBeTruthy();
  });

  it("shows the server's sentence for a lifetime run cap 429, not the weekly-budget line", async () => {
    const msg = "This workspace has used all its GEO runs for now. Your saved results stay on the page.";
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/reddit/sweep" && init?.method === "POST")
        return { ok: false, status: 429, json: async () => ({ error: { code: "tenant_limit_reached", message: msg } }) };
      return base(url, init);
    });
    await mount("reddit_organic");
    await act(async () => {
      fireEvent.click(await screen.findByLabelText("Scan now"));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(msg);
  });

  it("spends exactly one sweep across a tap, a tap mid-POST, and a tap after a payload lands mid-POST", async () => {
    await mount("reddit_organic");
    const button = await screen.findByLabelText("Scan now");

    let releasePost!: () => void;
    const postGate = new Promise<void>((r) => {
      releasePost = r;
    });
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/reddit/sweep" && init?.method === "POST") {
        await postGate;
        return ok({});
      }
      if (u.includes("/dashboard")) return ok(payload());
      if (u.includes("/actions"))
        return ok({ actions: [], more: 0, store: "channel_actions" });
      if (u.includes("/history"))
        return ok({ runs: [], closed: [], pre_switch: [] });
      if (u.includes("/settings")) return ok({ fields: {} });
      return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
    });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(sweepCalls()).toBe(1);
    expect(screen.getByText("Scanning…")).toBeTruthy();
    const disc = screen.getByLabelText("Refresh") as HTMLButtonElement;
    expect(disc.disabled).toBe(true);

    const readsBeforeSecondTap = dashCalls();
    await act(async () => {
      fireEvent.click(disc);
    });
    expect(dashCalls()).toBe(readsBeforeSecondTap);
    expect(sweepCalls()).toBe(1);

    __resetAgentDashCache();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dashCalls()).toBeGreaterThan(readsBeforeSecondTap);
    expect(screen.getByText("Scanning…")).toBeTruthy();
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    expect((screen.getByLabelText("Refresh") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Refresh"));
    });
    expect(sweepCalls()).toBe(1);

    await act(async () => {
      releasePost();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Scan now") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(sweepCalls()).toBe(1);
  });

  it("shows Scanning… and no button while the payload says a scan is running", async () => {
    route(
      payload({
        last: {
          id: "s2",
          status: "running",
          trigger: "manual",
          started_at: new Date().toISOString(),
          finished_at: null,
          posts_scanned: 0,
          comments_scanned: 0,
          communities_scanned: 0,
          error_code: null,
        },
      }),
    );
    await mount("reddit_organic");
    await screen.findByText("Scanning…");
    expect(screen.queryByLabelText("Scan now")).toBeNull();
  });

  it("re-reads instead of sweeping when the week's budget is used up", async () => {
    route(
      payload({ budget: { used_usd_7d: 10, cap_usd_7d: 10, exhausted: true } }),
    );
    await mount("reddit_organic");
    const button = await screen.findByLabelText("Refresh");
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    expect(
      screen.getByText(
        "This week's scan budget is used up. Scans resume as the 7-day window rolls.",
      ),
    ).toBeTruthy();

    const before = dashCalls();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(sweepCalls()).toBe(0);
    expect(dashCalls()).toBeGreaterThan(before);
  });

  it("re-reads instead of sweeping when scanning is switched off", async () => {
    route(payload({ enabled: false }));
    await mount("reddit_organic");
    const button = await screen.findByLabelText("Refresh");
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    expect(screen.getAllByText("Reddit scanning is turned off.").length).toBeGreaterThan(0);

    const before = dashCalls();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(sweepCalls()).toBe(0);
    expect(dashCalls()).toBeGreaterThan(before);
  });

  it("still offers a refresh when the payload carries no scan state", async () => {
    route({ connected: true, insights: { has_data: true } });
    await mount("reddit_organic");
    const button = await screen.findByLabelText("Refresh");
    expect(screen.queryByLabelText("Scan now")).toBeNull();

    const before = dashCalls();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(sweepCalls()).toBe(0);
    expect(dashCalls()).toBeGreaterThan(before);
  });

  it("waits for the first read, then stands its ground", async () => {
    __resetAgentDashCache();
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => {
      release = r;
    });
    apiFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/dashboard")) {
        await gate;
        return ok(payload());
      }
      if (u.includes("/actions"))
        return ok({ actions: [], more: 0, store: "channel_actions" });
      if (u.includes("/history"))
        return ok({ runs: [], closed: [], pre_switch: [] });
      if (u.includes("/settings")) return ok({ fields: {} });
      return ok({ snapshots: [], artifacts: [], briefs: [], metrics: [] });
    });

    render(
      <ChannelPanel
        detail={detailFor("reddit_organic")}
        actionCount={0}
        onOpenConnectors={() => {}}
      />,
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId("channel-scan")).toBeNull();

    await act(async () => {
      release(null);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("channel-scan")).toBeTruthy(),
    );
  });

  it("still offers a refresh when the tenant switched the surface off", async () => {
    route({ ...(payload() as Record<string, unknown>), workspace_v2: false });
    await mount("reddit_organic");
    expect(PLATFORMS.reddit_organic.payload?.offWhen).toBeDefined();
    const button = await screen.findByLabelText("Refresh");
    expect(screen.queryByLabelText("Scan now")).toBeNull();

    const before = dashCalls();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(sweepCalls()).toBe(0);
    expect(dashCalls()).toBeGreaterThan(before);
  });

  it("still offers a refresh while a sweep is running", async () => {
    route(
      payload({
        last: {
          id: "s9",
          status: "running",
          trigger: "manual",
          started_at: new Date().toISOString(),
          finished_at: null,
          posts_scanned: 0,
          comments_scanned: 0,
          communities_scanned: 0,
          error_code: null,
        },
      }),
    );
    await mount("reddit_organic");
    expect(screen.getByText("Scanning…")).toBeTruthy();
    const button = await screen.findByLabelText("Refresh");

    const before = dashCalls();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(sweepCalls()).toBe(0);
    expect(dashCalls()).toBeGreaterThan(before);
  });

  const failedSweep = (status: "failed" | "partial", error_code: string | null) =>
    payload({
      last: {
        id: "s3",
        status,
        trigger: "manual",
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: new Date(Date.now() - 60_000).toISOString(),
        posts_scanned: 0,
        comments_scanned: 0,
        communities_scanned: 0,
        error_code,
      },
    });

  it("says the last scan failed, claims no scan time for it, draws no freshness dot, and keeps the button", async () => {
    route(failedSweep("failed", "boom"));
    await mount("reddit_organic");
    await screen.findByTestId("channel-scan");
    expect(screen.getByRole("status").textContent).toBe("Last scan failed before it finished. Try again.");
    expect(screen.queryByText(/^Scanned /)).toBeNull();
    expect(screen.getByLabelText("Scan now")).toBeTruthy();
    expect(
      screen.queryByRole("img", {
        name: /Scanned in the last 24 hours|No successful scan/,
      }),
    ).toBeNull();
  });

  it.each([
    ["no_data_returned", "Last scan read nothing from Reddit. Check your keywords and subreddits, or try again later."],
    ["all_jobs_failed", "Last scan failed: Zavi couldn't read Reddit. Try again later."],
    ["no_jobs_run", "Last scan failed: Zavi couldn't read Reddit. Try again later."],
  ])("names why a failed scan (%s) read nothing", async (code, line) => {
    route(failedSweep("failed", code));
    await mount("reddit_organic");
    await screen.findByTestId("channel-scan");
    expect(screen.getByRole("status").textContent).toBe(line);
    expect(screen.queryByText(/^Scanned /)).toBeNull();
  });

  it("keeps the time of a partial scan and says it only partly finished", async () => {
    route(failedSweep("partial", null));
    await mount("reddit_organic");
    await screen.findByTestId("channel-scan");
    expect(screen.getByRole("status").textContent).toBe("Last scan only partly finished.");
    expect(screen.getByText("Scanned 1m ago")).toBeTruthy();
  });

  it("hides the failure line while a new scan is running", async () => {
    route(failedSweep("failed", "boom"));
    await mount("reddit_organic");
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/reddit/sweep" && init?.method === "POST") return new Promise(() => {});
      return base(url, init);
    });
    await act(async () => {
      fireEvent.click(await screen.findByLabelText("Scan now"));
    });
    expect(screen.getByText("Scanning…")).toBeTruthy();
    expect(screen.queryByText("Last scan failed before it finished. Try again.")).toBeNull();
  });

  it("shows Scanning… as visible text, not only to screen readers", async () => {
    route(
      payload({
        last: {
          id: "s10",
          status: "running",
          trigger: "manual",
          started_at: new Date().toISOString(),
          finished_at: null,
          posts_scanned: 0,
          comments_scanned: 0,
          communities_scanned: 0,
          error_code: null,
        },
      }),
    );
    await mount("reddit_organic");
    const label = await screen.findByText("Scanning…");
    expect(label.className.split(/\s+/)).not.toContain("sr-only");
  });

  it("tells the founder a scan is already running when they press the disc mid-sweep, and still spends nothing", async () => {
    route(
      payload({
        last: {
          id: "s11",
          status: "running",
          trigger: "manual",
          started_at: new Date().toISOString(),
          finished_at: null,
          posts_scanned: 0,
          comments_scanned: 0,
          communities_scanned: 0,
          error_code: null,
        },
      }),
    );
    await mount("reddit_organic");
    const before = dashCalls();
    await act(async () => {
      fireEvent.click(await screen.findByLabelText("Refresh"));
    });
    expect((await screen.findByRole("alert")).textContent).toBe("A scan is already running.");
    expect(sweepCalls()).toBe(0);
    expect(dashCalls()).toBeGreaterThan(before);
  });

  it("does not show the already-running line when a blocked disc is pressed", async () => {
    route(payload({ enabled: false }));
    await mount("reddit_organic");
    await act(async () => {
      fireEvent.click(await screen.findByLabelText("Refresh"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("a refused Scan now says why", () => {
    const refuse = (status: number, body: unknown) => {
      const base = apiFetch.getMockImplementation()!;
      apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url) === "/api/reddit/sweep" && init?.method === "POST")
          return { ok: false, status, json: async () => body };
        return base(url, init);
      });
    };
    const press = async () => {
      await mount("reddit_organic");
      await act(async () => {
        fireEvent.click(await screen.findByLabelText("Scan now"));
      });
      return (await screen.findByRole("alert")).textContent;
    };

    it.each([
      [409, {}, "A scan is already running."],
      [429, { reason: "rate_limited" }, "A scan ran a few minutes ago. Try again in a few minutes."],
      [429, { error: "tenant_cap_reached" }, "This week's scan budget is used up. Scans resume as the 7-day window rolls."],
      [429, { error: { code: "fleet_cap_reached" } }, "Zavi has hit today's Reddit scan limit across all workspaces. Try again tomorrow."],
      [429, {}, "A scan ran a few minutes ago, or this week's scan budget is used up."],
      [429, { reason: "rate_limited", message: "Wait 4 minutes before scanning again." }, "Wait 4 minutes before scanning again."],
      [403, {}, "Only an owner or an admin can change this."],
      [403, { error: { code: "forbidden", message: "Members cannot start scans." } }, "Members cannot start scans."],
    ])("%i %j", async (status, body, line) => {
      refuse(status, body);
      expect(await press()).toBe(line);
      expect(sweepCalls()).toBe(1);
      expect(screen.getByLabelText("Scan now")).toBeTruthy();
    });

    it("keeps a refusal on screen past the old two-second clear", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        refuse(429, { reason: "rate_limited" });
        await press();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(4_000);
        });
        expect(screen.getByRole("alert").textContent).toBe("A scan ran a few minutes ago. Try again in a few minutes.");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
        expect(screen.queryByRole("alert")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("offers a refresh, and claims no scan, when the payload has no sweep state", async () => {
    route({
      connected: true,
      manual_publish: true,
      suggestions: [],
      insights: null,
    });
    await mount("reddit_organic");
    expect(screen.getByTestId("channel-scan")).toBeTruthy();
    expect(screen.queryByLabelText("Scan now")).toBeNull();
    expect(screen.queryByText(/^Scanned /)).toBeNull();
    expect(
      screen.queryByLabelText(
        /Scanned in the last 24 hours|No successful scan/,
      ),
    ).toBeNull();
    expect(screen.getByLabelText("Refresh")).toBeTruthy();
  });
});

describe("the relative time reads the same as Reddit's own", () => {
  it("agrees on every branch", () => {
    const now = Date.now();
    for (const ms of [0, 30_000, 5 * 60_000, 3 * 3600_000, 50 * 3600_000]) {
      const iso = new Date(now - ms).toISOString();
      expect(scanAgo(iso)).toBe(agoShort(iso));
    }
    expect(scanAgo(null)).toBe(agoShort(null));
  });
});

describe("what the scan line tells the founder after the scan ends", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the age moving: 'just now' becomes '2m ago' without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const justNow = new Date(Date.now() - 10_000).toISOString();
    route(payload({ last: { ...(payload() as { insights: { sweep: Sweep } }).insights.sweep.last!, started_at: justNow, finished_at: justNow } }));
    await mount("reddit_organic");
    expect(await screen.findByText("Scanned just now")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });

    expect(screen.getByText("Scanned 2m ago")).toBeTruthy();
  });

  it("lifts 'Scanning…' when the POST landed but every re-read after it fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount("reddit_organic");
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/dashboard")) return { ok: false, status: 503, json: async () => ({}) };
      return base(url, init);
    });

    await act(async () => {
      fireEvent.click(await screen.findByLabelText("Scan now"));
    });
    expect(screen.getByText("Scanning…")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LATCH_MAX_MS + 1_000);
    });

    expect(screen.queryByText("Scanning…")).toBeNull();
    expect(apiFetch.mock.calls.some((c) => String(c[0]).includes("meter=1"))).toBe(false);
    const posts = apiFetch.mock.calls.filter(
      (c) => String(c[0]) === "/api/reddit/sweep" && (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(1);
  });
});
