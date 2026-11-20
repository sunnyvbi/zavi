// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThisWeekCalendar } from "./ChannelSchedule";
import { makeAction } from "./__tests__/fixtures";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

afterEach(cleanup);

const TODAY = new Date(2026, 9, 1, 12);
const FRIDAY = "2026-10-02";

function planned(id: string, over: Partial<ChannelActionView> = {}): ChannelActionView {
  return makeAction("video_post", { id, title: `Explainer ${id}`, plan_day: FRIDAY, ...over } as Partial<ChannelActionView>);
}

describe("This week shows the reel for a scheduled AI UGC video", () => {
  it("a planned video that has been made shows its reel, and tapping it opens the card", () => {
    const onOpen = vi.fn();
    const card = planned("made", {
      exec_status: "executed",
      body: { media: { kind: "video", url: "https://v.example/made.mp4", alt: "", ai_generated: true } } as ChannelActionView["body"],
    });
    render(<ThisWeekCalendar cards={[card]} today={TODAY} needsOk={() => false} onOpen={onOpen} onMove={async () => null} />);
    const reel = screen.getByTestId("event-video-made");
    expect(reel.querySelector("video")?.getAttribute("src")).toBe("https://v.example/made.mp4");
    fireEvent.click(reel);
    expect(onOpen).toHaveBeenCalledWith("made");
    expect(screen.queryByText("Explainer made")).toBeNull();
    expect(reel.getAttribute("aria-label")).toContain("Explainer made");
    expect(screen.getByTestId("week-grid").getAttribute("data-reels")).toBe("true");
  });

  it("a planned script with no video yet stays text only", () => {
    render(<ThisWeekCalendar cards={[planned("script")]} today={TODAY} needsOk={() => false} onOpen={() => {}} onMove={async () => null} />);
    expect(screen.getByTestId("event-script")).toBeTruthy();
    expect(screen.queryByTestId("event-video-script")).toBeNull();
    expect(screen.getByText("Explainer script")).toBeTruthy();
    expect(screen.getByTestId("week-grid").getAttribute("data-reels")).toBeNull();
  });
});

describe("side arrows scroll a reel week", () => {
  function week() {
    const card = planned("made", {
      exec_status: "executed",
      body: { media: { kind: "video", url: "https://v.example/made.mp4", alt: "", ai_generated: true } } as ChannelActionView["body"],
    });
    return render(<ThisWeekCalendar cards={[card]} today={TODAY} needsOk={() => false} onOpen={() => {}} onMove={async () => null} />);
  }

  it("shows only the arrows that have somewhere to go, and scrolls by them", () => {
    week();
    const grid = screen.getByTestId("week-grid");
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 600 });
    Object.defineProperty(grid, "scrollWidth", { configurable: true, value: 1200 });
    const scrollBy = vi.fn();
    grid.scrollBy = scrollBy as never;
    grid.scrollLeft = 0;
    fireEvent.scroll(grid);
    expect(screen.queryByTestId("week-prev")).toBeNull();
    fireEvent.click(screen.getByTestId("week-next"));
    expect(scrollBy).toHaveBeenCalledWith({ left: 340, behavior: "smooth" });

    grid.scrollLeft = 600;
    fireEvent.scroll(grid);
    expect(screen.queryByTestId("week-next")).toBeNull();
    fireEvent.click(screen.getByTestId("week-prev"));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -340, behavior: "smooth" });
  });

  it("a week that fits shows no arrows", () => {
    week();
    const grid = screen.getByTestId("week-grid");
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(grid, "scrollWidth", { configurable: true, value: 1200 });
    fireEvent.scroll(grid);
    expect(screen.queryByTestId("week-prev")).toBeNull();
    expect(screen.queryByTestId("week-next")).toBeNull();
  });
});
