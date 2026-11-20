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
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Date });
  return mod.exports;
}

const L = load("../src/features/build/logic.ts");
const plain = (v) => JSON.parse(JSON.stringify(v));
const err = (status, code, message) => ({ status, code, message });
const NOW = Date.parse("2026-09-26T12:00:00Z");

test("sessionRows: newest activity first, labels from state, blank title named", () => {
  const rows = L.sessionRows(
    {
      sessions: [
        { id: "a", title: "Old", state: "ready", last_activity_at: "2026-09-20T12:00:00Z", created_at: "2026-09-20T11:00:00Z" },
        { id: "b", title: "  ", state: "building", last_activity_at: "2026-09-26T11:55:00Z", created_at: "2026-09-26T11:00:00Z" },
        { id: "c", title: "Mid", state: "failed", last_activity_at: "2026-09-26T09:00:00Z", created_at: "2026-09-26T08:00:00Z" },
      ],
      current_session_id: "b",
    },
    NOW,
  );
  assert.deepEqual(plain(rows.map((r) => r.id)), ["b", "c", "a"]);
  assert.equal(rows[0].title, "Untitled build");
  assert.equal(rows[0].status, "Building");
  assert.equal(rows[0].building, true);
  assert.equal(rows[0].updated, "5 min ago");
  assert.equal(rows[1].status, "Stopped");
  assert.equal(rows[1].updated, "3 h ago");
  assert.equal(rows[2].status, "Ready");
  assert.equal(rows[2].updated, "6 d ago");
});

test("sessionRows tolerates a missing / malformed body", () => {
  assert.deepEqual(plain(L.sessionRows(null, NOW)), []);
  assert.deepEqual(plain(L.sessionRows({ sessions: null }, NOW)), []);
  assert.deepEqual(plain(L.sessionRows({ sessions: [{ id: "" }] }, NOW)), []);
});

test("formatUpdated: bad date is blank, old date is a calendar date", () => {
  assert.equal(L.formatUpdated("nope", NOW), "");
  assert.equal(L.formatUpdated(null, NOW), "");
  assert.equal(L.formatUpdated("2026-09-26T11:59:40Z", NOW), "just now");
  assert.equal(L.formatUpdated("2026-08-03T10:00:00Z", NOW), "Aug 3");
});

test("terminal statuses match the backend / web set", () => {
  for (const s of ["done", "failed", "halted", "paused", "cancelled", "canceled"]) assert.equal(L.isTerminalBuildRun(s), true, s);
  for (const s of ["provisioning", "active", "queued", "", null, undefined]) assert.equal(L.isTerminalBuildRun(s), false, String(s));
});

test("shouldKeepPolling: in flight polls, stopped/paused stop, done waits a bounded while for final", () => {
  assert.equal(L.shouldKeepPolling(null, "none", 0), false);
  assert.equal(L.shouldKeepPolling("active", "none", 0), true);
  assert.equal(L.shouldKeepPolling("provisioning", "instant", 5), true);
  assert.equal(L.shouldKeepPolling("failed", "none", 0), false);
  assert.equal(L.shouldKeepPolling("paused", "none", 0), false);
  assert.equal(L.shouldKeepPolling("cancelled", "none", 0), false);
  assert.equal(L.shouldKeepPolling("done", "final", 0), false);
  assert.equal(L.shouldKeepPolling("done", "early", 3), true);
  assert.equal(L.shouldKeepPolling("done", "early", L.MAX_SETTLE_TICKS), false);
  assert.equal(L.BUILD_POLL_MS, 3000);
});

test("isRefineBusy: any change not yet terminal", () => {
  assert.equal(L.isRefineBusy([]), false);
  assert.equal(L.isRefineBusy([{ id: "1", status: "done" }, { id: "2", status: "failed" }]), false);
  assert.equal(L.isRefineBusy([{ id: "1", status: "done" }, { id: "2", status: "active" }]), true);
});

