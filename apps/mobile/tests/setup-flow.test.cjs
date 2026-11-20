const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { loadTs } = require("./helpers/load-ts.cjs");

const src = (p) => path.join(__dirname, "../src", p);
const plain = (v) => JSON.parse(JSON.stringify(v));

const state = loadTs(src("features/setup/state.ts"));
const imports = loadTs(src("features/setup/imports.ts"));
const polish = loadTs(src("features/setup/polish.ts"));
const draft = loadTs(src("features/setup/draftStarter.ts"));
const copy = loadTs(src("features/setup/copy.ts"));

const cache = new Map();
function load(file, requireShim) {
  if (cache.has(file)) return cache.get(file);
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: requireShim, Intl, Date, URL, Object });
  cache.set(file, mod.exports);
  return mod.exports;
}
const SHARED = path.join(__dirname, "../../../packages/shared/src");
const sharedRequire = (dir) => (name) => {
  if (name === "zod") return require("zod");
  if (name.startsWith(".")) {
    const file = path.join(dir, `${name}.ts`);
    return load(file, sharedRequire(path.dirname(file)));
  }
  throw new Error(`unexpected require ${name}`);
};
const connectorsDir = path.join(SHARED, "connectors");
const shared = {
  ...load(path.join(connectorsDir, "connector-request.ts"), sharedRequire(connectorsDir)),
  ...load(path.join(connectorsDir, "rails.ts"), sharedRequire(connectorsDir)),
};
const connectors = loadTs(src("features/setup/connectors.ts"), { "@zavi/shared": shared });

const ON = (over = {}) => ({
  enabled: true,
  docs: { status: "pending", files: 0, facts: 0 },
  connectors: { status: "pending" },
  done: false,
  home_seen: false,
  draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true },
  ...over,
});

test("the step on screen is the first one the server has not answered", () => {
  assert.equal(state.currentStep(ON()), 1);
  assert.equal(state.currentStep(ON({ docs: { status: "skipped", files: 0, facts: 0 } })), 2);
  assert.equal(state.currentStep(ON({ docs: { status: "done", files: 1, facts: 3 }, connectors: { status: "done" } })), 3);
  assert.deepEqual(plain(state.stepStatuses(ON({ done: true, connectors: { status: "skipped" } }))), ["pending", "skipped", "done"]);
});

test("the empty chat's strategy card follows the first plan, as on the web", () => {
  const run = (status) => ({ status, run_id: "r", attempts: 1, can_retry: false, free_retry: true });
  const done = (over) => ON({ done: true, draft: run("running"), ...over });
  assert.equal(state.strategyCardState(done(), true), "writing");
  assert.equal(state.strategyCardState(done({ has_plan: false }), true), "writing");
  assert.equal(state.strategyCardState(done({ draft: run("none") }), true), "writing");
  assert.equal(state.strategyCardState(done({ has_plan: true }), true), "ready");
  assert.equal(state.strategyCardState(done({ draft: run("done"), has_plan: true }), true), "ready");
  assert.equal(state.strategyCardState(done({ draft: run("failed") }), true), "failed");
  assert.equal(state.strategyCardState(done({ draft: run("failed"), has_plan: true }), true), "failed");
  assert.equal(state.strategyCardState(done({ draft: run("done"), has_plan: false }), true), null);
  assert.equal(state.strategyCardState(ON({ draft: run("running") }), true), null);
  assert.equal(state.strategyCardState(done(), false), null);
  assert.equal(state.strategyCardState(done({ home_seen: true }), true), null);
  assert.equal(state.strategyCardState({ enabled: false }, true), null);
  assert.equal(state.strategyCardState(undefined, true), null);
});

test("the strategy bar moves 20, 50, 90, 100 as on the web, and is ready only once the draft is done", () => {
  const docs = { status: "done", files: 1, facts: 3 };
  const run = (status) => ({ status, run_id: "r", attempts: 1, can_retry: false, free_retry: true });
  assert.deepEqual(plain(state.cookingView(ON())), { pct: 20, ready: false });
  assert.deepEqual(plain(state.cookingView(ON({ docs }))), { pct: 50, ready: false });
  assert.deepEqual(plain(state.cookingView(ON({ docs, connectors: { status: "skipped" } }))), { pct: 90, ready: false });
  assert.deepEqual(plain(state.cookingView(ON({ docs, connectors: { status: "done" }, draft: run("running") }))), { pct: 100, ready: false });
  assert.deepEqual(plain(state.cookingView(ON({ docs, connectors: { status: "done" }, draft: run("done") }))), { pct: 100, ready: true });
});

