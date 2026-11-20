import { describe, it, expect } from "vitest";
import {
  ALL_ITEMS,
  DEFAULT_PINS,
  NAV_GROUPS_KEY,
  pinsFirst,
  GROUPS,
  PANIC_STOP,
  TONE_CLASSES,
  activeHref,
  filterNav,
  groupOf,
  isGroupOpen,
  itemOf,
  parseStoredGroups,
  parseStoredPins,
  togglePin,
} from "./admin-nav";

describe("activeHref", () => {
  it("picks the most specific link and handles the root", () => {
    expect(activeHref("/")).toBe("/");
    expect(activeHref("/creator-network/creators")).toBe("/creator-network/creators");
    expect(activeHref("/creator-network/disputes/9")).toBe("/creator-network");
    expect(activeHref("/tenants/abc")).toBe("/tenants");
    expect(activeHref("/nope")).toBeNull();
  });
});

describe("group open state", () => {
  it("defaults: every titled group starts closed", () => {
    for (const g of GROUPS) if (g.title) expect(isGroupOpen(g.key, {}, null)).toBe(false);
  });
  it("a stored choice overrides the default; state is keyed by stable group key, not title", () => {
    expect(isGroupOpen("health", { health: true }, null)).toBe(true);
    expect(isGroupOpen("system", { System: true, Operations: true }, null)).toBe(false);
    expect(NAV_GROUPS_KEY).not.toBe("zavi.admin.navGroups");
  });
  it("the active route's group is always open, even if stored closed", () => {
    const g = groupOf(activeHref("/config"));
    expect(g).toBe("system");
    expect(isGroupOpen("system", { system: false }, g)).toBe(true);
  });
  it("parses stored JSON defensively", () => {
    expect(parseStoredGroups(null)).toEqual({});
    expect(parseStoredGroups("not json")).toEqual({});
    expect(parseStoredGroups("[1,2]")).toEqual({});
    expect(parseStoredGroups('{"System":true,"Comms":"yes"}')).toEqual({ System: true });
  });
});

describe("filterNav", () => {
  it("returns every page for an empty query", () => {
    expect(filterNav(ALL_ITEMS, "  ")).toHaveLength(ALL_ITEMS.length);
  });
  it("ranks label prefix matches first", () => {
    const hrefs = filterNav(ALL_ITEMS, "cost").map((i) => i.href);
    expect(hrefs.slice(0, 2)).toEqual(["/cost-anomaly", "/costs"]);
    expect(hrefs.indexOf("/tenant-costs")).toBeGreaterThan(1);
  });
  it("matches on group name and needs every term", () => {
    const hits = filterNav(ALL_ITEMS, "health cron").map((i) => i.href);
    expect(hits).toEqual(["/crons"]);
    expect(filterNav(ALL_ITEMS, "zzz")).toEqual([]);
  });
  it("is case-insensitive", () => {
    expect(filterNav(ALL_ITEMS, "DECISIONS").map((i) => i.href)).toEqual(["/decisions"]);
  });
});

describe("groups", () => {
  it("places every page exactly once, in priority order", () => {
    const hrefs = GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(GROUPS.map((g) => g.title)).toEqual([
      null, "Health", "Customers", "Money", "Growth", "Customer voice", "Agents", "Creators", "System",
    ]);
  });
  it("keeps Panic-stop out of the groups but findable and highlightable", () => {
    expect(GROUPS.some((g) => g.items.some((i) => i.href === PANIC_STOP.href))).toBe(false);
    expect(filterNav(ALL_ITEMS, "panic").map((i) => i.href)).toEqual(["/fleet-halt"]);
    expect(activeHref("/fleet-halt")).toBe("/fleet-halt");
    expect(groupOf("/fleet-halt")).toBeNull();
    expect(filterNav(ALL_ITEMS, "system panic")).toEqual([]);
  });
  it("group keys are unique and rail tiles never reuse a page icon", () => {
    expect(new Set(GROUPS.map((g) => g.key)).size).toBe(GROUPS.length);
    const pageIcons = new Set(ALL_ITEMS.map((i) => i.icon));
    for (const g of GROUPS) if (g.title) expect(pageIcons.has(g.icon)).toBe(false);
  });
  it("gives every group a tone with classes", () => {
    for (const g of GROUPS) expect(TONE_CLASSES[g.tone]).toBeDefined();
  });
});

describe("pins", () => {
  it("uses the defaults when nothing valid is stored", () => {
    expect(parseStoredPins(null)).toEqual([...DEFAULT_PINS]);
    expect(parseStoredPins("not json")).toEqual([...DEFAULT_PINS]);
    expect(parseStoredPins('{"a":1}')).toEqual([...DEFAULT_PINS]);
  });
  it("keeps an empty list empty (the admin unpinned everything)", () => {
    expect(parseStoredPins("[]")).toEqual([]);
  });
  it("drops unknown pages, Panic-stop, non-strings and duplicates, keeping order", () => {
    expect(parseStoredPins('["/runs","/gone",3,"/fleet-halt","/errors","/runs"]')).toEqual(["/runs", "/errors"]);
  });
  it("every default pin is a real grouped page", () => {
    for (const h of DEFAULT_PINS) expect(itemOf(h)?.group).toBeTruthy();
  });
  it("togglePin adds at the end and removes", () => {
    expect(togglePin(["/runs"], "/errors")).toEqual(["/runs", "/errors"]);
    expect(togglePin(["/runs", "/errors"], "/runs")).toEqual(["/errors"]);
  });

  it("never pins the top rows (Overview, Search), even from stale storage", () => {
    expect(parseStoredPins('["/","/search","/runs"]')).toEqual(["/runs"]);
    expect(togglePin(["/runs"], "/")).toEqual(["/runs"]);
    expect(togglePin(["/runs"], "/search")).toEqual(["/runs"]);
  });
  it("pinsFirst puts pinned pages first in pin order, rest in sidebar order", () => {
    const out = pinsFirst(ALL_ITEMS, ["/runs", "/errors", "/gone"]).map((i) => i.href);
    expect(out.slice(0, 3)).toEqual(["/runs", "/errors", "/"]);
    expect(out).toHaveLength(ALL_ITEMS.length);
  });
  it("itemOf carries the group's tone", () => {
    expect(itemOf("/revenue")?.tone).toBe("money");
    expect(itemOf("/nope")).toBeNull();
  });
});