test("readPreviewUrl never returns a url the server didn't vouch for", () => {
  assert.equal(L.readPreviewUrl(null), null);
  assert.equal(L.readPreviewUrl({ kind: "none", url: "https://x.dev" }), null);
  assert.equal(L.readPreviewUrl({ kind: "instant", url: "" }), null);
  assert.equal(L.readPreviewUrl({ kind: "early", url: "https://x.dev" }), "https://x.dev");
});

test("deriveBuildSteps: active step from the running stage, done run is all done", () => {
  const steps = L.deriveBuildSteps(
    [
      { stage: "provision", status: "done" },
      { stage: "spec", status: "done" },
      { stage: "scaffold", status: "running" },
      { stage: "build", status: "pending" },
      { stage: "qa", status: "pending" },
    ],
    "active",
    false,
  );
  assert.deepEqual(plain(steps.map((s) => s.state)), ["done", "done", "active", "pending", "pending", "pending"]);
  assert.equal(steps.length, 6);
  assert.ok(L.deriveBuildSteps([], "done", false).every((s) => s.state === "done"));
  assert.ok(L.deriveBuildSteps([], "active", true).every((s) => s.state === "done"));
});

test("deriveBuildSteps: failed stage marks that step failed; paused marks the current step failed", () => {
  const failed = L.deriveBuildSteps(
    [
      { stage: "provision", status: "done" },
      { stage: "spec", status: "done" },
      { stage: "scaffold", status: "done" },
      { stage: "build", status: "failed" },
    ],
    "failed",
    false,
  );
  assert.deepEqual(plain(failed.map((s) => s.state)), ["done", "done", "done", "failed", "pending"]);
  const paused = L.deriveBuildSteps([{ stage: "provision", status: "done" }, { stage: "spec", status: "pending" }], "paused", false);
  assert.equal(paused[1].state, "failed");
});

test("deriveBuildSteps: a build without a qa stage never lists Preparing preview", () => {
  const stages = [
    { stage: "provision", status: "done" },
    { stage: "spec", status: "done" },
    { stage: "scaffold", status: "done" },
    { stage: "build", status: "done" },
  ];
  const steps = L.deriveBuildSteps(stages, "active", false);
  assert.deepEqual(plain(steps.map((s) => [s.key, s.state])), [
    ["workspace", "done"],
    ["understanding", "done"],
    ["structure", "done"],
    ["interface", "done"],
    ["deploy", "active"],
  ]);
});

const statusBody = (over = {}) => ({
  run: { id: "r1", objective: "x", status: "active", stages: [], failure: null, used_credits: 0, ...over.run },
  target: { repo_url: "https://github.com/zavi/acme-app", live_url: null, ...over.target },
  preview: over.preview ?? { url: null, kind: "none" },
  is_current: over.is_current ?? true,
  retired: over.retired,
});

test("buildView: building offers Stop, no change, no publish", () => {
  const v = L.buildView(statusBody());
  assert.equal(v.status, "building");
  assert.equal(v.canCancel, true);
  assert.equal(v.canContinue, false);
  assert.equal(v.canChange, false);
  assert.equal(v.appHost, null);
  assert.equal(v.openUrl, null);
});

test("buildView: instant preview opens as a preview", () => {
  const v = L.buildView(statusBody({ preview: { url: "https://sbx.e2b.dev", kind: "instant" } }));
  assert.equal(v.openUrl, "https://sbx.e2b.dev");
  assert.equal(v.openLabel, "Open preview");
});

test("buildView: done + live offers change, open live, publish host", () => {
  const v = L.buildView(
    statusBody({ run: { status: "done" }, target: { live_url: "https://Acme.onrender.com/" }, preview: { url: "https://acme.onrender.com", kind: "final" } }),
  );
  assert.equal(v.status, "ready");
  assert.equal(v.statusLabel, "Live");
  assert.equal(v.canCancel, false);
  assert.equal(v.canChange, true);
  assert.equal(v.openLabel, "Open live site");
  assert.equal(v.appHost, "acme.onrender.com");
});