test("the draft starts once step 2 is answered and none exists yet", () => {
  assert.equal(state.shouldAutoStartDraft(ON()), false);
  assert.equal(state.shouldAutoStartDraft(ON({ connectors: { status: "skipped" } })), true);
  const running = ON({ connectors: { status: "done" }, draft: { status: "running", run_id: "r", attempts: 1, can_retry: false, free_retry: true } });
  assert.equal(state.shouldAutoStartDraft(running), false);
});

const file = (name, size = 1000, mime = null) => ({ uri: `file:///cache/DocumentPicker/x.${name.split(".").pop()}`, name, size, mime });

test("a pick admits the web's formats, gives Office advice, and refuses the rest with a reason", () => {
  const { rows, dropped } = imports.admitPicked(
    [file("plan.md"), file("deck.pptx"), file("sheet.xlsx"), file("old.doc"), file("app.exe"), file("huge.pdf", 26 * 1024 * 1024), file("logo.png")],
    1,
  );
  assert.equal(dropped, 0);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by["plan.md"].status, "waiting");
  assert.equal(by["logo.png"].status, "waiting");
  assert.equal(by["deck.pptx"].reason, "save it as .pdf and add it again");
  assert.equal(by["sheet.xlsx"].reason, "save it as .csv and add it again");
  assert.equal(by["old.doc"].reason, "save it as .docx and add it again");
  assert.equal(by["app.exe"].reason, ".exe files aren't supported");
  assert.equal(by["huge.pdf"].reason, "bigger than 25 MB");
  assert.equal(by["app.exe"].file, undefined);
});

test("over 20 files, the rest are dropped and counted", () => {
  const many = Array.from({ length: 23 }, (_, i) => file(`n${i}.txt`));
  const { rows, dropped } = imports.admitPicked(many);
  assert.equal(rows.length, 20);
  assert.equal(dropped, 3);
});

test("the upload keeps the picked name, made safe for the multipart filename", () => {
  assert.equal(imports.uploadName("zavi-context.md"), "zavi-context.md");
  assert.equal(imports.uploadName("My notes (final).md"), "My_notes_(final).md");
  assert.equal(imports.uploadName("Q3 plan: v2.pdf"), "Q3_plan_v2.pdf");
  assert.equal(imports.uploadName("résumé.pdf"), "r_sum.pdf");
  assert.equal(imports.uploadName("日本.txt"), "file.txt");
  assert.equal(imports.uploadName("README"), "README");
});

test("the part's type comes from the picker, else from the extension", () => {
  assert.equal(imports.mimeFor({ name: "a.pdf", mime: "application/pdf" }), "application/pdf");
  assert.equal(imports.mimeFor({ name: "a.md", mime: "application/octet-stream" }), "text/markdown");
  assert.equal(imports.mimeFor({ name: "a.json", mime: null }), "application/json");
  assert.equal(imports.mimeFor({ name: "a", mime: null }), "application/octet-stream");
});

test("an upload failure says why; a 413 from the proxy gets its own words", () => {
  assert.equal(imports.uploadFailure(413, null), "bigger than the server takes right now");
  assert.equal(imports.uploadFailure(409, "Adding past work is turned off."), "Adding past work is turned off.");
  assert.equal(imports.uploadFailure(500, "  "), "upload failed");
});

const NOW = Date.parse("2026-10-07T12:00:00Z");
const row = (over = {}) => ({ id: "f1", filename: "plan.md", created_at: "2026-10-07T11:59:00Z", extraction: null, ...over });

test("each server file's read state, as the web reads it", () => {
  assert.deepEqual(plain(imports.fileFromServer(row(), NOW)), {
    id: "f1", filename: "plan.md", created_at: "2026-10-07T11:59:00Z", facts: 0, redactions: 0, truncated: false, unclaimed: true, status: "reading",
  });
  const read = imports.fileFromServer(row({ extraction: { state: "read", facts: 4, redactions: 1, truncated: true } }), NOW);
  assert.equal(read.status, "done");
  assert.equal(read.facts, 4);
  assert.equal(read.redactions, 1);
  assert.equal(read.truncated, true);
  assert.equal(read.unclaimed, false);
  assert.equal(imports.fileFromServer(row({ extraction: { state: "stored" } }), NOW).status, "stored");
  const bad = imports.fileFromServer(row({ extraction: { state: "unreadable", reason: "empty file" } }), NOW);
  assert.equal(bad.status, "failed");
  assert.equal(bad.reason, "empty file");
  const stale = imports.fileFromServer(row({ created_at: "2026-10-07T11:49:00Z", extraction: { state: "reading" } }), NOW);
  assert.equal(stale.status, "failed");
});

