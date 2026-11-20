const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, requireShim) {
  const source = fs.readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: requireShim, Intl, Date });
  return mod.exports;
}

const shared = load(path.join(__dirname, "../../../packages/shared/src/ui-blocks/report.ts"), () => ({}));
const agentBuilder = load(path.join(__dirname, "../src/features/agentBuilder/logic.ts"), () => ({}));
const cards = load(path.join(__dirname, "../src/features/agents/replyCards.ts"), (name) => {
  if (name === "@zavi/shared") return { ...shared, parseConnectorRequest: () => null };
  if (name === "../agentBuilder/logic") return agentBuilder;
  throw new Error(`unexpected require ${name}`);
});
const plain = (v) => JSON.parse(JSON.stringify(v));
const kinds = (plan) => plain(plan.cards.map((c) => c.kind));

const RUN = "11111111-1111-1111-1111-111111111111";
const msg = (meta, body = "Here you go.") => ({ body, agent_run_id: RUN, meta });
const opts = { isLast: true, threadSlug: "operator" };

test("chips: only on the newest message, at most five, blanks dropped", () => {
  const meta = { suggestions: ["Confirm", "  ", "Cancel", 3, "a", "b", "c", "d"] };
  const last = cards.planReplyCards(msg(meta), opts);
  assert.deepEqual(plain(last.cards[0]), { kind: "suggestions", suggestions: ["Confirm", "Cancel", "a", "b", "c"] });
  const older = cards.planReplyCards(msg(meta), { ...opts, isLast: false });
  assert.deepEqual(kinds(older), []);
});

test("no meta, or junk meta, draws the prose and nothing else", () => {
  for (const meta of [undefined, null, "x", [], { envelope: "nope" }]) {
    const plan = cards.planReplyCards(msg(meta), opts);
    assert.deepEqual(plain(plan), {
      body: "Here you go.",
      sources: null,
      paused: null,
      cards: [],
      trailing: [{ kind: "liveApp", runId: RUN }],
    });
  }
});

test("paused out of credits replaces the whole message", () => {
  const plan = cards.planReplyCards(
    msg({
      suggestions: ["Confirm"],
      envelope: {
        envelope_kind: "paused_out_of_credits",
        steps: [
          { label: "Pull data", status: "done" },
          { label: "Write report", status: "paused", creditsNeeded: 420.7 },
          { label: "Send", status: "weird" },
          { label: "" },
        ],
      },
    }),
    opts,
  );
  assert.equal(plan.cards.length, 0);
  assert.deepEqual(plain(plan.paused), {
    agentName: null,
    pausedStep: 2,
    totalSteps: 3,
    steps: [
      { label: "Pull data", status: "done", creditsNeeded: null },
      { label: "Write report", status: "paused", creditsNeeded: 420.7 },
      { label: "Send", status: "pending", creditsNeeded: null },
    ],
  });
});

test("a paused envelope with no steps falls back to the plain reply", () => {
  const plan = cards.planReplyCards(msg({ envelope: { envelope_kind: "paused_out_of_credits", steps: [] } }), opts);
  assert.equal(plan.paused, null);
});

const setupEnv = {
  envelope_kind: "setup_required",
  rationale: "Needs a staging URL.",
  missing_connectors: ["github"],
  missing_required_connectors: [],
  missing_optional_connectors: ["slack"],
  schema: {
    vault_keys: [
      { key: "b", label: "Optional", input: "text", required: false },
      { key: "a", label: "API key", input: "password", required: true },
      { key: "a", label: "Dup", input: "password", required: true },
      { label: "no key" },
    ],
  },
};

test("setup: required keys first, each once, and the new connector split wins", () => {
  const plan = cards.planReplyCards(msg({ envelope: setupEnv }), opts);
  const card = plan.cards.find((c) => c.kind === "setup");
  assert.equal(card.slug, "operator");
  assert.deepEqual(plain(card.model.keys.map((k) => k.key)), ["a", "b"]);
  assert.deepEqual(plain(card.model.missingRequiredConnectors), []);
  assert.deepEqual(plain(card.model.missingOptionalConnectors), ["slack"]);
});

