// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { ChannelChatProvider } from "../actions/channelChat";
import { ActionsEmpty, type ChannelRunInfo } from "./ChannelEmptyStates";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const eventRows = vi.hoisted(() => ({ value: [] as Array<{ stage: string; meta: unknown }> }));

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: eventRows.value }),
          }),
        }),
      }),
    }),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: () => {},
  }),
}));

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  eventRows.value = [];
});

function channelsPayload(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      channels: [
        {
          channel_slug: "google_ads",
          run_reserve_credits: 340,
          last_run_id: "11111111-1111-1111-1111-111111111111",
          ...over,
        },
      ],
    }),
  };
}

const runInfo = (over: Partial<ChannelRunInfo> = {}): ChannelRunInfo => ({
  slug: "google_ads",
  name: "Google Ads",
  switched: false,
  priorCount: 0,
  foldBelow: false,
  onRan: () => {},
  ...over,
});

const tool = (stage: string, tool_name: string) => ({ stage, meta: { tool_name } });

describe("the in-flight state never prints the run's own events", () => {
  it("shows only its own three steps even when the run IS known and has emitted events", async () => {
    apiFetch.mockResolvedValue(channelsPayload());
    eventRows.value = [
      { stage: "loaded_context", meta: null },
      tool("tool_use_started", "mcp__server__google_ads__list_campaigns"),
      tool("tool_use_completed", "mcp__server__google_ads__list_campaigns"),
    ];

    render(<ActionsEmpty workState="running" lastRunAt={null} run={runInfo()} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(Array.from(document.querySelectorAll("[data-step]")).map((el) => el.textContent)).toEqual(["Reading your Google Ads account", "Checking what worked and what didn't", "Writing suggestions"]);
    expect(screen.getByText(/Cooking up new suggestions for Google Ads/)).toBeTruthy();
    expect(screen.getByText(/Usually a few minutes/)).toBeTruthy();
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/mcp__|list_campaigns/);
  });
});

describe("the Run button quotes the channel's REAL hold", () => {
  it("shows the server's number for this channel, not a literal 160", async () => {
    apiFetch.mockResolvedValue(channelsPayload());

    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);

    expect((await screen.findByTestId("run-cost", {}, { timeout: 2000 })).textContent).toBeDefined();
    await waitFor(() => expect(screen.getByTestId("run-cost").textContent).toBe("About 340 credits"));
    expect(document.body.textContent).not.toMatch(/160 credits/);
  });

  it.each(["idle", "delivered", "running"] as const)("shows no cost badge on the Pinterest page when the run is %s", async (workState) => {
    apiFetch.mockResolvedValue(channelsPayload({ channel_slug: "pinterest_organic" }));
    render(<ActionsEmpty workState={workState} lastRunAt="2026-10-09T10:00:00Z" run={runInfo({ slug: "pinterest_organic", name: "Pinterest" })} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("run-cost")).toBeNull();
    expect(document.body.textContent).not.toMatch(/340 credits/);
  });

  it("puts the cost under the button row, once, and not inside it", async () => {
    apiFetch.mockResolvedValue(channelsPayload());
    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);
    await waitFor(() => expect(screen.getByTestId("run-cost").getAttribute("aria-busy")).toBeNull());
    const chip = screen.getByTestId("run-cost");
    expect(chip.textContent).toBe("About 340 credits");
    expect(chip.getAttribute("title")).toMatch(/charged what the run actually uses/);
    expect(chip.querySelector("svg")).toBeNull();
    expect(chip.className).not.toMatch(/rounded-full/);
    expect(document.body.textContent?.match(/340 credits/g)).toHaveLength(1);
    expect(screen.getByTestId("run-channel").parentElement?.nextElementSibling).toBe(chip);
    expect(screen.getByTestId("run-channel").parentElement?.textContent).not.toMatch(/credits/);
  });

  it.each(["delivered", "needs_review", "idle"] as const)("keeps the cost under the button after a run that %s, never beside it", async (workState) => {
    apiFetch.mockResolvedValue(channelsPayload());
    render(<ActionsEmpty workState={workState} lastRunAt="2026-10-09T10:00:00Z" run={runInfo()} />);
    await waitFor(() => expect(screen.getByTestId("run-cost").textContent).toBe("About 340 credits"));
    expect(document.body.textContent).not.toMatch(/Uses credits from your plan/);
    expect(document.body.textContent?.match(/340 credits/g)).toHaveLength(1);
    expect(screen.getByTestId("run-channel").parentElement?.textContent).not.toMatch(/credits/);
  });

  it("draws the filled Run and the outlined Ask Zavi at the same height, centred on one line", async () => {
    apiFetch.mockResolvedValue(channelsPayload());
    render(
      <ChannelChatProvider open={() => {}}>
        <ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />
      </ChannelChatProvider>,
    );
    const height = (el: Element) => (el.className.match(/(^|\s)min-h-(\d+)(\s|$)/) ?? [])[2];
    const run = await screen.findByTestId("run-channel");
    const ask = screen.getByTestId("ask-about-channel");
    expect(height(run)).toBe("9");
    expect(height(ask)).toBe("9");
    expect(run.parentElement).toBe(ask.parentElement);
    expect(run.parentElement!.className).toMatch(/(^|\s)items-center(\s|$)/);
    expect(run.parentElement!.className).toMatch(/(^|\s)justify-center(\s|$)/);
  });

  it("holds a loading placeholder until the figure arrives, then swaps it for the figure", async () => {
    let answer: (v: unknown) => void = () => {};
    apiFetch.mockReturnValue(new Promise((r) => (answer = r)));
    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);
    const loading = screen.getByTestId("run-cost");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.textContent).toBe("Loading what a run costs");
    expect(document.body.textContent).not.toMatch(/Uses credits from your plan|About \d+ credits/);
    answer(await channelsPayload());
    await waitFor(() => expect(screen.getByTestId("run-cost").textContent).toBe("About 340 credits"));
    expect(screen.getByTestId("run-cost").getAttribute("aria-busy")).toBeNull();
    expect(screen.getByTestId("run-cost")).toBe(loading);
  });

  it("stops loading and says it plainly when the read fails", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));
    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);
    await waitFor(() => expect(screen.getByTestId("run-cost").getAttribute("aria-busy")).toBeNull());
    expect(screen.getByTestId("run-cost").textContent).toBe("Uses credits from your plan");
  });

  it("shows a channel whose hold really is 160 as 160", async () => {
    apiFetch.mockResolvedValue(channelsPayload({ run_reserve_credits: 160 }));

    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);

    await waitFor(() => expect(screen.getByTestId("run-cost").textContent).toBe("About 160 credits"));
  });

  it("drops the figure entirely when the read fails, rather than guessing", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));

    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);

    expect(await screen.findByText("Uses credits from your plan")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+ credits/);
  });

  it("never shows the credit tag on UGC Videos, even after the hold loads", async () => {
    apiFetch.mockResolvedValue(channelsPayload({ channel_slug: "ugc", run_reserve_credits: 340 }));

    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo({ slug: "ugc", name: "UGC Videos" })} />);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("run-cost")).toBeNull();
    expect(screen.queryByTestId("run-cost-slot")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Uses\s*~?\d[\d,]* credits|Uses credits from your plan/);
  });
});