test("reads summarize into reading / done / stored / failed and the facts learned", () => {
  const files = [
    imports.fileFromServer(row({ id: "a", extraction: { state: "read", facts: 3 } }), NOW),
    imports.fileFromServer(row({ id: "b", extraction: { state: "read", facts: 2 } }), NOW),
    imports.fileFromServer(row({ id: "c" }), NOW),
    imports.fileFromServer(row({ id: "d", extraction: { state: "stored" } }), NOW),
  ];
  const s = imports.summarizeReads(files);
  assert.equal(s.done.length, 2);
  assert.equal(s.reading.length, 1);
  assert.equal(s.stored.length, 1);
  assert.equal(s.facts, 5);
  assert.equal(imports.namesOf([files[0]]), "plan.md");
  assert.equal(imports.namesOf(files), "4 files");
  assert.equal(imports.summarizeReads(null).facts, 0);
});

test("row labels read like the web's", () => {
  assert.equal(imports.rowLabel({ status: "done", facts: 1 }), "1 fact");
  assert.equal(imports.rowLabel({ status: "done", facts: 3 }), "3 facts");
  assert.equal(imports.rowLabel({ status: "stored" }), copy.STORED_IMAGE);
  assert.equal(imports.rowLabel({ status: "failed", reason: "too big" }), "Couldn't read this one (too big)");
  assert.equal(imports.rowLabel({ status: "reading" }), "Reading");
  assert.equal(imports.rowLabel({ status: "waiting" }), "Adding");
});

test("an unclaimed read is kicked once, only after 20 seconds", () => {
  const young = imports.fileFromServer(row({ id: "y", created_at: "2026-10-07T11:59:50Z" }), NOW);
  const old = imports.fileFromServer(row({ id: "o", created_at: "2026-10-07T11:59:30Z" }), NOW);
  const claimed = imports.fileFromServer(row({ id: "c", created_at: "2026-10-07T11:59:00Z", extraction: { state: "reading" } }), NOW);
  assert.deepEqual(plain(imports.filesToKick([young, old, claimed], new Set(), NOW)), ["o"]);
  assert.deepEqual(plain(imports.filesToKick([old], new Set(["o"]), NOW)), []);
});

test("the list polls only while a file reads or the first answer is missing, and backs off after 15 failures", () => {
  const reading = [imports.fileFromServer(row(), NOW)];
  const settled = [imports.fileFromServer(row({ extraction: { state: "read", facts: 1 } }), NOW)];
  assert.equal(imports.nextPollMs({ enabled: true, files: reading, failures: 0 }), imports.IMPORT_POLL_MS);
  assert.equal(imports.nextPollMs({ enabled: true, files: settled, failures: 0 }), null);
  assert.equal(imports.nextPollMs({ enabled: true, files: null, failures: 0 }), imports.IMPORT_POLL_MS);
  assert.equal(imports.nextPollMs({ enabled: false, files: null, failures: 0 }), null);
  assert.equal(imports.nextPollMs({ enabled: true, files: settled, failures: 2 }), imports.IMPORT_POLL_MS);
  assert.equal(imports.nextPollMs({ enabled: true, files: null, failures: 15 }), null);
  assert.equal(imports.nextPollMs({ enabled: true, files: reading, failures: 15 }), imports.SLOW_POLL_MS);
});

test("the starter tiles are the web's fifteen, in the web's order, without Teams", () => {
  const slugs = plain(connectors.compactConnectors().map((c) => c.slug));
  assert.deepEqual(slugs, [
    "stripe", "google_analytics", "meta_ads", "google_ads", "google_search_console", "slack", "whatsapp", "github", "instagram_social",
    "linkedin_social", "composio.shopify", "composio.hubspot",
    "x_social", "tiktok", "posthog",
  ]);
  assert.equal(slugs.length, 15);
  assert.ok(slugs.slice(0, 9).includes("slack") && slugs.slice(0, 9).includes("whatsapp") && slugs.slice(0, 9).includes("github"));
  assert.equal(connectors.ALL_SETUP_CONNECTORS.some((c) => c.slug === "teams"), false);
});

