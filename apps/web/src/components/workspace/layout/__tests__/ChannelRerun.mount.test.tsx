// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { ChannelDrawer, type ChannelDetail } from "../ChannelDrawer";
import { makeAction } from "../../actions/__tests__/fixtures";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../../agent/GoogleAdsPanel", () => ({ GoogleAdsPanel: () => <div /> }));
vi.mock("../../agent/RedditOrganicDashboard", () => ({ RedditOrganicDashboard: () => <div /> }));
vi.mock("../../agent/XAgentDashboard", () => ({ XAgentDashboard: () => <div /> }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

afterEach(cleanup);
beforeEach(() => apiFetch.mockReset());

const SLUG = "email_marketing";
const email = (CHANNELS as readonly Channel[]).find((c) => c.slug === SLUG)!;

const PRE_SWITCH_ROWS = (
  <>
    <li>
      PRE-SWITCH Z — staged before the move
      <button type="button">Approve</button>
      <button type="button">Reject</button>
    </li>
    <li>
      PRE-SWITCH Y — also before the move
      <button type="button">Approve</button>
      <button type="button">Reject</button>
    </li>
  </>
);

const preSwitchRow = (n: number) => ({
  run_id: `run-${n}`,
  title: `Pre-switch step ${n}`,
  position: n,
  of: 5,
  status: "archived",
  emitted_at: "2026-09-10T10:00:00Z",
  archived_at: "2026-09-19T10:00:00Z",
  source: "decision" as const,
});

function route(list: {
  actions: ChannelActionView[];
  store?: string;
  history?: { preSwitch: number } | "pending" | "fail";
}) {
  apiFetch.mockImplementation((path: string) => {
    if (String(path).includes(`/api/channels/${SLUG}/actions`)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          actions: list.actions,
          more: 0,
          store: list.store ?? "channel_actions",
        }),
      });
    }
    if (String(path).includes(`/api/channels/${SLUG}/history`)) {
      const h = list.history ?? { preSwitch: 0 };
      if (h === "pending") return new Promise(() => {});
      if (h === "fail") {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "read_failed" } }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          runs: [],
          closed: [],
          pre_switch: Array.from({ length: h.preSwitch }, (_, i) => preSwitchRow(i + 1)),
        }),
      });
    }
    if (String(path).includes(`/api/channels/${SLUG}/run`)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, run_id: "run-new", stamped: true }),
      });
    }
    if (String(path) === "/api/channels") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          channels: [{ channel_slug: SLUG, run_reserve_credits: 340, last_run_id: null }],
        }),
      });
    }
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
      {PRE_SWITCH_ROWS}
    </ChannelDrawer>,
  );
}

