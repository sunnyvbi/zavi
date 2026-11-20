import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const BACKEND_DIR = join(__dirname, "../../..");
const BASELINE_PATH = join(__dirname, "tenant-resources-baseline.json");
const SCAN_DIRS = ["src", "workers", "scripts"];

const PATTERNS: RegExp[] = [
  /\.from\(\s*["'`]tenant_resources["'`]/g,
  /\.rpc\(\s*["'`]set_tenant_resource["'`]/g,
];

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

function tenantResourcesAccesses(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(BACKEND_DIR, d))) {
      const src = stripComments(readFileSync(file, "utf8"));
      const n = PATTERNS.reduce((sum, re) => sum + (src.match(re) ?? []).length, 0);
      if (n > 0) counts[relative(BACKEND_DIR, file).split("\\").join("/")] = n;
    }
  }
  return counts;
}

describe("app identity: no NEW tenant_resources app access outside the legacy baseline", () => {
  const counts = tenantResourcesAccesses();

  if (process.env.UPDATE_TENANT_RESOURCES_BASELINE === "1") {
    const next: Record<string, number> = {};
    for (const f of Object.keys(baseline).sort()) {
      const n = Math.min(baseline[f], counts[f] ?? 0);
      if (n > 0) next[f] = n;
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  }

  it("finds the legacy readers (the scan is live, not vacuous)", () => {
    expect(counts["src/services/sites/legacy-app.ts"]).toBeGreaterThan(0);
    expect(Object.keys(counts).length).toBeGreaterThan(20);
  });

  it("no file outside the baseline touches tenant_resources, and no baselined file touches it more", () => {
    const fresh = Object.keys(counts).filter((f) => !(f in baseline));
    const grown = Object.keys(counts)
      .filter((f) => f in baseline && counts[f] > baseline[f])
      .map((f) => `${f} (${baseline[f]} -> ${counts[f]})`);
    expect(
      [...fresh, ...grown],
      `New tenant_resources access: ${[...fresh, ...grown].join(", ")}. A workspace has many apps: resolve ` +
        "the app through services/sites/app-identity.ts (site by repo / hostname / run / webhook / Build " +
        "session / request), and read the frozen old-pipeline app only through services/sites/legacy-app.ts. " +
        "Raising the baseline needs a reviewed reason.",
    ).toEqual([]);
  });

  it("the new-flow identity paths stay off the singleton", () => {
    for (const f of [
      "src/routes/workspace/app-code.ts",
      "src/routes/workspace/website-overview.ts",
      "src/routes/webhooks/github.ts",
      "src/services/agents/repo-resolver.ts",
      "src/services/sites/app-identity.ts",
      "src/services/sites/session-site.ts",
      "src/services/sites/store.ts",
    ]) {
      expect(counts[f] ?? 0).toBe(0);
      expect(f in baseline).toBe(false);
    }
  });
});
