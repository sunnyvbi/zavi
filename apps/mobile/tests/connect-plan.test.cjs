const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const cache = new Map();
function load(file, requireShim) {
  if (cache.has(file)) return cache.get(file);
  const source = fs.readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  vm.runInNewContext(compiled, {
    module: mod,
    exports: mod.exports,
    require: requireShim,
    Intl,
    Date,
    URL,
    Object,
  });
  cache.set(file, mod.exports);
  return mod.exports;
}

const SHARED = path.join(__dirname, "../../../packages/shared/src");
function sharedRequire(dir) {
  return (name) => {
    if (name === "zod") return require("zod");
    if (name.startsWith(".")) {
      const file = path.join(dir, `${name}.ts`);
      return load(file, sharedRequire(path.dirname(file)));
    }
    throw new Error(`unexpected require ${name}`);
  };
}
const connectorsDir = path.join(SHARED, "connectors");
const shared = {
  ...load(path.join(connectorsDir, "connector-request.ts"), sharedRequire(connectorsDir)),
  ...load(path.join(connectorsDir, "rails.ts"), sharedRequire(connectorsDir)),
  ...load(path.join(SHARED, "ui-blocks/report.ts"), () => ({})),
};
const onlyShared = (name) => {
  if (name === "@zavi/shared") return shared;
  if (name === "../agentBuilder/logic") return load(path.join(__dirname, "../src/features/agentBuilder/logic.ts"), onlyShared);
  throw new Error(`unexpected require ${name}`);
};
const plan = load(path.join(__dirname, "../src/features/connectors/connectPlan.ts"), onlyShared);
const cards = load(path.join(__dirname, "../src/features/agents/replyCards.ts"), onlyShared);
const plain = (v) => JSON.parse(JSON.stringify(v));

const route = (slug, label) => plain(plan.planConnect(slug, shared.connectInfoFor(slug, label)));
const oauth = (p) => ({ kind: "oauth", path: `/api/connectors/${p}/start` });

test("oauth: dedicated starters use their hyphenated route, the rest the generic /start", () => {
  assert.deepEqual(route("meta_ads"), oauth("meta-ads"));
  assert.deepEqual(route("google_ads"), oauth("google-ads"));
  assert.deepEqual(route("google_calendar"), oauth("google-calendar"));
  assert.deepEqual(route("google_sheets"), oauth("google-sheets"));
  for (const slug of ["slack", "github", "jira", "linear", "tiktok", "reddit_ads", "x_ads", "linkedin_social"]) {
    assert.deepEqual(route(slug), oauth(slug), slug);
  }
});

test("google analytics and search console follow their rail", () => {
  assert.equal(shared.railFor("google_analytics"), "composio");
  assert.equal(shared.railFor("google_search_console"), "composio");
  assert.deepEqual(route("google_analytics"), { kind: "composio", toolkit: "google_analytics" });
  assert.deepEqual(route("google_search_console"), { kind: "composio", toolkit: "google_search_console" });
});

test("instagram follows its rail (composio today); youtube is composio-only", () => {
  assert.equal(shared.railFor("instagram"), "composio");
  assert.deepEqual(route("instagram_social"), { kind: "composio", toolkit: "instagram" });
  assert.deepEqual(route("composio.youtube"), { kind: "composio", toolkit: "youtube" });
  assert.deepEqual(route("reddit_social"), { kind: "composio", toolkit: "reddit" });
});

test("composio.<toolkit> connects through Composio", () => {
  assert.deepEqual(route("composio.hubspot", "HubSpot"), { kind: "composio", toolkit: "hubspot" });
  assert.deepEqual(route("composio.instagram"), { kind: "composio", toolkit: "instagram" });
});

test("pipedream: the Composio twin when there is one, else the web integrations list", () => {
  assert.deepEqual(route("pipedream.instagram_business"), { kind: "composio", toolkit: "instagram" });
  assert.deepEqual(route("pipedream.youtube_data_api"), { kind: "composio", toolkit: "youtube" });
  assert.deepEqual(route("pipedream.airtable"), {
    kind: "web",
    url: "https://www.zaviagent.com/workspace?tab=settings#integration",
  });
});

test("key forms: native form for the six web forms, higgsfield OAuth, apple_ads/email on web", () => {
  for (const slug of ["stripe", "operator_db", "posthog", "sentry", "figma", "supabase"]) {
    assert.deepEqual(route(slug), { kind: "form", form: slug }, slug);
  }
  assert.deepEqual(route("higgsfield"), oauth("higgsfield"));
  for (const slug of ["apple_ads", "email"]) {
    assert.equal(route(slug).kind, "web", slug);
  }
});

test("every CONNECTOR_CONNECT slug has a route (no crash, no undefined path)", () => {
  for (const [slug, info] of Object.entries(shared.CONNECTOR_CONNECT)) {
    const p = plan.planConnect(slug, info);
    assert.ok(["oauth", "composio", "form", "web"].includes(p.kind), slug);
    if (p.kind === "oauth") assert.match(p.path, /^\/api\/connectors\/[a-z0-9_-]+\/start$/, slug);
  }
});

const req = (over = {}) => ({ slug: "stripe", mode: "connect", created_at: "2026-09-25T10:00:00Z", ...over });

