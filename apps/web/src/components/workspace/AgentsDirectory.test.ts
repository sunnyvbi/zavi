import { describe, it, expect } from "vitest";
import {
  coerceDepartment,
  toDirectoryRow,
  filterRows,
  groupByDepartment,
  type AgentEffectiveRow,
  type DirectoryRow,
} from "./AgentsDirectory";

function row(p: Partial<AgentEffectiveRow>): AgentEffectiveRow {
  return {
    slug: "x",
    default_state: "enabled",
    effective_state: "visible",
    effective_reason: "default_enabled",
    override_state: null,
    override_source: null,
    is_locked: false,
    ...p,
  };
}

describe("coerceDepartment", () => {
  it("passes valid values, defaults unknown/undefined to others", () => {
    expect(coerceDepartment("leadership")).toBe("leadership");
    expect(coerceDepartment("product")).toBe("product");
    expect(coerceDepartment("marketing")).toBe("others");
    expect(coerceDepartment(undefined)).toBe("others");
  });
});

describe("toDirectoryRow", () => {
  it("uses the canonical registry display name (matches sidebar)", () => {
    expect(toDirectoryRow(row({ slug: "pm" })).display).toBe("Product Manager");
    expect(toDirectoryRow(row({ slug: "growth-lead" })).display).toBe("Head of Growth");
    expect(toDirectoryRow(row({ slug: "brand-new" })).display).toBe("Brand New");
  });
  it("maps visible→on and derives lock from is_locked / staff source", () => {
    expect(toDirectoryRow(row({ effective_state: "visible", is_locked: true })).lock).toBe(
      "always_on",
    );
    expect(
      toDirectoryRow(row({ effective_state: "hidden", override_source: "staff" })).lock,
    ).toBe("staff");
    const plain = toDirectoryRow(row({ effective_state: "hidden" }));
    expect(plain.on).toBe(false);
    expect(plain.lock).toBe("none");
  });
  it("always_on wins over staff for the lock kind", () => {
    expect(
      toDirectoryRow(row({ is_locked: true, override_source: "staff" })).lock,
    ).toBe("always_on");
  });
  it("maps the department, defaulting unknown to others", () => {
    expect(toDirectoryRow(row({ department: "leadership" })).department).toBe("leadership");
    expect(toDirectoryRow(row({ department: undefined })).department).toBe("others");
  });
});

describe("filterRows", () => {
  const rows: DirectoryRow[] = [
    { slug: "a", display: "Alpha", department: "product", on: true, lock: "none" },
    { slug: "b", display: "Bravo", department: "growth", on: false, lock: "none" },
    { slug: "c", display: "Charlie", department: "product", on: true, lock: "always_on" },
  ];
  it("all shows everything", () => {
    expect(filterRows(rows, "all", "").length).toBe(3);
  });
  it("active shows only on", () => {
    expect(filterRows(rows, "active", "").map((r) => r.slug)).toEqual(["a", "c"]);
  });
  it("disable shows only off", () => {
    expect(filterRows(rows, "disable", "").map((r) => r.slug)).toEqual(["b"]);
  });
  it("query matches display or slug, case-insensitive", () => {
    expect(filterRows(rows, "all", "brav").map((r) => r.slug)).toEqual(["b"]);
    expect(filterRows(rows, "all", "A").length).toBeGreaterThan(0);
  });
});

describe("groupByDepartment", () => {
  it("groups in fixed order, drops empty groups, sorts within a group", () => {
    const rows: DirectoryRow[] = [
      { slug: "z", display: "Zeta", department: "product", on: true, lock: "none" },
      { slug: "a", display: "Alpha", department: "product", on: true, lock: "none" },
      { slug: "l", display: "Lead", department: "leadership", on: true, lock: "none" },
    ];
    const groups = groupByDepartment(rows);
    expect(groups.map((g) => g.department)).toEqual(["leadership", "product"]);
    expect(groups[1].rows.map((r) => r.display)).toEqual(["Alpha", "Zeta"]);
    expect(groups[0].label).toBe("Leadership");
  });
});
