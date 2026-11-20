const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/webLink.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, URL, URLSearchParams, Set, Object, encodeURIComponent });
const { webLinkToAppPath, chatShareUrl } = mod.exports;
const at = (u) => webLinkToAppPath(new URL(u));

test("a thread link opens that chat thread", () => {
  assert.equal(at("https://www.zaviagent.com/workspace/abc-123?deeplink=thread"), "/chat?thread_id=abc-123");
});

test("a shared chat link is the private web thread link, and opens that chat in the app", () => {
  const id = "3f2a9c10-1111-4111-8111-111111111111";
  assert.equal(chatShareUrl(id), `https://www.zaviagent.com/workspace/${id}?deeplink=thread`);
  assert.equal(at(chatShareUrl(id)), `/chat?thread_id=${id}`);
  assert.equal(chatShareUrl(id, "operator"), `https://www.zaviagent.com/workspace/${id}?deeplink=thread`);
});

test("a shared specialist chat reopens on that agent, not Zavi", () => {
  const id = "3f2a9c10-1111-4111-8111-111111111111";
  assert.equal(chatShareUrl(id, "research"), `https://www.zaviagent.com/workspace/${id}?deeplink=thread&agent=research`);
  assert.equal(at(chatShareUrl(id, "research")), `/chat?thread_id=${id}&slug=research`);
});

test("workspace pages that are not threads open the chat", () => {
  assert.equal(at("https://www.zaviagent.com/workspace?deeplink=chat"), "/chat");
  assert.equal(at("https://www.zaviagent.com/workspace/members"), "/chat");
  assert.equal(at("https://www.zaviagent.com/workspace/abc/extra"), "/chat");
});

test("approvals, growth and connectors open their screens", () => {
  assert.equal(at("https://www.zaviagent.com/approvals?deeplink=approvals"), "/chat");
  assert.equal(at("https://www.zaviagent.com/growth?deeplink=growth"), "/growth");
  assert.equal(at("https://www.zaviagent.com/connectors?deeplink=connectors"), "/toolkit");
  assert.equal(at("https://www.zaviagent.com/workspace?tab=analytics#email"), "/analytics");
});

test("an invite keeps its id", () => {
  assert.equal(at("https://www.zaviagent.com/invite/accept?id=inv_1&deeplink=invite"), "/invite/accept?id=inv_1");
  assert.equal(at("https://zaviagent.com/invite/accept"), "/invite/accept");
});

test("a reset link carries its token to the set-password screen", () => {
  assert.equal(
    at("https://www.zaviagent.com/auth/reset?next=%2Freset-password&token_hash=abc&type=recovery&deeplink=reset"),
    "/reset-password?token_hash=abc",
  );
  assert.equal(at("https://www.zaviagent.com/auth/reset?deeplink=reset"), "/reset-password");
});

test("other zaviagent.com pages land on the entry gate", () => {
  assert.equal(at("https://www.zaviagent.com/pricing"), "/");
});

test("other hosts and non-https links are not ours", () => {
  assert.equal(at("https://example.com/workspace/abc"), null);
  assert.equal(at("http://www.zaviagent.com/workspace/abc"), null);
  assert.equal(at("zavi://auth/callback"), null);
});

function routeParams(route) {
  const u = new URL(route, "app://zavi");
  return { pathname: u.pathname, thread_id: u.searchParams.get("thread_id"), slug: u.searchParams.get("slug") };
}

test("a shared chat comes back with the same thread and agent, for real ids and agent names", () => {
  const ids = ["3f2a9c10-1111-4111-8111-111111111111", "00000000-0000-4000-8000-000000000000"];
  const slugs = ["research", "seo-geo", "chief-of-staff", "performance-marketer", "meta_ads", "ugc"];
  for (const id of ids) {
    for (const slug of slugs) {
      const back = routeParams(at(chatShareUrl(id, slug)));
      assert.deepEqual(back, { pathname: "/chat", thread_id: id, slug }, `${id} / ${slug}`);
    }
  }
});

