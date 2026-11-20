
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS_DIR = join(__dirname, "..");
const INDEX_FILE = join(FUNCTIONS_DIR, "index.ts");

const NON_REGISTERED_FN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
]);

function workerSourceFiles(): string[] {
  return readdirSync(FUNCTIONS_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        f !== "index.ts",
    )
    .sort();
}

function discoverDefinedFns(): Map<string, string> {
  const found = new Map<string, string>();
  const direct =
    /export\s+const\s+([A-Za-z0-9_]+Fn)\s*=\s*inngest\.createFunction\(/g;
  const fnDecl = /function\s+([A-Za-z0-9_]+)\s*\(/g;
  const factoryReturn = /return\s+inngest\.createFunction\(/g;
  const factoryCall =
    /export\s+const\s+([A-Za-z0-9_]+Fn)\s*=\s*([A-Za-z0-9_]+)\s*\(/g;
  for (const file of workerSourceFiles()) {
    const src = readFileSync(join(FUNCTIONS_DIR, file), "utf8");
    for (const match of src.matchAll(direct)) {
      found.set(match[1], file);
    }
    const decls = [...src.matchAll(fnDecl)];
    const factories = new Set<string>();
    for (const ret of src.matchAll(factoryReturn)) {
      let name: string | undefined;
      for (const d of decls) {
        if (d.index! < ret.index!) name = d[1];
        else break;
      }
      if (name) factories.add(name);
    }
    if (factories.size > 0) {
      for (const match of src.matchAll(factoryCall)) {
        if (factories.has(match[2])) found.set(match[1], file);
      }
    }
  }
  return found;
}

function discoverRegisteredFns(): Set<string> {
  const src = readFileSync(INDEX_FILE, "utf8");
  const start = src.indexOf("inngestFunctions = [");
  expect(start, "could not find `inngestFunctions = [` in index.ts").toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  const close = src.indexOf("];", open);
  expect(close, "could not find closing `];` of inngestFunctions array").toBeGreaterThan(open);
  const body = src.slice(open + 1, close);
  const names = new Set<string>();
  for (const raw of body.split(",")) {
    const tok = raw.trim();
    if (tok && /^[A-Za-z0-9_]+$/.test(tok)) names.add(tok);
  }
  return names;
}

describe("worker-registry completeness", () => {
  const defined = discoverDefinedFns();
  const definedNames = new Set(defined.keys());
  const registered = discoverRegisteredFns();

  it("discovers a non-trivial number of worker functions (scan sanity)", () => {
    expect(definedNames.size).toBeGreaterThanOrEqual(30);
    expect(registered.size).toBeGreaterThanOrEqual(30);
  });

  it("every exported *Fn (inngest.createFunction) is in the inngestFunctions array", () => {
    const missing = [...definedNames]
      .filter((name) => !registered.has(name))
      .filter((name) => !NON_REGISTERED_FN_ALLOWLIST.has(name));
    expect(
      missing,
      missing.length === 0
        ? ""
        : `These Inngest functions are DEFINED but NOT REGISTERED — their events ` +
            `will silently drop on the floor (PUT-after-deploy drop-on-floor class). ` +
            `Add each to the \`inngestFunctions\` array in ` +
            `apps/backend/workers/functions/index.ts (and import it):\n` +
            missing.map((n) => `  - ${n}  (defined in ${defined.get(n)})`).join("\n"),
    ).toEqual([]);
  });

  it("every name in the inngestFunctions array is a real exported *Fn (no dangling/typo entry)", () => {
    const dangling = [...registered].filter((name) => !definedNames.has(name));
    expect(
      dangling,
      dangling.length === 0
        ? ""
        : `These names are in the \`inngestFunctions\` array but no matching ` +
            `exported \`export const X = inngest.createFunction(\` was found in ` +
            `workers/functions/*.ts (typo, renamed, or deleted fn):\n` +
            dangling.map((n) => `  - ${n}`).join("\n"),
    ).toEqual([]);
  });

  it("every allow-list entry is actually a defined *Fn (no stale exemptions)", () => {
    const stale = [...NON_REGISTERED_FN_ALLOWLIST].filter(
      (name) => !definedNames.has(name),
    );
    expect(
      stale,
      `NON_REGISTERED_FN_ALLOWLIST contains names that are no longer defined ` +
        `*Fn consts — remove the stale exemption: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("the defined and registered sets are exactly equal (modulo allow-list)", () => {
    const expectedRegistered = new Set(
      [...definedNames].filter((n) => !NON_REGISTERED_FN_ALLOWLIST.has(n)),
    );
    expect([...registered].sort()).toEqual([...expectedRegistered].sort());
  });
});
