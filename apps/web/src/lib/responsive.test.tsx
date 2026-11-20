// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { COMPACT_QUERY, useIsCompact, useMediaMatch } from "./responsive";

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const matching = new Set<string>();
let constructed = 0;

function installMatchMedia() {
  window.matchMedia = ((query: string) => {
    constructed += 1;
    return {
      get matches() {
        return matching.has(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: Listener) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)!.add(fn);
      },
      removeEventListener: (_: string, fn: Listener) => {
        listeners.get(query)?.delete(fn);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

function flip(query: string, matches: boolean) {
  if (matches) matching.add(query);
  else matching.delete(query);
  act(() => {
    listeners.get(query)?.forEach((fn) => fn());
  });
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  listeners.clear();
  matching.clear();
  constructed = 0;
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe("useMediaMatch", () => {
  it("reports the match on the very first client render, not one commit later", () => {
    matching.add(COMPACT_QUERY);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useIsCompact());
      return null;
    }
    render(<Probe />);
    expect(seen[0]).toBe(true);
    expect(seen).not.toContain(false);
  });

  it("mounts a compact-gated subtree exactly once on a phone", () => {
    matching.add(COMPACT_QUERY);
    let desktopMounts = 0;
    let compactMounts = 0;
    function Desktop() {
      desktopMounts += 1;
      return <div>desktop</div>;
    }
    function Compact() {
      compactMounts += 1;
      return <div>compact</div>;
    }
    function Page() {
      return useIsCompact() ? <Compact /> : <Desktop />;
    }
    render(<Page />);
    expect(desktopMounts).toBe(0);
    expect(compactMounts).toBe(1);
  });

  it("follows the media query when it changes", () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useMediaMatch("(min-width: 900px)"));
      return null;
    }
    render(<Probe />);
    expect(seen.at(-1)).toBe(false);
    flip("(min-width: 900px)", true);
    expect(seen.at(-1)).toBe(true);
    flip("(min-width: 900px)", false);
    expect(seen.at(-1)).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    function Probe() {
      useMediaMatch("(min-width: 900px)");
      return null;
    }
    const { unmount } = render(<Probe />);
    expect(listeners.get("(min-width: 900px)")?.size).toBe(1);
    unmount();
    expect(listeners.get("(min-width: 900px)")?.size).toBe(0);
  });

  it("stays false when matchMedia is missing instead of throwing", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useIsCompact());
      return null;
    }
    expect(() => render(<Probe />)).not.toThrow();
    expect(seen).toEqual([false]);
    expect(constructed).toBe(0);
  });
});