test("setup: an old envelope treats every missing connector as required, so Save stays off", () => {
  const { missing_required_connectors, ...old } = setupEnv;
  const model = cards.parseSetupEnvelope(old);
  assert.deepEqual(plain(model.missingRequiredConnectors), ["github"]);
  assert.equal(cards.setupCanSave(model, { a: "k" }), true);
});

test("setup: Save needs every required key, and the body drops empties and trims", () => {
  const model = cards.parseSetupEnvelope(setupEnv);
  assert.equal(cards.setupCanSave(model, {}), false);
  assert.equal(cards.setupCanSave(model, { a: "   " }), false);
  assert.equal(cards.setupCanSave(model, { a: "sk_1" }), true);
  assert.deepEqual(plain(cards.setupPayload({ a: " sk_1 ", b: "  " })), { a: "sk_1" });
});

test("a reply a specialist posted is that specialist's to set up", () => {
  const plan = cards.planReplyCards(msg({ from_agent_slug: "qa", envelope: setupEnv }), opts);
  assert.equal(plan.cards.find((c) => c.kind === "setup").slug, "qa");
});

const clarifyEnv = {
  envelope_kind: "clarifying_questions",
  request_id: "req-1",
  questions: [
    {
      id: "q1",
      text: "Which market?",
      header: "Market",
      type: "single",
      required: true,
      allow_other: true,
      options: [
        { id: "us", label: "US", prefill: true, provenance: { source_id: "m1", source_label: "memory" } },
        { id: "in", label: "India", prefill: true, provenance: { source_id: "m2" } },
        { id: "eu", label: "EU", prefill: true },
      ],
    },
    {
      id: "q2",
      text: "Channels?",
      header: "Channels",
      type: "multi",
      allow_skip: true,
      options: [
        { id: "x", label: "X", prefill: true, provenance: { source_id: "m3" } },
        { id: "li", label: "LinkedIn" },
      ],
    },
    { id: "q3", text: "Anything else?", header: "Notes", type: "text", required: true },
    { text: "no id" },
  ],
};

test("clarify: malformed questions are dropped; none left means no card", () => {
  const model = cards.parseClarifyEnvelope(clarifyEnv);
  assert.deepEqual(plain(model.questions.map((q) => q.id)), ["q1", "q2", "q3"]);
  assert.equal(cards.parseClarifyEnvelope({ ...clarifyEnv, questions: [] }), null);
  assert.equal(cards.parseClarifyEnvelope({ ...clarifyEnv, request_id: "" }), null);
  const plan = cards.planReplyCards(msg({ envelope: clarifyEnv }), opts);
  assert.deepEqual(kinds(plan), ["clarify"]);
});

test("clarify: only server-validated suggestions are pre-picked, one per single-choice", () => {
  const seeded = cards.seedAnswers(cards.parseClarifyEnvelope(clarifyEnv));
  assert.deepEqual(plain(seeded.q1.optionIds), ["us"]);
  assert.deepEqual(plain(seeded.q2.optionIds), ["x"]);
  assert.deepEqual(plain(seeded.q3.optionIds), []);
});

test("clarify: single-choice swaps and un-picks, multi toggles", () => {
  const model = cards.parseClarifyEnvelope(clarifyEnv);
  const [q1, q2] = model.questions;
  let a = cards.emptyAnswer();
  a = cards.toggleOption(q1, a, "us");
  a = cards.toggleOption(q1, a, "in");
  assert.deepEqual(plain(a.optionIds), ["in"]);
  a = cards.toggleOption(q1, a, "in");
  assert.deepEqual(plain(a.optionIds), []);
  let b = cards.emptyAnswer();
  b = cards.toggleOption(q2, b, "x");
  b = cards.toggleOption(q2, b, "li");
  b = cards.toggleOption(q2, b, "x");
  assert.deepEqual(plain(b.optionIds), ["li"]);
});

