// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useStoredFlag } from "./workspacePrefs";

describe("useStoredFlag", () => {
  const AUTO_ON = () => true;
  const AUTO_OFF = () => false;

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders false before its effect, then takes the caller's default", () => {
    const { result } = renderHook(() => useStoredFlag("zavi:test-flag", AUTO_ON));
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem("zavi:test-flag")).toBeNull();
  });

  it("a stored value beats the default, in both directions", () => {
    window.localStorage.setItem("zavi:test-flag", "0");
    const off = renderHook(() => useStoredFlag("zavi:test-flag", AUTO_ON));
    expect(off.result.current[0]).toBe(false);
    cleanup();
    window.localStorage.setItem("zavi:test-flag", "1");
    const on = renderHook(() => useStoredFlag("zavi:test-flag", AUTO_OFF));
    expect(on.result.current[0]).toBe(true);
  });

  it("persists as 1/0 when set", () => {
    const { result } = renderHook(() => useStoredFlag("zavi:test-flag", AUTO_OFF));
    act(() => result.current[1](true));
    expect(window.localStorage.getItem("zavi:test-flag")).toBe("1");
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(window.localStorage.getItem("zavi:test-flag")).toBe("0");
  });
});
