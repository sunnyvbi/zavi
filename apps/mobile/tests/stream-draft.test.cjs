const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const panelMod = loadTs(path.join(__dirname, "../../../packages/shared/src/runs/run-panel.ts"));
const shared = {
  DRAFTING: panelMod.DRAFTING,
  buildRunPanel: panelMod.buildRunPanel,
  looksLikeNarration: panelMod.looksLikeNarration,
  thoughtText: panelMod.thoughtText,
};
const { streamDraftPreview } = loadTs(path.join(__dirname, "../src/features/agents/streamDraftPreview.ts"));
const sd = loadTs(path.join(__dirname, "../src/features/agents/streamDraftState.ts"), { "@zavi/shared": shared });
const webPreview = loadTs(path.join(__dirname, "../../web/src/lib/workspace/streamDraftPreview.ts"));
const webHook = loadTs(path.join(__dirname, "../../web/src/lib/workspace/useRunStreamDraft.ts"), {
  react: {},
  "./useRealtimeChannel": {},
  "@/lib/realtimeAuth": {},
});
const plain = (v) => JSON.parse(JSON.stringify(v));

test("preview: a <plan> block first, then the words after it", () => {
  assert.equal(streamDraftPreview('<plan>{"steps":[]}</plan>Checking your numbers now.'), "Checking your numbers now.");
});

test("preview: words on both sides of a closed block, a self-closing <cite/> dropped", () => {
  assert.equal(streamDraftPreview("Pulling the list.<plan>{}</plan>Here is what I found."), "Pulling the list.\n\nHere is what I found.");
  assert.equal(streamDraftPreview("Retention is flat <cite src=\"x\"/> across August."), "Retention is flat  across August.");
});

test("preview: a half-streamed block shows nothing, never raw JSON", () => {
  assert.equal(streamDraftPreview('<plan>{"steps":['), "");
  assert.equal(streamDraftPreview("Solid base. <fundraising>{\"a\":"), "Solid base.");
});

test("preview: a tag whose name is still streaming shows nothing", () => {
  assert.equal(streamDraftPreview("<plan"), "");
  assert.equal(streamDraftPreview("Checking the totals. <pla"), "Checking the totals.");
});

test("preview: Array<T>, <https://x> and a bare < stay as written", () => {
  assert.equal(streamDraftPreview("Returns an Array<T> of rows"), "Returns an Array<T> of rows");
  assert.equal(streamDraftPreview("See <https://x.com/deck> for more"), "See <https://x.com/deck> for more");
  assert.equal(streamDraftPreview("Revenue is < 5% of target"), "Revenue is < 5% of target");
  assert.equal(streamDraftPreview(""), "");
});

test("preview: the same answer as web's own function on every case", () => {
  const corpus = [
    "", "Plain sentence.", "<plan>{}</plan>After", "A<plan>{}</plan>B<plan>{}</plan>C", "<plan>{\"x\":", "  <fundraising>{}",
    "Pulling the list. <fundraising>", "x <cite a=\"b\"/> y", "Array<T>", "<https://x>", "5 < 6", "text <pla", "<a>x</a>tail",
    "one\n\n<research>…</research>\n\ntwo",
  ];
  for (const c of corpus) assert.equal(streamDraftPreview(c), webPreview.streamDraftPreview(c), JSON.stringify(c));
});

const apply = (s, run, row) => sd.applyStreamDraftUpdate(s, run, row);

test("order: newer updates replace the text; older and repeated ones are dropped", () => {
  let s = sd.EMPTY_DRAFT;
  s = apply(s, "r1", { seq: 1, text: "Hel", status: "streaming" });
  s = apply(s, "r1", { seq: 3, text: "Hello wor", status: "streaming" });
  assert.equal(s.text, "Hello wor");
  const stale = apply(s, "r1", { seq: 2, text: "Hello", status: "streaming" });
  assert.equal(stale, s, "a stale update returns the same object, so React skips the render");
  assert.equal(apply(s, "r1", { seq: 3, text: "dup", status: "streaming" }), s);
  assert.equal(s.text, "Hello wor");
});

test("order: a string or non-finite seq is read like web does", () => {
  let s = apply(sd.EMPTY_DRAFT, "r1", { seq: "4", text: "a", status: "streaming" });
  assert.equal(s.lastSeq, 4);
  assert.equal(apply(s, "r1", { seq: "NaN", text: "x" }), s);
  assert.equal(apply(s, "r1", { seq: undefined, text: "x" }), s);
  assert.equal(apply(s, "r1", { seq: "3", text: "x" }), s);
});

test("order: the clear at a tool call has a higher seq, so it applies and the old text goes", () => {
  let s = apply(sd.EMPTY_DRAFT, "r1", { seq: 7, text: "Let me check that.", status: "streaming" });
  s = apply(s, "r1", { seq: 8, text: "", status: "streaming" });
  assert.equal(s.text, "");
  s = apply(s, "r1", { seq: 9, text: "Here is the answer.", status: "streaming" });
  assert.equal(s.text, "Here is the answer.");
});

