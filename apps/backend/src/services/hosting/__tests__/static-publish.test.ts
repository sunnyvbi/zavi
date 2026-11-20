import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => { throw new Error("no db in this test"); } }));

import {
  isStaticEligible,
  nextConfigOverridePlan,
  publishStatic,
  resetStaticNotConfiguredWarning,
  STATIC_SUPERSEDED,
  staticHostingConfig,
  STATIC_UPLOAD_CONCURRENCY,
} from "../static-publish";
import { FULL_ENV, FakeCloudflare, FakeSandbox } from "./static-fakes";

const HOST = "acme-1234abcd.zaviagent.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DEPLOY = "dtest-1";
const DIR = `/tmp/static-${DEPLOY}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
const WOFF = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xc3, 0x28]);

function deps(cf: FakeCloudflare, extra: Record<string, unknown> = {}) {
  return {
    env: FULL_ENV,
    fetchFn: cf.fetch,
    newDeployId: () => DEPLOY,
    now: () => 1_700_000_000_000,
    sleep: async () => undefined,
    verifyAttempts: 3,
    ...extra,
  };
}

function seed(sb: FakeSandbox): void {
  sb.files.set(`${DIR}/out/index.html`, "<html>home</html>");
  sb.files.set(`${DIR}/out/about/index.html`, "<html>about</html>");
  sb.files.set(`${DIR}/out/_next/static/chunks/main-abc.js`, "console.log(1)");
  sb.files.set(`${DIR}/out/_next/static/css/app.css`, "body{}");
  sb.files.set(`${DIR}/out/logo.png`, PNG);
  sb.files.set(`${DIR}/out/fonts/inter.woff2`, WOFF.toString("base64"));
  sb.files.set(`${DIR}/out/404.html`, "<html>nf</html>");
}

const input = (sb: FakeSandbox) => ({ tenant_id: "t-1", hostname: HOST, repo_full_name: "zavi-apps/acme", sha: SHA, sandbox: sb });

describe("staticHostingConfig", () => {
  it("is ok only when every env var is set", () => {
    expect(staticHostingConfig(FULL_ENV).ok).toBe(true);
    for (const key of Object.keys(FULL_ENV)) {
      const missing = staticHostingConfig({ ...FULL_ENV, [key]: undefined });
      expect(missing).toEqual({ ok: false, reason: "not_configured", missing: [key] });
      expect(staticHostingConfig({ ...FULL_ENV, [key]: "   " }).ok).toBe(false);
    }
  });
});

describe("isStaticEligible", () => {
  const on = async () => true;
  const base = { tenant_id: "t-1", hasDatabase: false, files: ["app/page.tsx", "app/layout.tsx", "package.json"] };

  it("is eligible for a plain static repo and checks the flag for that tenant", async () => {
    const flag = vi.fn(on);
    expect(await isStaticEligible(base, { env: FULL_ENV, flagEnabled: flag })).toEqual({ eligible: true });
    expect(flag).toHaveBeenCalledWith("t-1");
  });

  it("is ineligible when the flag is off even if everything else passes", async () => {
    expect(await isStaticEligible(base, { env: FULL_ENV, flagEnabled: async () => false })).toEqual({ eligible: false, reason: "flag_off" });
  });

  it("is ineligible when not configured", async () => {
    const r = await isStaticEligible(base, { env: { ...FULL_ENV, ZAVI_STATIC_WORKER_NAME: "" }, flagEnabled: on });
    expect(r).toEqual({ eligible: false, reason: "not_configured" });
  });

  it("flag on with no Cloudflare env falls back to Render: ineligible, no sandbox call, one warning with key names only", async () => {
    resetStaticNotConfiguredWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sandbox = { run: vi.fn(), readFile: vi.fn() };
    try {
      for (let i = 0; i < 3; i++) {
        const r = await isStaticEligible({ tenant_id: "t-1", hasDatabase: false, sandbox: sandbox as never }, { env: {}, flagEnabled: on });
        expect(r).toEqual({ eligible: false, reason: "not_configured" });
      }
      expect(sandbox.run).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("CLOUDFLARE_STATIC_API_TOKEN");
      expect(String(warn.mock.calls[0][0])).toContain("publishing on Render");
    } finally {
      warn.mockRestore();
    }
  });

  it("is ineligible when a database is provisioned", async () => {
    expect(await isStaticEligible({ ...base, hasDatabase: true }, { env: FULL_ENV, flagEnabled: on })).toEqual({ eligible: false, reason: "has_database" });
  });

  it.each([
    ["app/api/health/route.ts", "api_routes"],
    ["src/app/api/x/route.js", "api_routes"],
    ["pages/api/hello.ts", "api_routes"],
    ["middleware.ts", "middleware"],
    ["src/middleware.js", "middleware"],
    ["app/feed.xml/route.ts", "route_handlers"],
  ])("is ineligible when the repo has %s", async (file, reason) => {
    const r = await isStaticEligible({ ...base, files: [...base.files, file] }, { env: FULL_ENV, flagEnabled: on });
    expect(r).toEqual({ eligible: false, reason });
  });

  it("ignores server-looking paths inside node_modules", async () => {
    const r = await isStaticEligible({ ...base, files: [...base.files, "node_modules/x/app/api/a.ts", "node_modules/y/middleware.js"] }, { env: FULL_ENV, flagEnabled: on });
    expect(r).toEqual({ eligible: true });
  });

  it("is ineligible when a source file declares \"use server\"", async () => {
    const sb = new FakeSandbox();
    sb.grepHits = "./app/actions.ts\n";
    const r = await isStaticEligible({ ...base, sandbox: sb }, { env: FULL_ENV, flagEnabled: on });
    expect(r).toEqual({ eligible: false, reason: "server_actions" });
    expect(sb.runs.find((c) => c.cmd.startsWith("grep"))?.cwd).toBe("/home/user/repo");
  });

  it("lists repo files through the sandbox when none are passed", async () => {
    const sb = new FakeSandbox();
    sb.lsFiles = "app/page.tsx\nmiddleware.ts\n";
    const r = await isStaticEligible({ tenant_id: "t-1", hasDatabase: false, sandbox: sb }, { env: FULL_ENV, flagEnabled: on });
    expect(r).toEqual({ eligible: false, reason: "middleware" });
  });
});

describe("publishStatic", () => {
  let cf: FakeCloudflare;
  let sb: FakeSandbox;
  beforeEach(() => {
    cf = new FakeCloudflare();
    sb = new FakeSandbox();
    seed(sb);
  });

  it("returns not_configured without touching the sandbox or Cloudflare", async () => {
    const r = await publishStatic(input(sb), deps(cf, { env: { ...FULL_ENV, CLOUDFLARE_STATIC_API_TOKEN: undefined } }));
    expect(r).toEqual({ ok: false, stage: "build", error: "not_configured" });
    expect(sb.runs).toHaveLength(0);
    expect(cf.calls).toHaveLength(0);
  });

  it("does not flip KV when beforeFlip says a newer commit owns the site", async () => {
    const r = await publishStatic({ ...input(sb), beforeFlip: async () => false }, deps(cf));
    expect(r).toEqual({ ok: false, stage: "flip", error: STATIC_SUPERSEDED });
    expect(cf.calls.some((c) => c.url.includes("/storage/kv/"))).toBe(false);
    expect(cf.kv.has(`host:${HOST}`)).toBe(false);
  });

  it("refuses a sha that could inject shell", async () => {
    const r = await publishStatic({ ...input(sb), sha: "main; rm -rf /" }, deps(cf));
    expect(r.ok).toBe(false);
    expect(sb.runs).toHaveLength(0);
  });

  it("uploads every exported file with the right key, bytes and type, then flips KV once after all uploads", async () => {
    const r = await publishStatic(input(sb), deps(cf));
    expect(r).toEqual({ ok: true, deploy_id: DEPLOY, file_count: 7, ms: 0 });

    const prefix = `sites/${HOST}/${DEPLOY}/`;
    expect([...cf.r2.keys()].sort()).toEqual(
      [
        "404.html",
        "_next/static/chunks/main-abc.js",
        "_next/static/css/app.css",
        "about/index.html",
        "fonts/inter.woff2",
        "index.html",
        "logo.png",
      ].map((k) => prefix + k),
    );
    expect(cf.r2.get(`${prefix}index.html`)?.contentType).toBe("text/html; charset=utf-8");
    expect(cf.r2.get(`${prefix}index.html`)?.body.toString()).toBe("<html>home</html>");
    expect(cf.r2.get(`${prefix}_next/static/chunks/main-abc.js`)?.contentType).toBe("application/javascript; charset=utf-8");
    expect(cf.r2.get(`${prefix}_next/static/css/app.css`)?.contentType).toBe("text/css; charset=utf-8");
    expect(cf.r2.get(`${prefix}logo.png`)?.contentType).toBe("image/png");
    expect(cf.r2.get(`${prefix}logo.png`)?.body.equals(PNG)).toBe(true);
    expect(cf.r2.get(`${prefix}fonts/inter.woff2`)?.contentType).toBe("font/woff2");
    expect(cf.r2.get(`${prefix}fonts/inter.woff2`)?.body.equals(WOFF)).toBe(true);

    const kvPuts = cf.calls.filter((c) => c.method === "PUT" && c.url.includes("/storage/kv/"));
    expect(kvPuts).toHaveLength(1);
    expect(decodeURIComponent(kvPuts[0].url.split("/values/")[1])).toBe(`host:${HOST}`);
    const lastUpload = Math.max(...[...cf.r2.values()].map((o) => o.seq));
    expect(kvPuts[0].seq).toBeGreaterThan(lastUpload);
    expect(JSON.parse(cf.kv.get(`host:${HOST}`) ?? "{}")).toEqual({
      deploy_id: DEPLOY,
      sha: SHA,
      tenant_id: "t-1",
      published_at: new Date(1_700_000_000_000).toISOString(),
    });
    const verify = cf.calls.filter((c) => c.url === `https://${HOST}/`);
    expect(verify).toHaveLength(1);
    expect(verify[0].seq).toBeGreaterThan(kvPuts[0].seq);
    expect(cf.calls.every((c) => !c.url.startsWith("https://api.cloudflare.com") || c.headers.Authorization === "Bearer tok1")).toBe(true);

    const cmds = sb.runs.map((c) => c.cmd);
    expect(cmds[0]).toContain(`git -C /home/user/repo archive ${SHA} | tar -x -C ${DIR}`);
    expect(sb.runs.find((c) => c.cmd.startsWith("npm ci"))).toEqual({ cmd: "npm ci --prefer-offline --no-audit --no-fund", cwd: DIR });
    expect(sb.runs.find((c) => c.cmd.includes("next build"))?.cwd).toBe(DIR);
    expect(sb.runs.find((c) => c.cmd.includes("next.config.static.mjs"))?.cwd).toBe(DIR);
    expect(cmds.findIndex((c) => c.includes("next.config.static.mjs"))).toBeLessThan(cmds.findIndex((c) => c.includes("next build")));
    expect(cmds[cmds.length - 1]).toBe(`rm -rf ${DIR}`);
    expect(cmds.some((c) => c.includes("node_modules") && c.includes("ln "))).toBe(false);
  });

  it("never runs more than 8 uploads at once", async () => {
    for (let i = 0; i < 40; i++) sb.files.set(`${DIR}/out/_next/static/chunks/c${i}.js`, `x${i}`);
    cf.uploadDelayMs = 3;
    const r = await publishStatic(input(sb), deps(cf));
    expect(r.ok).toBe(true);
    expect(cf.r2.size).toBe(47);
    expect(cf.maxInFlight).toBe(STATIC_UPLOAD_CONCURRENCY);
  });

  it("does not flip KV when one upload fails, and leaves the live deploy untouched", async () => {
    const live = JSON.stringify({ deploy_id: "old", sha: "aaa", tenant_id: "t-1", published_at: "x" });
    cf.kv.set(`host:${HOST}`, live);
    for (let i = 0; i < 30; i++) sb.files.set(`${DIR}/out/_next/static/chunks/c${i}.js`, `x${i}`);
    cf.failUploadKey = (k) => k.endsWith("/logo.png");
    const r = await publishStatic(input(sb), deps(cf));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.stage).toBe("upload");
    expect(r.error).toContain("logo.png");
    expect(cf.calls.filter((c) => c.url.includes("/storage/kv/") && c.method !== "GET")).toHaveLength(0);
    expect(cf.kv.get(`host:${HOST}`)).toBe(live);
    expect(cf.calls.filter((c) => c.url === `https://${HOST}/`)).toHaveLength(0);
    expect(sb.runs[sb.runs.length - 1].cmd).toBe(`rm -rf ${DIR}`);
  });

  it("does not flip KV when a file cannot be read from the sandbox", async () => {
    const orig = sb.readFile.bind(sb);
    sb.readFile = async (p: string) => (p.endsWith("about/index.html") ? Promise.reject(new Error("gone")) : orig(p));
    const r = await publishStatic(input(sb), deps(cf));
    expect(r).toMatchObject({ ok: false, stage: "upload" });
    expect(cf.kv.size).toBe(0);
  });

  it.each(["archive", "npm", "build"] as const)("a %s failure is stage build with no uploads", async (step) => {
    sb.fail[step] = { exitCode: 1, stdout: "", stderr: `${step} exploded` };
    const r = await publishStatic(input(sb), deps(cf));
    expect(r).toMatchObject({ ok: false, stage: "build" });
    if (!r.ok) expect(r.error).toContain(`${step} exploded`);
    expect(cf.calls).toHaveLength(0);
    expect(sb.runs[sb.runs.length - 1].cmd).toBe(`rm -rf ${DIR}`);
  });

  it("a build with no out/ or no index.html is stage export with no uploads", async () => {
    sb.fail.list = { exitCode: 1, stdout: "", stderr: "" };
    expect(await publishStatic(input(sb), deps(cf))).toMatchObject({ ok: false, stage: "export" });
    const sb2 = new FakeSandbox();
    sb2.files.set(`${DIR}/out/about.html`, "x");
    expect(await publishStatic(input(sb2), deps(cf))).toMatchObject({ ok: false, stage: "export" });
    expect(cf.calls).toHaveLength(0);
  });

  it("a KV read failure stops before the flip", async () => {
    cf.kvReadStatus = 500;
    const r = await publishStatic(input(sb), deps(cf));
    expect(r).toMatchObject({ ok: false, stage: "flip" });
    expect(cf.calls.filter((c) => c.url.includes("/storage/kv/") && c.method !== "GET")).toHaveLength(0);
  });

  it("a verify failure restores the previous KV value exactly", async () => {
    const live = JSON.stringify({ deploy_id: "old", sha: "aaa", tenant_id: "t-1", published_at: "x" });
    cf.kv.set(`host:${HOST}`, live);
    cf.site = () => ({ status: 404, headers: { get: () => "text/html" }, text: async () => "not published" });
    const r = await publishStatic(input(sb), deps(cf));
    expect(r).toMatchObject({ ok: false, stage: "verify" });
    expect(cf.calls.filter((c) => c.url === `https://${HOST}/`)).toHaveLength(3);
    const kvWrites = cf.calls.filter((c) => c.url.includes("/storage/kv/") && c.method === "PUT");
    expect(kvWrites).toHaveLength(2);
    expect(JSON.parse(String(kvWrites[0].body)).deploy_id).toBe(DEPLOY);
    expect(cf.kv.get(`host:${HOST}`)).toBe(live);
  });

  it("a verify that returns non-HTML fails and deletes the key when there was no previous deploy", async () => {
    cf.site = () => ({ status: 200, headers: { get: () => "application/json" }, text: async () => "{}" });
    const r = await publishStatic(input(sb), deps(cf));
    expect(r).toMatchObject({ ok: false, stage: "verify" });
    expect(cf.kv.has(`host:${HOST}`)).toBe(false);
    expect(cf.calls.filter((c) => c.url.includes("/storage/kv/") && c.method === "DELETE")).toHaveLength(1);
  });

  it("a verify that recovers on a later attempt succeeds without restoring", async () => {
    let n = 0;
    cf.site = () =>
      ++n < 3
        ? { status: 404, headers: { get: () => null }, text: async () => "" }
        : {
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "content-type"
                  ? "text/html"
                  : name.toLowerCase() === "x-zavi-deploy-id"
                    ? DEPLOY
                    : null,
            },
            text: async () => "<html>",
          };
    const r = await publishStatic(input(sb), deps(cf));
    expect(r.ok).toBe(true);
    expect(JSON.parse(cf.kv.get(`host:${HOST}`) ?? "{}").deploy_id).toBe(DEPLOY);
  });
});

