const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const src = (p) => path.join(__dirname, "../src", p);
const SHARED = path.join(__dirname, "../../../packages/shared/src/connectors");

class ApiFetchError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const finishModule = loadTs(src("features/connectors/finishConnect.ts"));

function mount(params, backend) {
  const calls = { posts: [], tracked: [], dialogs: [], refreshes: 0, back: 0, replaced: [] };
  let effect = null;
  const stubs = {
    react: { createElement: (type, props) => ({ type, props }), useEffect: (fn) => { effect = fn; } },
    "expo-router": {
      useLocalSearchParams: () => params,
      useRouter: () => ({ canGoBack: () => true, back: () => { calls.back += 1; }, replace: (to) => calls.replaced.push(to) }),
    },
    "@zavi/shared": loadTs(path.join(SHARED, "connector-request.ts"), { zod: require("zod") }),
    "../../features/connectors/useConnections": { useRefreshConnections: () => () => { calls.refreshes += 1; } },
    "../../features/connectors/finishConnect": finishModule,
    "../../components/DialogHost": { showDialog: async (d) => { calls.dialogs.push(d); return true; } },
    "../../components/LoadingScreen": { LoadingScreen: () => null },
    "../../lib/analytics": { track: (name, props) => calls.tracked.push([name, props]) },
    "react-native": { Linking: {} },
    "../../lib/api": {
      apiJson: async (url, opts) => {
        calls.posts.push({ url, method: opts.method, body: opts.body });
        return backend(url, JSON.parse(opts.body));
      },
    },
  };
  const screen = loadTs(src("app/connectors/finish.tsx"), stubs);
  screen.default();
  return { calls, effect };
}

async function run(params, backend) {
  const { calls, effect } = mount(params, backend);
  effect();
  await new Promise((r) => setTimeout(r, 5));
  return calls;
}

const plain = (v) => JSON.parse(JSON.stringify(v));
let n = 0;
const fresh = (prefix) => `${prefix}-${++n}-${Date.now()}`;
const refused = () => {
  throw new ApiFetchError(403, "state_session_mismatch", "started by another person");
};

test("must catch: the app finishes its own connect with its own token and reports it connected", async () => {
  const state = fresh("state");
  const calls = await run({ connector: "linkedin_ads", code: "code+1/x", state }, async () => ({ ok: true }));
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].url, "/api/connectors/linkedin_ads/complete");
  assert.equal(calls.posts[0].method, "POST");
  assert.deepEqual(plain(JSON.parse(calls.posts[0].body)), { code: "code+1/x", state });
  assert.ok(!calls.posts[0].url.includes("code+1"));
  assert.deepEqual(plain(calls.tracked), [["connector_connected", { slug: "linkedin_ads" }]]);
  assert.equal(calls.dialogs.length, 0);
  assert.equal(calls.refreshes, 1);
  assert.equal(calls.back, 1);
});

test("must catch: an attacker's link is refused, the founder is told, and the app never claims it connected", async () => {
  const calls = await run({ connector: "linkedin_ads", code: "attacker-code", state: fresh("attacker-state") }, refused);
  assert.equal(calls.posts.length, 1);
  assert.deepEqual(plain(calls.tracked), [["connector_connect_failed", { slug: "linkedin_ads" }]]);
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.dialogs[0].message, "This LinkedIn Ads sign-in was started from another account or workspace, so nothing was connected. Tap Connect to start your own.");
  assert.ok(!calls.tracked.some(([name]) => name === "connector_connected"));
});

test("must catch: a crafted link naming another connector or an odd path never sends the founder's token anywhere", async () => {
  for (const connector of ["reddit_ads", "meta_ads", "../../api/staff", "linkedin_ads/../x", "", undefined]) {
    const calls = await run({ connector, code: "c", state: fresh("s") }, async () => ({ ok: true }));
    assert.equal(calls.posts.length, 0, String(connector));
    assert.equal(calls.dialogs.length, 1, String(connector));
    assert.ok(!calls.tracked.some(([name]) => name === "connector_connected"));
  }
});

