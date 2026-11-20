// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { StartersPanel, starterTileState, type StarterRun } from "./StartersPanel";
import { makeAction } from "./__tests__/fixtures";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const SLUG = "generated_video";
const RUN = "run-starters";

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

function card(id: string, over: Partial<ChannelActionView> = {}): ChannelActionView {
  return makeAction("video_post", {
    id,
    run_id: RUN,
    channel_slug: SLUG,
    title: "Explainer: Why it takes 20 seconds",
    executable: true,
    exec_status: null,
    status: "pending",
    proposed_at: "2026-10-01T14:00:00Z",
    body: {
      video_format: "explainer",
      cost_credits: 1500,
      step: { deliverable: { content: "Here is the first line of the script.\n\nCaption: a caption" } },
    } as unknown as ChannelActionView["body"],
    ...over,
  });
}

const starter: StarterRun = { loaded: true, runId: RUN, failedAttempts: 0, setRunId: () => undefined };

let approveAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true, exec_status: "queued" } };

beforeEach(() => {
  apiFetch.mockReset();
  approveAnswer = { status: 200, body: { ok: true, exec_status: "queued" } };
  apiFetch.mockImplementation(async (url: string) => {
    if (String(url) === "/api/channels") return res({ channels: [{ channel_slug: SLUG, video_credits_each: 1318 }] });
    if (String(url).endsWith("/approve")) return res(approveAnswer.body, approveAnswer.status);
    return res({});
  });
});
afterEach(() => cleanup());

async function mount(actions: ChannelActionView[], onChanged = vi.fn()) {
  await act(async () => {
    render(<StartersPanel slug={SLUG} starter={starter} actions={actions} running={false} onRan={() => undefined} onChanged={onChanged} />);
  });
  return onChanged;
}

