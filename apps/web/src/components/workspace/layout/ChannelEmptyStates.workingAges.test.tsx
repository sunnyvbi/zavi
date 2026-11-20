// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { CookingCard } from "./ChannelEmptyCard";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T09:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const current = () => document.querySelector("[data-step=current]")?.textContent;
const done = () => document.querySelectorAll("[data-step=done]").length;

describe("CookingCard on a page left open", () => {
  it("moves through its steps with no new props and no parent render", async () => {
    render(<CookingCard slug="linkedin_ads" name="LinkedIn Ads" startedAt="2026-10-28T09:00:00Z" />);
    expect(current()).toBe("Reading your LinkedIn Ads account");
    expect(done()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(current()).toBe("Checking what worked and what didn't");
    expect(done()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(current()).toBe("Writing suggestions");
    expect(done()).toBe(2);
    expect(screen.getByTestId("empty-running")).toBeTruthy();
  });

  it("starts at the right step for a run that began before the page opened", () => {
    render(<CookingCard name="Blog" startedAt="2026-10-28T08:58:00Z" />);
    expect(current()).toBe("Writing suggestions");
  });

  it("stops its clock when it unmounts", () => {
    const view = render(<CookingCard name="LinkedIn Ads" startedAt="2026-10-28T09:00:00Z" />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