describe("the other empty states are unchanged", () => {
  beforeEach(() => apiFetch.mockResolvedValue(channelsPayload()));

  it("needs_review still says the last run did not finish, with a retry", () => {
    render(<ActionsEmpty workState="needs_review" lastRunAt={null} run={runInfo()} />);
    expect(screen.getByText(/last run didn't finish/i)).toBeTruthy();
    expect(screen.getByTestId("run-channel").textContent).toBe("Get suggestions");
  });

  it("delivered with nothing said still shows the last-run card, like ChatGPT Ads", async () => {
    render(
      <ChannelChatProvider open={() => {}}>
        <ActionsEmpty workState="delivered" lastRunAt={null} run={runInfo()} />
      </ChannelChatProvider>,
    );
    const box = await screen.findByTestId("empty-delivered");
    expect(within(box).getByRole("heading").textContent).toMatch(/^You're all caught up on /);
    expect(box.textContent).not.toMatch(/No pending steps|found nothing|Nothing yet/i);
    expect(within(box).getByTestId("run-channel").textContent).toBe("Get suggestions");
    expect(within(box).getByRole("button", { name: "Answer Zavi in chat" })).toBeTruthy();
  });

  it("a filtered delivered list still says why it is empty", async () => {
    render(<ActionsEmpty workState="delivered" lastRunAt={null} run={runInfo()} filteredReason="Outside your checklist." />);
    expect(await screen.findByText("Outside your checklist.")).toBeTruthy();
    expect(screen.queryByTestId("empty-delivered")).toBeNull();
  });

  it("idle still invites the first run", () => {
    render(<ActionsEmpty workState="idle" lastRunAt={null} run={runInfo()} />);
    expect(screen.getByText(/No suggestions for .* yet/)).toBeTruthy();
    expect(screen.getByTestId("run-channel").textContent).toBe("Get suggestions");
  });

  it("an unresolved switch signal gets its own branch and NO button", () => {
    render(
      <ActionsEmpty workState="delivered" lastRunAt={null} run={runInfo({ switched: "unknown" })} />,
    );
    expect(screen.getByTestId("empty-pending").textContent).toMatch(
      /Checking what this channel already has/,
    );
    expect(screen.queryByTestId("run-channel")).toBeNull();
    expect(screen.queryByText(/found nothing/i)).toBeNull();
  });

  it("the store-moved state still offers the Run button and gates on pre_switch", async () => {
    render(
      <ActionsEmpty
        workState="delivered"
        lastRunAt={null}
        run={runInfo({ switched: true, priorCount: 4 })}
      />,
    );
    expect(screen.getByTestId("empty-switched")).toBeTruthy();
    expect(screen.getByText(/Your 4 earlier items are/)).toBeTruthy();
    expect(screen.getByTestId("run-channel").textContent).toBe("Get suggestions");
    expect(await screen.findByText("About 340 credits")).toBeTruthy();
  });

  it("running still outranks the store-moved state", () => {
    render(
      <ActionsEmpty
        workState="running"
        lastRunAt={null}
        run={runInfo({ switched: true, priorCount: 4 })}
      />,
    );
    expect(screen.queryByTestId("empty-switched")).toBeNull();
    expect(screen.getByText(/Cooking up new suggestions for Google Ads/)).toBeTruthy();
  });
});
