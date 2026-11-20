// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  failEditingMessage,
  startEditingMessage,
  stopEditingMessage,
  useEditingMessage,
} from "./editingMessage";

describe("editingMessage store", () => {
  it("edits one message at a time, and moves when another is picked", () => {
    const first = renderHook(() => useEditingMessage("a"));
    const second = renderHook(() => useEditingMessage("b"));
    act(() => startEditingMessage("a"));
    expect(first.result.current?.id).toBe("a");
    expect(second.result.current).toBeNull();
    act(() => startEditingMessage("b"));
    expect(first.result.current).toBeNull();
    expect(second.result.current?.id).toBe("b");
    act(() => stopEditingMessage("a"));
    expect(second.result.current?.id).toBe("b");
    act(() => stopEditingMessage("b"));
    expect(second.result.current).toBeNull();
  });

  it("keeps the typed text and the error when a send fails", () => {
    const hook = renderHook(() => useEditingMessage("a"));
    act(() => failEditingMessage("a", "new text", "Out of credits"));
    expect(hook.result.current).toEqual({ id: "a", draft: "new text", error: "Out of credits" });
    act(() => stopEditingMessage("a"));
  });
});
