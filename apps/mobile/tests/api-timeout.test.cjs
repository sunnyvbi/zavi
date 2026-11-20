const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(fetchImpl) {
  const compile = (file) =>
    ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/lib", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
  const run = (code, req) => {
    const mod = { exports: {} };
    vm.runInNewContext(code, {
      module: mod, exports: mod.exports, require: req, process: { env: {} },
      fetch: fetchImpl, Headers, AbortController, setTimeout, clearTimeout, Promise, Error, TypeError,
    });
    return mod.exports;
  };
  const retry = run(compile("apiRetry.ts"), () => ({}));
  return run(compile("api.ts"), (name) => {
    if (name === "./supabase") return { supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } };
    if (name === "./tenant-claim") return { decodeActiveTenantClaim: () => null };
    if (name === "./apiRetry") return retry;
    throw new Error(`unexpected require ${name}`);
  });
}

const hang = (_url, init) =>
  new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init.signal?.aborted) fail();
    init.signal?.addEventListener("abort", fail);
  });

test("a request that never answers fails with code timeout once timeoutMs passes", async () => {
  const api = load(hang);
  await assert.rejects(api.apiFetch("/x", { method: "POST", timeoutMs: 20 }), (e) => e.code === "timeout" && e.status === 0);
});

test("a request that answers in time is returned as is", async () => {
  const api = load(async () => new Response("{}", { status: 200 }));
  const res = await api.apiFetch("/x", { timeoutMs: 1000 });
  assert.equal(res.status, 200);
});

test("the caller's own abort is not reported as a timeout", async () => {
  const api = load(hang);
  const ctrl = new AbortController();
  const p = api.apiFetch("/x", { method: "POST", timeoutMs: 1000, signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
});
