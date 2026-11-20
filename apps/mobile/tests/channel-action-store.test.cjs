const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const MOBILE = path.join(__dirname, "..");
const REPO = path.join(MOBILE, "..", "..");

function compile(file) {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

function mountChannelsApi() {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(
    compile(path.join(MOBILE, "src/features/channels/api.ts")),
    {
      module,
      exports: module.exports,
      console,
      require(name) {
        if (name === "../../lib/api") {
          return {
            async apiJson(p, opts) {
              calls.push({ path: p, method: opts?.method, body: opts?.body });
              return {};
            },
          };
        }
        if (name === "@zavi/shared") {
          return { isCustomerChannelAction: () => true };
        }
        throw new Error(`Unexpected dependency: ${name}`);
      },
    },
    { filename: "api.ts" },
  );
  return { api: module.exports, calls };
}

test("mark complete on a channel_actions card writes to the channel-actions route", async () => {
  const { api, calls } = mountChannelsApi();
  await api.approveAction("a-1", undefined, "channel_action");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/channel-actions/a-1");
  assert.equal(calls[0].method, "POST");
  assert.equal(JSON.parse(calls[0].body).action, "acted");
});

const SET_BODY_MIN = (() => {
  const src = fs.readFileSync(path.join(REPO, "apps/backend/src/routes/channels/actions.ts"), "utf8");
  const m = src.match(/request_id:\s*z\.string\(\)\.trim\(\)\.min\((\d+)\)/);
  assert.ok(m, "routes/channels/actions.ts no longer declares a min length for request_id");
  return Number(m[1]);
})();

test("mark complete sends the idempotency key the route requires", async () => {
  const { api, calls } = mountChannelsApi();
  await api.approveAction("a-1", undefined, "channel_action");
  const body = JSON.parse(calls[0].body);
  assert.equal(typeof body.request_id, "string");
  assert.ok(
    body.request_id.trim().length >= SET_BODY_MIN,
    `request_id must be at least ${SET_BODY_MIN} characters, got ${JSON.stringify(body.request_id)}`,
  );
});

test("each completion gets its own key, so it is a key and not a constant", async () => {
  const { api, calls } = mountChannelsApi();
  await api.approveAction("a-1", undefined, "channel_action");
  await api.approveAction("a-2", undefined, "channel_action");
  assert.notEqual(JSON.parse(calls[0].body).request_id, JSON.parse(calls[1].body).request_id);
});

test("mark complete on a decisions card is unchanged, including with no source given", async () => {
  const { api, calls } = mountChannelsApi();
  await api.approveAction("d-1");
  await api.approveAction("d-2", undefined, "decision");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/approvals/d-1/approve", "/api/approvals/d-2/approve"],
  );
});

test("redo follows the same store as the card", async () => {
  const { api, calls } = mountChannelsApi();
  await api.redoAction("a-1", "shorter please", "channel_action");
  await api.redoAction("d-1", "shorter please");
  assert.equal(calls[0].path, "/api/channel-actions/a-1/redo");
  assert.deepEqual(JSON.parse(calls[0].body), { note: "shorter please" });
  assert.equal(calls[1].path, "/api/approvals/d-1/redo");
  assert.deepEqual(JSON.parse(calls[1].body), { message: "shorter please" });
});

test("task ticks save the whole list to the steps route", async () => {
  const { api, calls } = mountChannelsApi();
  await api.saveActionSteps("a-1", [0, 2]);
  assert.equal(calls[0].path, "/api/channel-actions/a-1/steps");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), { steps_done: [0, 2] });
});

test("every path the phone can produce is a route the backend mounts", async () => {
  const routes = fs.readFileSync(path.join(REPO, "apps/backend/src/routes/index.ts"), "utf8");
  const { api, calls } = mountChannelsApi();
  await api.approveAction("x", undefined, "channel_action");
  await api.approveAction("x");
  await api.redoAction("x", "m", "channel_action");
  await api.redoAction("x", "m");
  await api.saveActionSteps("x", [0]);
  for (const c of calls) {
    const template = c.path.replace(/\/x(?=\/|$)/, "/:id");
    assert.ok(
      routes.includes(`"${template}"`) ||
        routes.includes(`"${template.replace("/:id", "/:decision_id")}"`),
      `mobile calls ${c.path}, which matches no route mounted in routes/index.ts`,
    );
  }
});
