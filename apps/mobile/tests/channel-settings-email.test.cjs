const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const C = loadTs(path.join(__dirname, "../src/features/channels/settingsConfig.ts"));
const S = loadTs(path.join(__dirname, "../src/features/channels/channelSettings.ts"));
const OWNER_SENTENCE = "Only an owner or an admin can change this.";
const RETRY = /press Save|try again/i;

test("mobile Email campaigns settings declare exactly the fields web declares", () => {
  const web = fs.readFileSync(path.join(__dirname, "../../web/src/components/workspace/actions/platforms/email_marketing.ts"), "utf8");
  const settingsBlock = web.slice(web.indexOf("settings: ["));
  const webIds = [...settingsBlock.matchAll(/^\s*id:\s*"([a-z_]+)"/gm)].map((m) => m[1]);
  assert.ok(webIds.length > 0);
  assert.deepEqual([...C.settingsFor("email_marketing").map((f) => f.id)], webIds);
});

test("no channel on mobile offers the retired email fields", () => {
  for (const [slug, fields] of Object.entries(C.CHANNEL_SETTINGS)) {
    for (const f of fields) {
      assert.ok(!["sending_domain", "esp"].includes(f.id), `${slug}.${f.id}`);
      if (slug === "email_marketing") assert.notEqual(f.id, "postal_address");
    }
  }
});

test("only owners and admins can edit settings", () => {
  assert.equal(S.canEditSettings("owner"), true);
  assert.equal(S.canEditSettings("admin"), true);
  for (const r of ["member", "viewer", "", null, undefined, "Owner"]) assert.equal(S.canEditSettings(r), false, String(r));
});

test("a 403 anywhere in a save names owners and admins and never asks for a retry", () => {
  assert.equal(S.saveNote([403], 1), OWNER_SENTENCE);
  assert.equal(S.saveNote([500, 403], 3), OWNER_SENTENCE);
  assert.doesNotMatch(S.saveNote([403, null], 2), RETRY);
  assert.match(S.saveNote([500], 1), /1 of 1 didn't save/);
  assert.equal(S.saveNote([], 2), "Saved. Applies on the next run.");
});

function harness({ role, mutate }) {
  const slots = [];
  let i = 0;
  const react = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = typeof init === "function" ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === "function" ? v(slots[k]) : v; }];
    },
    useEffect(fn) {
      fn();
    },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  };
  const calls = [];
  const { ChannelSettings } = loadTs(path.join(__dirname, "../src/components/channels/ChannelSettings.tsx"), {
    react,
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View", Switch: "Switch", TextInput: "TextInput", StyleSheet: { create: (s) => s, hairlineWidth: 1 } },
    "./UgcParts": { StateLine: "StateLine" },
    "../OptionSheet": { OptionSheet: "OptionSheet" },
    "../Icon": { Icon: "Icon" },
    "../growth/StoryKit": { TextLink: "TextLink" },
    "../ZaviTextField": { FocusRing: "FocusRing" },
    "../../lib/api": { apiFetch: async () => ({ ok: true }) },
    "../../features/channels/ugcHooks": {
      useChannelSettings: () => ({ data: { number_route: [{ item: "none" }] }, isError: false, isLoading: false, refetch: async () => {} }),
      useSaveSetting: () => ({ isPending: false, mutateAsync: async (v) => { calls.push(v); return mutate(v); } }),
    },
    "../../features/channels/settingsConfig": C,
    "../../features/settings/api": { useMyRole: () => role },
    "../../theme/tokens": { font: { family: {} }, radius: {}, space: {} },
    "../../theme/theme": { useStyles: () => ({}), useTheme: () => ({ colors: {} }) },
  });
  const fields = C.settingsFor("sms");
  const render = () => {
    i = 0;
    return ChannelSettings({ slug: "sms", fields });
  };
  return { render, calls };
}

const walk = (n) => (!n || typeof n !== "object" ? [] : [n, ...(n.children || []).flatMap(walk)]);
const texts = (tree) => walk(tree).flatMap((n) => n.children.filter((c) => typeof c === "string")).join("\n");
const saveButton = (tree) => walk(tree).find((n) => n.type === "Pressable" && texts(n).match(/Save settings|Saving/));
const option = (tree, label) => walk(tree).find((n) => n.type === "Pressable" && texts(n) === label);

test("a member sees no Save button, even after editing, and is told who can change it", () => {
  for (const role of ["member", null]) {
    const h = harness({ role, mutate: async () => ({}) });
    let tree = h.render();
    assert.equal(saveButton(tree), undefined);
    option(tree, "Toll-free, verified").props.onPress();
    tree = h.render();
    assert.equal(saveButton(tree), undefined);
    assert.match(texts(tree), new RegExp(OWNER_SENTENCE.replace(".", "\\.")));
    assert.doesNotMatch(texts(tree), RETRY);
    assert.equal(h.calls.length, 0);
  }
});

test("an admin whom the server refuses with 403 gets the owner/admin sentence, never a retry prompt", async () => {
  const h = harness({ role: "admin", mutate: async () => { throw Object.assign(new Error("Forbidden"), { status: 403, code: "forbidden" }); } });
  let tree = h.render();
  option(tree, "10DLC, registered").props.onPress();
  tree = h.render();
  const save = saveButton(tree);
  assert.equal(save.props.disabled, false);
  await save.props.onPress();
  await new Promise((r) => setTimeout(r, 0));
  tree = h.render();
  assert.equal(h.calls.length, 1);
  assert.match(texts(tree), new RegExp(OWNER_SENTENCE.replace(".", "\\.")));
  assert.doesNotMatch(texts(tree), RETRY);
});

test("an admin whose save fails for another reason is still offered the retry", async () => {
  const h = harness({ role: "owner", mutate: async () => { throw Object.assign(new Error("boom"), { status: 500 }); } });
  let tree = h.render();
  option(tree, "10DLC, registered").props.onPress();
  tree = h.render();
  await saveButton(tree).props.onPress();
  await new Promise((r) => setTimeout(r, 0));
  tree = h.render();
  assert.match(texts(tree), /1 of 1 didn't save/);
  assert.doesNotMatch(texts(tree), new RegExp(OWNER_SENTENCE.replace(".", "\\.")));
});
