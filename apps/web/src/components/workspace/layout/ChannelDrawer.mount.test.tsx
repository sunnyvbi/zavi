// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { ChannelDrawer, type ChannelDetail } from "./ChannelDrawer";
import { makeAction } from "../actions/__tests__/fixtures";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../agent/GoogleAdsPanel", () => ({ GoogleAdsPanel: () => <div /> }));
vi.mock("../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../agent/XAgentDashboard", () => ({ XAgentDashboard: () => <div /> }));
vi.mock("../agent/ScheduleView", () => ({
  ScheduleView: () => <div data-testid="schedule-view" />,
}));

afterEach(cleanup);
beforeEach(() => apiFetch.mockReset());

const email = (CHANNELS as readonly Channel[]).find((c) => c.slug === "email_marketing")!;

const SLUG = "email_marketing";

const RANKED: ChannelActionView[] = [
  makeAction("check", { channel_slug: SLUG, title: "RANKED A — first out of the ranker" }),
  makeAction("check", { channel_slug: SLUG, title: "RANKED B — second" }),
  makeAction("check", { channel_slug: SLUG, title: "RANKED C — third" }),
];

const CHILDREN = (
  <>
    <li>UNRANKED Z — newest by proposed_at</li>
    <li>UNRANKED Y — next newest</li>
  </>
);

function route(list: { actions: ChannelActionView[]; more?: number; store?: string }) {
  apiFetch.mockImplementation((path: string) => {
    if (String(path).includes(`/api/channels/${SLUG}/actions`)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ actions: list.actions, more: list.more ?? 0, store: list.store ?? "channel_actions" }),
      });
    }
    if (String(path).includes("/history")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ runs: [], closed: [], pre_switch: [] }) });
    if (String(path).includes("/email-test-lists")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ routes: [], orphans: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ metrics: [], briefs: [], artifacts: [] }) });
  });
}

const detail: ChannelDetail = {
  channel: email,
  mode: "produce",
  connected: true,
  connectors: ["sendgrid"],
  workState: "delivered",
  lastRunAt: new Date().toISOString(),
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};

function mount(over: Partial<ChannelDetail> = {}, actionCount = 2) {
  return render(
    <ChannelDrawer
      detail={{ ...detail, ...over }}
      actionCount={actionCount}
      error={null}
      onClose={() => {}}
      onOpenConnectors={() => {}}
    >
      {CHILDREN}
    </ChannelDrawer>,
  );
}

function primary() {
  return screen.getByTestId("action-section");
}

describe("a switched generic channel renders the RANKED rows, never the drawer's children", () => {
  it("paints the ranker's three rows, in the ranker's order", async () => {
    route({ actions: RANKED });
    mount();

    await screen.findByText("RANKED A — first out of the ranker");
    const section = primary();
    expect(within(section).queryByRole("button", { name: "Show more" })).toBeNull();
    const titles = Array.from(section.querySelectorAll("article")).map((card) => within(card).getByRole("heading", { name: /RANKED/ }).textContent);
    expect(titles).toEqual([
      "RANKED A — first out of the ranker",
      "RANKED B — second",
      "RANKED C — third",
    ]);
  });

  it("keeps the unranked rows out of the primary list, inside the fold only", async () => {
    route({ actions: RANKED });
    const { container } = mount();

    await screen.findByText("RANKED A — first out of the ranker");
    expect(within(primary()).queryByText(/^UNRANKED/)).toBeNull();

    const fold = container.querySelector("details")!;
    expect(fold).toBeTruthy();
    expect(within(fold as HTMLElement).getByText("UNRANKED Z — newest by proposed_at")).toBeTruthy();
    expect(within(fold as HTMLElement).getByText("UNRANKED Y — next newest")).toBeTruthy();
  });
});

describe("an EMPTY ranked list is still the ranked rail, not the unranked one", () => {
  it("shows the four-state empty, not the drawer's children", async () => {
    route({ actions: [], store: "channel_actions" });
    mount({ workState: "delivered" });

    await screen.findByTestId("action-section");
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(within(primary()).queryByText(/^UNRANKED/)).toBeNull();
  });

  it("tells a failed run apart from an idle channel inside that empty", async () => {
    route({ actions: [], store: "channel_actions" });
    mount({ workState: "needs_review" });

    await screen.findByTestId("action-section");
    expect(screen.getByText("The last run didn't finish")).toBeTruthy();
  });

  it("renders the in-flight state as a component, which a <p> wrapper cannot hold", async () => {
    route({ actions: [], store: "channel_actions" });
    const { container } = mount({ workState: "running" });

    await screen.findByTestId("action-section");
    expect(screen.getByText(/Cooking up new suggestions for Email campaigns/)).toBeTruthy();

    const live = container.querySelector("[aria-live='polite']")!;
    expect(live).toBeTruthy();
    expect(live.closest("p"), "ActionSection must wrap `empty` in a <div>").toBeNull();
  });
});

