import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { capTabsForPersist, MAX_PERSISTED_TABS } from "./tabsSession";

type Tab = { id: string; kind: string };

const home: Tab = { id: "home-default", kind: "home" };
const agents = (n: number): Tab[] =>
  Array.from({ length: n }, (_, i) => ({ id: `a${i}`, kind: "agent" }));

describe("capTabsForPersist", () => {
  it("returns the same array when within the cap", () => {
    const tabs = [home, ...agents(5)];
    expect(capTabsForPersist(tabs, "a2")).toBe(tabs);
  });

  it("keeps Home when a long session would push it out of the server's last-20 trim (Bug #2)", () => {
    const tabs = [home, ...agents(25)];
    const out = capTabsForPersist(tabs, "a24");
    expect(out).toHaveLength(MAX_PERSISTED_TABS);
    expect(out[0]).toBe(home);
    expect(out.slice(1).map((t) => t.id)).toEqual(
      agents(25)
        .slice(-19)
        .map((t) => t.id),
    );
  });

  it("keeps an older active tab alongside Home", () => {
    const tabs = [home, ...agents(25)];
    const out = capTabsForPersist(tabs, "a3");
    expect(out).toHaveLength(MAX_PERSISTED_TABS);
    expect(out.map((t) => t.id)).toContain("a3");
    expect(out[0]).toBe(home);
    expect(out[1].id).toBe("a3");
  });

  it("never exceeds the cap, even with a tiny max", () => {
    const tabs = [home, ...agents(10)];
    const out = capTabsForPersist(tabs, "a4", 2);
    expect(out.map((t) => t.id)).toEqual(["home-default", "a4"]);
  });

  it("works with no Home tab and no active tab", () => {
    const tabs = agents(22);
    const out = capTabsForPersist(tabs, null);
    expect(out).toHaveLength(MAX_PERSISTED_TABS);
    expect(out[0].id).toBe("a2");
  });
});
