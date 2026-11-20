// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ pats: [] }) })),
}));

import { PartTabs } from "../PartTabs";
import { RedditDraftActions } from "@/components/agents/RedditReplyCard";
import { McpClientsPanel } from "@/components/workspace/settings/McpClientsPanel";

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function expectIconOnly(button: HTMLElement, name: string) {
  expect(button.getAttribute("aria-label")).toBe(name);
  expect(button.getAttribute("title")).toBe(name);
  expect(button.textContent).toBe("");
  expect(button.querySelector("svg")).not.toBeNull();
}

function iconClass(button: HTMLElement): string {
  return button.querySelector("svg")?.getAttribute("class") ?? "";
}

describe("copy buttons are icon only", () => {
  it("PartTabs: Copy has no visible word, swaps to a check, and swaps back after 1.5s", async () => {
    vi.useFakeTimers();
    render(
      <PartTabs labels={["Email 1", "Email 2"]} selected={0} onSelect={() => {}} copyText="Hi there">
        <p>Hi there</p>
      </PartTabs>,
    );
    const button = screen.getByRole("button", { name: "Copy" });
    expectIconOnly(button, "Copy");
    expect(iconClass(button)).toContain("lucide-copy");
    expect(screen.queryByText("Copy")).toBeNull();

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("Hi there");
    const copied = screen.getByRole("button", { name: "Copied" });
    expectIconOnly(copied, "Copied");
    expect(iconClass(copied)).toContain("lucide-check");
    expect(screen.queryByText("Copied")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(iconClass(screen.getByRole("button", { name: "Copy" }))).toContain("lucide-copy");
  });

  it("RedditDraftActions: Copy is an icon with its name in aria-label and title, Approve & post keeps its words", () => {
    const { rerender } = render(<RedditDraftActions copied={false} onCopy={() => {}} onApprove={() => {}} label={"Approve & post"} connected />);
    expectIconOnly(screen.getByRole("button", { name: "Copy" }), "Copy");
    expect(screen.getByRole("button", { name: "Approve & post" }).textContent).toBe("Approve & post");
    rerender(<RedditDraftActions copied onCopy={() => {}} onApprove={() => {}} label={"Approve & post"} connected />);
    const copied = screen.getByRole("button", { name: "Copied" });
    expectIconOnly(copied, "Copied");
    expect(iconClass(copied)).toContain("lucide-check");
  });

  it("McpClientsPanel: every copy button is an icon with a Copy name and no visible word", () => {
    render(<McpClientsPanel showTokens={false} />);
    const buttons = screen.getAllByRole("button", { name: /^Copy / });
    expect(buttons.length).toBeGreaterThan(1);
    for (const b of buttons) {
      expect(b.textContent).toBe("");
      expect(b.getAttribute("title")).toBe("Copy");
      expect(b.querySelector("svg")).not.toBeNull();
    }
    expect(screen.queryByText("Copy")).toBeNull();
  });
});
