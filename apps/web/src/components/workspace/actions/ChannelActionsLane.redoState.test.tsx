// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const SLUG = "linkedin_organic";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const refused = (message: string) => ({
  ok: false,
  status: 409,
  json: async () => ({ error: { code: "exec_action_use_revise", message } }),
});

const card = makeAction("text_post", { id: "ca-1", channel_slug: SLUG, title: "The card to redo" });
const replacement = makeAction("text_post", {
  id: "ca-2",
  channel_slug: SLUG,
  title: "The rewrite the run produced",
  redo_of: "ca-1",
});

let actions = [card];
let runStatus: (id: string) => unknown = () => ok({});
let redoAnswer: () => unknown = () => ok({ ok: true, run_id: "run-9", redo_of_action_id: "ca-1" });

function route() {
  actions = [card];
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes("/redo") && init?.method === "POST") return redoAnswer();
    if (u.startsWith("/api/agents/runs/")) return runStatus(decodeURIComponent(u.slice("/api/agents/runs/".length)));
    if (u.includes(`/api/channels/${SLUG}/actions`)) {
      return ok({ actions, more: 0, store: "channel_actions" });
    }
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
}

async function mount() {
  render(
    <ChannelActionsLane
      slug={SLUG}
      legacy={<p>LEGACY RAIL</p>}
      workState="running"
      lastRunAt="2026-09-20T10:00:00Z"
      actionCount={0}
      connected
      hasConnectors
    >
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function pressRedo() {
  const card = screen.getByTestId("action-ca-1");
  await act(async () => {
    within(card).getByRole("button", { name: "More actions" }).click();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    screen.getByRole("menuitem", { name: /Redo/ }).click();
    await vi.advanceTimersByTimeAsync(0);
  });
  const note = within(card).getByLabelText("What should Zavi do differently?");
  fireEvent.change(note, { target: { value: "Use last month's numbers instead" } });
  await act(async () => {
    within(card).getByRole("button", { name: "Redo" }).click();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  redoAnswer = () => ok({ ok: true, run_id: "run-9", redo_of_action_id: "ca-1" });
  runStatus = () => ok({ run: { status: "running" } });
  route();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a card the founder pressed Redo on", () => {
  it("says so, on that card only, from the moment the redo is accepted", async () => {
    await mount();
    expect(screen.queryByTestId("action-redoing")).toBeNull();
    await pressRedo();

    const line = screen.getByTestId("action-redoing");
    expect(line.getAttribute("data-redo-state")).toBe("working");
    expect(line.textContent).toContain(
      "Zavi is redoing this. The new version replaces this card when it lands.",
    );
  });

  it("clears when the replacement lands, with no timer involved", async () => {
    await mount();
    await pressRedo();
    expect(screen.getByTestId("action-redoing")).toBeTruthy();

    actions = [replacement];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(screen.queryByTestId("action-redoing")).toBeNull();
    expect(screen.queryAllByText("The rewrite the run produced").length).toBeGreaterThan(0);
  });

  it("stops claiming to be working if the replacement never comes", async () => {
    await mount();
    await pressRedo();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21 * 60_000);
    });

    const line = screen.getByTestId("action-redoing");
    expect(line.getAttribute("data-redo-state")).toBe("no_replacement");
    expect(line.textContent).toContain(
      "Nothing has replaced this yet. You can still work this card as it is.",
    );
    expect(line.textContent).not.toMatch(/fail|error|could not/i);
  });

  it("shows nothing when the redo was refused, because no redo started", async () => {
    redoAnswer = () =>
      refused("This is an account change. Edit it with Revise, or decline it. Redo re-runs the whole recipe.");
    await mount();
    await pressRedo();
    expect(screen.queryByTestId("action-redoing")).toBeNull();
    expect(screen.getByText(/Edit it with Revise/)).toBeTruthy();
  });

  it("must-catch: a redo run that fails within a minute says so on the card, instead of a spinner for 20 minutes", async () => {
    const asked: string[] = [];
    runStatus = (id) => {
      asked.push(id);
      return ok({ run: { status: "failed" } });
    };
    await mount();
    await pressRedo();
    expect(screen.getByTestId("action-redoing").getAttribute("data-redo-state")).toBe("working");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const line = screen.getByTestId("action-redoing");
    expect(line.getAttribute("data-redo-state")).toBe("failed");
    expect(line.textContent).toContain("Zavi could not finish this redo");
    expect(line.querySelector(".animate-spin")).toBeNull();
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["run-9"]));
  });

  it("watches the run the server started, not a guess: a duplicate redo watches the run it joined", async () => {
    const asked: string[] = [];
    redoAnswer = () => ok({ ok: true, run_id: "run-already", redo_of_action_id: "ca-1", duplicate: true });
    runStatus = (id) => {
      asked.push(id);
      return ok({ run: { status: id === "run-already" ? "error" : "running" } });
    };
    await mount();
    await pressRedo();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("action-redoing").getAttribute("data-redo-state")).toBe("failed");
    expect(new Set(asked)).toEqual(new Set(["run-already"]));
  });

  it("a run still going keeps the working line, and an unreadable status is not taken as a failure", async () => {
    let n = 0;
    runStatus = () => (++n % 2 ? { ok: false, status: 500, json: async () => ({}) } : ok({ run: { status: "running" } }));
    await mount();
    await pressRedo();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByTestId("action-redoing").getAttribute("data-redo-state")).toBe("working");
    expect(n).toBeGreaterThan(2);
  });

  it("a run that ended well but left the card in place stops spinning and says nothing replaced it", async () => {
    runStatus = () => ok({ run: { status: "success" } });
    await mount();
    await pressRedo();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("action-redoing").getAttribute("data-redo-state")).toBe("no_replacement");
  });

  it("leaving the channel while a status read is in flight stops the polling for good", async () => {
    let n = 0;
    let answer: (v: unknown) => void = () => {};
    runStatus = () => (++n === 1 ? new Promise((r) => { answer = r; }) : ok({ run: { status: "running" } }));
    await mount();
    await pressRedo();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(n).toBe(1);
    cleanup();
    await act(async () => {
      answer(ok({ run: { status: "running" } }));
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(n).toBe(1);
  });

  it("a replacement that lands still clears the line, and polling stops", async () => {
    let n = 0;
    runStatus = () => (n++, ok({ run: { status: "running" } }));
    await mount();
    await pressRedo();
    actions = [replacement];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.queryByTestId("action-redoing")).toBeNull();
    const after = n;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(n).toBe(after);
  });
});
