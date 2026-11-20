// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";
import { mixedRowViolations } from "./gutters";
import type { ActionHandlers } from "../types";

afterEach(cleanup);

function handlers(over: Partial<ActionHandlers> = {}): ActionHandlers {
  return {
    onSetStatus: vi.fn(),
    onRedo: vi.fn(),
    onApprove: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenRedoChat: vi.fn(),
    onPublish: vi.fn(),
    ...over,
  };
}

function renderCard(type: Parameters<typeof makeAction>[0], channel_slug: string, opts: { handlers?: ActionHandlers; executable?: boolean } = {}) {
  const a = makeAction(type, {
    channel_slug,
    title: "Replace the homepage hero with a citable answer block",
    executable: opts.executable ?? false,
    body: {
      action_label: "Do it",
      step: {
        body: "The current first screen fails the swap test.",
        effort: "minutes",
        deliverable: { kind: "snippet", label: "What to use", content: "A citable answer block, 40 words." },
      },
    },
  });
  render(<ChannelActionCard action={a} platform={platformFor(channel_slug)} handlers={opts.handlers ?? handlers()} />);
  return screen.getByTestId(`action-${a.id}`);
}

describe("the panels a footer opens are spaced evenly too", () => {
  function openFromMoreMenu(item: string, over: Partial<ActionHandlers> = {}) {
    renderCard("reply", "x_organic", { handlers: handlers(over) });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(item) }));
  }

  it("the Not now picker", () => {
    openFromMoreMenu("Not now");
    const card = screen.getByTestId("snooze-picker");
    expect(mixedRowViolations(card, true)).toEqual([]);
    expect(mixedRowViolations(card, false)).toEqual([]);
  });

  it("the Reject note", () => {
    openFromMoreMenu("Reject");
    const card = screen.getByLabelText("Why are you rejecting it?").closest(".rounded-xl")!;
    expect(mixedRowViolations(card, true)).toEqual([]);
    expect(mixedRowViolations(card, false)).toEqual([]);
  });

  it("the Redo note, on a surface with no side chat to take it", () => {
    openFromMoreMenu("Redo", { onOpenRedoChat: undefined });
    const card = screen.getByLabelText("What should Zavi do differently?").closest(".rounded-xl")!;
    expect(mixedRowViolations(card, true)).toEqual([]);
    expect(mixedRowViolations(card, false)).toEqual([]);
  });
});
