// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const openTab = vi.hoisted(() => vi.fn());
vi.mock("../../WorkspaceShell", () => ({ useWorkspace: () => ({ openTab }) }));

import { useOpenStatic } from "../shared";
import { setUnappliedEditGuard } from "@/lib/workspace/unappliedEdits";

afterEach(() => {
  openTab.mockReset();
});

describe("sidebar destinations and an unapplied site edit", () => {
  it("opens at once with nothing typed, and only after the Apply / Discard answer with a draft", () => {
    const { result } = renderHook(() => useOpenStatic());
    result.current("channels");
    expect(openTab).toHaveBeenCalledTimes(1);

    let answer: (() => void) | null = null;
    const clear = setUnappliedEditGuard((proceed) => {
      answer = proceed;
      return true;
    });
    result.current("analytics");
    expect(openTab).toHaveBeenCalledTimes(1);
    answer!();
    expect(openTab).toHaveBeenCalledTimes(2);
    expect(openTab.mock.calls[1]![0]).toMatchObject({ kind: "analytics", payload: { kind: "analytics" } });
    clear();
  });
});
