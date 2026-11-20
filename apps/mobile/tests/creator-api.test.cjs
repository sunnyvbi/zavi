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

function run(file, requireShim, extraGlobals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    compile(file),
    {
      module,
      exports: module.exports,
      require: requireShim,
      console,
      ...extraGlobals,
    },
    { filename: path.basename(file) },
  );
  return module.exports;
}

function mountCreatorApi({ fail = null } = {}) {
  const calls = [];
  class ApiFetchError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const api = run(
    path.join(MOBILE, "src/features/creator/api.ts"),
    (name) => {
      if (name === "../../lib/api") {
        return {
          ApiFetchError,
          async apiJson(p, opts) {
            calls.push({ path: p, method: opts?.method, body: opts?.body });
            if (fail) throw new ApiFetchError(fail.status, fail.code, fail.message);
            return {};
          },
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  );
  return { api, calls, ApiFetchError };
}

const CALLS = [
  { name: "me", run: (a) => a.me(), path: "/api/creator/me", method: undefined },
  { name: "inbox", run: (a) => a.inbox(), path: "/api/creator/inbox", method: undefined },
  {
    name: "markAlertRead",
    run: (a) => a.markAlertRead("alert-1"),
    path: "/api/creator/notifications/alert-1/read",
    method: "POST",
  },
  { name: "briefs", run: (a) => a.briefs(), path: "/api/creator/briefs", method: undefined },
  {
    name: "jobs active",
    run: (a) => a.jobs("active"),
    path: "/api/creator/jobs?scope=active",
    method: undefined,
  },
  {
    name: "jobs all",
    run: (a) => a.jobs("all"),
    path: "/api/creator/jobs?scope=all",
    method: undefined,
  },
  { name: "job", run: (a) => a.job("order-1"), path: "/api/creator/jobs/order-1", method: undefined },
  {
    name: "accept",
    run: (a) => a.accept("order-1"),
    path: "/api/creator/jobs/order-1/accept",
    method: "POST",
  },
  {
    name: "pass",
    run: (a) => a.pass("order-1", "booked that week"),
    path: "/api/creator/jobs/order-1/pass",
    method: "POST",
    body: { reason: "booked that week" },
  },
  {
    name: "extension",
    run: (a) => a.requestExtension("order-1", "2026-10-01T12:00:00.000Z", "one more day"),
    path: "/api/creator/jobs/order-1/extension",
    method: "POST",
    body: { requested_due_at: "2026-10-01T12:00:00.000Z", note: "one more day" },
  },
  {
    name: "message",
    run: (a) => a.sendMessage("order-1", "on it"),
    path: "/api/creator/jobs/order-1/messages",
    method: "POST",
    body: { body: "on it" },
  },
  {
    name: "upload url",
    run: (a) => a.uploadUrl("order-1", "video/quicktime"),
    path: "/api/creator/jobs/order-1/upload-url",
    method: "POST",
    body: { content_type: "video/quicktime" },
  },
  {
    name: "submit",
    run: (a) =>
      a.submit(
        "order-1",
        [{ kind: "video", storage_path: "t/o/u.mov", mime_type: "video/quicktime", bytes: 12 }],
        "first cut",
      ),
    path: "/api/creator/jobs/order-1/submissions",
    method: "POST",
    body: {
      files: [{ kind: "video", storage_path: "t/o/u.mov", mime_type: "video/quicktime", bytes: 12 }],
      note: "first cut",
    },
  },
  { name: "earnings", run: (a) => a.earnings(), path: "/api/creator/earnings", method: undefined },
  {
    name: "onboarding link",
    run: (a) => a.onboardingLink(),
    path: "/api/creator/payouts/onboarding-link",
    method: "POST",
  },
  {
    name: "tax forms link",
    run: (a) => a.taxFormsLink(),
    path: "/api/creator/payouts/tax-forms-link",
    method: "POST",
  },
  {
    name: "storefront",
    run: (a) => a.storefront(),
    path: "/api/creator/storefront",
    method: undefined,
  },
  {
    name: "save package",
    run: (a) => a.savePackage("pkg-1", { active: false }),
    path: "/api/creator/storefront/packages/pkg-1",
    method: "PATCH",
    body: { active: false },
  },
];

for (const expected of CALLS) {
  test(`${expected.name} calls ${expected.method ?? "GET"} ${expected.path}`, async () => {
    const { api, calls } = mountCreatorApi();
    await expected.run(api.creatorApi);
    assert.equal(calls.length, 1, "exactly one request per action");
    assert.equal(calls[0].path, expected.path);
    assert.equal(calls[0].method, expected.method);
    if (expected.body) {
      assert.deepEqual(JSON.parse(calls[0].body), expected.body);
    }
  });
}

test("an order id with a slash in it cannot walk out of its own path", async () => {
  const { api, calls } = mountCreatorApi();
  await api.creatorApi.job("../me");
  assert.equal(calls[0].path, "/api/creator/jobs/..%2Fme");
});

test("nothing the app sends names a creator, a member or a tenant", async () => {
  const { api, calls } = mountCreatorApi();
  for (const c of CALLS) await c.run(api.creatorApi);
  assert.equal(calls.length, CALLS.length);
  for (const call of calls) {
    const wire = `${call.path} ${call.body ?? ""}`;
    for (const forbidden of ["human_member", "member_id", "creator_id", "tenant_id", "auth_user"]) {
      assert.ok(
        !wire.includes(forbidden),
        `${call.path} must not carry ${forbidden}: the backend derives it from the token`,
      );
    }
  }
});

test("every path the app calls is a creator route the backend already mounts", async () => {
  const routes = fs.readFileSync(
    path.join(REPO, "apps/backend/src/routes/index.ts"),
    "utf8",
  );
  const mounted = [...routes.matchAll(/app\.(get|post|patch|put|delete)\(\s*"(\/api\/creator[^"]*)"/g)].map(
    (m) => ({ method: m[1].toUpperCase(), pattern: m[2] }),
  );
  assert.ok(mounted.length >= 18, `expected S10's creator routes, found ${mounted.length}`);

  const { api, calls } = mountCreatorApi();
  for (const c of CALLS) await c.run(api.creatorApi);

  for (const call of calls) {
    const method = (call.method ?? "GET").toUpperCase();
    const pathOnly = call.path.split("?")[0];
    const hit = mounted.find((m) => {
      if (m.method !== method) return false;
      const re = new RegExp(`^${m.pattern.replace(/:[A-Za-z]+/g, "[^/]+")}$`);
      return re.test(pathOnly);
    });
    assert.ok(hit, `${method} ${pathOnly} is not a route the backend mounts`);
  }
});

test("a creator-area refusal keeps the backend's own code and sentence", async () => {
  const { api } = mountCreatorApi({
    fail: { status: 403, code: "not_a_creator", message: "This area is for Zavi creators." },
  });
  await assert.rejects(
    () => api.creatorApi.me(),
    (e) => {
      assert.equal(e.name, "CreatorApiError");
      assert.equal(e.code, "not_a_creator");
      assert.equal(e.status, 403);
      assert.equal(e.message, "This area is for Zavi creators.");
      return true;
    },
  );
});

function mountApiClient({ token }) {
  const requests = [];
  return {
    requests,
    api: run(
      path.join(MOBILE, "src/lib/api.ts"),
      (name) => {
        const supabaseStub = {
          supabase: {
            auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) },
          },
        };
        if (name === "./supabase") return supabaseStub;
        if (name === "./tenant-claim") {
          return run(path.join(MOBILE, "src/lib/tenant-claim.ts"), (dep) => {
            if (dep === "./supabase") return supabaseStub;
            throw new Error(`Unexpected dependency: ${dep}`);
          });
        }
        if (name === "./apiRetry") {
          return run(path.join(MOBILE, "src/lib/apiRetry.ts"), (dep) => {
            throw new Error(`Unexpected dependency: ${dep}`);
          });
        }
        throw new Error(`Unexpected dependency: ${name}`);
      },
      {
        Headers,
        process: { env: { EXPO_PUBLIC_BACKEND_URL: "https://api.example.test" } },
        async fetch(url, init) {
          requests.push({ url, headers: init.headers });
          return { ok: true, status: 200, text: async () => "{}" };
        },
      },
    ),
  };
}

test("every creator call carries the signed-in creator's bearer token", async () => {
  const { api, requests } = mountApiClient({ token: "creator-access-token" });
  await api.apiJson("/api/creator/inbox");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.example.test/api/creator/inbox");
  assert.equal(requests[0].headers.get("Authorization"), "Bearer creator-access-token");
});

test("a POST body is sent as JSON with the bearer alongside it", async () => {
  const { api, requests } = mountApiClient({ token: "creator-access-token" });
  await api.apiJson("/api/creator/jobs/order-1/pass", {
    method: "POST",
    body: JSON.stringify({ reason: "busy" }),
  });
  assert.equal(requests[0].headers.get("Authorization"), "Bearer creator-access-token");
  assert.equal(requests[0].headers.get("Content-Type"), "application/json");
});

test("signed out, no Authorization header is invented", async () => {
  const { api, requests } = mountApiClient({ token: null });
  await api.apiJson("/api/creator/me");
  assert.equal(requests[0].headers.get("Authorization"), null);
});

function mountIdentity(behaviour) {
  class CreatorApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return run(
    path.join(MOBILE, "src/features/creator/identity.ts"),
    (name) => {
      if (name === "./api") {
        return {
          CreatorApiError,
          creatorApi: {
            async me() {
              if (behaviour.throw) {
                const { code, message, status } = behaviour.throw;
                throw new CreatorApiError(code, message, status);
              }
              if (behaviour.plainThrow) throw new Error("network down");
              return behaviour.me;
            },
          },
        };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  );
}

test("a 200 means creator, and the body is reused rather than fetched twice", async () => {
  const me = { creator: { id: "member-1", display_name: "Ada" }, payout_account: null };
  const mod = mountIdentity({ me });
  const identity = await mod.fetchCreatorIdentity();
  assert.equal(identity.kind, "creator");
  assert.deepEqual(identity.me, me);
  assert.equal(mod.identityIsCreator(identity), true);
  assert.equal(mod.identityMemberId(identity), "member-1");
});

test("403 not_a_creator is a founder, and carries no member id to key a cache with", async () => {
  const mod = mountIdentity({
    throw: { status: 403, code: "not_a_creator", message: "This area is for Zavi creators." },
  });
  const identity = await mod.fetchCreatorIdentity();
  assert.equal(identity.kind, "not_creator");
  assert.equal(mod.identityIsCreator(identity), false);
  assert.equal(mod.identityMemberId(identity), null);
});

test("403 not_approved is still a creator, so they get the honest state not onboarding", async () => {
  const mod = mountIdentity({
    throw: { status: 403, code: "not_approved", message: "Your creator signup is not finished yet." },
  });
  const identity = await mod.fetchCreatorIdentity();
  assert.equal(identity.kind, "blocked");
  assert.equal(identity.message, "Your creator signup is not finished yet.");
  assert.equal(mod.identityIsCreator(identity), true);
  assert.equal(mod.identityMemberId(identity), null);
});

test("a 401 or a dead network is not an answer and is rethrown for the retry to handle", async () => {
  for (const behaviour of [
    { throw: { status: 401, code: "unauthorized", message: "Sign in required." } },
    { throw: { status: 503, code: "creator_area_unavailable", message: "That did not load." } },
    { plainThrow: true },
  ]) {
    const mod = mountIdentity(behaviour);
    await assert.rejects(() => mod.fetchCreatorIdentity());
  }
});

test("a 403 with an unfamiliar code is not quietly read as 'not a creator'", async () => {
  const mod = mountIdentity({
    throw: { status: 403, code: "something_new", message: "No." },
  });
  await assert.rejects(() => mod.fetchCreatorIdentity());
});
