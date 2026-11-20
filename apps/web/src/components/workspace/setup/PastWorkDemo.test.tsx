// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PastWorkDemo } from "./PastWorkDemo";
import { PAST_WORK_DEMO_SEQUENCE } from "./pastWorkDemoSequence";

let reduced = false;
const listener = vi.fn();
beforeEach(() => {
  reduced = false;
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener: listener,
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function FirstClient({
  capture,
  children,
}: {
  capture: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(capture, [capture]);
  return children;
}
describe("past-work example animation", () => {
  it("generates and downloads a file, drops it into Zavi, then adds it and loops", () => {
    const view = render(<PastWorkDemo />);
    expect(screen.getByText("Copy this prompt")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1800));
    expect(screen.getByText("Copied")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("Creating your file…")).toBeTruthy();
    expect(screen.queryByText("Copy this prompt")).toBeNull();
    act(() => vi.advanceTimersByTime(1400));
    expect(screen.getByText("zavi-context.md")).toBeTruthy();
    expect(screen.getByText("Download file")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2200));
    expect(screen.getByText("Downloaded")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1400));
    expect(screen.getByText("Upload your files")).toBeTruthy();
    expect(screen.getByText("Drop your files here, or choose files")).toBeTruthy();
    expect(screen.queryByText("Ready to add")).toBeNull();
    act(() => vi.advanceTimersByTime(1400));
    expect(view.container.querySelector(".animate-past-work-file-drop")).toBeTruthy();
    expect(screen.getAllByText("zavi-context.md")).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1200));
    expect(view.container.querySelector(".animate-past-work-file-drop")).toBeNull();
    expect(screen.getByText("Ready to add")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1800));
    expect(screen.getAllByText("Adding…")).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1400));
    expect(screen.getByText("Added to Zavi")).toBeTruthy();
    expect(screen.getByText("Added. Zavi will read it in the background.")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2800));
    expect(screen.getByText("Copy this prompt")).toBeTruthy();
  });
  it("repeats the complete upload sequence across multiple loops", () => {
    render(<PastWorkDemo />);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      act(() => vi.advanceTimersByTime(13600));
      expect(screen.getByText("Added to Zavi")).toBeTruthy();
      act(() => vi.advanceTimersByTime(2800));
      expect(screen.getByText("Copy this prompt")).toBeTruthy();
      expect(screen.queryByText("Added to Zavi")).toBeNull();
      expect(vi.getTimerCount()).toBe(1);
    }
  });
  it("never shows the retired paste-answer interface in any frame", () => {
    const view = render(<PastWorkDemo />);
    for (const step of PAST_WORK_DEMO_SEQUENCE) {
      expect(view.container.textContent).not.toMatch(/Paste the answer here|The business sells|Here's what I know about Bloom Studio/);
      expect(view.container.querySelector("input, textarea, button, [tabindex]")).toBeNull();
      act(() => vi.advanceTimersByTime(step.duration));
    }
  });
  it("shows a still completed upload with reduced motion and schedules no loop", () => {
    reduced = true;
    render(<PastWorkDemo />);
    expect(screen.getByText("Upload your files")).toBeTruthy();
    expect(screen.getByText("Added to Zavi")).toBeTruthy();
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByText("Added to Zavi")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("pauses the tutorial when the document is hidden", () => {
    render(<PastWorkDemo />);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByText("Copy this prompt")).toBeTruthy();
    expect(screen.queryByText("zavi-context.md")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(4200));
    expect(screen.getByText("zavi-context.md")).toBeTruthy();
  });
  it("cleans up the animation timer on unmount", () => {
    const view = render(<PastWorkDemo />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("renders the same first client frame as the server before adopting motion preference", async () => {
    reduced = true;
    const container = document.createElement("div");
    container.innerHTML = renderToString(<PastWorkDemo />);
    document.body.append(container);
    const server = container.cloneNode(true);
    let firstMatches = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(
        container,
        <FirstClient
          capture={() => {
            firstMatches = container.isEqualNode(server);
          }}
        >
          <PastWorkDemo />
        </FirstClient>,
      );
    });
    expect(firstMatches).toBe(true);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(
      /hydrat|did not match/i,
    );
    await act(async () => root.unmount());
    container.remove();
    errors.mockRestore();
  });
});
