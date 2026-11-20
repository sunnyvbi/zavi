// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn() }));

import { TutorialsGrid } from "./TutorialsGrid";
import { TUTORIALS, TUTORIAL_GROUPS, isPlayable } from "@/lib/tutorials";

afterEach(cleanup);

describe("TutorialsGrid", () => {
  it("shows every group and every tutorial; ready ones play, coming-soon ones are visible but not playable", () => {
    render(<TutorialsGrid startHref="/start" />);
    for (const g of TUTORIAL_GROUPS) expect(screen.getByRole("heading", { name: g.title })).toBeTruthy();
    for (const t of TUTORIALS) {
      expect(screen.getByText(t.title)).toBeTruthy();
      expect(screen.getByText(t.description)).toBeTruthy();
      expect(screen.getAllByText(t.poster.title).length, t.slug).toBeGreaterThan(0);
    }
    const playable = TUTORIALS.filter(isPlayable).length;
    expect(screen.queryAllByText("Coming soon")).toHaveLength(TUTORIALS.length - playable);
    expect(screen.queryAllByRole("button")).toHaveLength(playable);
  });

  it("shows no plan badges on the cards", () => {
    render(<TutorialsGrid startHref="/start" />);
    for (const tier of ["Free", "Starter", "Growth", "Pro"]) expect(screen.queryByText(tier, { exact: true })).toBeNull();
  });

  it("the player has a speed control that sets the video's playback rate", () => {
    render(<TutorialsGrid startHref="/start" />);
    fireEvent.click(screen.getAllByRole("button")[0]);
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).toBeTruthy();
    const fast = screen.getByRole("button", { name: "1.5x" });
    expect(screen.getByRole("button", { name: "1x" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(fast);
    expect(video.playbackRate).toBe(1.5);
    expect(fast.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the chosen speed after the player is closed and reopened", () => {
    render(<TutorialsGrid startHref="/start" />);
    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    fireEvent.click(screen.getByRole("button", { name: "Close video" }));
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getByRole("button", { name: "2x" }).getAttribute("aria-pressed")).toBe("true");
    const video = document.querySelector("video") as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.playbackRate).toBe(2);
  });
});
