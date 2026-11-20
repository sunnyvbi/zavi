// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    h.paths.push(path);
    return {
      ok: true,
      json: async () => ({ sessions: [], current_session_id: null, flags: {}, ui_flags: { chips_wrap_mobile: true } }),
    };
  }),
}));

import { SuggestionChips, WORKSPACE_MODE_SUGGESTION_CHIPS } from "./ZaviWelcome";
import { __resetBuildSessionsForTest } from "@/lib/workspace/useBuildSessions";

function matchMediaAt(width: number) {
  return (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (max ? width <= Number(max[1]) : true) && (min ? width >= Number(min[1]) : true);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}

const buildSessionReads = () => h.paths.filter((p) => p === "/api/workspace/autopilot/build-sessions").length;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  __resetBuildSessionsForTest();
  h.paths = [];
});
afterEach(() => cleanup());

describe("the welcome chips only read build-sessions on a phone", () => {
  it("a wide screen renders the chips without fetching build-sessions, even on a tab refocus", async () => {
    window.matchMedia = matchMediaAt(1280);
    render(<SuggestionChips items={WORKSPACE_MODE_SUGGESTION_CHIPS.build} onPick={() => {}} />);
    await flush();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(buildSessionReads()).toBe(0);
    expect(screen.queryByTestId("suggestion-chips-wrap")).toBeNull();
    expect(screen.getAllByRole("button", { name: WORKSPACE_MODE_SUGGESTION_CHIPS.build[0].prompt }).length).toBeGreaterThan(0);
  });

  it("a phone reads the setting and wraps the chips", async () => {
    window.matchMedia = matchMediaAt(390);
    render(<SuggestionChips items={WORKSPACE_MODE_SUGGESTION_CHIPS.build} onPick={() => {}} />);
    await flush();
    expect(buildSessionReads()).toBe(1);
    expect(screen.getByTestId("suggestion-chips-wrap")).toBeTruthy();
  });
});
