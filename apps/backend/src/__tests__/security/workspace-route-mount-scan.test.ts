import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_DIR = join(__dirname, "../../routes/workspace");
const indexSrc = readFileSync(join(__dirname, "../../routes/index.ts"), "utf-8");
const appSrc = readFileSync(join(__dirname, "../../app.ts"), "utf-8");
const mountSrc = `${indexSrc}\n${appSrc}`;

const VERBS = "get|post|put|patch|delete|all";

function handlerFiles(): string[] {
  return readdirSync(WORKSPACE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"));
}

function exportedRouteHandlers(src: string): string[] {
  const handlers: string[] = [];
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g)) {
    const params = m[2].split(",").map((p) => p.trim()).filter(Boolean);
    if (params.length !== 2) continue;
    if (!/^_?[a-zA-Z][a-zA-Z0-9_]*\s*:\s*Request\b/.test(params[0])) continue;
    if (!/:\s*Response\b/.test(params[1])) continue;
    handlers.push(m[1]);
  }
  return handlers;
}

function exportedChainsHolding(src: string, handler: string): string[] {
  const chains: string[] = [];
  for (const m of src.matchAll(/export\s+const\s+([a-zA-Z0-9_]+)\s*=\s*\[([^\]]*)\]/g)) {
    if (new RegExp(`\\b${handler}\\b`).test(m[2])) chains.push(m[1]);
  }
  return chains;
}

function isMounted(source: string, name: string): boolean {
  return new RegExp(`app\\.(${VERBS})\\([^;]*\\b${name}\\b`).test(source);
}

function mountedHandler(source: string, moduleSrc: string, handler: string): boolean {
  if (isMounted(source, handler)) return true;
  return exportedChainsHolding(moduleSrc, handler).some((chain) => isMounted(source, chain));
}

describe("workspace-route mount scan: every workspace route handler is registered", () => {
  it("scans a non-trivial number of workspace handlers", () => {
    const total = handlerFiles().reduce((n, f) => n + exportedRouteHandlers(readFileSync(join(WORKSPACE_DIR, f), "utf-8")).length, 0);
    expect(handlerFiles().length).toBeGreaterThan(40);
    expect(total).toBeGreaterThan(120);
  });

  it("still rejects a handler that is mounted nowhere, or imported but never registered", () => {
    expect(isMounted(mountSrc, "workspaceHandlerThatIsMountedNowhere")).toBe(false);
    const importedOnly = `import { postSitePublish } from "./workspace/site-publish";\napp.post("/api/other", authMiddleware, somethingElse);`;
    expect(isMounted(importedOnly, "postSitePublish")).toBe(false);
    expect(mountedHandler(importedOnly, "", "postSitePublish")).toBe(false);
    expect(mountedHandler(`app.post("/x", ...uploadChain);`, "export const uploadChain = [guard, postThing];", "postThing")).toBe(true);
    expect(mountedHandler(`app.post("/x", ...otherChain);`, "export const uploadChain = [guard, postThing];", "postThing")).toBe(false);
  });

  it("the scan sees the publish handler as a route handler", () => {
    const src = readFileSync(join(WORKSPACE_DIR, "site-publish.ts"), "utf-8");
    expect(exportedRouteHandlers(src)).toEqual(["postSitePublish"]);
  });

  it("every exported workspace route handler is registered in routes/index.ts or app.ts", () => {
    const violations: string[] = [];
    for (const file of handlerFiles()) {
      const src = readFileSync(join(WORKSPACE_DIR, file), "utf-8");
      for (const name of exportedRouteHandlers(src)) {
        if (!mountedHandler(mountSrc, src, name)) violations.push(`${file}: ${name}`);
      }
    }
    expect(violations, `handlers written but never mounted:\n${violations.join("\n")}`).toEqual([]);
  });
});

describe("POST /api/workspace/autopilot/sites/:site_id/publish is mounted behind auth and the refine limiter", () => {
  const PATH = "/api/workspace/autopilot/sites/:site_id/publish";

  it("is imported from the publish route module", () => {
    expect(indexSrc).toMatch(/import \{ postSitePublish \} from "\.\/workspace\/site-publish";/);
  });

  it("is registered exactly once, as POST, with authMiddleware first, then the limiter, then the handler", () => {
    const mounts = [...indexSrc.matchAll(/app\.(get|post|put|patch|delete|all|use)\(\s*"([^"]+)"\s*,([^;]*?)\);/g)].filter((m) => m[2] === PATH);
    expect(mounts).toHaveLength(1);
    expect(mounts[0][1]).toBe("post");
    const chain = mounts[0][3].split(",").map((s) => s.trim()).filter(Boolean);
    expect(chain).toEqual(["authMiddleware", "refineProductLimiter", "postSitePublish"]);
    expect(indexSrc.split("postSitePublish").length - 1).toBe(2);
    expect(appSrc).not.toContain("postSitePublish");
  });

  it("is registered after the limiter it uses is defined", () => {
    const limiter = indexSrc.indexOf("const refineProductLimiter = rateLimit(");
    expect(limiter).toBeGreaterThan(-1);
    expect(indexSrc.indexOf(`"${PATH}"`)).toBeGreaterThan(limiter);
  });

  it("no earlier route can shadow it", () => {
    const before = indexSrc.slice(0, indexSrc.indexOf(`"${PATH}"`));
    const shadows = [...before.matchAll(/app\.(post|all|use)\(\s*"([^"]+)"/g)]
      .map((m) => m[2])
      .filter((p) => p.startsWith("/api/workspace/autopilot/sites") || p === "/api/workspace/autopilot/*" || p === "/api/workspace/autopilot");
    expect(shadows).toEqual([]);
  });
});
