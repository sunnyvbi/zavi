import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bundleFunctions, cleanRepoPath, FunctionsBundleError, usesRequire, type RepoReader } from "../bundle";
import { ENTRY_MODULE, RUNTIME_JS, RUNTIME_MODULE } from "../runtime-source";

const repo = (files: Record<string, string>): RepoReader => ({ read: async (p) => (p in files ? files[p] : null) });

const FN = `
import { total } from "./_lib/math";
import type { Thing } from "../src/zavi/types";
export default {
  zaviFunction: 1,
  kind: "http",
  async invoke(inv: any, platform: any): Promise<Response> {
    const t: Thing = { n: total([1, 2, 3]) };
    if (inv.type === "schedule") {
      await platform.data.collection("runs").create({ at: inv.scheduled_time });
      return new Response("scheduled");
    }
    const key = await platform.secrets.get("STRIPE_SECRET_KEY");
    const undeclared = await platform.secrets.get("OTHER");
    const body = await inv.request.text();
    return Response.json({ t, key, undeclared, body, user: inv.user, url: inv.request.url, inv_header: inv.request.headers.get("x-zavi-invocation") });
  },
};
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function load(modules: Array<{ name: string; content: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "zfn-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const m of modules) {
    mkdirSync(dirname(join(dir, m.name)), { recursive: true });
    writeFileSync(join(dir, m.name), m.content);
  }
  return (await import(pathToFileURL(join(dir, ENTRY_MODULE)).href)).default as { fetch(r: Request, env: Record<string, string>, ctx: unknown): Promise<Response> };
}

describe("bundle", () => {
  it("transpiles the module graph, rewrites relative imports, and the entry serves the S8b handshake", async () => {
    const b = await bundleFunctions(
      repo({
        "functions/checkout.ts": FN,
        "functions/_lib/math.ts": "export const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);",
        "src/zavi/types.ts": "export interface Thing { n: number }",
      }),
      ["checkout"],
      ["STRIPE_SECRET_KEY"],
    );
    expect(b.mainModule).toBe(ENTRY_MODULE);
    expect(b.modules.map((m) => m.name).sort()).toEqual([ENTRY_MODULE, RUNTIME_MODULE, "functions/_lib/math.js", "functions/checkout.js"].sort());
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    const worker = await load(b.modules);
    const req = new Request("https://shop.example.com/api/fn/checkout?x=1", {
      method: "POST",
      body: "hello",
      headers: { "x-zavi-invocation": JSON.stringify({ v: 1, type: "request", kind: "http", function: "checkout", site_id: "s", invocation_id: "ray-1", user: { id: "u1", role: "user" } }) },
    });
    const res = await worker.fetch(req, { STRIPE_SECRET_KEY: "sk_test_x", OTHER: "nope" }, {});
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ t: { n: 6 }, key: "sk_test_x", body: "hello", user: { id: "u1", email: null, role: "user" }, url: "https://shop.example.com/api/fn/checkout?x=1", inv_header: null });
    expect(j.undeclared).toBeNull();
  });

  it("is deterministic for the same sources", async () => {
    const files = { "functions/a.ts": "export default { zaviFunction: 1, invoke: async () => new Response('a') };" };
    expect((await bundleFunctions(repo(files), ["a"], [])).sha256).toBe((await bundleFunctions(repo(files), ["a"], [])).sha256);
  });

  it("refuses bare / URL / escaping / node_modules imports, JSX, and missing files, all at once", async () => {
    const files = {
      "functions/a.ts": [
        'import Stripe from "stripe";',
        'import x from "https://esm.sh/x";',
        'import y from "../../etc/passwd";',
        'import z from "../node_modules/z/index.js";',
        'import w from "./missing";',
        'import v from "./view.tsx";',
        "export default { zaviFunction: 1, invoke: async () => new Response('a') };",
      ].join("\n"),
      "functions/view.tsx": "export default 1;",
    };
    try {
      await bundleFunctions(repo(files), ["a", "b"], []);
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(FunctionsBundleError);
      expect((e as FunctionsBundleError).problems.join("\n")).toContain("functions/b.ts is missing");
    }
    try {
      await bundleFunctions(repo(files), ["a"], []);
      throw new Error("expected refusal");
    } catch (e) {
      const p = (e as FunctionsBundleError).problems.join("\n");
      for (const frag of ['"stripe"', '"https://esm.sh/x"', '"../../etc/passwd"', '"../node_modules/z/index.js"', '"./missing"', '"./view.tsx"']) expect(p, frag).toContain(frag);
    }
  });

  it("refuses CommonJS require (it cannot run in an ES-module Worker)", async () => {
    const files = { "functions/a.ts": 'const x = require("./b");\nexport default { zaviFunction: 1, invoke: async () => new Response(String(x)) };', "functions/b.ts": "export const y = 1;" };
    await expect(bundleFunctions(repo(files), ["a"], [])).rejects.toThrow(/CommonJS/);
    for (const src of ['const r = require; r("./b");', '(0, require)("./b");', 'module.exports = {};', 'exports.x = 1;']) {
      expect(usesRequire("a.ts", src), src).toBe(true);
    }
    for (const src of ['const exports = {}; exports.x = 1;', 'function f(require: (s: string) => unknown) { return require("x"); }', 'const o = { require: 1 }; o.require;']) {
      expect(usesRequire("a.ts", src), src).toBe(false);
    }
  });

  it("cleanRepoPath keeps paths inside the repo", () => {
    expect(cleanRepoPath("functions/../src/a.ts")).toBe("src/a.ts");
    expect(cleanRepoPath("../a.ts")).toBeNull();
    expect(cleanRepoPath("/etc/passwd")).toBeNull();
    expect(cleanRepoPath("src/.env")).toBeNull();
    expect(cleanRepoPath("node_modules/x.js")).toBeNull();
  });
});

describe("runtime data client (inside the user worker)", () => {
  it("calls only the data origin, with stable idempotency keys per invocation", async () => {
    const b = await bundleFunctions(repo({ "functions/checkout.ts": FN.replace('kind: "http"', 'kind: "schedule"'), "functions/_lib/math.ts": "export const total = (xs: number[]) => xs.length;", "src/zavi/types.ts": "export {}" }), ["checkout"], []);
    const worker = await load(b.modules);
    const calls: Array<{ url: string; key: string | null }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string, i: RequestInit) => {
      calls.push({ url: String(u), key: new Headers(i.headers).get("idempotency-key") });
      return new Response(JSON.stringify({ data: { id: "r1" } }), { status: 201 });
    }) as typeof fetch;
    try {
      const mk = () => new Request("https://shop.example.com/__zavi/schedule/checkout", {
        method: "POST",
        headers: { "x-zavi-invocation": JSON.stringify({ v: 1, type: "schedule", kind: "schedule", function: "checkout", site_id: "s", invocation_id: "site:nightly:1790996400", scheduled_time: "2026-10-03T03:00:00Z", user: null }) },
      });
      expect(await (await worker.fetch(mk(), {}, {})).text()).toBe("scheduled");
      expect(await (await worker.fetch(mk(), {}, {})).text()).toBe("scheduled");
    } finally {
      globalThis.fetch = orig;
    }
    expect(calls.map((c) => c.url)).toEqual(["https://data.zavi.internal/api/data/runs", "https://data.zavi.internal/api/data/runs"]);
    expect(calls[0].key).toBe(calls[1].key);
    expect(calls[0].key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("transition passes expect / set through (shard 0013 CAS) and a lost race surfaces as transition_conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zfn-rt-"));
    dirs.push(dir);
    writeFileSync(join(dir, "rt.mjs"), RUNTIME_JS);
    const rt = (await import(pathToFileURL(join(dir, "rt.mjs")).href)) as {
      createDataApi(id: string, f: (u: string, i: RequestInit) => Promise<Response>): {
        collection(n: string): { transition(id: string, to: string, o?: { expect?: unknown; set?: unknown }): Promise<unknown> };
      };
    };
    const bodies: unknown[] = [];
    let status = 200;
    const api = rt.createDataApi("inv-1", async (u, i) => {
      bodies.push({ url: u, method: i.method, body: JSON.parse(String(i.body)) });
      return status === 200
        ? new Response(JSON.stringify({ data: { id: "o1", from: "open", to: "paid", transitioned: true } }), { status })
        : new Response(JSON.stringify({ error: { code: "transition_conflict" } }), { status });
    });
    const orders = api.collection("orders");
    await orders.transition("o1", "paid", { expect: { session_id: "cs_1", amount: 500 } });
    await orders.transition("o1", "checkout_open", { expect: { session_id: "claim" }, set: { session_id: "cs_2" } });
    await orders.transition("o1", "pending");
    expect(bodies).toEqual([
      { url: "https://data.zavi.internal/api/data/orders/o1/transition", method: "POST", body: { to: "paid", expect: { session_id: "cs_1", amount: 500 } } },
      { url: "https://data.zavi.internal/api/data/orders/o1/transition", method: "POST", body: { to: "checkout_open", expect: { session_id: "claim" }, set: { session_id: "cs_2" } } },
      { url: "https://data.zavi.internal/api/data/orders/o1/transition", method: "POST", body: { to: "pending" } },
    ]);
    status = 409;
    const err = (await orders.transition("o1", "paid", { expect: { session_id: "x" } }).catch((e) => e)) as { status: number; code: string; reason: string };
    expect([err.status, err.code, err.reason]).toEqual([409, "transition_conflict", "transition_conflict"]);
  });

  it("a file whose kind differs from the manifest's never runs (a webhook must verify its sender)", async () => {
    const b = await bundleFunctions(repo({ "functions/hook.ts": "export default { zaviFunction: 1, kind: \"http\", async invoke() { return new Response(\"ran\"); } };" }), ["hook"], []);
    const worker = await load(b.modules);
    const meta = (kind: string) => ({ "x-zavi-invocation": JSON.stringify({ v: 1, type: "request", kind, function: "hook", site_id: "s", invocation_id: "r", user: null }) });
    const res = await worker.fetch(new Request("https://x.example.com/api/hooks/hook", { method: "POST", headers: meta("webhook") }), {}, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "function_kind_mismatch" } });
    expect(await (await worker.fetch(new Request("https://x.example.com/api/fn/hook", { method: "POST", headers: meta("http") }), {}, {})).text()).toBe("ran");
  });

  it("a module without the Zavi default export is a clear 500, not a crash", async () => {
    const b = await bundleFunctions(repo({ "functions/a.ts": "export default { hello: 1 };" }), ["a"], []);
    const worker = await load(b.modules);
    const res = await worker.fetch(new Request("https://x.example.com/api/fn/a", { headers: { "x-zavi-invocation": JSON.stringify({ v: 1, type: "request", function: "a" }) } }), {}, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "function_invalid_export" } });
    const none = await worker.fetch(new Request("https://x.example.com/api/fn/a"), {}, {});
    expect(none.status).toBe(400);
  });
});