test("connect mode: any row for the slug (or an alias) satisfies it", () => {
  assert.equal(plan.isRequestSatisfied([], req()), false);
  assert.equal(plan.isRequestSatisfied([{ slug: "stripe" }], req()), true);
  assert.equal(plan.isRequestSatisfied([{ slug: "composio.instagram" }], req({ slug: "instagram_social" })), true);
});

test("the Zavi umbrella GitHub row never counts as the tenant's GitHub", () => {
  assert.equal(plan.isRequestSatisfied([{ slug: "github", account_login: "praxis-build" }], req({ slug: "github" })), false);
  assert.equal(plan.isRequestSatisfied([{ slug: "github", account_login: "acme" }], req({ slug: "github" })), true);
});

test("reconnect mode: only a row connected after the request", () => {
  const r = req({ mode: "reconnect" });
  assert.equal(plan.isRequestSatisfied([{ slug: "stripe", connected_at: "2026-09-25T09:00:00Z" }], r), false);
  assert.equal(plan.isRequestSatisfied([{ slug: "stripe", connected_at: "2026-09-25T11:00:00Z" }], r), true);
  assert.equal(plan.isRequestSatisfied([{ slug: "stripe" }], r), false);
});

test("reconnect mode: ANY alias row reconnected after the request counts (continue route rule)", () => {
  const r = req({ slug: "instagram_social", mode: "reconnect" });
  const rows = [
    { slug: "instagram_social", connected_at: "2026-09-25T09:00:00Z" },
    { slug: "composio.instagram", connected_at: "2026-09-25T11:00:00Z" },
  ];
  assert.equal(plan.isRequestSatisfied(rows, r), true);
});

test("satisfactionKey: null until satisfied, stable across refreshes, changes on a reconnect", () => {
  const r = req();
  assert.equal(plan.satisfactionKey([], r), null);
  const a = plan.satisfactionKey([{ slug: "stripe", connected_at: "2026-09-25T11:00:00Z" }], r);
  const again = plan.satisfactionKey([{ slug: "stripe", connected_at: "2026-09-25T11:00:00Z" }], r);
  const later = plan.satisfactionKey([{ slug: "stripe", connected_at: "2026-09-25T12:00:00Z" }], r);
  assert.ok(a);
  assert.equal(a, again);
  assert.notEqual(a, later);
});

test("setup gate: an unloaded list holds Save while a required connector is listed", () => {
  assert.equal(plan.setupConnectorGate([], null), "ready");
  assert.equal(plan.setupConnectorGate(["stripe"], null), "loading");
  assert.equal(plan.setupConnectorGate(["stripe"], []), "missing");
  assert.equal(plan.setupConnectorGate(["stripe"], [{ slug: "stripe" }]), "ready");
});

test("key forms enable on the web form's own rule", () => {
  assert.equal(plan.keyFormReady("stripe", { api_key: "rk_live_123" }), false);
  assert.equal(plan.keyFormReady("stripe", { api_key: "rk_live_1234" }), true);
  assert.equal(plan.keyFormReady("operator_db", { connection_string: "pg://ab" }), false);
  assert.equal(plan.keyFormReady("operator_db", { connection_string: "pg://abc" }), true);
  assert.equal(plan.keyFormReady("posthog", { api_key: "" }), false);
  assert.equal(plan.keyFormReady("posthog", { api_key: "x" }), true);
  assert.equal(plan.keyFormReady("sentry", { auth_token: "sntrys_abcd", org_slug: "  " }), false);
  assert.equal(plan.keyFormReady("sentry", { auth_token: "sntrys_abcd", org_slug: "acme" }), true);
  assert.equal(plan.keyFormReady("figma", { api_key: "  figd_short_token   " }), false);
  assert.equal(plan.keyFormReady("figma", { api_key: "figd_0123456789abcdef" }), true);
  assert.equal(plan.keyFormReady("supabase", { access_token: "sbp_" + "a".repeat(15) }), false);
  assert.equal(plan.keyFormReady("supabase", { access_token: "sbp_" + "a".repeat(16) }), true);
});

test("a failed DB probe gets a plain reason, never the raw driver text", () => {
  assert.equal(plan.probeFailureReason("password authentication failed"), "The username or password was rejected.");
  assert.equal(plan.probeFailureReason("AggregateError"), "Nothing answered at that host and port.");
  assert.equal(plan.probeFailureReason("weird"), null);
});

const REQ = {
  kind: "connector_request",
  v: 1,
  request_id: "req-1",
  slug: "stripe",
  label: "Stripe",
  connect: "key_form",
  reason: "I need your Stripe data to answer that.",
  origin: "model",
  mode: "connect",
  run_id: "run-1",
  created_at: "2026-09-25T10:00:00Z",
};
const msg = (meta) => ({ body: "Connect Stripe first.", agent_run_id: "run-1", meta });

test("meta.connector_request becomes a card; a malformed one is ignored", () => {
  const ok = cards.planReplyCards(msg({ connector_request: REQ }), { isLast: true, threadSlug: "operator" });
  assert.deepEqual(plain(ok.cards), [{ kind: "connectorRequest", request: REQ }]);
  const bad = cards.planReplyCards(msg({ connector_request: { ...REQ, v: 2 } }), { isLast: true, threadSlug: "operator" });
  assert.deepEqual(plain(bad.cards), []);
});