test("must catch: a link missing the code or the state posts nothing", async () => {
  for (const params of [{ connector: "linkedin_ads", state: "s" }, { connector: "linkedin_ads", code: "c" }, { connector: "linkedin_ads", code: ["a", "b"], state: "s" }]) {
    const calls = await run(params, async () => ({ ok: true }));
    assert.equal(calls.posts.length, 0);
    assert.equal(calls.dialogs.length, 1);
  }
});

test("must catch: the same link delivered twice posts once, so a good connect never shows a false failure", async () => {
  const state = fresh("twice");
  let posts = 0;
  const backend = async () => {
    posts += 1;
    if (posts > 1) throw new ApiFetchError(403, "invalid_state", "replayed");
    await new Promise((r) => setTimeout(r, 2));
    return { ok: true };
  };
  const { calls, effect } = mount({ connector: "linkedin_ads", code: "c", state }, backend);
  effect();
  effect();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(posts, 1);
  assert.equal(calls.dialogs.length, 0);
  assert.equal(calls.tracked.length, 2);
  assert.ok(calls.tracked.every(([name]) => name === "connector_connected"));
});

test("must catch: the same link opened again after signing in is a new attempt, posts again and connects", async () => {
  const state = fresh("after-sign-in");
  let signedIn = false;
  let posts = 0;
  const backend = async () => {
    posts += 1;
    if (!signedIn) throw new ApiFetchError(401, "unauthorized", "Sign in");
    return { ok: true };
  };
  const params = { connector: "linkedin_ads", code: "c", state };
  const first = await run(params, backend);
  assert.equal(first.dialogs[0].message, "Sign in to Zavi, then tap Connect to link LinkedIn Ads again.");
  signedIn = true;
  const second = await run(params, backend);
  assert.equal(posts, 2);
  assert.equal(second.dialogs.length, 0);
  assert.deepEqual(plain(second.tracked), [["connector_connected", { slug: "linkedin_ads" }]]);
});

test("must catch: a network failure or a server error leaves the link usable, because nothing was refused", async () => {
  for (const failure of [() => new TypeError("Network request failed"), () => new ApiFetchError(500, "state_consume_failed", "x")]) {
    const params = { connector: "linkedin_ads", code: "c", state: fresh("retry") };
    let posts = 0;
    const backend = async () => {
      posts += 1;
      if (posts === 1) throw failure();
      return { ok: true };
    };
    await run(params, backend);
    const second = await run(params, backend);
    assert.equal(posts, 2);
    assert.equal(second.dialogs.length, 0);
  }
});

test("must catch: signed out and delivered twice at once posts once and both deliveries get the same answer", async () => {
  let posts = 0;
  const backend = async () => {
    posts += 1;
    await new Promise((r) => setTimeout(r, 2));
    throw new ApiFetchError(401, "unauthorized", "Sign in");
  };
  const { calls, effect } = mount({ connector: "linkedin_ads", code: "c", state: fresh("both") }, backend);
  effect();
  effect();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(posts, 1);
  assert.equal(calls.dialogs.length, 2);
  assert.ok(calls.dialogs.every((d) => /Sign in to Zavi/.test(d.message)));
});

test("must not catch: a connected link delivered again later never posts again, and neither does a link the server refused", async () => {
  const good = { connector: "linkedin_ads", code: "c", state: fresh("good") };
  let posts = 0;
  const ok = async () => {
    posts += 1;
    return { ok: true };
  };
  await run(good, ok);
  const again = await run(good, ok);
  assert.equal(posts, 1);
  assert.equal(again.dialogs.length, 0);
  const bad = { connector: "linkedin_ads", code: "c", state: fresh("bad") };
  let refusals = 0;
  const refuse = async () => {
    refusals += 1;
    throw new ApiFetchError(403, "state_session_mismatch", "started by another person");
  };
  const first = await run(bad, refuse);
  const second = await run(bad, refuse);
  assert.equal(refusals, 1);
  assert.equal(second.dialogs[0].message, first.dialogs[0].message);
});

