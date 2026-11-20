// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useNewTaskLanding } from "./useNewTaskLanding";

function at(href: string) {
  window.history.replaceState(null, "", href);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  at("/");
});

describe("useNewTaskLanding (#18)", () => {
  it("on a bare /workspace, opens the operator tab", async () => {
    at("/workspace");
    const order: string[] = [];
    const openAgentTab = vi.fn(async (slug: string) => {
      order.push(`open:${slug}`);
      return "tab-1";
    });
    renderHook(() => useNewTaskLanding(openAgentTab));
    expect(openAgentTab).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(order).toEqual(["open:operator"]);
    expect(openAgentTab).toHaveBeenCalledWith("operator");
  });

  it("does nothing on a deep link", async () => {
    at("/workspace?tab=settings");
    const openAgentTab = vi.fn(async () => "tab-1");
    const setChatFocus = vi.fn();
    renderHook(() => useNewTaskLanding(openAgentTab));
    await vi.runAllTimersAsync();
    expect(openAgentTab).not.toHaveBeenCalled();
    expect(setChatFocus).not.toHaveBeenCalled();
  });

  it("runs once per mount, even when the URL later becomes bare again (Board click)", async () => {
    at("/workspace?agent=operator");
    const openAgentTab = vi.fn(async () => "tab-1");
    const { rerender } = renderHook(() => useNewTaskLanding(openAgentTab));
    at("/workspace");
    rerender();
    await vi.runAllTimersAsync();
    expect(openAgentTab).not.toHaveBeenCalled();
  });

  it("fires exactly once under StrictMode's double mount", async () => {
    at("/workspace");
    const openAgentTab = vi.fn(async () => "tab-1");
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useNewTaskLanding(openAgentTab), { wrapper });
    await vi.runAllTimersAsync();
    expect(openAgentTab).toHaveBeenCalledTimes(1);
  });
});