test("clarify: a skip never satisfies a required question; text needs text", () => {
  const model = cards.parseClarifyEnvelope(clarifyEnv);
  const answers = {
    q1: { optionIds: [], otherText: "", skipped: true },
    q2: { optionIds: [], otherText: "", skipped: true },
    q3: { optionIds: [], otherText: "  ", skipped: false },
  };
  assert.deepEqual(plain(cards.missingRequired(model, answers).map((q) => q.id)), ["q1", "q3"]);
  answers.q1 = { optionIds: [], otherText: "Canada", skipped: false };
  answers.q3 = { optionIds: [], otherText: "no", skipped: false };
  assert.deepEqual(plain(cards.missingRequired(model, answers)), []);
});

test("clarify: the submit body carries picks, trimmed other text and skips", () => {
  const model = cards.parseClarifyEnvelope(clarifyEnv);
  const body = cards.toStructuredAnswers(model, {
    q1: { optionIds: ["us"], otherText: " also CA ", skipped: false },
    q2: { optionIds: ["x"], otherText: "", skipped: true },
  });
  assert.deepEqual(plain(body), [
    { question_id: "q1", option_ids: ["us"], other_text: "also CA" },
    { question_id: "q2", skipped: true },
    { question_id: "q3" },
  ]);
});

test("a research report folds to its title; other agents' envelopes get no card", () => {
  const env = {
    kind: "report",
    title: "Market scan",
    subtitle: "Q3",
    blocks: [
      { type: "exec_summary", prose_md: "Demand is up.", citations: [1, 2] },
      { type: "gap_list", title: "Gaps", items: [{ title: "Pricing", detail: "Too high" }] },
      { type: "validation", chips: [{ text: "hidden" }] },
    ],
    sources: [{ n: 1, title: "Report", url: "https://example.com/r" }],
  };
  const research = cards.planReplyCards(msg({ from_agent_slug: "research", envelope: env }), opts);
  const card = research.cards.find((c) => c.kind === "envelope");
  assert.equal(card.outline.title, "Market scan");
  assert.match(card.outline.markdown, /Demand is up\./);
  assert.match(card.outline.markdown, /### Gaps/);
  assert.match(card.outline.markdown, /- Pricing: Too high/);
  assert.match(card.outline.markdown, /\[Report\]\(https:\/\/example\.com\/r\)/);
  assert.doesNotMatch(card.outline.markdown, /hidden/);
  assert.doesNotMatch(card.outline.markdown, /^- 1$/m);
  assert.deepEqual(kinds(cards.planReplyCards(msg({ envelope: env }), opts)), []);
});

test("a pm envelope shows only for the actionable and strategy statuses", () => {
  const actionable = { status: "actionable", backlog: [{ theme: "Onboarding", rice_score: 12.34, proposed_fix: "Shorter form" }] };
  const outline = cards.envelopeOutline("pm", actionable);
  assert.equal(outline.title, "Backlog");
  assert.match(outline.markdown, /\*\*Onboarding\*\* \(RICE 12\.3\): Shorter form/);
  assert.equal(cards.envelopeOutline("pm", { status: "no_signal" }), null);
  assert.equal(cards.envelopeOutline("pm", { status: "actionable", backlog: [] }), null);
});

test("dispatch proposals: well-formed only, never an engineer hand-off", () => {
  const env = {
    dispatch_proposals: [
      { agent_slug: "performance-marketer", brief: "Raise budget", why: "ROAS 4x" },
      { agent_slug: "engineer", brief: "Ship it", why: "because" },
      { agent_slug: "pm", brief: "No why" },
    ],
  };
  const plan = cards.planReplyCards(msg({ envelope: env }), opts);
  assert.deepEqual(plain(plan.cards), [
    { kind: "proposals", proposals: [{ agent_slug: "performance-marketer", brief: "Raise budget", why: "ROAS 4x" }] },
  ]);
  assert.equal(cards.agentName("performance-marketer"), "Ads Manager");
  assert.equal(cards.agentName("x_organic"), "X Organic");
});

test("a scheduled brief carries the schedule chip for the specialist that ran", () => {
  const plan = cards.planReplyCards(msg({ standing_order: true, from_agent_slug: "x_organic" }), opts);
  assert.deepEqual(plain(plan.cards), [{ kind: "schedule", slug: "x_organic" }]);
  assert.deepEqual(kinds(cards.planReplyCards(msg({ standing_order: "yes" }), opts)), []);
});

test("the pages card is fetched only when the reply links a page and has a run", () => {
  const opts = { isLast: false, threadSlug: "operator" };
  const link = "Open it: https://www.zaviagent.com/pages/0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.deepEqual(plain(cards.planReplyCards(msg(null, link), opts).trailing), [{ kind: "sharedPages", runId: RUN }]);
  assert.deepEqual(plain(cards.planReplyCards({ body: link, agent_run_id: null }, opts).trailing), []);
  assert.deepEqual(plain(cards.planReplyCards(msg(null, "/pages/not-a-uuid"), opts).trailing), []);
});

test("a trailing Sources block is lifted out of the prose and folded", () => {
  const body = "Revenue rose 12%.\n\n---\n**Sources.** 2 pulls from Stripe.\nNot in this run's data: churn.\n- Stripe charges, 30d";
  const plan = cards.planReplyCards(msg(null, body), opts);
  assert.equal(plan.body, "Revenue rose 12%.");
  const fn = cards.sourcesFootnote(plan.sources);
  assert.deepEqual(plain(fn), {
    summary: "2 pulls from Stripe.",
    warning: "Not in this run's data: churn.",
    detail: "- Stripe charges, 30d",
  });
});

const previews = load(path.join(__dirname, "../src/features/agents/previews.ts"), (name) => {
  throw new Error(`unexpected require ${name}`);
});

test("html preview: v1 inline html becomes a card, placed after setup and before clarify", () => {
  const plan = cards.planReplyCards(
    msg({ envelope: { kind: "html_preview", title: "New pricing page", summary: "Two tiers.", html: "<p>hi</p>" } }),
    { ...opts, threadSlug: "engineer" },
  );
  assert.deepEqual(plain(plan.cards), [
    {
      kind: "htmlPreview",
      model: { title: "New pricing page", summary: "Two tiers.", html: "<p>hi</p>", previewId: null },
    },
  ]);
});

test("html preview: v2 needs version 2, state html_preview_ready and a preview_id", () => {
  const ok = cards.parseHtmlPreview({ kind: "html_preview", version: 2, state: "html_preview_ready", preview_id: "p1" });
  assert.deepEqual(plain(ok), { title: "Proposed design", summary: "", html: null, previewId: "p1" });
  for (const env of [
    { kind: "html_preview", version: 2, state: "html_preview_pending", preview_id: "p1" },
    { kind: "html_preview", version: 1, state: "html_preview_ready", preview_id: "p1" },
    { kind: "html_preview", version: 2, state: "html_preview_ready" },
    { kind: "html_preview" },
    { kind: "report", html: "<p>x</p>" },
    null,
  ]) {
    assert.equal(cards.parseHtmlPreview(env), null, JSON.stringify(env));
  }
});

test("html preview: inline html wins, and a v2 id alongside it is kept for the displayed ack", () => {
  const m = cards.parseHtmlPreview({
    kind: "html_preview",
    version: 2,
    state: "html_preview_ready",
    preview_id: "p1",
    html: "<p>x</p>",
  });
  assert.deepEqual(plain(m), { title: "Proposed design", summary: "", html: "<p>x</p>", previewId: "p1" });
});

test("live app card: newest reply with a run only", () => {
  const plan = (o, id = RUN) => plain(cards.planReplyCards({ body: "Done.", agent_run_id: id, meta: null }, o).trailing);
  assert.deepEqual(plan(opts), [{ kind: "liveApp", runId: RUN }]);
  assert.deepEqual(plan({ ...opts, isLast: false }), []);
  assert.deepEqual(plan(opts, null), []);
});

test("harden: CSP goes first (after a doctype), off-page links and refresh are stripped", () => {
  const CSP_START = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';';
  const plainDoc = previews.harden('<img src="https://evil/x"><a href="https://evil">x</a><a href="#top">t</a>');
  assert.ok(plainDoc.startsWith(CSP_START));
  assert.ok(plainDoc.includes('<a href="#">x</a>'));
  assert.ok(plainDoc.includes('<a href="#top">t</a>'));
  const withDoctype = previews.harden('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil"></head></html>');
  assert.ok(withDoctype.startsWith("<!DOCTYPE html>" + CSP_START));
  assert.ok(!/refresh/i.test(withDoctype));
  const hidden = previews.harden('<meta http-equiv="&#114;efresh" content="0;url=data:text/html,x"><p>hi</p>');
  assert.ok(!hidden.includes("&#114;efresh"));
  assert.ok(hidden.includes("<p>hi</p>"));
  const form = previews.harden("<form action='https://evil'><a ping=\"https://evil\" href=\"#\">p</a></form>");
  assert.ok(form.includes('action="#"'));
  assert.ok(!form.includes("ping"));
});

test("preview navigation: only the document loads; everything else, http(s) included, is blocked", () => {
  const d = (url, loaded) => previews.previewNavDecision(url, { loaded });
  assert.equal(d("about:blank", false), "allow");
  assert.equal(d("about:blank", true), "allow");
  assert.equal(d("about:blank#pricing", true), "allow");
  assert.equal(d("data:text/html;charset=utf-8,<p>x</p>", false), "allow");
  assert.equal(d("data:text/html,<script>1</script>", true), "block");
  assert.equal(d("https://example.com/a", true), "block");
  assert.equal(d("https://example.com/a", false), "block");
  assert.equal(d("HTTP://example.com", true), "block");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "intent://x#Intent;end", "tel:5551234", "zavi://auth", ""]) {
    assert.equal(d(bad, true), "block", bad);
    assert.equal(d(bad, false), "block", bad);
  }
});

