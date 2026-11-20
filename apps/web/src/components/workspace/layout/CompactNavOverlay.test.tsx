// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CompactNavOverlay, NAV_EXIT_MS } from "./CompactNavOverlay";

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduce : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Harness({ onClosed }: { onClosed: () => void }) {
  return (
    <CompactNavOverlay onClose={onClosed}>
      <button type="button">Channels</button>
    </CompactNavOverlay>
  );
}

const panel = () => screen.queryByRole("dialog", { name: "Navigation" });
const scrim = () => screen.getByRole("button", { name: "Close navigation" });

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe("CompactNavOverlay", () => {
  it("plays the exit before it unmounts, instead of snapping shut", () => {
    const onClose = vi.fn();
    render(<Harness onClosed={onClose} />);
    expect(panel()?.className).toContain("animate-nav-in");

    fireEvent.click(scrim());

    expect(onClose).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
    expect(panel()?.className).toContain("animate-nav-out");
    expect(panel()?.className).not.toContain("animate-nav-in");

    vi.advanceTimersByTime(NAV_EXIT_MS - 16);
    expect(onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dims nothing behind the panel, and still closes on a tap outside", () => {
    const onClose = vi.fn();
    render(<Harness onClosed={onClose} />);
    const cls = scrim().className;
    expect(cls).not.toMatch(/bg-black|bg-ink|backdrop-blur/);
    expect(cls).toContain("bg-transparent");

    fireEvent.click(scrim());
    vi.advanceTimersByTime(NAV_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes at once when the founder asked for reduced motion", () => {
    setReducedMotion(true);
    const onClose = vi.fn();
    render(<Harness onClosed={onClose} />);

    fireEvent.click(scrim());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("only ever schedules one close, however many times the scrim is tapped", () => {
    const onClose = vi.fn();
    render(<Harness onClosed={onClose} />);

    fireEvent.click(scrim());
    fireEvent.click(scrim());
    fireEvent.click(scrim());
    vi.advanceTimersByTime(NAV_EXIT_MS * 3);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops the shell scrolling underneath, and hands the scroll back", () => {
    const { unmount } = render(<Harness onClosed={() => {}} />);
    expect(document.documentElement.style.overflow).toBe("hidden");

    unmount();
    expect(document.documentElement.style.overflow).not.toBe("hidden");
  });

  it("restores the scroll and drops the pending close when unmounted mid-exit", () => {
    document.documentElement.style.overflow = "auto";
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClosed={onClose} />);
    fireEvent.click(scrim());

    vi.advanceTimersByTime(NAV_EXIT_MS / 2);
    unmount();
    vi.advanceTimersByTime(NAV_EXIT_MS * 2);

    expect(onClose).not.toHaveBeenCalled();
    expect(document.documentElement.style.overflow).toBe("auto");
    document.documentElement.style.overflow = "";
  });

  it("keeps one exit timer when the parent re-renders with a new onClose", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onClosed={first} />);
    fireEvent.click(scrim());

    vi.advanceTimersByTime(NAV_EXIT_MS);
    rerender(<Harness onClosed={second} />);
    vi.advanceTimersByTime(NAV_EXIT_MS);

    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
  });

  it("fires the exact close it was handed last, once, when the prop changes mid-exit", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onClosed={first} />);
    fireEvent.click(scrim());

    vi.advanceTimersByTime(NAV_EXIT_MS / 2);
    rerender(<Harness onClosed={second} />);
    vi.advanceTimersByTime(NAV_EXIT_MS / 2);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NAV_EXIT_MS * 3);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("plays the exit on Escape", () => {
    const onClose = vi.fn();
    render(<Harness onClosed={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(panel()?.className).toContain("animate-nav-out");
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(NAV_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("tapping a destination inside the sheet", () => {
  function Sheet({ onClosed }: { onClosed: () => void }) {
    return (
      <CompactNavOverlay onClose={onClosed}>
        <nav>
          <button type="button" aria-current="page">
            Growth Channels
          </button>
          <button type="button" data-nav-item="">
            Chat: yesterday
          </button>
          <a href="/talk-to-team">Talk to the team</a>
          <button type="button">Dark mode</button>
          <button type="button" aria-pressed="true">
            Menu
          </button>
        </nav>
      </CompactNavOverlay>
    );
  }

  it("closes the sheet when the row for the page already on screen is tapped", () => {
    const onClose = vi.fn();
    render(<Sheet onClosed={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Growth Channels" }));

    expect(panel()?.className).toContain("animate-nav-out");
    vi.advanceTimersByTime(NAV_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a tagged row and on a link, even when the tap lands on a child", () => {
    const onClose = vi.fn();
    render(<Sheet onClosed={onClose} />);
    const link = screen.getByRole("link", { name: "Talk to the team" });
    const inner = document.createElement("span");
    inner.textContent = "!";
    link.append(inner);

    fireEvent.click(inner);
    expect(panel()?.className).toContain("animate-nav-out");
  });

  it("leaves the sheet open for the theme toggle and menu buttons", () => {
    const onClose = vi.fn();
    render(<Sheet onClosed={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Dark mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    vi.advanceTimersByTime(NAV_EXIT_MS * 2);

    expect(panel()?.className).toContain("animate-nav-in");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hands its dismiss to a render-prop child so the collapse button animates out too", () => {
    const onClose = vi.fn();
    render(
      <CompactNavOverlay onClose={onClose}>
        {(dismiss) => (
          <button type="button" onClick={dismiss}>
            Hide sidebar
          </button>
        )}
      </CompactNavOverlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(panel()?.className).toContain("animate-nav-out");
    vi.advanceTimersByTime(NAV_EXIT_MS);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

import tailwind from "../../../../tailwind.config";

const theme = (tailwind as unknown as {
  theme: {
    extend: {
      keyframes: Record<string, Record<string, Record<string, string>>>;
      animation: Record<string, string>;
    };
  };
}).theme.extend;

const durationOf = (name: string) => {
  const match = /(\d+)ms/.exec(theme.animation[name]);
  if (!match) throw new Error(`no duration on ${name}`);
  return Number(match[1]);
};

describe("the nav blinks on, it does not slide", () => {
  it("moves nothing — every nav keyframe is opacity only", () => {
    for (const name of ["nav-in", "nav-out"]) {
      const steps = Object.values(theme.keyframes[name]);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(Object.keys(step)).toEqual(["opacity"]);
      }
    }
  });

  it("is over fast enough to read as a blink", () => {
    for (const name of ["nav-in", "nav-out"]) {
      expect(durationOf(name)).toBeLessThanOrEqual(150);
    }
  });

  it("unmounts the instant the exit ends — no dead frame, no early cut", () => {
    expect(NAV_EXIT_MS).toBe(durationOf("nav-out"));
  });

  it("puts no transform on the panel itself", () => {
    render(<Harness onClosed={() => {}} />);
    const cls = panel()!.className;
    expect(cls).not.toMatch(/translate|transform/);
  });
});