describe("a switched channel with nothing ranked offers a run, and nothing approvable", () => {
  it("renders the fifth empty state and a pressable run button", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    mount();

    const state = await screen.findByTestId("empty-switched");
    expect(
      within(state).getByText("Nothing here yet"),
    ).toBeTruthy();

    const button = screen.getByTestId("run-channel") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await waitFor(() => expect(screen.getByTestId("run-channel")).toBeTruthy());
    expect(screen.queryByText("About 340 credits")).toBeNull();
  });

  it("renders NONE of the pre-switch rows as approvable", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    const view = mount();
    await screen.findByTestId("empty-switched");

    const fold = view.container.querySelector("[data-testid='prior-items']") as HTMLElement;
    expect(fold).toBeTruthy();
    expect(within(fold).getByText(/PRE-SWITCH Z/)).toBeTruthy();

    const verbs = Array.from(fold.querySelectorAll("button")).filter((b) =>
      /^(Approve|Reject)$/.test(b.textContent ?? ""),
    );
    expect(verbs.length).toBe(4);
    for (const verb of verbs) {
      const guard = verb.closest("fieldset");
      expect(guard, "a pre-switch verb outside the read-only fieldset").toBeTruthy();
      expect(guard!.hasAttribute("disabled")).toBe(true);
    }

    const section = screen.getByTestId("action-section");
    expect(within(section).queryByText(/PRE-SWITCH/)).toBeNull();
  });

  it("pressing it calls POST /api/channels/:slug/run, once", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    mount();
    await screen.findByTestId("empty-switched");

    const button = screen.getByTestId("run-channel");
    fireEvent.click(button);

    await waitFor(() => {
      const posts = apiFetch.mock.calls.filter(
        ([path, init]: [string, RequestInit | undefined]) =>
          String(path) === `/api/channels/${SLUG}/run` && init?.method === "POST",
      );
      expect(posts.length).toBe(1);
    });

    await waitFor(() => expect(screen.queryByTestId("empty-running")).not.toBeNull());
    expect(screen.queryByTestId("run-channel")).toBeNull();
  });

  it("sends a request_id, and sends the SAME one after a reload mid-flight", async () => {
    window.localStorage.clear();
    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    mount();
    await screen.findByTestId("empty-switched");
    fireEvent.click(screen.getByTestId("run-channel"));

    const idOf = (call: [string, RequestInit | undefined]) =>
      (JSON.parse(String(call[1]?.body ?? "{}")) as { request_id?: string }).request_id;
    const posts = () =>
      apiFetch.mock.calls.filter(
        ([path, init]: [string, RequestInit | undefined]) =>
          String(path) === `/api/channels/${SLUG}/run` && init?.method === "POST",
      );

    await waitFor(() => expect(posts().length).toBe(1));
    const first = idOf(posts()[0]);
    expect(typeof first).toBe("string");
    expect((first ?? "").length).toBeGreaterThanOrEqual(8);

    cleanup();
    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    mount();
    await screen.findByTestId("empty-switched");
    fireEvent.click(screen.getByTestId("run-channel"));

    await waitFor(() => expect(posts().length).toBe(2));
    expect(idOf(posts()[1])).toBe(first);
  });

  it("keeps the request_id when the network throws, so a retry cannot charge twice", async () => {
    window.localStorage.clear();
    const idOf = (call: [string, RequestInit | undefined]) =>
      (JSON.parse(String(call[1]?.body ?? "{}")) as { request_id?: string }).request_id;
    const posts = () =>
      apiFetch.mock.calls.filter(
        ([path, init]: [string, RequestInit | undefined]) =>
          String(path) === `/api/channels/${SLUG}/run` && init?.method === "POST",
      );

    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    mount();
    await screen.findByTestId("empty-switched");

    const routed = apiFetch.getMockImplementation()!;
    let thrown = false;
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (String(path) === `/api/channels/${SLUG}/run` && init?.method === "POST" && !thrown) {
        thrown = true;
        return Promise.reject(new Error("Failed to fetch"));
      }
      return routed(path, init);
    });

    fireEvent.click(screen.getByTestId("run-channel"));
    await waitFor(() => expect(posts().length).toBe(1));
    const first = idOf(posts()[0]);

    fireEvent.click(screen.getByTestId("run-channel"));
    await waitFor(() => expect(posts().length).toBe(2));
    expect(idOf(posts()[1])).toBe(first);
  });

  it("shows the cooking card the moment it is pressed, before the request answers", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    const answered = apiFetch.getMockImplementation()!;
    let answer: (v: unknown) => void = () => {};
    apiFetch.mockImplementation((path: string, init?: RequestInit) =>
      String(path).includes(`/api/channels/${SLUG}/run`) ? new Promise((r) => (answer = r)) : answered(path, init),
    );
    mount();
    await screen.findByTestId("empty-switched");

    fireEvent.click(screen.getByTestId("run-channel"));
    expect(screen.getByTestId("empty-running")).toBeTruthy();
    expect(screen.getByTestId("empty-switched").closest("[hidden]")).toBeTruthy();

    await act(async () => {
      answer({ ok: true, status: 200, json: async () => ({ ok: true, run_id: "run-new", stamped: true }) });
    });
    await waitFor(() => expect(screen.queryByTestId("empty-switched")).toBeNull());
    expect(screen.getByTestId("empty-running")).toBeTruthy();
  });

  it("brings the card back with the reason when the request is refused", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 2 } });
    const answered = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((path: string, init?: RequestInit) =>
      String(path).includes(`/api/channels/${SLUG}/run`)
        ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: { message: "This channel is paused." } }) })
        : answered(path, init),
    );
    mount();
    await screen.findByTestId("empty-switched");

    fireEvent.click(screen.getByTestId("run-channel"));
    expect(await screen.findByText("This channel is paused.")).toBeTruthy();
    expect(screen.queryByTestId("empty-running")).toBeNull();
    expect(screen.getByTestId("empty-switched").closest("[hidden]")).toBeNull();
  });

  it("is not pressable while a run is already in flight", async () => {
    route({ actions: [], store: "channel_actions" });
    mount({ workState: "running" });

    await screen.findByTestId("action-section");
    expect(await screen.findByTestId("empty-running")).toBeTruthy();
    expect(screen.queryByTestId("run-channel")).toBeNull();
  });
});

describe("the switch signal survives the deploy that causes the switch", () => {
  it("fires on zero pending approvals when history has pre-switch rows", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 5 } });
    mount({ workState: "delivered" }, 0);

    const state = await screen.findByTestId("empty-switched");
    expect(
      within(state).getByText("Nothing here yet"),
    ).toBeTruthy();
    expect(
      screen.queryByText("No pending steps here right now."),
    ).toBeNull();
  });

  it("does not promise items are 'below' when no fold is rendered", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 5 } });
    mount({ workState: "delivered" }, 0);

    const state = await screen.findByTestId("empty-switched");
    expect(screen.queryByTestId("prior-items")).toBeNull();
    expect(state.textContent).toContain("Your 5 earlier items are kept, read-only");
    expect(state.textContent).not.toContain("below");
  });
});

