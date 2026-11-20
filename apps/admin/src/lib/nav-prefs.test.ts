import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_PINS, NAV_GROUPS_KEY, NAV_PINS_KEY } from "./admin-nav";
import {
  getNavPrefs,
  openOnlyNavGroup,
  resetNavPrefsForTest,
  setNavGroupOpen,
  toggleNavPin,
} from "./nav-prefs";

let store: Record<string, string>;

beforeEach(() => {
  store = {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  resetNavPrefsForTest();
});

describe("nav prefs store", () => {
  it("starts from the defaults when nothing is saved", () => {
    expect(getNavPrefs()).toEqual({ pins: [...DEFAULT_PINS], openGroups: {} });
  });
  it("reads what an earlier session saved", () => {
    store[NAV_PINS_KEY] = JSON.stringify(["/billing"]);
    store[NAV_GROUPS_KEY] = JSON.stringify({ money: true });
    expect(getNavPrefs()).toEqual({ pins: ["/billing"], openGroups: { money: true } });
  });
  it("pinning updates the shared snapshot and saves it", () => {
    toggleNavPin("/billing");
    expect(getNavPrefs().pins).toContain("/billing");
    expect(JSON.parse(store[NAV_PINS_KEY])).toContain("/billing");
    toggleNavPin("/billing");
    expect(getNavPrefs().pins).not.toContain("/billing");
  });
  it("a saved pin survives a reload", () => {
    toggleNavPin("/billing");
    resetNavPrefsForTest();
    expect(getNavPrefs().pins).toContain("/billing");
  });
  it("opening a group saves it; openOnly closes the others", () => {
    setNavGroupOpen("health", true);
    setNavGroupOpen("money", true);
    openOnlyNavGroup("agents");
    expect(getNavPrefs().openGroups).toEqual({ health: false, money: false, agents: true });
    expect(JSON.parse(store[NAV_GROUPS_KEY])).toEqual({ health: false, money: false, agents: true });
  });
  it("a storage failure never throws", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    resetNavPrefsForTest();
    expect(() => toggleNavPin("/billing")).not.toThrow();
    expect(getNavPrefs().pins).toContain("/billing");
  });
});
