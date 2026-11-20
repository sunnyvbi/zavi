const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const analytics = loadTs(path.join(__dirname, "../src/lib/analyticsCore.ts"));
const plain = (value) => JSON.parse(JSON.stringify(value));

test("failureReason buckets timeout, network, and server failures", () => {
  assert.equal(analytics.failureReason({ name: "AbortError" }), "timeout");
  assert.equal(analytics.failureReason(new TypeError("offline")), "network");
  assert.equal(analytics.failureReason(new Error("500")), "server");
});

test("screenFromSegments drops route groups and keeps placeholders", () => {
  assert.deepEqual(plain(analytics.screenFromSegments(["(auth)", "welcome"])), {
    screen_name: "welcome",
    screen_group: "auth",
  });
  assert.deepEqual(plain(analytics.screenFromSegments(["(onboarding)", "website"])), {
    screen_name: "website",
    screen_group: "onboarding",
  });
  assert.deepEqual(plain(analytics.screenFromSegments(["agents", "[id]"])), {
    screen_name: "agents/[id]",
    screen_group: "agents",
  });
  assert.deepEqual(plain(analytics.screenFromSegments(["settings", "billing"])), {
    screen_name: "settings/billing",
    screen_group: "billing",
  });
  assert.deepEqual(plain(analytics.screenFromSegments([])), {
    screen_name: "index",
    screen_group: "other",
  });
});

test("authAnalyticsEvent classifies first sign-in as signup and later sign-in as login", () => {
  assert.deepEqual(
    plain(analytics.authAnalyticsEvent({
      created_at: "2026-10-13T10:00:00.000Z",
      last_sign_in_at: "2026-10-13T10:00:30.000Z",
      app_metadata: { provider: "google" },
    })),
    { event: "signup_completed", method: "google" },
  );
  assert.deepEqual(
    plain(analytics.authAnalyticsEvent({
      created_at: "2026-10-13T10:00:00.000Z",
      last_sign_in_at: "2026-10-13T10:05:00.000Z",
      app_metadata: {},
    })),
    { event: "logged_in", method: "email" },
  );
});

test("appEnvironment is production only for non-dev production builds", () => {
  assert.equal(analytics.appEnvironment(false, "production"), "production");
  assert.equal(analytics.appEnvironment(true, "production"), "development");
  assert.equal(analytics.appEnvironment(false, "development"), "development");
  assert.equal(analytics.appEnvironment(false, undefined), "development");
});

test("sendsToMixpanel skips events that backend sends itself", () => {
  assert.equal(analytics.sendsToMixpanel("chat_message_sent"), false);
  assert.equal(analytics.sendsToMixpanel("connector_connected"), false);
  assert.equal(analytics.sendsToMixpanel("product_feedback_submitted"), false);
  assert.equal(analytics.sendsToMixpanel("signup_completed"), true);
});

test("firstThisDevice is true once per key and true again for another company", async () => {
  const saved = new Map();
  const store = {
    getItem: async (key) => saved.get(key) ?? null,
    setItem: async (key, value) => void saved.set(key, value),
  };
  assert.equal(await analytics.firstThisDevice(store, "zavi_first_result:a"), true);
  assert.equal(await analytics.firstThisDevice(store, "zavi_first_result:a"), false);
  assert.equal(await analytics.firstThisDevice(store, "zavi_first_result:b"), true);
});

test("firstThisDevice counts a storage failure as first, like the web", async () => {
  const broken = {
    getItem: async () => {
      throw new Error("storage unavailable");
    },
    setItem: async () => {},
  };
  assert.equal(await analytics.firstThisDevice(broken, "zavi_first_result:a"), true);
});