describe("nextConfigOverridePlan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "static-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function loadResult(target: string): Promise<Record<string, unknown>> {
    const mod = (await import(pathToFileURL(join(dir, target)).href + `?t=${Math.random()}`)) as { default: (p: string, c: unknown) => Promise<Record<string, unknown>> };
    return mod.default("phase-production-build", { defaultConfig: {} });
  }

  it("wraps an ESM function config without editing it and forces export + unoptimized images", async () => {
    const original = `export default async (phase) => ({ reactStrictMode: true, output: "standalone", images: { remotePatterns: [{ hostname: "cdn.x" }] }, env: { PHASE: phase } });\n`;
    writeFileSync(join(dir, "next.config.mjs"), original);
    writeFileSync(join(dir, "next.config.ts"), "export default {}");
    const plan = nextConfigOverridePlan(["package.json", "next.config.mjs", "next.config.ts"]);
    execFileSync("bash", ["-c", plan.script], { cwd: dir });
    expect(readFileSync(join(dir, "next.config.original.mjs"), "utf8")).toBe(original);
    expect(() => readFileSync(join(dir, "next.config.ts"))).toThrow();
    const cfg = await loadResult(plan.target);
    expect(cfg).toEqual({
      reactStrictMode: true,
      output: "export",
      images: { remotePatterns: [{ hostname: "cdn.x" }], unoptimized: true },
      env: { PHASE: "phase-production-build" },
    });
  });

  it("wraps a CommonJS next.config.js object", async () => {
    writeFileSync(join(dir, "next.config.js"), `module.exports = { trailingSlash: false, images: { domains: ["a"] } };\n`);
    writeFileSync(join(dir, "package.json"), `{"name":"x"}`);
    const plan = nextConfigOverridePlan(["next.config.js", "package.json"]);
    expect(plan.target).toBe("next.config.mjs");
    execFileSync("bash", ["-c", plan.script], { cwd: dir });
    expect(await loadResult(plan.target)).toEqual({ trailingSlash: false, output: "export", images: { domains: ["a"], unoptimized: true } });
  });

  it("writes a fresh config when the repo has none", async () => {
    const plan = nextConfigOverridePlan(["package.json"]);
    execFileSync("bash", ["-c", plan.script], { cwd: dir });
    expect(await loadResult(plan.target)).toEqual({ output: "export", images: { unoptimized: true } });
  });

  it("keeps a TypeScript config as TypeScript importing the renamed original", () => {
    const plan = nextConfigOverridePlan(["next.config.ts"]);
    expect(plan.target).toBe("next.config.ts");
    expect(plan.script).toContain("mv next.config.ts next.config.original.ts");
    const b64 = plan.script.match(/printf '%s' '([^']+)'/)?.[1] ?? "";
    expect(Buffer.from(b64, "base64").toString()).toContain(`import base from "./next.config.original";`);
  });
});
