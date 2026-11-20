// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  captureStaffModelParam,
  getStaffModelParam,
  setStaffModelScope,
  staffModelBodyField,
  staffModelLabel,
  _resetForTests,
} from "../staffModelParam";

beforeEach(() => {
  _resetForTests();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/workspace");
});

describe("staffModelParam", () => {
  it("captures from the URL and survives a URL without it", () => {
    captureStaffModelParam("?model=qwen&agent=operator");
    expect(getStaffModelParam()).toBe("qwen");
    captureStaffModelParam("?agent=operator");
    expect(getStaffModelParam()).toBe("qwen");
  });

  it("switching company drops the choice (memory and storage)", () => {
    setStaffModelScope("u1", "t1");
    captureStaffModelParam("?model=qwen");
    setStaffModelScope("u1", "t2");
    expect(getStaffModelParam()).toBeUndefined();
    setStaffModelScope("u2", "t1");
    expect(getStaffModelParam()).toBeUndefined();
    setStaffModelScope("u1", "t1");
    expect(getStaffModelParam()).toBe("qwen");
  });

  it("signing out (no user) scopes to anon", () => {
    setStaffModelScope("u1", "t1");
    captureStaffModelParam("?model=qwen");
    setStaffModelScope(undefined, undefined);
    expect(getStaffModelParam()).toBeUndefined();
  });

  it("?model=claude (or empty) clears it", () => {
    captureStaffModelParam("?model=qwen");
    captureStaffModelParam("?model=claude");
    expect(getStaffModelParam()).toBeUndefined();
    captureStaffModelParam("?model=qwen");
    captureStaffModelParam("?model=");
    expect(getStaffModelParam()).toBeUndefined();
  });

  it("reads the live URL on get", () => {
    window.history.replaceState(null, "", "/workspace?model=opus-high");
    expect(getStaffModelParam()).toBe("opus-high");
    expect(staffModelBodyField()).toEqual({ model: "opus-high" });
  });

  it("body field is empty with no choice", () => {
    expect(staffModelBodyField()).toEqual({});
  });

  it("label keyed on the staff choice", () => {
    expect(staffModelLabel("qwen", "qwen/qwen3.8-27b")).toBe("answered by qwen · qwen/qwen3.8-27b");
    expect(staffModelLabel("opus-xhigh", null)).toBe("answered by opus-xhigh");
    expect(staffModelLabel(undefined, "claude-opus-5-5")).toBeNull();
  });
});