test("search finds tiles by name, line or category, and the catalog from two letters", () => {
  const catalog = [{ slug: "notion", name: "Notion" }, { slug: "shopify", name: "Shopify" }];
  assert.deepEqual(plain(connectors.searchConnectors("", catalog).map((c) => c.slug)), plain(connectors.COMPACT_SLUGS));
  assert.ok(connectors.searchConnectors("revenue", catalog).some((c) => c.slug === "stripe"));
  const notion = connectors.searchConnectors("notion", catalog);
  assert.deepEqual(plain(notion), [{ slug: "composio.notion", name: "Notion", category: "Product & data", what: "From the app catalog" }]);
  assert.equal(connectors.searchConnectors("shopify", catalog).filter((c) => c.slug === "composio.shopify").length, 1);
  assert.deepEqual(plain(connectors.searchConnectors("n", catalog).filter((c) => c.slug.startsWith("composio.notion"))), []);
});

test("Continue counts every connection once, never Zavi's own GitHub or legacy rows", () => {
  const rows = [
    { slug: "stripe" },
    { slug: "github", account_login: shared.UMBRELLA_GITHUB_LOGIN },
    { slug: "pipedream.slack" },
    { slug: "composio.notion" },
    { slug: "meta_ads" },
  ];
  const names = connectors.connectedNames(rows, [{ slug: "notion", name: "Notion" }]);
  assert.deepEqual(plain(names), ["Stripe", "Notion", "Meta Ads"]);
  assert.equal(connectors.isConnected(rows, "stripe"), true);
  assert.equal(connectors.isConnected(rows, "github"), false);
  assert.equal(connectors.isConnected([{ slug: "github", account_login: "my-org" }], "github"), true);
});

test("the form fills from company facts, competitors split on commas", () => {
  const f = polish.formFromFacts([
    { key: "company_name", value_text: " Acme " },
    { key: "domain", value_text: "acme.com" },
    { key: "what_we_sell", value_text: null },
    { key: "competitors", value_text: "Foo, Bar ,, Baz" },
  ]);
  assert.deepEqual(plain(f), { company_name: "Acme", domain: "acme.com", what_we_sell: "", competitors: ["Foo", "Bar", "Baz"] });
});

test("finish sends every field shown, and an emptied pre-filled field as a clear", () => {
  const before = { company_name: "Acme", domain: "acme.com", what_we_sell: "Rentals", competitors: ["Foo"] };
  const after = { company_name: "Acme", domain: "", what_we_sell: "Car rentals", competitors: [] };
  assert.deepEqual(plain(polish.displayedFacts(after, before)), [
    { key: "company_name", value: "Acme" },
    { key: "domain", value: "" },
    { key: "what_we_sell", value: "Car rentals" },
    { key: "competitors", value: "" },
  ]);
  assert.deepEqual(plain(polish.displayedFacts(polish.EMPTY_FORM, polish.EMPTY_FORM)), []);
});

test("competitors are added once, in any case, and suggestions go after the founder's", () => {
  assert.deepEqual(plain(polish.addCompetitor(["Foo"], " foo ")), ["Foo"]);
  assert.deepEqual(plain(polish.addCompetitor(["Foo"], "Bar")), ["Foo", "Bar"]);
  assert.deepEqual(plain(polish.addCompetitor(["Foo"], "  ")), ["Foo"]);
  assert.deepEqual(plain(polish.withSuggested(["Mine"], ["Theirs", "mine"])), ["Mine", "Theirs"]);
});

test("a file landing mid-edit fills untouched fields and only offers on the typed ones", () => {
  const before = { company_name: "Acme", domain: "acme.com", what_we_sell: "Rentals", competitors: [] };
  const form = { company_name: "Acme Inc", domain: "acme.com", what_we_sell: "Rentals", competitors: [] };
  const next = { company_name: "ACME Ltd", domain: "acme.com", what_we_sell: "Peer-to-peer car rental", competitors: ["Turo"] };
  const out = polish.mergeFileFacts({ next, form, before, touched: new Set(["company_name"]), file: "notes.md", firstReadFailed: false });
  assert.equal(out.form.company_name, "Acme Inc");
  assert.deepEqual(plain(out.offers), { company_name: { file: "notes.md", value: "ACME Ltd" } });
  assert.equal(out.form.what_we_sell, "Peer-to-peer car rental");
  assert.deepEqual(plain(out.tags.what_we_sell), { file: "notes.md", guess: "Rentals" });
  assert.deepEqual(plain(out.form.competitors), ["Turo"]);
  assert.equal(out.before.company_name, "ACME Ltd");
  assert.equal(out.form.domain, "acme.com");
});

