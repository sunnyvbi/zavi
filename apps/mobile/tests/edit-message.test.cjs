const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(rel) {
  const source = fs.readFileSync(path.join(__dirname, rel), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
  return mod.exports;
}

const { editableMessageIds, rowsFromMessage, messageMenuTime } = load("../src/features/agents/editMessage.ts");
const plain = (v) => JSON.parse(JSON.stringify(v));

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "44444444-4444-4444-8444-444444444444";
const A1 = "33333333-3333-4333-8333-333333333333";
const user = (id, extra = {}) => ({ id, sender_role: "user", ...extra });
const reply = (id) => ({ id, sender_role: "assistant" });
const noVideo = () => false;
const ids = (messages, hasVideo = noVideo) => [...editableMessageIds(messages, hasVideo)];

test("every answered user message offers Edit, not only the newest", () => {
  assert.deepEqual(ids([user(U1), reply(A1), user(U2), reply("r2"), user(U3)]), [U3, U2, U1]);
});

test("the newest message offers Edit even before Zavi has answered", () => {
  assert.deepEqual(ids([user(U1), reply(A1), user(U2)]), [U2, U1]);
});

test("a message directly followed by another user message offers no Edit", () => {
  assert.deepEqual(ids([user(U1), user(U2), reply(A1)]), [U2]);
});

test("a reply of role agent counts as an answer", () => {
  assert.deepEqual(ids([user(U1), { id: A1, sender_role: "agent" }, user(U2)]), [U2, U1]);
});

test("system rows are not turns: they do not break or fake a following user message", () => {
  const note = { id: "note-1", sender_role: "system" };
  assert.deepEqual(ids([user(U1), note, reply(A1)]), [U1]);
  assert.deepEqual(ids([user(U1), note, user(U2)]), [U2]);
});

test("an optimistic (not yet saved) message offers no Edit, and the user message right before it loses it", () => {
  assert.deepEqual(ids([user(U1), reply(A1), user("optimistic-3")]), [U1]);
  assert.deepEqual(ids([user(U1), user("optimistic-3")]), []);
});

test("a message with a photo or file offers no Edit, its neighbours still do", () => {
  const withPhoto = user(U2, { attachments: [{ path: "a.jpg", kind: "image" }] });
  assert.deepEqual(ids([user(U1), reply(A1), withPhoto, reply("r2"), user(U3)]), [U3, U1]);
  assert.deepEqual(ids([user(U1, { attachments: [] })]), [U1]);
  assert.deepEqual(ids([user(U1, { attachments: null })]), [U1]);
});

test("a message this phone sent a video with offers no Edit", () => {
  assert.deepEqual(ids([user(U1), reply(A1), user(U2)], (id) => id === U1), [U2]);
});

test("no user message, no Edit", () => {
  assert.deepEqual(ids([reply(A1)]), []);
  assert.deepEqual(ids([]), []);
});

test("an edit replaces the edited message and every row after it", () => {
  const rows = [user(U1), reply(A1), user(U2), reply("r2")];
  assert.deepEqual(plain(rowsFromMessage(rows, U2)), [U2, "r2"]);
  assert.deepEqual(plain(rowsFromMessage(rows, U1)), [U1, A1, U2, "r2"]);
  assert.deepEqual(plain(rowsFromMessage(rows, "missing")), []);
});

const NOW = new Date(2026, 9, 7, 12, 0);
const at = (...parts) => new Date(...parts).toISOString();

test("menu time: within the last 7 days shows the weekday and time", () => {
  assert.equal(messageMenuTime(at(2026, 9, 3, 17, 47), NOW), "Saturday, 5:47 PM");
  assert.equal(messageMenuTime(at(2026, 9, 7, 9, 5), NOW), "Wednesday, 9:05 AM");
  assert.equal(messageMenuTime(at(2026, 9, 7, 0, 0), NOW), "Wednesday, 12:00 AM");
  assert.equal(messageMenuTime(at(2026, 9, 6, 12, 30), NOW), "Tuesday, 12:30 PM");
});

test("menu time: 7 days or older shows the date, with the year only when it differs", () => {
  assert.equal(messageMenuTime(at(2026, 8, 30, 10, 0), NOW), "Sep 30, 10:00 AM");
  assert.equal(messageMenuTime(at(2026, 8, 20, 9, 5), NOW), "Sep 20, 9:05 AM");
  assert.equal(messageMenuTime(at(2025, 11, 31, 23, 59), NOW), "Dec 31, 2025, 11:59 PM");
});

test("menu time: a date that won't parse gives no line", () => {
  assert.equal(messageMenuTime("not-a-date", NOW), null);
  assert.equal(messageMenuTime("", NOW), null);
});
