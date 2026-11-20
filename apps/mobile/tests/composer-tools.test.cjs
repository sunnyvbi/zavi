const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const shared = loadTs(path.join(__dirname, "../../../packages/shared/src/composer/slash-commands.ts"));
const t = loadTs(path.join(__dirname, "../src/features/agents/composerTools.ts"), { "@zavi/shared": shared });
const plain = (v) => JSON.parse(JSON.stringify(v));

test("slash menu opens only while a command is being typed", () => {
  assert.equal(t.slashQuery("/"), "");
  assert.equal(t.slashQuery("/Dec"), "dec");
  assert.equal(t.slashQuery("/run now"), null);
  assert.equal(t.slashQuery("hi /"), null);
});

test("slash filter matches the command or a word of the plain name", () => {
  assert.equal(t.filterSlash("").length, 5);
  assert.deepEqual(plain(t.filterSlash("dec").map((c) => c.kind)), ["decision"]);
  assert.deepEqual(plain(t.filterSlash("appro").map((c) => c.kind)), ["decision"]);
  assert.deepEqual(plain(t.filterSlash("zzz")), []);
});

const ID = "3f2a9c1e-1b2c-4d5e-8f90-1234567890ab";

test("typed commands parse like web parseInput", () => {
  assert.deepEqual(plain(t.parseSend("/clear okay")), { kind: "clear" });
  assert.deepEqual(plain(t.parseSend(" /help ")), { kind: "help" });
  assert.deepEqual(plain(t.parseSend("/run check signups")), { kind: "force_run", body: "check signups" });
  assert.deepEqual(plain(t.parseSend("/feedback be brief")), { kind: "feedback", body: "be brief" });
  assert.deepEqual(plain(t.parseSend("/feedback")), { kind: "unknown_command" });
  assert.deepEqual(plain(t.parseSend(`/decision ${ID} why?`)), { kind: "attach_decision", decisionId: ID, body: "why?" });
  assert.deepEqual(plain(t.parseSend("/decision nope why")), { kind: "unknown_command" });
  assert.deepEqual(plain(t.parseSend("/unknown x")), { kind: "unknown_command" });
  assert.deepEqual(plain(t.parseSend("/ hi")), { kind: "chat", body: "/ hi" });
  assert.deepEqual(plain(t.parseSend("hello")), { kind: "chat", body: "hello" });
});

test("turn text: /run empty is a forced run, /decision sends only its words", () => {
  assert.equal(t.turnText(t.parseSend("/run")), "(forced run)");
  assert.equal(t.turnText(t.parseSend(`/decision ${ID} why?`)), "why?");
  assert.equal(t.turnText(t.parseSend("/clear")), null);
});

test("hint explains a typed command, and nothing for plain text", () => {
  assert.equal(t.slashHint("hello"), null);
  assert.equal(t.slashHint("/clear"), "Send to start a fresh chat.");
  assert.match(t.slashHint("/decision "), /^Pick the approval from the \/ list/);
  assert.match(t.slashHint("/decision bad"), /^Pick the approval from the \/ list/);
  assert.match(t.slashHint("/feedback"), /^Add <rule> after \/feedback/);
  assert.match(t.slashHint("/nope"), /^Unknown command/);
  assert.equal(t.slashHint(`/decision ${ID}`), "Send to attach decision 3f2a9c1e… as context.");
});

test("feedback confirmation matches web", () => {
  assert.match(t.feedbackConfirmation("x", "suggested"), /^Suggested as a rule/);
  assert.equal(t.feedbackConfirmation("x", "exists"), 'That rule is already saved: "x".');
  assert.match(t.feedbackConfirmation("x", "active"), /^Rule saved/);
});

test("mention query is the trailing @word, and picking strips it", () => {
  assert.equal(t.mentionQuery("@"), "");
  assert.equal(t.mentionQuery("run ads on @me"), "me");
  assert.equal(t.mentionQuery("mail me@x.com"), null);
  assert.equal(t.mentionQuery("@meta ads"), null);
  assert.equal(t.stripMention("run ads on @me"), "run ads on ");
  assert.equal(t.stripMention("@goo"), "");
});

test("mention filter matches name or executor", () => {
  const all = [
    { name: "Meta Ads", executor: "meta_ads" },
    { name: "LinkedIn", executor: "linkedin_organic" },
  ];
  assert.equal(t.filterMentions(all, "").length, 2);
  assert.deepEqual(plain(t.filterMentions(all, "link").map((c) => c.name)), ["LinkedIn"]);
  assert.deepEqual(plain(t.filterMentions(all, "META_").map((c) => c.name)), ["Meta Ads"]);
});

test("sent message: a picked channel rides in front, same as web", () => {
  assert.equal(t.composeMessage(" hi ", null), "hi");
  assert.equal(t.composeMessage("raise it", { executor: "google_ads" }), "@google_ads raise it");
});

