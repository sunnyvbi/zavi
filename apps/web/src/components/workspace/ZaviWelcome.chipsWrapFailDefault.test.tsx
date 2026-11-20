// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, apiUrl: (p: string) => `http://api.test${p}` }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));

import { SuggestionChips, WORKSPACE_MODE_SUGGESTION_CHIPS } from "./ZaviWelcome";
import {
  __resetBuildSessionsForTest,
  DEFAULT_UI_FLAGS,
  readBuildSessions,
  refreshBuildSessions,
} from "@/lib/workspace/useBuildSessions";

function phone() {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (max ? 390 <= Number(max[1]) : true) && (min ? 390 >= Number(min[1]) : true);
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
  }) as typeof window.matchMedia;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const okBody = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => {
  __resetBuildSessionsForTest();
  apiFetch.mockReset();
  phone();
});
afterEach(() => {
  cleanup();
  __resetBuildSessionsForTest();
});

describe("DEL-1323 B39: a failed build-sessions read still wraps the chips on a phone", () => {
  it.each([
    ["the read throws", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["the read answers 500", () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)],
  ] as const)("when %s the chips wrap, the key's default, instead of the drifting row", async (_label, answer) => {
    apiFetch.mockImplementation(answer);
    render(<SuggestionChips items={[...WORKSPACE_MODE_SUGGESTION_CHIPS.build]} onPick={() => {}} />);
    await settle();
    expect(apiFetch).toHaveBeenCalledWith("/api/workspace/autopilot/build-sessions");
    expect(readBuildSessions().failed).toBe(true);
    expect(readBuildSessions().uiFlags).toEqual(DEFAULT_UI_FLAGS);
    expect(screen.getByTestId("suggestion-chips-wrap")).toBeTruthy();
  });

  it("the server's explicit off still wins over the default", async () => {
    apiFetch.mockImplementation(async () => okBody({ sessions: [], ui_flags: { chips_wrap_mobile: false } }));
    render(<SuggestionChips items={[...WORKSPACE_MODE_SUGGESTION_CHIPS.build]} onPick={() => {}} />);
    await settle();
    expect(screen.queryByTestId("suggestion-chips-wrap")).toBeNull();
  });

  it("a later failed refresh keeps the flags the server already gave, never flips them to defaults", async () => {
    apiFetch.mockImplementationOnce(async () =>
      okBody({ sessions: [], ui_flags: { chips_wrap_mobile: false, mobile_actions: false } }),
    );
    await refreshBuildSessions();
    apiFetch.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    await refreshBuildSessions();
    expect(readBuildSessions().failed).toBe(true);
    expect(readBuildSessions().uiFlags.chipsWrapMobile).toBe(false);
    expect(readBuildSessions().uiFlags.mobileActions).toBe(false);
  });

  it("a key missing from the server's ui_flags takes its default", async () => {
    apiFetch.mockImplementation(async () => okBody({ sessions: [], ui_flags: { mobile_actions: false } }));
    await refreshBuildSessions();
    expect(readBuildSessions().uiFlags).toEqual({ ...DEFAULT_UI_FLAGS, mobileActions: false });
  });
});
