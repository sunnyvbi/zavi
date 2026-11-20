// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { CgoNavItem, CgoRailItem } from "./CgoNavItem";
import { __resetNeedsYouStore, publishFromPage } from "../growth/needsYou";
import { act } from "react";

afterEach(cleanup);
beforeEach(() => {
  __resetNeedsYouStore();
  window.localStorage.clear();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
});

describe("Your CGO menu entry", () => {
  it("is named Your CGO, wears the mascot, and marks the current page", () => {
    render(<CgoNavItem active onClick={() => {}} />);
    const row = screen.getByRole("button", { name: /Your CGO/ });
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.querySelector("img")?.getAttribute("src")).toBe("/mascots/video/zavi-still.webp");
    expect(row.className).toContain("bg-ink/10");
    expect(row.className).not.toContain("bg-[#0F766E]");
  });

  it("is teal text with no fill when another page is open", () => {
    render(<CgoNavItem active={false} onClick={() => {}} />);
    const row = screen.getByRole("button", { name: /Your CGO/ });
    expect(row.getAttribute("aria-current")).toBeNull();
    expect(row.className).toContain("text-[#0F766E]");
    expect(row.className).not.toContain("bg-ink/10");
  });

  const answer = (questions: unknown[]) =>
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes("/growth/questions")) return { ok: true, json: async () => ({ questions }) };
      if (url.includes("/growth/plan")) return { ok: true, json: async () => ({ goals: { items: [] }, unreadable: [] }) };
      if (url.includes("/api/approvals?home=growth"))
        return { ok: true, json: async () => ({ decisions: [], next_cursor: null, totals: { growth: 0, channel: 0, needs_you: 0 } }) };
      return { ok: true, json: async () => ({ decisions: [] }) };
    });
  const question = { id: "q1", ordinal: 1, ask: "Raise the cap?", recommended: null, why: null, yes_no: true };

  it("shows the dot for something new, never a number, and clears it once the page is opened", async () => {
    answer([question]);
    render(<CgoNavItem active={false} onClick={() => {}} />);
    expect(await screen.findByText("Something needs attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Your CGO/ }).textContent).not.toMatch(/\d/);
    act(() => publishFromPage({ kind: "ready", total: 1, capped: false }));
    expect(screen.queryByText("Something needs attention")).toBeNull();
    act(() => publishFromPage({ kind: "failed" }));
    expect(screen.queryByText("Something needs attention")).toBeNull();
  });

  it("the collapsed rail carries the same name and dot", async () => {
    answer([question]);
    render(<CgoRailItem active={false} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Your CGO" })).toBeTruthy();
    expect(await screen.findByText("Something needs attention")).toBeTruthy();
  });
});