test("a picked channel with no words is not sent; the hint names the channel", () => {
  const meta = { name: "Meta Ads", executor: "meta_ads" };
  assert.equal(t.emptyMentionHint("", meta), "Add your question for Meta Ads.");
  assert.equal(t.emptyMentionHint("   \n ", meta), "Add your question for Meta Ads.");
  assert.equal(t.composeMessage("", meta), "@meta_ads");
});

test("the empty-mention block lets a real turn through", () => {
  const meta = { name: "Meta Ads", executor: "meta_ads" };
  assert.equal(t.emptyMentionHint("raise the budget", meta), null);
  assert.equal(t.emptyMentionHint("", null), null);
  assert.equal(t.emptyMentionHint("", meta, { id: "d1", summary: "Raise budget" }), null);
});

test("a typed bare @executor still splits into its channel with no words", () => {
  const channels = [{ executor: "meta_ads", name: "Meta Ads" }];
  assert.deepEqual(plain(t.splitChannelMention("@meta_ads", channels)), { channel: channels[0], body: "" });
  assert.deepEqual(plain(t.splitChannelMention("@meta_ads   ", channels)), { channel: channels[0], body: "" });
});

test("mention query ends at the first space after the @word", () => {
  assert.equal(t.mentionQuery("@meta_ads "), null);
  assert.equal(t.mentionQuery("ask @meta_ads raise"), null);
  assert.equal(t.mentionQuery("ask @meta_a"), "meta_a");
});

test("library files: only what attach-artifact takes, newest 12", () => {
  const f = (filename, mime = "application/octet-stream") => ({ filename, mime, created_at: "" });
  assert.equal(t.isAttachableFile(f("a.pdf")), true);
  assert.equal(t.isAttachableFile(f("notes.MD")), true);
  assert.equal(t.isAttachableFile(f("x", "image/png")), true);
  assert.equal(t.isAttachableFile(f("tab-task-1.jpg", "image/jpeg")), false);
  assert.equal(t.isAttachableFile(f("deck.pptx")), false);
  const many = Array.from({ length: 20 }, (_, i) => f(`${i}.csv`));
  assert.equal(t.libraryFiles(many).length, 12);
});

test("library attach: a full slot is caught before the server copy", () => {
  const caps = { image: 4, doc: 4 };
  const png = { mime: "image/png" };
  const pdf = { mime: "application/pdf" };
  assert.equal(t.libraryAttachBlock(png, { image: 0, doc: 0 }, caps), null);
  assert.equal(t.libraryAttachBlock(png, { image: 3, doc: 4 }, caps), null);
  assert.equal(t.libraryAttachBlock(png, { image: 4, doc: 0 }, caps), "Max 4 images per message.");
  assert.equal(t.libraryAttachBlock(pdf, { image: 4, doc: 3 }, caps), null);
  assert.equal(t.libraryAttachBlock(pdf, { image: 0, doc: 4 }, caps), "Max 4 files per message.");
  assert.equal(t.libraryAttachBlock(png, { image: 4, doc: 4 }, caps), "This message is already full of attachments.");
  assert.equal(t.libraryAttachBlock(pdf, { image: 4, doc: 4 }, caps), "This message is already full of attachments.");
});

test("ago reads like the wireframe", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(t.ago("2026-10-02T11:59:50Z", now), "just now");
  assert.equal(t.ago("2026-09-30T12:00:00Z", now), "2 days ago");
  assert.equal(t.ago("2026-09-25T12:00:00Z", now), "1 week ago");
  assert.equal(t.ago("bad", now), "");
});

test("a sent @executor turn splits into its channel and words, like web", () => {
  const channels = [{ executor: "meta_ads", name: "Meta Ads" }];
  assert.deepEqual(plain(t.splitChannelMention("@meta_ads raise budget", channels)), {
    channel: channels[0],
    body: "raise budget",
  });
  assert.deepEqual(plain(t.splitChannelMention("@nobody hi", channels)), { channel: null, body: "@nobody hi" });
  assert.deepEqual(plain(t.splitChannelMention("hi @meta_ads", channels)), { channel: null, body: "hi @meta_ads" });
});

test("a picked approval's id is added in code, and the bubble reads it back", () => {
  const approval = { id: ID, summary: 'Raise "Spring" budget' };
  const msg = t.composeMessage("why now?", null, approval);
  assert.equal(msg, `About the approval "Raise 'Spring' budget" (decision ${ID}):\nwhy now?`);
  assert.deepEqual(plain(t.splitApprovalContext(msg)), {
    approval: { summary: "Raise 'Spring' budget", id: ID },
    body: "why now?",
  });
  assert.match(t.composeMessage("", null, approval), /Tell me about this approval\.$/);
  assert.equal(t.composeMessage("hi", { executor: "meta_ads" }, approval).startsWith("@meta_ads About the approval"), true);
  assert.deepEqual(plain(t.splitApprovalContext("plain words")), { approval: null, body: "plain words" });
});

test("approval summary reads the same keys as the approval card", () => {
  assert.equal(t.approvalSummary({ title: " Publish page " }), "Publish page");
  assert.equal(t.approvalSummary(null), "An approval");
});
