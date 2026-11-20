const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/connectors/connectResult.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, URLSearchParams, Object });
const { readConnectResult } = mod.exports;
const names = { slack: "Slack", linkedin_social: "LinkedIn", x_social: "X", google_ads: "Google Ads", "composio.youtube": "YouTube", meta_ads: "Meta Ads", tiktok: "TikTok", github: "GitHub" };
const read = (qs) => JSON.parse(JSON.stringify(readConnectResult(new URLSearchParams(qs), (s) => names[s] ?? s)));

test("success: any <slug>=connected, including Composio and the extras that ride along", () => {
  assert.deepEqual(read("tab=settings&slack=connected&team=T1"), { kind: "connected", slug: "slack" });
  assert.deepEqual(read("tab=settings&github=connected&action=install"), { kind: "connected", slug: "github" });
  assert.deepEqual(read("tab=settings&composio_youtube=connected"), { kind: "connected", slug: "composio.youtube" });
  assert.deepEqual(read("tab=settings&linkedin_social=connected"), { kind: "connected", slug: "linkedin_social" });
});

test("Slack errors use the web's copy", () => {
  assert.equal(read("tab=settings&slack_error=invalid_state").message, "Your Slack connection link expired. Tap Connect and try again.");
  assert.equal(read("tab=settings&slack_error=missing_code").message, "Slack didn't finish the connection. Please try again.");
  assert.equal(read("tab=settings&slack_error=save_failed").message, "We couldn't save your Slack connection. Please try again.");
  assert.equal(read("tab=settings&slack_error=weird").message, "Slack connection failed. Please try again.");
});

test("Composio errors name the app and say why", () => {
  const r = read("tab=settings&composio_error=youtube&code=missing_params");
  assert.equal(r.kind, "failed");
  assert.equal(r.slug, "composio.youtube");
  assert.equal(r.message, "YouTube didn't finish connecting. If you cancelled, tap Connect to try again.");
  assert.equal(read("tab=settings&composio_error=unknown&code=composio_verify_failed").message, "Couldn't connect the app. Try again.");
});

test("error pages turned into app returns (cancel, expired link, unavailable, no accounts)", () => {
  assert.equal(read("tab=settings&connect_error=invalid_state&provider=x_social").message, "The X sign-in link expired. Tap Connect and try again.");
  assert.equal(
    read("tab=settings&connect_error=permission_denied&provider=google_ads").message,
    "Google Ads didn't finish connecting. If you cancelled, tap Connect to try again.",
  );
  assert.equal(read("tab=settings&connect_error=missing_params&provider=tiktok").slug, "tiktok");
  assert.equal(
    read("tab=settings&connect_error=connector_misconfigured&provider=linkedin_social").message,
    "LinkedIn isn't available yet. Email support@zaviagent.com if you need it turned on.",
  );
  assert.equal(
    read("tab=settings&connect_error=no_ad_accounts&provider=meta_ads").message,
    "Your Meta Ads sign-in has no account Zavi can read. Try a different login.",
  );
  assert.equal(read("tab=settings&connect_error=failed&provider=github").message, "Couldn't connect GitHub. Try again.");
});

test("Meta's 'connected, expiry not recorded' page is a success", () => {
  assert.deepEqual(read("tab=settings&connect_error=connected_but_expiry_not_recorded&provider=meta_ads"), { kind: "connected", slug: "meta_ads" });
});

test("a bare return link reports nothing", () => {
  assert.deepEqual(read(""), { kind: "none" });
  assert.deepEqual(read("tab=settings"), { kind: "none" });
});