test("live app: shown only when the run checked product builds and a final build has a url", () => {
  const panel = (names) => ({ items: [{ type: "step" }, { type: "group", tools: names.map((name) => ({ name })) }] });
  assert.equal(previews.panelCheckedProductBuilds(panel(["list_product_builds"])), true);
  assert.equal(previews.panelCheckedProductBuilds(panel(["query_db", "mcp_list_product_builds"])), true);
  assert.equal(previews.panelCheckedProductBuilds(panel(["query_db"])), false);
  for (const junk of [null, undefined, {}, { items: "x" }, { items: [null, { tools: [null, { name: 3 }] }] }]) {
    assert.equal(previews.panelCheckedProductBuilds(junk), false);
  }
  assert.equal(previews.readShippedAppUrl({ kind: "final", url: "https://acme.onrender.com" }), "https://acme.onrender.com");
  assert.equal(previews.readShippedAppUrl({ kind: "draft", url: "https://acme.onrender.com" }), null);
  assert.equal(previews.readShippedAppUrl({ kind: "final", url: "" }), null);
  assert.equal(previews.readShippedAppUrl({ kind: "final", url: "javascript:alert(1)" }), null);
  assert.equal(previews.readShippedAppUrl(null), null);
  assert.equal(previews.hostLabel("https://acme.onrender.com/app?x=1"), "acme.onrender.com");
});

