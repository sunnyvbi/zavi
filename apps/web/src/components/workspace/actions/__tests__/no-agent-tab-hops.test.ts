
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKSPACE = fileURLToPath(new URL("../..", import.meta.url));
const ROOTS = ["layout", "actions"];

const NO_HOP_PANELS = ["agent/GoogleAdsPanel.tsx", "agent/XAgentDashboard.tsx"];

const LEGACY_ALLOWLIST = new Set<string>([
  "layout/ChannelsPanel.tsx",
  "layout/ContextPanel.tsx",
  "layout/OnboardingView.tsx",
  "layout/ThreadTitleBar.tsx",
  "layout/WorkspaceLayout.tsx",
  "layout/useNewTaskLanding.ts",
]);

const HOP = /\b(?:openAgentTab|seedComposer)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function filesUsingHops(): string[] {
  return ROOTS.flatMap((root) => sourceFiles(join(WORKSPACE, root)))
    .filter((f) => HOP.test(readFileSync(f, "utf8")))
    .map((f) => relative(WORKSPACE, f).split("\\").join("/"))
    .sort();
}

describe("no openAgentTab / seedComposer under layout/** or actions/**", () => {
  const found = filesUsingHops();

  it("the scan sees the legacy callers (it is not blind)", () => {
    expect(found).toContain("layout/ChannelsPanel.tsx");
  });

  it("the action cards never hop to another tab", () => {
    expect(found.filter((f) => f.startsWith("actions/"))).toEqual([]);
  });

  it("no file outside the legacy allowlist calls them", () => {
    expect(found.filter((f) => !LEGACY_ALLOWLIST.has(f)), "Open the side chat (onOpenChat) instead of another tab").toEqual([]);
  });

  it("keeps the allowlist honest: every entry still calls them", () => {
    expect([...LEGACY_ALLOWLIST].filter((f) => !found.includes(f)), "Remove files that no longer call them from LEGACY_ALLOWLIST").toEqual([]);
  });

  it("the switched channel panels never hop to another tab", () => {
    const hopping = NO_HOP_PANELS.filter((rel) => HOP.test(readFileSync(join(WORKSPACE, rel), "utf8")));
    expect(hopping, "Open the side chat (onOpenChat) instead of another tab").toEqual([]);
  });
});