test("a typed field the file agrees with gets no offer; the website fills only after a failed first read", () => {
  const before = { company_name: "", domain: "", what_we_sell: "", competitors: [] };
  const form = { company_name: "Acme", domain: "", what_we_sell: "", competitors: [] };
  const next = { company_name: "Acme", domain: "acme.com", what_we_sell: "", competitors: [] };
  const a = polish.mergeFileFacts({ next, form, before, touched: new Set(["company_name"]), file: "f", firstReadFailed: false });
  assert.deepEqual(plain(a.offers), {});
  assert.equal(a.form.domain, "");
  const b = polish.mergeFileFacts({ next, form, before, touched: new Set(["company_name"]), file: "f", firstReadFailed: true });
  assert.equal(b.form.domain, "acme.com");
  const c = polish.mergeFileFacts({ next, form, before, touched: new Set(["domain"]), file: "f", firstReadFailed: true });
  assert.equal(c.form.domain, "");
});

test("while a file still reads, untouched fillable fields are left to it, never the website", () => {
  assert.deepEqual(plain(polish.leftToFile({ fileUnknown: false, touched: new Set(), tagged: new Set() })), []);
  assert.deepEqual(
    plain(polish.leftToFile({ fileUnknown: true, touched: new Set(["company_name"]), tagged: new Set(["competitors"]) })),
    ["what_we_sell"],
  );
});

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const noSleep = async () => {};

test("the starter asks again while the server says retry, then returns the run", async () => {
  const answers = [reply(200, { retry: true }), reply(500, null), reply(200, { status: "queued", run_id: "r1" })];
  let calls = 0;
  const out = await draft.runDraftStarter(async () => answers[calls++], { attempts: 5, sleep: noSleep });
  assert.deepEqual(plain(out), { status: "queued", run_id: "r1" });
  assert.equal(calls, 3);
});

test("402 is a credit refusal, 409/403 a refusal, a thrown network error is asked again", async () => {
  assert.deepEqual(plain(await draft.runDraftStarter(async () => reply(402, null), { attempts: 3, sleep: noSleep })), { insufficientCredits: true });
  assert.deepEqual(plain(await draft.runDraftStarter(async () => reply(409, null), { attempts: 3, sleep: noSleep })), { refused: true });
  assert.deepEqual(plain(await draft.runDraftStarter(async () => reply(403, null), { attempts: 3, sleep: noSleep })), { refused: true });
  let n = 0;
  const out = await draft.runDraftStarter(
    async () => {
      n += 1;
      if (n === 1) throw new Error("offline");
      return reply(200, { status: "already", run_id: "r0" });
    },
    { attempts: 3, sleep: noSleep },
  );
  assert.deepEqual(plain(out), { status: "already", run_id: "r0" });
});

test("the starter gives up after its attempts, and stops at once when cancelled", async () => {
  let calls = 0;
  const out = await draft.runDraftStarter(async () => { calls += 1; return reply(200, { retry: true }); }, { attempts: 3, sleep: noSleep });
  assert.deepEqual(plain(out), { gaveUp: true });
  assert.equal(calls, 3);
  let posted = 0;
  let cancel = false;
  const stopped = await draft.runDraftStarter(
    async () => { posted += 1; cancel = true; return reply(200, { retry: true }); },
    { attempts: 10, sleep: noSleep, cancelled: () => cancel },
  );
  assert.deepEqual(plain(stopped), { gaveUp: true });
  assert.equal(posted, 1);
});

test("skip and intro copy speak about the idea, what is known, or the website, in that order", () => {
  assert.match(copy.skip1Body(false, true), /your idea/);
  assert.match(copy.skip1Body(true, false), /already know/);
  assert.match(copy.skip1Body(false, false), /website only/);
  assert.match(copy.skipAllBody(true, true), /your idea/);
  assert.match(copy.skip3Body(false, false), /your website/);
  assert.equal(copy.continueLabel(0), "Continue");
  assert.equal(copy.continueLabel(2), "Continue with 2 connected");
  assert.match(copy.polishIntro(true, false), /your files told me/);
  assert.match(copy.polishIntro(false, false), /your idea told me/);
  assert.equal(copy.STEP_TITLES.length, 3);
  assert.equal(copy.WHY.length, 3);
});