test("rule suggestion: meta.rule_suggestion draws a card with the exact words; junk draws none", () => {
  const card = { rule_id: "r1", text: "Never post on weekends", scope_kind: "all" };
  const plan = cards.planReplyCards({ body: "Keep this as a rule?", agent_run_id: null, meta: { rule_suggestion: card } }, opts);
  assert.deepEqual(kinds(plan), ["ruleSuggestion"]);
  assert.deepEqual(plain(plan.cards[0]), { kind: "ruleSuggestion", rule_id: "r1", text: "Never post on weekends" });
  for (const bad of [{ rule_id: "", text: "x" }, { rule_id: "r1" }, "r1", null]) {
    const p = cards.planReplyCards({ body: "x", agent_run_id: null, meta: { rule_suggestion: bad } }, opts);
    assert.deepEqual(kinds(p), []);
  }
});

test("code change: plain words, file count and lines; only the newest asks for a yes", () => {
  const env = {
    pending_pr_proposal: true,
    title: "Fix the Safari checkout loop",
    customer_summary: "Safari visitors stay on checkout. Signed-out people land back on checkout!",
    risk_class: "low",
    files: [
      { path: "a.tsx", action: "modify", diff: "@@ -1 +1 @@\n-old\n+new\n+more\n ctx" },
      { path: "b.ts", action: "delete" },
      { action: "modify" },
    ],
  };
  const last = cards.planReplyCards(msg({ envelope: env }), opts);
  const card = plain(last.cards.find((c) => c.kind === "codeChange"));
  assert.equal(card.actionable, true);
  assert.equal(card.model.title, "Fix the Safari checkout loop");
  assert.deepEqual(card.model.points, ["Safari visitors stay on checkout.", "Signed-out people land back on checkout!"]);
  assert.equal(card.model.files.length, 2);
  assert.equal(card.model.lines, 3);
  const older = cards.planReplyCards(msg({ envelope: env }), { ...opts, isLast: false });
  assert.equal(older.cards.find((c) => c.kind === "codeChange").actionable, false);
  assert.equal(cards.parseCodeChange({ ...env, pending_pr_proposal: false }), null);
  assert.equal(cards.parseCodeChange({ ...env, files: [] }), null);
});

