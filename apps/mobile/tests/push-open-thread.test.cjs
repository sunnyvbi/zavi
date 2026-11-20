const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load() {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/lib/push.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  let handler = null;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod,
    exports: mod.exports,
    process: { env: {} },
    Promise,
    require: (name) => {
      if (name === "react-native") return { Platform: { OS: "ios" } };
      if (name === "expo-notifications")
        return { setNotificationHandler: (h) => (handler = h.handleNotification), AndroidImportance: {} };
      if (name === "./api") return { apiFetch: async () => ({}) };
      return {};
    },
  });
  return { push: mod.exports, handle: (data) => handler({ request: { content: { data } } }) };
}

test("push about the open chat: no banner, no sound", async () => {
  const { push, handle } = load();
  push.initNotifications();
  push.setOpenThread("thread-1");
  const r = await handle({ thread_id: "thread-1" });
  assert.equal(r.shouldShowBanner, false);
  assert.equal(r.shouldPlaySound, false);
});

test("push about another chat, or with no chat open: banner shows", async () => {
  const { push, handle } = load();
  push.initNotifications();
  push.setOpenThread("thread-1");
  assert.equal((await handle({ thread_id: "thread-2" })).shouldShowBanner, true);
  push.setOpenThread(null);
  assert.equal((await handle({ thread_id: "thread-1" })).shouldShowBanner, true);
  assert.equal((await handle({ type: "approval" })).shouldShowBanner, true);
});
