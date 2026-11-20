// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { ChannelDrawer, type ChannelDetail } from "./ChannelDrawer";
import { makeAction } from "../actions/__tests__/fixtures";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../agent/GoogleAdsPanel", () => ({ GoogleAdsPanel: () => <div /> }));
vi.mock("../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

afterEach(cleanup);

const meta = (CHANNELS as readonly Channel[]).find((c) => c.slug === "meta_ads")!;

const BUDGET_RAISE: ChannelActionView = makeAction("update_ad", {
  channel_slug: "meta_ads",
  title: "Raise the “Prospecting — broad” budget to $55 a day",
  executable: true,
  body: {
    action_label: "Adjust budget",
    change_sentence:
      "Zavi changes the daily budget of “Prospecting — broad” from $40 to $55, adding about $456 a month at full delivery.",
    exact_change: {
      rows: [{ item: "“Prospecting — broad” daily budget", before: "$40/day", after: "$55/day" }],
    },
  },
});

const MANUAL_STEP: ChannelActionView = makeAction("check", {
  channel_slug: "meta_ads",
  title: "Check why cost per result doubled on mobile",
  body: {
    action_label: "Do it",
    step: {
      body: "Mobile cost per result went from $9 to $19 while desktop held flat.",
      effort: "hours",
    },
  },
});

const AD_SHAPED_BUT_NOT_EXECUTABLE: ChannelActionView = makeAction("update_ad", {
  channel_slug: "meta_ads",
  title: "Rewrite the primary text on the top ad set",
  body: { action_label: "Rewrite ad set", step: { body: "The same primary text has run for eleven weeks.", effort: "minutes" } },
});

function route(list: { actions: ChannelActionView[]; more?: number; store?: string }) {
  apiFetch.mockImplementation((path: string) => {
    if (String(path).includes("/api/channels/meta_ads/actions")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ actions: list.actions, more: list.more ?? 0, store: list.store ?? "channel_actions" }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ metrics: [], briefs: [], outputs: [] }) });
  });
}

const detail: ChannelDetail = {
  channel: meta,
  mode: "produce",
  connected: true,
  connectors: ["meta_ads"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};

function mount(count: number) {
  return render(
    <ChannelDrawer detail={detail} actionCount={count} error={null} onClose={() => {}} onOpenConnectors={() => {}}>
      <li>A row the panel rendered</li>
    </ChannelDrawer>,
  );
}

beforeEach(() => apiFetch.mockReset());

describe("an executable Meta change shows the server's exact change rows on the card", () => {
  it("renders the rows inline, with the server's own before and after", async () => {
    route({ actions: [BUDGET_RAISE] });
    mount(1);

    const rows = await screen.findByTestId("exact-change");
    const table = within(rows);
    expect(table.getByText("“Prospecting — broad” daily budget")).toBeTruthy();
    expect(table.getByText("$40/day")).toBeTruthy();
    expect(table.getByText("$55/day")).toBeTruthy();
  });

  it("says the change in a sentence on the card", async () => {
    route({ actions: [BUDGET_RAISE] });
    mount(1);

    await screen.findByTestId("exact-change");
    expect(
      within(screen.getByTestId("action-section")).getByText(/changes the daily budget of “Prospecting — broad” from \$40 to \$55/),
    ).toBeTruthy();
  });

  it("names the approve button after the change", async () => {
    route({ actions: [BUDGET_RAISE] });
    mount(1);

    await screen.findByTestId("exact-change");
    const sec = screen.getByTestId("action-section");
    const primary = within(sec).getByText("Adjust budget");
    expect(primary.tagName).toBe("BUTTON");
    expect(within(sec).queryByText("Approve")).toBeNull();
  });

  it("echoes the server's strings character for character, rounding nothing", async () => {
    route({
      actions: [
        makeAction("update_ad", {
          channel_slug: "meta_ads",
          title: "Raise a budget",
          executable: true,
          body: {
            change_sentence: "Zavi changes the daily budget from $40.00 to $1,234.50.",
            exact_change: {
              rows: [{ item: "Daily budget", before: "$40.00/day", after: "$1,234.50/day" }],
            },
          },
        }),
      ],
    });
    mount(1);

    const table = within(await screen.findByTestId("exact-change"));
    expect(table.getByText("$40.00/day")).toBeTruthy();
    expect(table.getByText("$1,234.50/day")).toBeTruthy();
    expect(table.queryByText("$40/day")).toBeNull();
    expect(table.queryByText("$1,235/day")).toBeNull();
    expect(table.queryByText("$1234.50/day")).toBeNull();
  });

  it("renders those rows READ-ONLY: the founder cannot edit what will execute", async () => {
    route({ actions: [BUDGET_RAISE] });
    const { container } = mount(1);

    const rows = await screen.findByTestId("exact-change");
    expect(rows.querySelectorAll("input, textarea, select, [contenteditable='true']")).toHaveLength(0);
    expect(container.querySelectorAll("input, textarea, select, [contenteditable='true']")).toHaveLength(0);
  });
});

describe("the control: a Meta action that is not executable gets NO spend-shaped control", () => {
  it("has no approve button and no primary link, however the card looks", async () => {
    route({ actions: [MANUAL_STEP] });
    mount(1);

    await screen.findByText("Check why cost per result doubled on mobile");
    const sec = screen.getByTestId("action-section");
    expect(sec.textContent).not.toContain("Check · a few hours");
    expect(sec.querySelector("button[data-approve]")).toBeNull();
    expect(within(sec).queryByText("Approve")).toBeNull();
    expect(within(sec).queryByText("Do it")).toBeNull();
    expect(screen.queryByTestId("exact-change")).toBeNull();
    expect(sec.querySelector('[data-testid="card-footer"] button[aria-label="More actions"]')).toBeTruthy();
    expect(within(sec).queryByTestId("post-text")).toBeNull();
  });

  it("and the one WITH an exec_class comes out of the ad card, with rows", async () => {
    route({ actions: [BUDGET_RAISE] });
    mount(1);

    expect(await screen.findByTestId("exact-change")).toBeTruthy();
    const adSec = screen.getByTestId("action-section");
    expect(adSec.querySelector('[data-testid="card-footer"] button[aria-label="More actions"]')).toBeTruthy();
    expect(within(adSec).queryByTestId("post-text")).toBeNull();
    expect(within(adSec).getByText("Adjust budget").tagName).toBe("BUTTON");
  });

  it("an ad-shaped meta action with no exec_class gets the ad card but nothing approvable", async () => {
    route({ actions: [AD_SHAPED_BUT_NOT_EXECUTABLE] });
    mount(1);

    await screen.findByText("Rewrite the primary text on the top ad set");
    const notExecSec = screen.getByTestId("action-section");
    expect(notExecSec.querySelector('[data-testid="card-footer"] button[aria-label="More actions"]')).toBeTruthy();
    expect(within(notExecSec).queryByTestId("post-text")).toBeNull();
    expect(notExecSec.querySelector("button[data-approve]")).toBeNull();
    expect(screen.queryByTestId("exact-change")).toBeNull();
    expect(within(notExecSec).queryByText("Approve")).toBeNull();
    expect(within(notExecSec).queryByText("Rewrite ad set")).toBeNull();
  });
});

describe("the mount never guesses a rail", () => {
  it("leaves the drawer's own list alone when the backend has not switched the channel", async () => {
    route({ actions: [], store: "decisions" });
    mount(1);

    expect(await screen.findByText("A row the panel rendered")).toBeTruthy();
    expect(screen.queryByTestId("action-section")).toBeNull();
  });
});
