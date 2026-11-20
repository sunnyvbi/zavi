import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AD_BUDGET_URL, URL_TAB_KINDS, isUrlTabKind, tabUrlParam, urlTabKindFromParam } from "./tabUrl";
import { AD_BUDGET_ANCHOR } from "@/components/workspace/growth/AdBudgetSection";

describe("URL_TAB_KINDS", () => {
  it("covers every destination the sidebar can open", () => {
    const panel = readFileSync(
      join(__dirname, "../../components/workspace/layout/ContextPanel.tsx"),
      "utf8",
    );
    const opened = new Set(
      [...panel.matchAll(/openStatic\("([a-z-]+)"/g)].map((m) => m[1]),
    );
    opened.delete("home");

    expect(opened.size).toBeGreaterThan(0);
    for (const kind of opened) {
      expect(URL_TAB_KINDS, `${kind} would not survive a reload`).toContain(
        kind,
      );
    }
  });

  it("does not claim home, which is the bare URL", () => {
    expect(isUrlTabKind("home")).toBe(false);
  });

  it("rejects an unknown tab so a pasted link falls back to Home", () => {
    expect(isUrlTabKind("nope")).toBe(false);
    expect(isUrlTabKind(undefined)).toBe(false);
  });

  it("accepts messaging", () => {
    expect(isUrlTabKind("messaging")).toBe(true);
  });

  it("accepts needs-you and round-trips it (2026-10-17)", () => {
    expect(isUrlTabKind("needs-you")).toBe(true);
    expect(tabUrlParam("needs-you")).toBe("needs-you");
    expect(urlTabKindFromParam("needs-you")).toBe("needs-you");
  });

  it("accepts the agent pages, so a reload lands back on them", () => {
    for (const kind of ["fundraising", "supply-demand", "engineer"]) {
      expect(isUrlTabKind(kind), kind).toBe(true);
    }
  });
});

describe("the Growth Strategy address", () => {
  it("writes the page's name, not the internal kind, into ?tab=", () => {
    expect(tabUrlParam("autopilot")).toBe("growth-strategy");
  });

  it("reads the new address back to the kind that renders it", () => {
    expect(urlTabKindFromParam("growth-strategy")).toBe("autopilot");
  });

  it("still honours links minted before the rename", () => {
    expect(urlTabKindFromParam("autopilot")).toBe("autopilot");
    expect(urlTabKindFromParam("feed")).toBe("channels");
  });

  it("round-trips every other kind unchanged", () => {
    for (const kind of URL_TAB_KINDS) {
      expect(urlTabKindFromParam(tabUrlParam(kind))).toBe(kind);
    }
  });

  it("does not turn an unknown param into a page", () => {
    expect(urlTabKindFromParam("nope")).toBeNull();
    expect(urlTabKindFromParam(undefined)).toBeNull();
  });
});

describe("AD_BUDGET_URL", () => {
  it("opens the Growth tab at the ad budget section's own anchor", () => {
    expect(urlTabKindFromParam(new URL(AD_BUDGET_URL, "https://x").searchParams.get("tab"))).toBe("autopilot");
    expect(AD_BUDGET_URL.endsWith(`#${AD_BUDGET_ANCHOR}`)).toBe(true);
  });
});