test("buildView: paused offers Continue; superseded offers nothing", () => {
  const paused = L.buildView(statusBody({ run: { status: "paused" } }));
  assert.equal(paused.canContinue, true);
  assert.equal(paused.canCancel, false);
  const old = L.buildView(statusBody({ run: { status: "done" }, is_current: false, target: { live_url: "https://a.b" } }));
  assert.equal(old.superseded, true);
  assert.equal(old.canChange, false);
  assert.equal(old.appHost, null);
  const pausedOld = L.buildView(statusBody({ run: { status: "paused" }, retired: true }));
  assert.equal(pausedOld.canContinue, false);
});

test("buildView: stopped build carries human failure copy", () => {
  const v = L.buildView(
    statusBody({ run: { status: "failed", failure: { message: "repair dispatch failed (insufficient_credits)" } } }),
  );
  assert.equal(v.status, "stopped");
  assert.equal(v.failure, L.BUILD_OUT_OF_CREDITS);
  const raw = L.buildView(
    statusBody({ run: { status: "failed", failure: { message: "onSiteSandboxReady: the running preview could not be stopped (exit 1)" } } }),
  );
  assert.equal(raw.failure, L.BUILD_INTERNAL_FAILURE);
  assert.equal(L.buildView({ run: null }), null);
});

test("buildView: a body with a founder code is shown as sent; out_of_credits keeps the phone's wall line", () => {
  const sent = "Your app was built, but putting it online didn't finish. Try again.";
  const v = L.buildView(statusBody({ run: { status: "failed", failure: { class: "deploy_failed", code: "publish_failed", message: sent } } }));
  assert.equal(v.failure, sent);
  const credits = L.buildView(
    statusBody({ run: { status: "failed", failure: { class: "stage_failed", code: "out_of_credits", message: "This build ran out of credits partway through." } } }),
  );
  assert.equal(credits.failure, L.BUILD_OUT_OF_CREDITS);
  assert.equal(L.isCreditFailure(credits.failure), true);
  const paused = L.buildView(
    statusBody({ run: { status: "paused", failure: { class: "stage_failed", code: "out_of_credits", message: "x" } } }),
  );
  assert.equal(paused.failure, L.BUILD_PAUSED_OUT_OF_CREDITS);
});

test("buildView: spend line prefers credits, then dollars", () => {
  assert.equal(L.buildView(statusBody({ run: { used_credits: 1234.4 } })).spend, "1,234 credits used");
  assert.equal(L.buildView(statusBody({ run: { used_credits: 0, used_usd: 1.5 } })).spend, "$1.50 spent");
  assert.equal(L.buildView(statusBody()).spend, null);
});

test("no user-facing copy carries an em dash", () => {
  for (const s of [L.BUILD_OUT_OF_CREDITS, L.BUILD_OVER_BUDGET, L.BUILD_PROVIDER_BUSY]) assert.equal(s.includes("—"), false);
});

test("cleanObjective strips the pipeline lead and decodes entities", () => {
  assert.equal(L.cleanObjective("Build product: Acme — a booking site &amp; shop"), "a booking site & shop");
  assert.equal(L.cleanObjective("  "), null);
  assert.equal(L.cleanObjective(null), null);
});

test("idea / company / change bounds match web + server", () => {
  assert.equal(L.validateIdea("short").ok, false);
  assert.equal(L.validateIdea("   12345678   ").ok, true);
  assert.equal(L.validateIdea("x".repeat(4001)).ok, false);
  assert.equal(L.validateCompanyName("  ").ok, false);
  assert.equal(L.validateCompanyName("Acme").ok, true);
  assert.equal(L.validateCompanyName("x".repeat(101)).ok, false);
  assert.equal(L.validateChange("tiny").ok, false);
  assert.equal(L.validateChange("make the header blue").ok, true);
  assert.equal(L.validateChange("x".repeat(1001)).ok, false);
});

