import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STAFF_DIR = join(__dirname, "../../routes/admin");

const NON_HANDLER_FILES = new Set(["index.ts"]);

const indexSrc = readFileSync(join(STAFF_DIR, "index.ts"), "utf-8");

function handlerFiles(): string[] {
  return readdirSync(STAFF_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => !NON_HANDLER_FILES.has(f));
}

function exportedRouteHandlers(file: string): string[] {
  const src = readFileSync(join(STAFF_DIR, file), "utf-8");
  const matches = src.matchAll(
    /export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g,
  );
  const handlers: string[] = [];
  for (const m of matches) {
    const name = m[1];
    const params = m[2];
    if (/^\s*_?[a-zA-Z][a-zA-Z0-9_]*\s*:\s*Request\b/.test(params)) {
      handlers.push(name);
    }
  }
  return handlers;
}

describe("staff-route mount scan — every staff route is under staffMiddleware()", () => {
  it("scans a non-trivial number of staff handler files (sanity)", () => {
    expect(handlerFiles().length).toBeGreaterThan(15);
  });

  it("adminRouter applies r.use(staffMiddleware()) BEFORE any route registration", () => {
    const bodyMatch = indexSrc.match(/export function adminRouter\(\)\s*:\s*Router\s*\{([\s\S]*)\n\}/);
    expect(bodyMatch, "could not locate adminRouter() body").not.toBeNull();
    const body = bodyMatch![1];

    const guardIdx = body.search(/\.use\(\s*staffMiddleware\(\)\s*\)/);
    expect(guardIdx, "adminRouter must call r.use(staffMiddleware())").toBeGreaterThanOrEqual(0);

    const firstRouteIdx = body.search(/\br\.(get|post|put|patch|delete)\s*\(/);
    expect(firstRouteIdx, "adminRouter registers no routes?").toBeGreaterThanOrEqual(0);
    expect(
      guardIdx,
      "staffMiddleware() guard must be applied BEFORE any route is registered (else early routes are un-gated)",
    ).toBeLessThan(firstRouteIdx);
  });

  it("EVERY exported staff ROUTE HANDLER is registered under the router (no orphaned/un-gated route)", () => {
    const violations: string[] = [];
    let totalRouteHandlers = 0;
    for (const file of handlerFiles()) {
      const handlers = exportedRouteHandlers(file);
      totalRouteHandlers += handlers.length;
      for (const name of handlers) {
        const importedOrUsed = new RegExp(`\\b${name}\\b`).test(indexSrc);
        if (!importedOrUsed) {
          violations.push(`${file} -> ${name} (exported route handler not referenced in staff/index.ts)`);
          continue;
        }
        const registered = new RegExp(`r\\.(get|post|put|patch|delete)\\([^)]*\\b${name}\\b`).test(indexSrc);
        if (!registered) {
          violations.push(`${file} -> ${name} (imported but NOT registered under r.<verb>() — un-mounted)`);
        }
      }
    }

    expect(
      totalRouteHandlers,
      "handler-detection found NO route handlers — the (req: Request,...) signal regressed",
    ).toBeGreaterThan(20);

    expect(
      violations,
      `STAFF-ROUTE MOUNT VIOLATION — these staff route handlers are not mounted under the ` +
        `staffMiddleware() guard in routes/admin/index.ts. A handler not registered here ` +
        `(or wired into a different router) would be an un-gated admin endpoint:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("anti-vacuous: the staffMiddleware import is present in index.ts", () => {
    expect(indexSrc).toMatch(
      /import\s*\{[^}]*\bstaffMiddleware\b[^}]*\}\s*from\s*["'`]@\/services\/auth\/staff-middleware["'`]/,
    );
  });
});
