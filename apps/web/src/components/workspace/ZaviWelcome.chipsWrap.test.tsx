// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { cleanup, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ wrap: true, width: 390 }));

vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: null,
    sessions: [],
    flags: { siteNames: false, siteRepoChip: false, siteListDetails: false },
    uiFlags: { chipsWrapMobile: h.wrap },
  }),
}));

import { SuggestionChips, WORKSPACE_MODE_SUGGESTION_CHIPS, MAKE_SUGGESTION_CHIPS } from "./ZaviWelcome";

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

const HIDING = /(^|\s)(hidden|sr-only|invisible)(\s|$)|(^|\s)(sm|md|lg|compact):(hidden|sr-only)(\s|$)/;

beforeEach(() => {
  h.wrap = true;
  window.matchMedia = matchMediaAt(390);
});
afterEach(() => cleanup());

describe("DEL-1323 B39: suggestion chips at 390px", () => {
  it.each([
    ["build", WORKSPACE_MODE_SUGGESTION_CHIPS.build],
    ["grow", WORKSPACE_MODE_SUGGESTION_CHIPS.grow],
    ["make", MAKE_SUGGESTION_CHIPS],
  ] as const)("the %s chips wrap onto lines with every full label shown once and nothing hidden", (_name, items) => {
    const { container } = render(<SuggestionChips items={[...items]} onPick={() => {}} />);
    const wrap = screen.getByTestId("suggestion-chips-wrap");
    expect(wrap.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
    expect(container.querySelector("[aria-hidden='true'] button")).toBeNull();
    expect(container.querySelector("[class*='mask-image']")).toBeNull();
    const buttons = within(wrap).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(items.map((c) => c.label));
    for (const button of buttons) {
      let node: HTMLElement | null = button;
      while (node && node !== container) {
        expect(node.className).not.toMatch(HIDING);
        node = node.parentElement;
      }
    }
  });

  it("wider screens keep the drifting row", () => {
    window.matchMedia = matchMediaAt(1280);
    render(<SuggestionChips items={WORKSPACE_MODE_SUGGESTION_CHIPS.build} onPick={() => {}} />);
    expect(screen.queryByTestId("suggestion-chips-wrap")).toBeNull();
  });

  it("with the setting off a phone keeps the drifting row", () => {
    h.wrap = false;
    render(<SuggestionChips items={WORKSPACE_MODE_SUGGESTION_CHIPS.build} onPick={() => {}} />);
    expect(screen.queryByTestId("suggestion-chips-wrap")).toBeNull();
  });
});