test("buildCreditWall: 402 wallet codes raise the wall with the server's sentence", () => {
  assert.deepEqual(plain(L.buildCreditWall(err(402, "insufficient_credits_for_build", "Needs 4,320 credits."), "build")), {
    kind: "credits",
    message: "Needs 4,320 credits.",
  });
  assert.equal(L.buildCreditWall(err(402, "insufficient_credits", ""), "change").message.includes("change"), true);
  assert.equal(L.buildCreditWall(err(402, "provision_budget_exceeded", "cap"), "build"), null);
  assert.equal(L.buildCreditWall(err(403, "product_builder_disabled", "off"), "build"), null);
  assert.equal(L.buildCreditWall(err(403, "plan_upgrade_required", "Pro"), "build").kind, "plan");
  assert.equal(L.buildCreditWall(new Error("network"), "build"), null);
  assert.equal(L.buildCreditWall(null, "build"), null);
});

test("buildErrorMessage: known codes get plain copy, else the server's words, else fallback", () => {
  assert.equal(L.buildErrorMessage(err(403, "product_builder_disabled", "Product builder is not enabled."), "f"), "Building apps isn't turned on for this workspace.");
  assert.equal(L.buildErrorMessage(err(409, "build_already_in_progress", "x"), "f"), "A build is already running. Stop it before starting another.");
  assert.equal(L.buildErrorMessage(err(429, "daily_build_limit_reached", "3 builds a day."), "f"), "3 builds a day.");
  assert.equal(L.buildErrorMessage(err(500, "http_500", "Request failed (500)"), "fallback"), "fallback");
  assert.equal(L.buildErrorMessage(null, "fallback"), "fallback");
});

test("publishErrorMessage: any 403 is the owner/admin line", () => {
  assert.equal(L.publishErrorMessage(err(403, "not_your_app", "this app is not registered"), "f"), L.PUBLISH_FORBIDDEN);
  assert.equal(L.publishErrorMessage(err(403, "forbidden", ""), "f"), "Only workspace owners and admins can publish.");
  assert.equal(L.publishErrorMessage(err(409, "no_deployed_app", "Your app isn't built yet."), "f"), "Your app isn't built yet.");
  assert.equal(L.publishErrorMessage(err(500, "x", "Request failed (500)"), "f"), "f");
});