test("order: a new run starts clean even if the last run reached a huge seq", () => {
  let s = apply(sd.EMPTY_DRAFT, "r1", { seq: 1_000_000_050, text: "old run", status: "complete" });
  s = apply(s, "r2", { seq: 1, text: "new run", status: "streaming" });
  assert.deepEqual([s.runId, s.text, s.status, s.lastSeq], ["r2", "new run", "streaming", 1]);
});

const at = (sec) => new Date(Date.UTC(2026, 9, 7, 5, 0, sec)).toISOString();
const row = (seq, sec, text = `t${seq}@${sec}`, status = "streaming") => ({ seq, text, status, updated_at: at(sec) });

test("order: a retried attempt restarts seq at 1, and its newer writes still replace the failed attempt's text", () => {
  let s = sd.EMPTY_DRAFT;
  for (const r of [row(1, 1), row(5, 5), row(10, 10, "failed attempt text")]) s = apply(s, "r1", r);
  assert.equal(s.text, "failed attempt text");
  s = apply(s, "r1", row(1, 40, "retry started"));
  assert.equal(s.text, "retry started", "seq 1 is lower than 10, but the write is newer");
  s = apply(s, "r1", row(2, 41, "retry going"));
  assert.equal(s.text, "retry going");
  s = apply(s, "r1", row(3, 42, "retry done", "complete"));
  assert.deepEqual([s.text, s.status], ["retry done", "complete"]);
});

test("order: a late event from the failed attempt cannot come back over the retry", () => {
  let s = apply(sd.EMPTY_DRAFT, "r1", row(1, 40, "retry started"));
  const late = apply(s, "r1", row(10, 10, "failed attempt text"));
  assert.equal(late, s, "older write dropped even though its seq is higher");
});

test("order: writes in the same instant fall back to seq; a row with no time is ordered by seq alone", () => {
  let s = apply(sd.EMPTY_DRAFT, "r1", row(3, 7, "three"));
  assert.equal(apply(s, "r1", row(2, 7, "two")), s);
  s = apply(s, "r1", row(4, 7, "four"));
  assert.equal(s.text, "four");
  s = apply(s, "r1", { seq: 5, text: "five", status: "streaming" });
  assert.equal(s.text, "five");
  assert.equal(apply(s, "r1", { seq: 5, text: "dup", updated_at: "not a time" }), s);
  s = apply(s, "r1", { seq: 6, text: "six", updated_at: "not a time" });
  assert.equal(s.text, "six");
  assert.equal(apply(s, "r1", row(9, 3, "ancient")), s);
});

test("order: the same answer as web's own reducer on a shuffled run of updates", () => {
  const rows = [
    { seq: 2, text: "He", status: "streaming" },
    { seq: 1, text: "H", status: "streaming" },
    { seq: "5", text: "Hello wo", status: "streaming" },
    { seq: 5, text: "dup", status: "streaming" },
    { seq: 4, text: "Hello", status: "streaming" },
    { seq: 6, text: "Hello world", status: "complete" },
    { seq: Number.NaN, text: "bad" },
    { seq: 3, text: "stale", status: "streaming" },
  ];
  let mobile = sd.EMPTY_DRAFT;
  let web = webHook.EMPTY_DRAFT_ACCUM;
  for (const row of rows) {
    mobile = apply(mobile, "r1", row);
    web = webHook.applyStreamDraftUpdate(web, row);
    assert.deepEqual([mobile.text, mobile.status, mobile.lastSeq], [web.text, web.status, web.lastSeq], JSON.stringify(row));
  }
  assert.equal(mobile.text, "Hello world");
});

test("a draft is live while streaming or complete, until its reply lands", () => {
  assert.equal(sd.isDraftLive("streaming", false), true);
  assert.equal(sd.isDraftLive("complete", false), true);
  assert.equal(sd.isDraftLive("complete", true), false, "no second bubble once the real reply is there");
  for (const dead of ["failed", "cancelled", "", "weird"]) assert.equal(sd.isDraftLive(dead, false), false, dead);
});

test("split: a short plain sentence types in the panel, a long or markdown one is the answer", () => {
  const narration = sd.splitStreamDraft("Let me pull your Stripe numbers first.", "streaming");
  assert.deepEqual(plain(narration), { narration: "Let me pull your Stripe numbers first.", answer: "" });
  const long = "Revenue grew this month because ".repeat(10);
  assert.deepEqual(plain(sd.splitStreamDraft(long, "streaming")), { narration: "", answer: long.trim() });
  assert.equal(sd.splitStreamDraft("## Summary\nRevenue is up.", "streaming").answer, "## Summary\nRevenue is up.");
  assert.equal(sd.splitStreamDraft("First line.\nSecond line.", "streaming").narration, "");
});

test("split: the final flush (complete) is always the answer, even a short one", () => {
  assert.deepEqual(plain(sd.splitStreamDraft("Done. Your report is ready.", "complete")), {
    narration: "",
    answer: "Done. Your report is ready.",
  });
});

