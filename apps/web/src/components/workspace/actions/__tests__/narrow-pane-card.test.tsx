// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES } from "./fixtures";

afterEach(cleanup);

function handlers(): ActionHandlers {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() };
}

function renderCard(type: keyof typeof FIXTURES) {
  const a = FIXTURES[type];
  render(<ChannelActionCard action={a} platform={platformFor(a.channel_slug)} handlers={handlers()} />);
  return screen.getByTestId(`action-${a.id}`);
}

describe("a shared card in a narrow channel pane", () => {
  it("can shrink with the pane and keeps a single-column flow", () => {
    const card = renderCard("reply");
    expect(card.className).toContain("min-w-0");
    expect(card.className).toContain("flex-col");
  });

  it("wraps the footer and its action buttons instead of overflowing", () => {
    const card = renderCard("reply");
    const how = within(card).getByRole("button", { name: "How it works" });
    const footer = how.parentElement?.parentElement;
    expect(footer?.className).toContain("flex-wrap");
    const primary = within(card).getByRole("button", { name: "Copy post" });
    expect(primary.parentElement?.className).toContain("flex-wrap");
    expect(primary.parentElement?.className).toContain("max-w-full");
    expect(primary.parentElement?.className).not.toMatch(/\bsm:/);
    expect(primary.className).toContain("max-w-full");
    expect(primary.className).toContain("whitespace-normal");
  });

  it("keeps every footer control available in the compact layout", () => {
    const card = renderCard("reply");
    expect(within(card).getByRole("button", { name: "How it works" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "What it is" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Copy post" })).toBeTruthy();
  });

  it("lets an unbroken token in the title and the draft break rather than overflow", () => {
    const card = renderCard("reply");
    const title = within(card).getByRole("heading", { level: 4 });
    expect(title.className).toContain("break-words");
    const words = title.querySelector("[data-card-title]")!;
    expect(words.className).toContain("line-clamp-3");
    expect(words.className).toContain("[@container(min-width:36rem)]:line-clamp-2");
    expect(title.className).toContain("[overflow-wrap:anywhere]");
    expect(title.getAttribute("title")).toBe(title.textContent);
    const draft = within(card).getByText(/Every plan has every feature/).parentElement;
    expect(draft?.className).toContain("[overflow-wrap:anywhere]");
  });
});
