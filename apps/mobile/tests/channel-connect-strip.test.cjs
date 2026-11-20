const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadDisplay() {
  const file = path.join(__dirname, "..", "src/features/channels/display.ts");
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name === "@zavi/shared") {
          return { getChannel: (slug) => ({ name: slug.toUpperCase(), description: "d", connectors: ["google_search_console"] }), socialLimit: () => null, PHONE_APPROVE_EXEC: new Set(["seo.create_pr.v1", "geo.create_pr.v1", "generated_video.render.v1"]), EMAIL_SEND_EXEC: "email_campaign.create_and_send" };
        }
        if (name === "./channelList") return { CHANNEL_ORDER: ["seo"] };
        if (name === "./cardCopy") return { cardCopy: () => null };
        throw new Error(`Unexpected dependency: ${name}`);
      },
    },
    { filename: "display.ts" },
  );
  return module.exports;
}
const { buildChannelList } = loadDisplay();
const approvals = { decisions: [], channel_pending_counts: {} };

test("before /api/channels answers, nothing asks to connect", () => {
  const [item] = buildChannelList(undefined, approvals);
  assert.equal(item.needsConnect, false);
});

test("once it answers, a channel the server says is not connected asks to connect", () => {
  const [item] = buildChannelList([{ channel_slug: "seo", connected: false, connectors: ["google_search_console"], work_state: "idle", locked: false, runnable: true }], approvals);
  assert.equal(item.needsConnect, true);
});

test("and a connected one (SEO reads public pages) does not", () => {
  const [item] = buildChannelList([{ channel_slug: "seo", connected: true, connectors: ["google_search_console"], work_state: "idle", locked: false, runnable: true }], approvals);
  assert.equal(item.needsConnect, false);
});