test("split: nothing for an empty draft, an envelope-only draft or a dead status", () => {
  const none = { narration: "", answer: "" };
  assert.deepEqual(plain(sd.splitStreamDraft("", "streaming")), none);
  assert.deepEqual(plain(sd.splitStreamDraft('<plan>{"steps":[', "streaming")), none);
  assert.deepEqual(plain(sd.splitStreamDraft("Let me check.", "failed")), none);
  assert.deepEqual(plain(sd.splitStreamDraft("Let me check.", "cancelled")), none);
  assert.deepEqual(plain(sd.splitStreamDraft("Let me check.", "")), none);
});

test("split: the words after a <plan> preamble are what is drawn", () => {
  const out = sd.splitStreamDraft('<plan>{"steps":[]}</plan>Checking the numbers.', "streaming");
  assert.deepEqual(plain(out), { narration: "Checking the numbers.", answer: "" });
});

const running = (items = []) => ({ state: "running", summary: "Zavi is working…", toolCount: 0, items, readOnly: false });
const thought = (text, key = "t1") => ({ type: "thought", key, text });
const group = { type: "group", key: "g1", label: "Checked your database", count: 1, state: "running", tools: [] };

test("panel: the sentence being typed goes last, and the one-line summary says it", () => {
  const out = sd.withLiveRun(running([group]), { thought: "Let me check the real field names.", drafting: false });
  assert.equal(out.items.length, 2);
  assert.deepEqual(plain(out.items[1]), { type: "thought", key: "live", text: "Let me check the real field names.", live: true });
  assert.equal(out.summary, "Let me check the real field names.");
  assert.equal(out.state, "running");
});

test("panel: the same sentence is not drawn twice when its saved row has just landed", () => {
  const panel = running([thought("Let me check the real field names.")]);
  assert.equal(sd.withLiveRun(panel, { thought: "Let me check the real field names.", drafting: false }), panel);
  assert.equal(sd.withLiveRun(panel, { thought: "Let me check the real", drafting: false }), panel);
  assert.equal(sd.withLiveRun(running([thought("Let me check…")]), { thought: "Let me check the real field names.", drafting: false }).items.length, 1);
  assert.equal(sd.withLiveRun(panel, { thought: "Now the totals look right.", drafting: false }).items.length, 2);
});

test("panel: while the answer is typing, the last step is Writing your answer", () => {
  const out = sd.withLiveRun(running([group]), { thought: "", drafting: true });
  assert.deepEqual(plain(out.items[1]), { type: "step", key: "drafting", label: "Writing your answer", state: "running" });
  assert.equal(out.summary, "Writing your answer…");
});

test("panel: a long sentence is cut for the one-line summary only", () => {
  const long = "I am looking at how the signups moved after the pricing change last week, " + "and ".repeat(40);
  const out = sd.withLiveRun(running(), { thought: long, drafting: false });
  assert.ok(out.summary.length <= 90 && out.summary.endsWith("…"));
  assert.ok(out.items[out.items.length - 1].text.length > 90);
});

test("panel: before the first poll there is no panel, so one is built to carry the sentence", () => {
  const out = sd.withLiveRun(undefined, { thought: "Starting on your question.", drafting: false });
  assert.equal(out.state, "running");
  assert.equal(out.items[out.items.length - 1].text, "Starting on your question.");
  assert.equal(sd.withLiveRun(undefined, { thought: "", drafting: false }), undefined);
});

test("panel: left alone when there is nothing live to add, or the run is over", () => {
  const panel = running([group]);
  assert.equal(sd.withLiveRun(panel, { thought: "", drafting: false }), panel);
  const done = { ...panel, state: "finished" };
  assert.equal(sd.withLiveRun(done, { thought: "Late sentence.", drafting: true }), done);
});

test("held answer: kept after a good finish until the reply row lands", () => {
  const last = { runId: "r1", text: "Here is the answer." };
  assert.equal(sd.heldAnswerFor({ runStatus: "success", last, runId: "r1", replied: false }), "Here is the answer.");
  assert.equal(sd.heldAnswerFor({ runStatus: "success", last, runId: "r1", replied: true }), null);
});

test("held answer: not for a run that failed, was stopped, or is waiting on an approval", () => {
  const last = { runId: "r1", text: "Partial text" };
  for (const runStatus of ["failed", "cancelled", "dispatch_error", "parse_failed", "paused_awaiting_approval", "running", undefined, null]) {
    assert.equal(sd.heldAnswerFor({ runStatus, last, runId: "r1", replied: false }), null, String(runStatus));
  }
});

test("held answer: never another run's text, and never an empty one", () => {
  assert.equal(sd.heldAnswerFor({ runStatus: "success", last: { runId: "r0", text: "old" }, runId: "r1", replied: false }), null);
  assert.equal(sd.heldAnswerFor({ runStatus: "success", last: { runId: "r1", text: "" }, runId: "r1", replied: false }), null);
  assert.equal(sd.heldAnswerFor({ runStatus: "success", last: null, runId: "r1", replied: false }), null);
});