async function tap(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe("starterTileState", () => {
  it("an unapproved starter waits; an approved one is being made; failed and ready keep their states", () => {
    expect(starterTileState(card("a"))).toBe("waiting");
    expect(starterTileState(card("a"), new Map([["a", null]]))).toBe("making");
    expect(starterTileState(card("a", { exec_status: "queued" }))).toBe("making");
    expect(starterTileState(card("a", { exec_status: "dispatching" }))).toBe("making");
    expect(starterTileState(card("a", { exec_status: "failed" }))).toBe("failed");
    expect(starterTileState(card("a", { exec_status: "failed" }), new Map([["a", "failed" as const]]))).toBe("making");
    expect(starterTileState(card("a", { exec_status: "failed" }), new Map([["a", null]]))).toBe("failed");
    expect(starterTileState(card("a", { exec_status: "queued" }), new Map([["a", null]]))).toBe("making");
  });
});

describe("a starter waiting for the founder", () => {
  it("shows the format, the script preview and its own price, and approves it with one tap", async () => {
    const onChanged = await mount([card("w-1")]);
    const tile = screen.getByTestId("starter-tile");
    expect(tile.getAttribute("data-state")).toBe("waiting");
    expect(tile.textContent).toContain("Explainer");
    expect(screen.getByTestId("starter-script").textContent).toBe("Here is the first line of the script.");
    const button = screen.getByTestId("starter-make");
    expect(button.textContent).toBe("Make this video");
    const cost = within(tile).getByTestId("starter-cost");
    expect(cost.textContent).toBe("Uses\u00a0~1,500 credits");
    expect(cost.className).toMatch(/absolute right-3 top-3/);
    expect(cost.className).not.toMatch(/rounded-full/);
    expect(cost.getAttribute("title")).toMatch(/only if the video arrives/);

    await tap(button);

    const approves = apiFetch.mock.calls.filter((c) => String(c[0]).endsWith("/approve"));
    expect(approves).toHaveLength(1);
    expect(approves[0][0]).toBe("/api/channel-actions/w-1/approve");
    expect((approves[0][1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((approves[0][1] as RequestInit).body))).toHaveProperty("request_id");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("starter-tile").getAttribute("data-state")).toBe("making");
    expect(screen.getByRole("status").textContent).toBe("1 making");
  });

  it("a credit refusal shows the top-up notice on that tile and leaves it waiting", async () => {
    approveAnswer = { status: 402, body: { error: { code: "insufficient_credits", message: "Not enough credits." } } };
    const onChanged = await mount([card("w-1")]);
    await tap(screen.getByTestId("starter-make"));
    const tile = screen.getByTestId("starter-tile");
    expect(tile.getAttribute("data-state")).toBe("waiting");
    expect(tile.textContent).toContain("Not enough credits for this video.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("any other refusal shows the server's words and leaves the tile waiting", async () => {
    approveAnswer = { status: 409, body: { error: { code: "exec_blocked_no_retry", message: "This change cannot be retried." } } };
    await mount([card("w-1")]);
    await tap(screen.getByTestId("starter-make"));
    expect(screen.getByRole("alert").textContent).toBe("This change cannot be retried.");
    expect(screen.getByTestId("starter-tile").getAttribute("data-state")).toBe("waiting");
  });

  it("falls back to the channel's price when the card carries none", async () => {
    await mount([card("w-1", { body: { video_format: "hook" } as ChannelActionView["body"] })]);
    expect(screen.getByTestId("starter-make").textContent).toBe("Make this video");
    await waitFor(() => expect(screen.getByTestId("starter-cost").textContent).toBe("Uses\u00a0~1,318 credits"));
  });
});

describe("writing tiles follow the starter run, not a timer", () => {
  it("a finished run with three scripts shows no writing tiles, even while the page still watches", async () => {
    await act(async () => {
      render(
        <StartersPanel
          slug={SLUG}
          starter={{ ...starter, runStatus: "completed" }}
          actions={[card("a", { exec_status: "dispatching" }), card("b"), card("c")]}
          running
          onRan={() => undefined}
        />,
      );
    });
    expect(screen.queryAllByTestId("starter-tile").map((t) => t.getAttribute("data-state"))).toEqual(["making", "waiting", "waiting"]);
    expect(screen.getByRole("status").textContent).toBe("1 making · 2 waiting for you");
  });

  it("a run still writing shows writing tiles for the scripts still to come", async () => {
    await act(async () => {
      render(
        <StartersPanel
          slug={SLUG}
          starter={{ ...starter, runStatus: "running" }}
          actions={[card("a", { exec_status: "dispatching" })]}
          running
          onRan={() => undefined}
        />,
      );
    });
    expect(screen.queryAllByTestId("starter-tile").map((t) => t.getAttribute("data-state"))).toEqual(["making", "writing", "writing", "writing", "writing"]);
  });
});

describe("a failed starter", () => {
  it("a temporary failure can be tried again with one tap, and then reads as making", async () => {
    const onChanged = await mount([card("f", { exec_status: "failed", exec_bucket: "temporary" })]);
    await tap(screen.getByTestId("starter-make"));
    expect(apiFetch.mock.calls.filter((c) => String(c[0]) === "/api/channel-actions/f/approve")).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("starter-tile").getAttribute("data-state")).toBe("making");
  });

  it("a finished starter run that wrote nothing does not claim to be writing", async () => {
    await act(async () => {
      render(<StartersPanel slug={SLUG} starter={{ ...starter, runStatus: "completed" }} actions={[]} running onRan={() => undefined} />);
    });
    expect(screen.getByRole("status").textContent).toBe("No videos yet");
  });
});

describe("a tap stands in only until the server answers", () => {
  it("a retry that the server queues and then fails again shows failed, not making", async () => {
    const failed = card("f", { exec_status: "failed", exec_bucket: "temporary" });
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<StartersPanel slug={SLUG} starter={starter} actions={[failed]} running={false} onRan={() => undefined} onChanged={() => undefined} />);
    });
    await tap(screen.getByTestId("starter-make"));
    expect(screen.getByTestId("starter-tile").getAttribute("data-state")).toBe("making");
    for (const next of [card("f", { exec_status: "queued" }), card("f", { exec_status: "failed", exec_bucket: "temporary" })]) {
      await act(async () => {
        view.rerender(<StartersPanel slug={SLUG} starter={starter} actions={[next]} running={false} onRan={() => undefined} onChanged={() => undefined} />);
      });
    }
    expect(screen.getByTestId("starter-tile").getAttribute("data-state")).toBe("failed");
  });
});

describe("a tap with no server answer", () => {
  it("stops reading as making after two minutes even if every refresh fails", async () => {
    vi.useFakeTimers();
    try {
      await mount([card("w-1")], vi.fn());
      await tap(screen.getByTestId("starter-make"));
      expect(screen.getByTestId("starter-tile").getAttribute("data-state")).toBe("making");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * 60_000);
      });
      expect(screen.getByTestId("starter-tile").getAttribute("data-state")).toBe("waiting");
    } finally {
      vi.useRealTimers();
    }
  });
});