describe("decision 14's signal is not widened", () => {
  it("a switched channel with no pre-switch history keeps its workState copy", async () => {
    route({ actions: [], store: "channel_actions", history: { preSwitch: 0 } });
    mount({ workState: "delivered" }, 0);

    await screen.findByTestId("action-section");
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(screen.queryByTestId("empty-switched")).toBeNull();
    expect(screen.queryByTestId("prior-items")).toBeNull();
    expect(screen.getByTestId("run-channel")).toBeTruthy();
  });

  it("says it is still checking rather than guessing, while history is in flight", async () => {
    route({ actions: [], store: "channel_actions", history: "pending" });
    mount({ workState: "delivered" }, 0);

    await screen.findByTestId("empty-pending");
    expect(screen.queryByTestId("empty-switched")).toBeNull();
    expect(
      screen.queryByText("No pending steps here right now."),
    ).toBeNull();
    expect(screen.queryByTestId("run-channel")).toBeNull();
  });

  it("falls back to the workState copy when history FAILS, rather than guessing", async () => {
    route({ actions: [], store: "channel_actions", history: "fail" });
    mount({ workState: "delivered" }, 0);

    await screen.findByTestId("action-section");
    await waitFor(() => expect(screen.getByTestId("empty-delivered")).toBeTruthy());
    expect(screen.queryByTestId("empty-switched")).toBeNull();
    expect(screen.queryByTestId("empty-pending")).toBeNull();
  });

  it("a channel still on the old store gets neither the state nor the button", async () => {
    route({ actions: [], store: "decisions" });
    mount();

    expect(await screen.findByText(/PRE-SWITCH Z/)).toBeTruthy();
    expect(screen.queryByTestId("empty-switched")).toBeNull();
    expect(screen.queryByTestId("run-channel")).toBeNull();
  });
});

describe("a channel whose actions still come from `decisions` still approves", () => {
  const LEGACY_BACKEND = (CHANNELS as readonly Channel[]).filter((c) =>
    ["email_marketing", "youtube_ads"].includes(c.slug),
  );

  it("every registry channel is switched now, which is why the source changed", () => {
    const onDecisions = (CHANNELS as readonly Channel[]).filter(
      (c) => c.actions_store === "decisions",
    );
    expect(onDecisions.map((c) => c.slug)).toEqual([]);
    expect(LEGACY_BACKEND.length).toBe(2);
  });

  for (const ch of LEGACY_BACKEND) {
    it(`${ch.slug}: a backend answering \`decisions\` renders live rows, outside any read-only fieldset`, async () => {
      apiFetch.mockImplementation((path: string) => {
        if (String(path).includes(`/api/channels/${ch.slug}/actions`)) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ actions: [], more: 0, store: "decisions" }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ metrics: [], briefs: [], artifacts: [] }),
        });
      });

      const view = render(
        <ChannelDrawer
          detail={{ ...detail, channel: ch, workState: "delivered" }}
          actionCount={2}
          error={null}
          onClose={() => {}}
          onOpenConnectors={() => {}}
        >
          {PRE_SWITCH_ROWS}
        </ChannelDrawer>,
      );

      expect(await screen.findByText(/PRE-SWITCH Z/)).toBeTruthy();

      const verbs = Array.from(view.container.querySelectorAll("button")).filter((b) =>
        /^(Approve|Reject)$/.test(b.textContent ?? ""),
      );
      expect(verbs.length).toBe(4);
      for (const verb of verbs) {
        expect(
          verb.closest("fieldset[disabled]"),
          `${ch.slug} is reading \`decisions\`; its verbs must not be read-only`,
        ).toBeNull();
      }

      expect(screen.queryByTestId("prior-items")).toBeNull();
      expect(screen.queryByTestId("empty-switched")).toBeNull();
      expect(screen.queryByTestId("run-channel")).toBeNull();
    });
  }
});

describe("the FIRST PAINT offers no run button and no empty state", () => {
  it("says it is reading rather than offering a run", () => {
    apiFetch.mockImplementation((path: string) => {
      if (String(path).includes(`/api/channels/${SLUG}/actions`)) return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ metrics: [], briefs: [], artifacts: [] }) });
    });
    const { container } = mount();

    expect(screen.queryByTestId("run-channel")).toBeNull();
    expect(screen.queryByTestId("empty-switched")).toBeNull();
    expect(screen.queryByTestId("action-section")).toBeNull();
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.queryByText(/PRE-SWITCH/)).toBeNull();
  });
});