test("signed out: it says to sign in and does not claim the link expired", async () => {
  const calls = await run({ connector: "linkedin_ads", code: "c", state: fresh("out") }, () => {
    throw new ApiFetchError(401, "unauthorized", "Sign in");
  });
  assert.equal(calls.dialogs[0].message, "Sign in to Zavi, then tap Connect to link LinkedIn Ads again.");
});

test("a failed exchange and a network failure both report a plain failure, never a raw server message", async () => {
  const exchange = await run({ connector: "linkedin_ads", code: "c", state: fresh("x") }, () => {
    throw new ApiFetchError(502, "connector_exchange_failed", "raw vendor secret text");
  });
  assert.equal(exchange.dialogs[0].message, "Couldn't connect LinkedIn Ads. Try again.");
  const net = await run({ connector: "linkedin_ads", code: "c", state: fresh("y") }, () => {
    throw new TypeError("Network request failed");
  });
  assert.equal(net.dialogs[0].message, "Couldn't connect LinkedIn Ads. Try again.");
});

const webLink = loadTs(src("lib/webLink.ts"));

test("must catch: the app's return link reaches the finish screen with code and state intact", () => {
  assert.equal(
    webLink.connectReturnPath(new URL("zavi://connectors/finish?connector=linkedin_ads&code=a%2Bb&state=s%2F1")),
    "/connectors/finish?connector=linkedin_ads&code=a%2Bb&state=s%2F1",
  );
});

test("must catch: Android's App Link to the web finish page opens the finish screen, not the Connectors list", () => {
  assert.equal(
    webLink.webLinkToAppPath(new URL("https://www.zaviagent.com/connectors/finish#connector=linkedin_ads&code=a%2Bb&state=s")),
    "/connectors/finish?connector=linkedin_ads&code=a%2Bb&state=s",
  );
});

test("must not catch: other connector links keep landing where they did", () => {
  assert.equal(webLink.webLinkToAppPath(new URL("https://www.zaviagent.com/connectors/finish")), "/toolkit");
  assert.equal(webLink.webLinkToAppPath(new URL("https://www.zaviagent.com/connectors?deeplink=connectors")), "/toolkit");
  assert.equal(webLink.webLinkToAppPath(new URL("https://evil.example/connectors/finish#code=c")), null);
  assert.equal(webLink.connectReturnPath(new URL("zavi://connectors/done?tab=settings&reddit_ads=connected")), "/connectors/done?tab=settings&reddit_ads=connected");
  assert.equal(webLink.connectReturnPath(new URL("zavi://evil/finish?code=c")), null);
});

const connectPlan = loadTs(src("features/connectors/connectPlan.ts"), {
  "@zavi/shared": {
    COMPOSIO_PREFIX: "composio.",
    PIPEDREAM_PREFIX: "pipedream.",
    UMBRELLA_GITHUB_LOGIN: "zavi",
    connectorSettingsPath: () => "/x",
    railFor: () => "native",
    satisfyingSlugs: (s) => [s],
  },
});

test("must not catch: LinkedIn Ads still starts a real connect on mobile, and its neighbours are unchanged", () => {
  const oauth = { connect: "oauth", label: "x", settingsAnchor: null };
  assert.equal(connectPlan.planConnect("linkedin_ads", oauth).kind, "oauth");
  assert.equal(connectPlan.planConnect("linkedin_ads", oauth).path, "/api/connectors/linkedin_ads/start");
  assert.equal(connectPlan.planConnect("meta_ads", oauth).path, "/api/connectors/meta-ads/start");
  assert.equal(connectPlan.planConnect("reddit_ads", oauth).path, "/api/connectors/reddit_ads/start");
});
