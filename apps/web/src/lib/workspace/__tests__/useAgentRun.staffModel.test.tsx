// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ run_id: "r1", thread_id: "t1" }), { status: 200 });
  }),
}));

import { useAgentRun } from "../useAgentRun";
import { setStaffModelScope, _resetForTests } from "../staffModelParam";

beforeEach(() => {
  calls.length = 0;
  _resetForTests();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/workspace");
});

describe("useAgentRun sends the staff ?model= choice", () => {
  it("adds model to the chat POST body when the URL has ?model=", async () => {
    setStaffModelScope("u1", "t1");
    window.history.replaceState(null, "", "/workspace?model=qwen&agent=operator");
    const { result } = renderHook(() => useAgentRun());
    await act(async () => { await result.current.send("operator", "hi", "th1"); });
    expect(calls[0].url).toBe("/api/agents/operator/chat");
    expect(calls[0].body).toMatchObject({ message: "hi", model: "qwen" });
  });

  it("keeps the choice after client navigation drops the param", async () => {
    setStaffModelScope("u1", "t1");
    window.history.replaceState(null, "", "/workspace?model=kimi");
    const { result } = renderHook(() => useAgentRun());
    await act(async () => { await result.current.send("operator", "a", "th1"); });
    window.history.replaceState(null, "", "/workspace?agent=operator");
    await act(async () => { await result.current.send("operator", "b", "th1"); });
    expect(calls[1].body.model).toBe("kimi");
  });

  it("sends no model when there is no choice", async () => {
    const { result } = renderHook(() => useAgentRun());
    await act(async () => { await result.current.send("operator", "hi", "th1"); });
    expect(calls[0].body).not.toHaveProperty("model");
  });
});