test("exportErrorView: not connected asks for GitHub; repo-must-exist names the repo; 5xx plain", () => {
  const nc = L.exportErrorView(err(409, "github_not_connected", "Connect your own GitHub"));
  assert.equal(nc.needsGithub, true);
  const missing = L.exportErrorView(
    err(409, "dest_repo_must_exist", 'cannot auto-create "me/acme-app" under a personal GitHub account. Create an empty repo named "acme-app" under me on GitHub, then retry'),
  );
  assert.equal(missing.needsGithub, false);
  assert.match(missing.text, /a repo named acme-app under me on GitHub/);
  assert.match(L.exportErrorView(err(502, "export_failed", "export dest repo create failed (403): nope")).text, /can't create repos in that organization/);
  assert.equal(L.exportErrorView(err(502, "export_failed", "GitHub is down")).text, "GitHub is down");
  assert.equal(L.exportErrorView(err(503, "export_not_configured", "Export is not configured")).text, "Export is not configured");
  assert.equal(L.exportErrorView(err(409, "no_provisioned_repo", "")).text, "There's no built app to export yet.");
});

test("exportDoneLine", () => {
  assert.equal(
    L.exportDoneLine({ exported: true, file_count: 42, dest: { full_name: "me/acme", url: "u", branch: "main", created_repo: true } }),
    "Exported 42 files to me/acme. New repo created.",
  );
  assert.match(L.exportDoneLine({ exported: false, file_count: 0, dest: { full_name: "me/acme", url: "u", branch: "main" } }), /Already up to date/);
});

test("publishView: no address -> Publish; address live + pending -> Publish changes; up to date -> nothing", () => {
  const none = L.publishView({ builtin: null, status: { pending: 0, published: 0, last_published_at: null } });
  assert.equal(none.publishLabel, "Publish");
  assert.equal(none.tone, "off");
  const live = { label: "acme", hostname: "acme.zaviagent.com", url: "https://acme.zaviagent.com", status: "live" };
  const pending = L.publishView({ builtin: live, status: { pending: 2, published: 1, last_published_at: null } });
  assert.equal(pending.publishLabel, "Publish changes");
  assert.equal(pending.sub, "2 unpublished changes");
  assert.equal(pending.canRevert, true);
  const upToDate = L.publishView({ builtin: live, status: { pending: 0, published: 0, last_published_at: null } });
  assert.equal(upToDate.publishLabel, null);
  assert.equal(upToDate.canRevert, false);
  assert.equal(upToDate.tone, "live");
  const settingUp = L.publishView({ builtin: { ...live, status: "provisioning" }, status: null });
  assert.equal(settingUp.title, "Publishing");
  assert.equal(settingUp.publishLabel, "Publish");
});

test("visibility: only Public is enforced today", () => {
  assert.deepEqual(plain(L.VISIBILITY_OPTIONS.filter((o) => o.enforced).map((o) => o.value)), ["public"]);
});

test("buildRoleView: owner/admin publish + export, member neither", () => {
  assert.deepEqual(plain(L.buildRoleView(true)), { canPublish: true, canExport: true });
  assert.deepEqual(plain(L.buildRoleView(false)), { canPublish: false, canExport: false });
});

test("refineRow: busy, done, failed with a safe line", () => {
  assert.equal(L.refineRow({ id: "1", message: "Blue header", status: "active" }).tone, "busy");
  const done = L.refineRow({ id: "2", message: "x", status: "done", summary: "Header is blue." });
  assert.equal(done.status, "Done");
  assert.equal(done.detail, "Header is blue.");
  const failed = L.refineRow({ id: "3", message: "x", status: "failed", failure_message: "see https://render.com/log" });
  assert.equal(failed.tone, "error");
  assert.match(failed.detail, /Nothing on your app was affected/);
  assert.equal(L.refineRow({ id: "4", message: "", status: "done", kind: "undo" }).status, "Restored");
});

test("refineRow: a thrown-away, parked or draft change is never called Done (DEL-1323 B28)", () => {
  const discarded = L.refineRow({
    id: "5",
    message: "Green button",
    status: "done",
    draft: true,
    discarded: true,
    summary: "The hero button is green.",
  });
  assert.equal(discarded.status, "Discarded");
  assert.equal(discarded.detail, null);
  assert.notEqual(discarded.tone, "ok");
  const parked = L.refineRow({ id: "6", message: "x", status: "done", awaiting_review: true, summary: "Orders start pending." });
  assert.equal(parked.status, "Saved, not live yet");
  assert.equal(parked.detail, "Orders start pending.");
  const draft = L.refineRow({ id: "7", message: "x", status: "done", draft: true, summary: "Header is blue." });
  assert.equal(draft.status, "Ready in your preview");
  assert.equal(draft.detail, "Header is blue.");
  assert.equal(L.refineRow({ id: "8", message: "x", status: "done", draft: false, discarded: false }).status, "Done");
});

test("F1: paused on credits says top up then CONTINUE, never start again", () => {
  const paused = L.buildView(
    statusBody({ run: { status: "paused", failure: { message: "repair dispatch failed (insufficient_credits)" } } }),
  );
  assert.equal(paused.failure, L.BUILD_PAUSED_OUT_OF_CREDITS);
  assert.match(paused.failure, /continue the build/);
  assert.doesNotMatch(paused.failure, /start the build again/);
  assert.equal(paused.canContinue, true);
  assert.equal(L.isCreditFailure(paused.failure), true);
  for (const status of ["failed", "halted"]) {
    const stopped = L.buildView(statusBody({ run: { status, failure: { message: "insufficient_credits" } } }));
    assert.equal(stopped.failure, L.BUILD_OUT_OF_CREDITS);
    assert.equal(L.isCreditFailure(stopped.failure), true);
  }
  assert.equal(L.pausedFailureCopy("Scaffold did not serve."), L.BUILD_INTERNAL_FAILURE);
  assert.equal(L.isCreditFailure("Scaffold did not serve."), false);
  assert.equal(L.BUILD_PAUSED_OUT_OF_CREDITS.includes("—"), false);
});

test("F2: builtin address polls every 4s while verifying, 45 tries, not when blocked or live", () => {
  const verifying = { label: "a", hostname: "a.zaviagent.com", url: "https://a.zaviagent.com", status: "verifying" };
  assert.equal(L.builtinPollInterval(verifying, 0), 4000);
  assert.equal(L.builtinPollInterval(verifying, 44), 4000);
  assert.equal(L.builtinPollInterval(verifying, 45), false);
  assert.equal(L.builtinPollInterval({ ...verifying, setup_blocked: "dns_not_configured" }, 0), false);
  assert.equal(L.builtinPollInterval({ ...verifying, status: "live" }, 0), false);
  assert.equal(L.builtinPollInterval(null, 0), false);
});

test("F2: 'Published.' only once the address is live", () => {
  const base = { label: "a", hostname: "a.zaviagent.com", url: "https://a.zaviagent.com" };
  assert.deepEqual(plain(L.publishOutcome({ ...base, status: "live" })), { kind: "published" });
  const setting = L.publishOutcome({ ...base, status: "verifying" });
  assert.equal(setting.kind, "setting_up");
  assert.match(setting.text, /Setting up a\.zaviagent\.com/);
  assert.equal(L.publishOutcome({ ...base, status: "verifying", setup_blocked: "dns_not_configured" }).kind, "blocked");
  assert.equal(L.publishOutcome(null).kind, "setting_up");
});

test("mergeRecent: a build with no chat thread gets its own Recent row, ordered with the chats", () => {
  const threads = [
    { id: "t-old", last_message_at: "2026-09-26T09:00:00Z" },
    { id: "t-new", last_message_at: "2026-09-26T11:00:00Z" },
    { id: "t-none", last_message_at: null },
  ];
  const out = L.mergeRecent(threads, {
    sessions: [
      { id: "b1", title: "  ", request: "dog walking", state: "building", run_status: "running", created_at: "2026-09-26T10:00:00Z", last_activity_at: "", refine_count: 0, is_current: true },
    ],
  });
  assert.deepEqual(
    plain(out).map((e) => (e.kind === "thread" ? e.row.id : `${e.id}:${e.title}:${e.state}`)),
    ["t-new", "b1:Untitled build:building", "t-old", "t-none"],
  );
});

test("mergeRecent: no build list leaves the chats as they were", () => {
  const threads = [{ id: "a", last_message_at: "2026-09-26T11:00:00Z" }, { id: "b", last_message_at: null }];
  assert.deepEqual(plain(L.mergeRecent(threads, null)).map((e) => e.row.id), ["a", "b"]);
  assert.deepEqual(plain(L.mergeRecent(threads, { sessions: null })).map((e) => e.row.id), ["a", "b"]);
});

test("mergeRecent: a build started from a chat is shown once, as that chat", () => {
  const threads = [{ id: "chat-1", last_message_at: "2026-09-26T11:00:00Z" }];
  const session = (id, chat_thread_ids) => ({ id, title: id, request: "", state: "ready", run_status: "done", created_at: "2026-09-26T10:00:00Z", last_activity_at: "2026-09-26T10:00:00Z", refine_count: 0, is_current: true, chat_thread_ids });
  const out = L.mergeRecent(threads, { sessions: [session("from-chat", ["chat-1"]), session("deleted-chat", ["gone"]), session("onboarding")] });
  assert.deepEqual(plain(out).map((e) => (e.kind === "thread" ? e.row.id : e.id)), ["chat-1", "deleted-chat", "onboarding"]);
});
