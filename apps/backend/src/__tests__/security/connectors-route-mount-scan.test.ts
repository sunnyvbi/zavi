import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONNECTORS_DIR = join(__dirname, "../../routes/connectors");
const INDEX_PATH = join(__dirname, "../../routes/index.ts");
const APP_PATH = join(__dirname, "../../app.ts");

const indexSrc = readFileSync(INDEX_PATH, "utf-8");
const appSrc = readFileSync(APP_PATH, "utf-8");

const mountSrc = `${indexSrc}\n${appSrc}`;

function handlerFiles(): string[] {
  return readdirSync(CONNECTORS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"));
}

function exportedRouteHandlers(file: string): string[] {
  const src = readFileSync(join(CONNECTORS_DIR, file), "utf-8");
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

describe("connector-route mount scan — every connector route is registered", () => {
  it("scans a non-trivial number of connector handler files (sanity)", () => {
    expect(handlerFiles().length).toBeGreaterThan(15);
  });

  it("still rejects a handler that is mounted in NEITHER file (anti-vacuity)", () => {
    const ghost = "connectorHandlerThatIsMountedNowhere";
    expect(new RegExp(`\\b${ghost}\\b`).test(mountSrc)).toBe(false);
    expect(
      new RegExp(`app\\.(get|post|put|patch|delete)\\([^;]*\\b${ghost}\\b`).test(
        mountSrc,
      ),
    ).toBe(false);
  });

  it("recognises metaAdsDeauthorize, which mounts in app.ts, as registered", () => {
    expect(
      new RegExp(
        `app\\.(get|post|put|patch|delete)\\([^;]*\\bmetaAdsDeauthorize\\b`,
      ).test(mountSrc),
      "metaAdsDeauthorize is mounted in app.ts with its own rate limiter + body parsers",
    ).toBe(true);
  });

  it("recognises mobileReturnMiddleware, which mounts with app.use, as registered", () => {
    expect(
      new RegExp(`app\\.(get|post|put|patch|delete|use)\\([^;]*\\bmobileReturnMiddleware\\b`).test(mountSrc),
      "mobileReturnMiddleware is mounted with app.use(\"/api/connectors\", ...)",
    ).toBe(true);
  });

  it("EVERY exported connector ROUTE HANDLER is registered in routes/index.ts or app.ts (no dead route)", () => {
    const violations: string[] = [];
    let totalRouteHandlers = 0;
    for (const file of handlerFiles()) {
      const handlers = exportedRouteHandlers(file);
      totalRouteHandlers += handlers.length;
      for (const name of handlers) {
        const importedOrUsed = new RegExp(`\\b${name}\\b`).test(mountSrc);
        if (!importedOrUsed) {
          violations.push(
            `${file} -> ${name} (exported route handler not referenced in routes/index.ts or app.ts)`,
          );
          continue;
        }
        const registered = new RegExp(
          `app\\.(get|post|put|patch|delete|use)\\([^;]*\\b${name}\\b`,
        ).test(mountSrc);
        if (!registered) {
          violations.push(
            `${file} -> ${name} (imported but NOT registered under app.<verb>() — dead route, will 404)`,
          );
        }
      }
    }

    expect(
      totalRouteHandlers,
      "handler-detection found too few route handlers — the (req: Request,...) signal regressed",
    ).toBeGreaterThan(40);

    expect(
      violations,
      `CONNECTOR-ROUTE MOUNT VIOLATION — these connector route handlers are not ` +
        `registered in routes/index.ts or app.ts. A handler not registered is a DEAD ` +
        `endpoint: any frontend call to it returns Express's default 404:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    ).toEqual([]);
  });
});

describe("route contract — POST /api/connectors/github/disconnect", () => {
  it("is registered with the POST verb on the exact path the frontend calls", () => {
    expect(
      indexSrc,
      "routes/index.ts must register POST /api/connectors/github/disconnect — " +
        "the GitHub card's Disconnect button calls exactly this method+path",
    ).toMatch(
      /app\.post\(\s*["'`]\/api\/connectors\/github\/disconnect["'`][^;]*githubDisconnect/,
    );
  });
});

describe("route contract — POST /api/connectors/meta-ads/disconnect", () => {
  it("is registered with the POST verb on the exact path the frontend calls", () => {
    expect(
      indexSrc,
      "routes/index.ts must register POST /api/connectors/meta-ads/disconnect — " +
        "the Meta Ads tile's Disconnect menu item calls exactly this method+path",
    ).toMatch(
      /app\.post\(\s*["'`]\/api\/connectors\/meta-ads\/disconnect["'`][^;]*metaAdsDisconnect/,
    );
  });
});