describe("the mount never guesses a rail", () => {
  it("leaves the drawer's own list alone when the backend has not switched the channel", async () => {
    route({ actions: [], store: "decisions" });
    mount();

    expect(await screen.findByText("UNRANKED Z — newest by proposed_at")).toBeTruthy();
    expect(screen.queryByTestId("action-section")).toBeNull();
  });

  it("keeps the layout, with one line and a retry, when the store could not be resolved at all", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (String(path).includes(`/api/channels/${SLUG}/actions`)) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "HTTP 500" } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ metrics: [], briefs: [], artifacts: [] }) });
    });
    mount();

    expect(within(await screen.findByTestId("channel-refresh-line")).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getAllByTestId("channel-refresh-line")).toHaveLength(1);
    const section = screen.getByTestId("action-section");
    expect(section.querySelectorAll("article")).toHaveLength(0);
    expect(screen.queryByText(/^UNRANKED/)).toBeNull();
  });
});

describe("empty metrics state their cause instead of hiding", () => {
  it("says why there are none and what would produce them", async () => {
    route({ actions: RANKED });
    mount();

    const line = await screen.findByTestId("channel-value-empty");
    expect(line.textContent).toContain("hasn't judged this channel");
    expect(line.textContent).not.toContain("first time");
  });

  it("names the connector when there is one and it is not connected", async () => {
    route({ actions: RANKED });
    mount({ connected: false });

    const line = await screen.findByTestId("channel-value-empty");
    expect(line.textContent).not.toContain("Nothing has written numbers here yet.");
  });
});

describe("the composed surfaces survive the swap", () => {
  it("drops the description, the mode copy and the facts list from Overview", async () => {
    route({ actions: RANKED });
    mount();

    await screen.findByTestId("action-section");
    expect(screen.queryByText(email.description)).toBeNull();
    expect(screen.queryByText("Account")).toBeNull();
    expect(screen.queryByText("Last worked")).toBeNull();
    expect(screen.queryByText("Measured on")).toBeNull();
    expect(screen.queryByText(email.measured_on.join(", "))).toBeNull();
  });

  it("shows no timer line for Email campaigns on either tab, even when it can run", async () => {
    route({ actions: RANKED });
    mount();

    await screen.findByTestId("action-section");
    expect(screen.queryByTestId("channel-run-note")).toBeNull();
    await act(async () => {
      screen.getByRole("tab", { name: /Settings/ }).click();
    });
    expect(await screen.findByRole("heading", { name: "Contacts" })).toBeTruthy();
    expect(screen.queryByTestId("channel-run-note")).toBeNull();
    expect(screen.queryByText(/There is no timer for/)).toBeNull();
  });

  it("and drops the schedule when the channel cannot run, exactly as before", async () => {
    route({ actions: RANKED });
    mount({ connected: false });

    await screen.findByTestId("action-section");
    expect(screen.queryByTestId("channel-run-note")).toBeNull();
    await act(async () => {
      screen.getByRole("tab", { name: /Settings/ }).click();
    });
    expect(screen.queryByTestId("channel-run-note")).toBeNull();
  });
});

describe("the FIRST PAINT, before the ranked call answers, is never the unranked rail", () => {
  function routePending() {
    apiFetch.mockImplementation((path: string) => {
      if (String(path).includes(`/api/channels/${SLUG}/actions`)) return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ metrics: [], briefs: [], artifacts: [] }) });
    });
  }

  it("does not paint the drawer's children while the store is still unknown", () => {
    routePending();
    mount();

    expect(screen.queryByText(/^UNRANKED/)).toBeNull();
    expect(screen.queryByTestId("action-section")).toBeNull();
  });

  it("says it is reading, rather than showing a list it does not have", () => {
    routePending();
    const { container } = mount();

    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.getByTestId("channel-overview-loading")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Next steps" })).toBeNull();
  });

  it("and it is the SAME mount that later shows the ranked rows", async () => {
    route({ actions: RANKED });
    mount();

    expect(screen.queryByText(/^UNRANKED/)).toBeNull();
    await screen.findByText("RANKED A — first out of the ranker");
    expect(within(primary()).queryByText(/^UNRANKED/)).toBeNull();
  });
});

describe("switching channels does not leave the previous channel's rows on screen", () => {
  it("drops them the moment the slug changes, before the new call answers", async () => {
    route({ actions: RANKED });
    const view = mount();
    await screen.findByText("RANKED A — first out of the ranker");

    const sms = (CHANNELS as readonly Channel[]).find((c) => c.slug === "sms")!;
    apiFetch.mockImplementation((path: string) => {
      if (String(path).includes("/api/channels/sms/actions")) return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ metrics: [], briefs: [], artifacts: [] }) });
    });
    view.rerender(
      <ChannelDrawer
        detail={{ ...detail, channel: sms }}
        actionCount={2}
        error={null}
        onClose={() => {}}
        onOpenConnectors={() => {}}
      >
        {CHILDREN}
      </ChannelDrawer>,
    );

    expect(screen.queryByText("RANKED A — first out of the ranker")).toBeNull();
    expect(screen.queryByText("RANKED C — third")).toBeNull();
  });
});
