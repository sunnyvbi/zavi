import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "../../..");
const SCAN_DIRS = [join(BACKEND_ROOT, "src"), join(BACKEND_ROOT, "workers")];

function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.includes("/__tests__/");
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, acc);
    } else if (name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("unify-fleet-halt dead-switch removal guard", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d)).filter(
    (f) => !isTestFile(f),
  );

  it("scanned a non-trivial number of backend TS files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("NO backend code references the dropped set_fleet_kill RPC", () => {
    const offenders = files.filter((f) =>
      /set_fleet_kill/.test(readFileSync(f, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });

  it("NO backend code references the dropped autopilot_fleet_kill table", () => {
    const offenders = files.filter((f) =>
      /autopilot_fleet_kill/.test(readFileSync(f, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every is_fleet_halted() reader stays on the (unchanged) RPC name", () => {
    const conductorTick = readFileSync(
      join(BACKEND_ROOT, "workers/functions/conductor-tick.ts"),
      "utf-8",
    );
    expect(conductorTick).toMatch(/\.rpc\(["']is_fleet_halted["']\)/);
  });
});
