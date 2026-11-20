// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthOtpAnimation } from "./AuthOtpAnimation";

let prefersReducedMotion = false;

beforeEach(() => {
  prefersReducedMotion = false;
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches: prefersReducedMotion,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sent-code illustration", () => {
  it("plays the six captured states on the wireframe's 1.3 second cadence", () => {
    render(<AuthOtpAnimation />);
    const animation = screen.getByTestId("auth-otp-animation");
    expect(animation.getAttribute("data-phase")).toBe("0");
    expect(screen.getByText("Your mail app").parentElement?.className).toContain("opacity-100");

    for (let phase = 1; phase < 6; phase += 1) {
      act(() => vi.advanceTimersByTime(1300));
      expect(animation.getAttribute("data-phase")).toBe(String(phase));
    }

    expect(screen.getByText("Copied")).toBeTruthy();
    expect(screen.getByText("You're in")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1300));
    expect(animation.getAttribute("data-phase")).toBe("0");
  });

  it("shows the completed state without a timer when reduced motion is requested", () => {
    prefersReducedMotion = true;
    render(<AuthOtpAnimation />);
    const animation = screen.getByTestId("auth-otp-animation");
    expect(animation.getAttribute("data-phase")).toBe("complete");
    expect(animation.textContent).not.toMatch(/\d{8}/);
    expect(screen.getByText("Copied")).toBeTruthy();
    expect(screen.getByText("You're in")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
