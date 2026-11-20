// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReadProblemAlert, alertWords } from "./ReadProblemAlert";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("alertWords", () => {
  it("bolds what happened and keeps only what to do", () => {
    expect(alertWords("Meta stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back.")).toEqual({ title: "Meta stopped accepting Zavi's access.", rest: "Reconnect to bring them back." });
    expect(alertWords("Zavi could not read your Meta Ads account just now. Try Refresh in a minute.")).toEqual({ title: "Zavi could not read your Meta Ads account just now.", rest: "Try Refresh in a minute." });
  });

  it("keeps the so-clause when it is the only follow-up", () => {
    expect(alertWords("Zavi could not read your X account just now, so these numbers are from the last read that worked.")).toEqual({ title: "Zavi could not read your X account just now.", rest: "These numbers are from the last read that worked." });
  });

  it("leaves a single plain sentence as the title", () => {
    expect(alertWords("Zavi could not read your site just now.")).toEqual({ title: "Zavi could not read your site just now.", rest: null });
  });
});

describe("ReadProblemAlert", () => {
  it("shows the short alert with its action, and vanishes when dismissed", () => {
    vi.useFakeTimers();
    render(<ReadProblemAlert text="Meta stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back." action={<button type="button">Reconnect</button>} />);
    const alert = screen.getByTestId("channel-read-problem");
    expect(alert.querySelector("strong")?.textContent).toBe("Meta stopped accepting Zavi's access.");
    expect(alert.textContent).not.toContain("could not be read");
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(alert.className).toContain("opacity-0");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByTestId("channel-read-problem")).toBeNull();
  });
});
