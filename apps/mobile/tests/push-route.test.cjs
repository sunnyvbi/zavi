const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/pushRoute.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
const { pushTarget } = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("a reply or approval opens its chat thread", () => {
  assert.deepEqual(plain(pushTarget({ type: "agent_reply", thread_id: "t1" })), {
    pathname: "/chat",
    params: { thread_id: "t1" },
  });
  assert.deepEqual(plain(pushTarget({ type: "approval", thread_id: null })), { pathname: "/chat" });
});

test("a specialist agent's reply opens that agent's thread", () => {
  assert.deepEqual(plain(pushTarget({ type: "agent_reply", thread_id: "t1", agent_slug: "engineer" })), {
    pathname: "/chat",
    params: { thread_id: "t1", slug: "engineer" },
  });
  assert.deepEqual(plain(pushTarget({ type: "agent_reply", thread_id: "t1", agent_slug: null })), {
    pathname: "/chat",
    params: { thread_id: "t1" },
  });
});

test("growth lead and result milestone open the Growth page, even with a thread", () => {
  assert.deepEqual(plain(pushTarget({ type: "growth_lead", thread_id: "t1" })), { pathname: "/growth" });
  assert.deepEqual(plain(pushTarget({ type: "result_milestone" })), { pathname: "/growth" });
  assert.deepEqual(plain(pushTarget({ type: "growth_lead", thread_id: "t1", agent_slug: "growth-lead" })), {
    pathname: "/growth",
  });
});

test("a broken connector opens Connectors", () => {
  assert.deepEqual(plain(pushTarget({ type: "connector_broke" })), { pathname: "/toolkit" });
});

test("a missing or unknown type falls back to the chat", () => {
  assert.deepEqual(plain(pushTarget(undefined)), { pathname: "/chat" });
  assert.deepEqual(plain(pushTarget({ type: "something_new", thread_id: "t2" })), {
    pathname: "/chat",
    params: { thread_id: "t2" },
  });
});