test("code change: the --- / +++ file header lines of a diff are not counted as changes", () => {
  const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n ctx";
  const model = cards.parseCodeChange({ pending_pr_proposal: true, files: [{ path: "a.ts", action: "modify", diff }] });
  assert.equal(model.lines, 2);
});

test("code change: a deleted file with no diff is still listed, and adds no lines", () => {
  const model = plain(
    cards.parseCodeChange({
      pending_pr_proposal: true,
      files: [{ path: "old.ts", action: "delete", diff: null }, { path: "gone.ts", action: "delete" }, { path: "e.ts", diff: "" }],
    }),
  );
  assert.deepEqual(model.files.map((f) => [f.path, f.action, f.diff]), [
    ["old.ts", "delete", null],
    ["gone.ts", "delete", null],
    ["e.ts", "modify", null],
  ]);
  assert.equal(model.lines, 0);
});

test("code change: a plain title, at most three points, and no risk when none is given", () => {
  const model = plain(
    cards.parseCodeChange({
      pending_pr_proposal: true,
      customer_summary: "One. Two. Three. Four. Five.",
      files: [{ path: "a.ts", action: "create", diff: "+x" }],
    }),
  );
  assert.equal(model.title, "Code change");
  assert.deepEqual(model.points, ["One.", "Two.", "Three."]);
  assert.equal(model.risk, null);
  assert.equal(model.lines, 1);
});

test("code change: anything that is not a pending change with a file list is no card", () => {
  assert.equal(cards.parseCodeChange(null), null);
  assert.equal(cards.parseCodeChange({}), null);
  assert.equal(cards.parseCodeChange({ pending_pr_proposal: "true", files: [{ path: "a" }] }), null);
  assert.equal(cards.parseCodeChange({ pending_pr_proposal: true, files: "a.ts" }), null);
  assert.equal(cards.parseCodeChange({ pending_pr_proposal: true, files: [{ path: "" }, { path: 3 }, null] }), null);
});

test("code change: an older message with the same change is a record, not a question", () => {
  const env = { pending_pr_proposal: true, files: [{ path: "a.ts", action: "modify", diff: "+x" }] };
  const newest = cards.planReplyCards(msg({ envelope: env }), opts).cards.find((c) => c.kind === "codeChange");
  const older = cards.planReplyCards(msg({ envelope: env }), { ...opts, isLast: false }).cards.find((c) => c.kind === "codeChange");
  assert.equal(newest.actionable, true);
  assert.equal(older.actionable, false);
  assert.equal(older.model.files.length, 1, "the card is still drawn, only without the yes button");
});

test("custom agent draft: meta.custom_agent_draft draws the card with the proposing run", () => {
  const draft = { name: "Standup bot", role: "", instructions: "Summarize yesterday.", tools: [], triggers: [], deliver: null };
  const plan = cards.planReplyCards(msg({ custom_agent_draft: { kind: "draft", draft } }), opts);
  const card = plan.cards.find((c) => c.kind === "customAgent");
  assert.equal(card.originRunId, RUN);
  assert.equal(card.card.kind, "draft");
  assert.equal(card.card.draft.name, "Standup bot");
  const junk = cards.planReplyCards(msg({ custom_agent_draft: { kind: "draft", draft: { name: 1 } } }), opts);
  assert.ok(!kinds(junk).includes("customAgent"));
});