test("a chat with Zavi itself, or no agent named, comes back on Zavi (no slug)", () => {
  const id = "3f2a9c10-1111-4111-8111-111111111111";
  for (const slug of ["operator", "", undefined]) {
    assert.deepEqual(routeParams(at(chatShareUrl(id, slug))), { pathname: "/chat", thread_id: id, slug: null }, String(slug));
  }
});

test("a shared link is always the https zaviagent.com thread link iOS and Android will hand to the app", () => {
  const id = "3f2a9c10-1111-4111-8111-111111111111";
  for (const slug of [undefined, "operator", "research"]) {
    const u = new URL(chatShareUrl(id, slug));
    assert.equal(u.protocol, "https:");
    assert.equal(u.hostname, "www.zaviagent.com");
    assert.equal(u.pathname, `/workspace/${id}`);
    assert.equal(u.searchParams.get("deeplink"), "thread");
  }
});

test("only our own https links open the app: another host or plain http maps to nothing", () => {
  const id = "3f2a9c10-1111-4111-8111-111111111111";
  assert.equal(at(chatShareUrl(id).replace("https://", "http://")), null);
  assert.equal(at(chatShareUrl(id).replace("www.zaviagent.com", "evil.example")), null);
  assert.equal(at(chatShareUrl(id).replace("www.zaviagent.com", "zaviagent.com.evil.example")), null);
  assert.equal(at(chatShareUrl(id).replace("www.", "")) !== null, true, "the bare domain is ours too");
});

test("a UGC Videos drawer link (email, notification, Stripe return) opens its phone screen", () => {
  const hub = "https://www.zaviagent.com/workspace?tab=channels&channel=ugc";
  assert.equal(at(`${hub}&drawer=job&job=o-1&paid=1`), "/channels/ugc/job/o-1");
  assert.equal(at(`${hub}&drawer=review&job=o-2`), "/channels/ugc/job/o-2");
  assert.equal(at(`${hub}&drawer=thread&creator=invite%3Aabc`), "/channels/ugc/thread/invite%3Aabc");
  assert.equal(at(`${hub}&drawer=applicants&brief=b1&application=a1&hire_cancelled=1`), "/channels/ugc/applicants/b1");
  assert.equal(at(`${hub}&drawer=hire&offer=of1`), "/channels/ugc/hire?offer=of1");
  assert.equal(at(`${hub}&drawer=hire&application=a1&brief=b1`), "/channels/ugc/hire?application=a1&brief=b1");
  assert.equal(at(`${hub}&drawer=brief`), "/channels/ugc/brief/new");
  assert.equal(at(`${hub}&drawer=inbox`), "/channels/ugc/inbox");
  assert.equal(at(hub), "/channels/actions/ugc");
  assert.equal(at("https://www.zaviagent.com/workspace?tab=channels&channel=meta_ads"), "/chat");
});

test("a connector sign-in finished in the browser comes back to the connect screen with its result, not the chat", () => {
  assert.equal(
    at("https://www.zaviagent.com/workspace?tab=settings&linkedin_social=connected"),
    "/connectors/done?tab=settings&linkedin_social=connected",
  );
  assert.equal(
    at("https://www.zaviagent.com/workspace?tab=settings&slack_error=invalid_state"),
    "/connectors/done?tab=settings&slack_error=invalid_state",
  );
  assert.equal(
    at("https://www.zaviagent.com/workspace?tab=settings&composio_error=youtube&code=missing_params"),
    "/connectors/done?tab=settings&composio_error=youtube&code=missing_params",
  );
  assert.equal(at("https://www.zaviagent.com/workspace?tab=settings"), "/chat");
  const { connectReturnPath } = mod.exports;
  assert.equal(
    connectReturnPath(new URL("zavi://connectors/done?tab=settings&connect_error=invalid_state&provider=x_social")),
    "/connectors/done?tab=settings&connect_error=invalid_state&provider=x_social",
  );
  assert.equal(connectReturnPath(new URL("zavi://connectors/done")), "/connectors/done");
  assert.equal(connectReturnPath(new URL("zavi://connectors/other")), null);
});
