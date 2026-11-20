const assert = require("node:assert/strict");
const { createHash, randomFillSync, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { createClient } = require("@supabase/supabase-js");

const pendingKey = "zavi.auth.pendingOAuth";
const verifierKey = "sb-test-auth-token-code-verifier";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadModule(file, mocks) {
  const source = readFileSync(path.join(__dirname, "../src", file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  vm.runInNewContext(
    outputText,
    {
      module,
      exports: module.exports,
      URL,
      URLSearchParams,
      Uint8Array,
      setTimeout,
      require(name) {
        if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
        return mocks[name];
      },
    },
    { filename: file },
  );
  return module.exports;
}

function harness(options = {}) {
  const values = new Map();
  const opened = deferred();
  const calls = { starts: [], exchanges: [], opened: [] };
  const storage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
    multiRemove: async (keys) => {
      keys.forEach((key) => values.delete(key));
    },
  };
  const mockAuth = {
    async signInWithOAuth(input) {
      calls.starts.push(input);
      values.set(verifierKey, JSON.stringify("sdk-temporary-verifier"));
      if (options.startError)
        return { data: { url: null }, error: new Error("provider dump") };
      const url = new URL("https://supabase.example/auth/v1/authorize");
      url.searchParams.set("provider", input.provider);
      url.searchParams.set("redirect_to", input.options.redirectTo);
      url.searchParams.set("code_challenge", "sdk-temporary-verifier");
      url.searchParams.set("code_challenge_method", "plain");
      return { data: { url: url.toString() }, error: null };
    },
    async exchangeCodeForSession(code) {
      calls.exchanges.push({
        code,
        verifier: JSON.parse(values.get(verifierKey) ?? "null"),
      });
      if (options.exchangeWait) await options.exchangeWait.promise;
      values.delete(verifierKey);
      return (
        options.exchangeResult ?? {
          data: { session: { user: { id: "user" } } },
          error: null,
        }
      );
    },
  };
  const auth = options.realSdk
    ? createClient("https://test.supabase.co", "public-test-key", {
        auth: {
          storage,
          storageKey: "sb-test-auth-token",
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          flowType: "pkce",
        },
        global: {
          fetch: async (url, init) => {
            assert.equal(
              url,
              "https://test.supabase.co/auth/v1/token?grant_type=pkce",
            );
            const body = JSON.parse(init.body);
            calls.exchanges.push({
              code: body.auth_code,
              verifier: body.code_verifier,
            });
            return new Response(
              JSON.stringify({
                access_token: "fixture-access-token",
                refresh_token: "fixture-refresh-token",
                expires_in: 3600,
                token_type: "bearer",
                user: {
                  id: "fixture-user",
                  aud: "authenticated",
                  created_at: "2026-01-01T00:00:00Z",
                  app_metadata: {},
                  user_metadata: {},
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        },
      }).auth
    : mockAuth;
  const oauth = loadModule("auth/oauth.ts", {
    "@react-native-async-storage/async-storage": {
      __esModule: true,
      default: storage,
    },
    "expo-crypto": {
      getRandomValues: randomFillSync,
      randomUUID,
      CryptoDigestAlgorithm: { SHA256: "SHA-256" },
      CryptoEncoding: { BASE64: "base64" },
      digestStringAsync: async (_, value) =>
        createHash("sha256").update(value).digest("base64"),
    },
    "react-native": { Platform: { OS: options.platform ?? "ios" } },
    "expo-web-browser": {
      async openAuthSessionAsync(url, redirect) {
        calls.opened.push({ url, redirect });
        opened.resolve(url);
        if (options.browser) return options.browser(url);
        return {
          type: "success",
          url: `${new URL(url).searchParams.get("redirect_to")}&code=valid-code`,
        };
      },
    },
    "../lib/supabase": {
      authStorageKey: "sb-test-auth-token",
      supabase: { auth },
    },
  });
  const nativeIntent = loadModule("app/+native-intent.tsx", {
    "../auth/oauth": oauth,
    "../lib/webLink": loadModule("lib/webLink.ts", {}),
  });
  return { oauth, nativeIntent, values, calls, opened, auth };
}

function seed(h, changes = {}) {
  h.values.set(
    pendingKey,
    JSON.stringify({
      attemptId: "attempt",
      provider: "github",
      startedAt: Date.now(),
      ...changes,
    }),
  );
  h.values.set(verifierKey, JSON.stringify("a".repeat(64)));
  return "zavi://auth/callback?attempt=attempt&code=valid-code";
}

for (const provider of ["github", "slack_oidc"]) {
  test(`${provider} uses secure S256, matching persisted verifier, and normal session exchange`, async () => {
    const h = harness();
    await h.oauth.signInWithBrowser(provider);
    assert.equal(h.calls.starts.length, 1);
    assert.equal(h.calls.starts[0].provider, provider);
    assert.equal(h.calls.starts[0].options.skipBrowserRedirect, true);
    assert.deepEqual(Object.keys(h.calls.starts[0].options).sort(), [
      "redirectTo",
      "skipBrowserRedirect",
    ]);
    const url = new URL(h.calls.opened[0].url);
    const verifier = h.calls.exchanges[0].verifier;
    assert.match(verifier, /^[a-f0-9]{64}$/);
    assert.equal(
      url.searchParams.get("code_challenge"),
      createHash("sha256").update(verifier).digest("base64url"),
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "s256");
    assert.ok(!url.toString().includes(verifier));
    assert.match(
      url.searchParams.get("redirect_to"),
      /^zavi:\/\/auth\/callback\?attempt=[a-f0-9-]+$/,
    );
    assert.equal(h.calls.opened[0].redirect, "zavi://auth/callback");
    assert.equal(h.calls.exchanges.length, 1);
    assert.equal(h.values.size, 0);
  });
}

test("closing the browser is quiet, clears the attempt, and permits retry", async () => {
  const h = harness({ browser: async () => ({ type: "cancel" }) });
  await h.oauth.signInWithBrowser("github");
  assert.equal(h.calls.exchanges.length, 0);
  assert.equal(h.values.size, 0);
  await h.oauth.signInWithBrowser("slack_oidc");
  assert.equal(h.calls.starts.length, 2);
});

test("concurrent provider taps cannot replace a pending verifier", async () => {
  const browser = deferred();
  const h = harness({ browser: () => browser.promise });
  const first = h.oauth.signInWithBrowser("github");
  await h.opened.promise;
  const before = h.values.get(verifierKey);
  await assert.rejects(
    h.oauth.signInWithBrowser("slack_oidc"),
    /already in progress/,
  );
  assert.equal(h.values.get(verifierKey), before);
  assert.equal(h.calls.starts.length, 1);
  browser.resolve({ type: "cancel" });
  await first;
});

test("cold-start callback exchanges from persistent storage through the native route", async () => {
  const h = harness();
  const url = seed(h);
  const route = await h.nativeIntent.redirectSystemPath({
    path: url,
    initial: true,
  });
  const callbackUrl = new URL(route, "zavi://").searchParams.get("callbackUrl");
  await h.oauth.completeBrowserOAuth(callbackUrl);
  assert.equal(h.calls.exchanges.length, 1);
  assert.equal(h.values.size, 0);
});

test("cold-start navigation returns immediately while the network exchange is still pending", async () => {
  const exchangeWait = deferred();
  const h = harness({ exchangeWait });
  const url = seed(h);
  const route = await h.nativeIntent.redirectSystemPath({
    path: url,
    initial: true,
  });
  assert.match(route, /^\/auth\/callback\?callbackUrl=/);
  assert.ok(h.values.has(pendingKey));
  exchangeWait.resolve();
  await h.oauth.completeBrowserOAuth(url);
  assert.equal(h.calls.exchanges.length, 1);
});

test("browser and native-route delivery exchange the same code only once", async () => {
  const browser = deferred();
  const exchangeWait = deferred();
  const h = harness({ browser: () => browser.promise, exchangeWait });
  const signingIn = h.oauth.signInWithBrowser("github");
  const authorizeUrl = await h.opened.promise;
  const callback = `${new URL(authorizeUrl).searchParams.get("redirect_to")}&code=code`;
  const route = h.nativeIntent.redirectSystemPath({
    path: callback,
    initial: false,
  });
  browser.resolve({ type: "success", url: callback });
  exchangeWait.resolve();
  await Promise.all([signingIn, route]);
  assert.equal(h.calls.exchanges.length, 1);
});

test("Android foreground dismissal allows a late matching callback to finish", async () => {
  const h = harness({
    platform: "android",
    browser: async (url) => {
      setTimeout(() => {
        void h.nativeIntent.redirectSystemPath({
          path: `${new URL(url).searchParams.get("redirect_to")}&code=code`,
          initial: false,
        });
      }, 20);
      return { type: "dismiss" };
    },
  });
  await h.oauth.signInWithBrowser("github");
  assert.equal(h.calls.exchanges.length, 1);
  assert.equal(h.values.size, 0);
});

test("old callbacks cannot consume or clear a newer attempt", async () => {
  const h = harness();
  seed(h, { attemptId: "new-attempt" });
  const before = h.values.get(verifierKey);
  await assert.rejects(
    h.oauth.completeBrowserOAuth(
      "zavi://auth/callback?attempt=old-attempt&code=old-code",
    ),
    /expired/,
  );
  assert.equal(h.calls.exchanges.length, 0);
  assert.equal(h.values.get(verifierKey), before);
  assert.equal(JSON.parse(h.values.get(pendingKey)).attemptId, "new-attempt");
});

for (const url of [
  "zavi://auth/callback-other?attempt=attempt&code=code",
  "exp+zavi://auth/callback?attempt=attempt&code=code",
  "zavi://user@auth/callback?attempt=attempt&code=code",
  "zavi://auth:8080/callback?attempt=attempt&code=code",
  "zavi://auth/callback?attempt=attempt&code=code#access_token=invalid",
]) {
  test(`untrusted callback URL is rejected: ${url.split("?")[0]}`, async () => {
    const h = harness();
    seed(h);
    await assert.rejects(
      h.oauth.completeBrowserOAuth(url),
      /Invalid sign-in response/,
    );
    await h.nativeIntent.redirectSystemPath({ path: url, initial: true });
    assert.equal(h.calls.exchanges.length, 0);
    assert.ok(h.values.has(verifierKey));
  });
}

for (const query of [
  "",
  "&code=",
  "&code=one&code=two",
  "&error=access_denied&error_description=PRIVATE_PROVIDER_DUMP",
]) {
  test(`missing, duplicate, and error callbacks fail safely: ${query.split("&error_description")[0]}`, async () => {
    const h = harness();
    seed(h);
    await assert.rejects(
      h.oauth.completeBrowserOAuth(
        `zavi://auth/callback?attempt=attempt${query}`,
      ),
      (error) => {
        assert.ok(!error.message.includes("PRIVATE_PROVIDER_DUMP"));
        return true;
      },
    );
    assert.equal(h.calls.exchanges.length, 0);
    assert.equal(h.values.size, 0);
  });
}

for (const startedAt of [
  Date.now() - 11 * 60 * 1000,
  Date.now() + 60_000,
  "invalid",
]) {
  test(`expired or invalid attempt cannot exchange: ${typeof startedAt}`, async () => {
    const h = harness();
    const url = seed(h, { startedAt });
    await assert.rejects(h.oauth.completeBrowserOAuth(url), /expired/);
    assert.equal(h.calls.exchanges.length, 0);
    assert.equal(h.values.size, 0);
  });
}

for (const exchangeResult of [
  { data: { session: null }, error: new Error("PRIVATE_PROVIDER_DUMP") },
  { data: { session: null }, error: null },
]) {
  test("failed or sessionless exchange is visible and is not retried with the same code", async () => {
    const h = harness({ exchangeResult });
    const url = seed(h);
    await assert.rejects(h.oauth.completeBrowserOAuth(url), /Unable to finish/);
    await assert.rejects(h.oauth.completeBrowserOAuth(url), /Unable to finish/);
    assert.equal(h.calls.exchanges.length, 1);
    assert.equal(h.values.size, 0);
  });
}

test("failed initiation never opens a browser and clears its verifier", async () => {
  const h = harness({ startError: true });
  await assert.rejects(h.oauth.signInWithBrowser("github"), /Unable to start/);
  assert.equal(h.calls.opened.length, 0);
  assert.equal(h.values.size, 0);
});

test("competing native auth invalidates stale OAuth and blocks callback replacement", async () => {
  const h = harness();
  const url = seed(h);
  const wait = deferred();
  const started = deferred();
  const native = h.oauth.runAuthAction(async () => {
    started.resolve();
    await wait.promise;
  });
  await started.promise;
  await assert.rejects(
    h.oauth.completeBrowserOAuth(url),
    /already in progress/,
  );
  await assert.rejects(
    h.oauth.runAuthAction(async () => {}),
    /already in progress/,
  );
  assert.equal(h.values.size, 0);
  wait.resolve();
  await native;
  await assert.rejects(h.oauth.completeBrowserOAuth(url), /expired/);
  assert.equal(h.calls.exchanges.length, 0);
});

test("logout clears successful callback cache so a reopened link fails instead of hanging", async () => {
  const h = harness();
  const url = seed(h);
  await h.oauth.completeBrowserOAuth(url);
  await h.oauth.runAuthAction(async () => {});
  await assert.rejects(h.oauth.completeBrowserOAuth(url), /expired/);
  assert.equal(h.calls.exchanges.length, 1);
});

test("unrelated native links keep their existing routing", async () => {
  const h = harness();
  for (const url of [
    "zavi://chat?thread_id=thread",
    "exp+zavi://expo-development-client/?url=http://localhost",
    "/settings",
  ]) {
    assert.equal(
      await h.nativeIntent.redirectSystemPath({ path: url, initial: true }),
      url,
    );
  }
  assert.equal(h.calls.exchanges.length, 0);
});

test("installed Supabase SDK reads the native verifier, persists the session, and emits SIGNED_IN", async () => {
  const h = harness({ realSdk: true });
  const events = [];
  const { data: subscription } = h.auth.onAuthStateChange((event) => {
    events.push(event);
  });
  try {
    await h.oauth.signInWithBrowser("github");
    const url = new URL(h.calls.opened[0].url);
    assert.equal(
      url.searchParams.get("code_challenge"),
      createHash("sha256")
        .update(h.calls.exchanges[0].verifier)
        .digest("base64url"),
    );
    assert.equal(h.calls.exchanges[0].code, "valid-code");
    assert.ok(events.includes("SIGNED_IN"));
    assert.equal(
      (await h.auth.getSession()).data.session.user.id,
      "fixture-user",
    );
    assert.ok(h.values.has("sb-test-auth-token"));
    assert.ok(!h.values.has(verifierKey));
    assert.ok(!h.values.has(pendingKey));
  } finally {
    subscription.subscription.unsubscribe();
    h.auth.stopAutoRefresh();
  }
});