const NONCE = "22222222-2222-2222-2222-222222222222";
const confirmMeta = (extra = {}) => ({
  build_confirm: {
    nonce: NONCE,
    target: "new_product",
    est_credits: 12000,
    est_usd: 30,
    expires_at: "2099-01-01T00:00:00Z",
    ...extra,
  },
});

test("build confirm: a well-formed meta draws the card, newest or not", () => {
  const plan = cards.planReplyCards(msg(confirmMeta()), opts);
  const card = plan.cards.find((c) => c.kind === "buildConfirm");
  assert.equal(card.confirm.nonce, NONCE);
  assert.equal(card.confirm.est_credits, 12000);
  assert.equal(card.confirm.status, undefined);
});

test("build confirm: a missing nonce, bad numbers or no expiry is no card", () => {
  for (const bad of [{ nonce: "" }, { nonce: 7 }, { target: 3 }, { est_credits: "12" }, { est_usd: null }, { expires_at: 0 }]) {
    assert.equal(cards.parseBuildConfirm({ ...confirmMeta().build_confirm, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(cards.parseBuildConfirm(null), null);
  assert.equal(cards.parseBuildConfirm("x"), null);
});

test("build confirm: status started or replaced is kept; anything else is dropped", () => {
  const read = (extra) => cards.parseBuildConfirm({ ...confirmMeta().build_confirm, ...extra });
  assert.equal(read({ status: "started", run_id: RUN }).status, "started");
  assert.equal(read({ status: "started", run_id: RUN }).run_id, RUN);
  assert.equal(read({ status: "replaced" }).status, "replaced");
  assert.equal(read({ status: "whatever" }).status, undefined);
  assert.equal(read({ run_id: 5 }).run_id, undefined);
});

test("build confirm: a free first build says Free, otherwise credits and dollars", () => {
  assert.equal(cards.buildEstimateLine({ est_credits: 0, est_usd: 0 }), "Free: this is your workspace's first build.");
  assert.equal(cards.buildEstimateLine({ est_credits: 12000, est_usd: 30 }), "About 12,000 credits (~$30.00).");
  assert.equal(cards.buildEstimateLine({ est_credits: 800, est_usd: 2.5 }), "About 800 credits (~$2.50).");
});

test("build confirm: each server answer to Start build has one clear outcome", () => {
  const out = (status, body = null) => plain(cards.buildStartOutcome({ status, body }));
  assert.deepEqual(out(200, { run_id: RUN }), { phase: "started", runId: RUN });
  assert.deepEqual(out(200), { phase: "started", runId: null });
  assert.deepEqual(out(402), { phase: "out_of_credits" });
  assert.deepEqual(out(409), { phase: "expired" });
});

test("build confirm: a member who is not owner or admin gets a plain 403 line", () => {
  const server = { error: { code: "forbidden", message: "This action requires one of: owner, admin. Your role: member." } };
  assert.deepEqual(plain(cards.buildStartOutcome({ status: 403, body: server })), {
    phase: "failed",
    error: "Only the workspace owner or an admin can start this build.",
  });
  assert.equal(cards.buildStartOutcome({ status: 403, body: null }).phase, "failed");
});

test("build confirm: other failures show the server's words, else a generic line", () => {
  const generic = "Something went wrong starting the build.";
  assert.equal(cards.buildStartOutcome({ status: 500, body: { message: "Sandbox busy" } }).error, "Sandbox busy");
  assert.equal(cards.buildStartOutcome({ status: 400, body: { error: { message: "Bad nonce" } } }).error, "Bad nonce");
  assert.equal(cards.buildStartOutcome({ status: 500, body: null }).error, generic);
  assert.equal(cards.buildStartOutcome({ status: 404, body: {} }).error, generic);
});
