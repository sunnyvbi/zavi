const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const tc = loadTs(path.join(__dirname, "../src/features/agents/tenantCommands.ts"));
const shared = loadTs(path.join(__dirname, "../../../packages/shared/src/composer/slash-commands.ts"));
const tools = loadTs(path.join(__dirname, "../src/features/agents/composerTools.ts"), { "@zavi/shared": shared });
const plain = (v) => JSON.parse(JSON.stringify(v));

const weekly = { slug: "weekly-report", name: "Weekly report", description: "Summarise the week" };
const launch = { slug: "launch", name: "Launch", description: "" };
const state = (over = {}) => ({ commands: [weekly, launch], loaded: true, failed: false, ...over });

test("the list keeps only what the phone shows; the saved instructions are dropped", () => {
  const rows = tc.readTenantCommands({
    commands: [{ id: "1", slug: "weekly-report", name: " Weekly report ", description: " Summarise ", instructions_md: "secret", updated_at: "x" }],
  });
  assert.deepEqual(plain(rows), [{ slug: "weekly-report", name: "Weekly report", description: "Summarise" }]);
});

test("a row with a bad slug is skipped; a missing name falls back to the slug", () => {
  const rows = tc.readTenantCommands({
    commands: [
      { slug: "Weekly" },
      { slug: "1abc" },
      { slug: "a".repeat(41) },
      { slug: 7 },
      null,
      "x",
      { slug: "ok" },
      { slug: "named", name: "  ", description: 3 },
    ],
  });
  assert.deepEqual(plain(rows), [
    { slug: "ok", name: "ok", description: "" },
    { slug: "named", name: "named", description: "" },
  ]);
});

test("anything that is not a list of rows reads as no commands", () => {
  for (const junk of [null, undefined, {}, { commands: "x" }, { commands: null }, 5, []]) {
    assert.deepEqual(plain(tc.readTenantCommands(junk)), []);
  }
});

test("the filter is a case-insensitive prefix on the slug; empty lists them all", () => {
  const all = [weekly, launch];
  assert.deepEqual(plain(tc.filterTenantCommands("", all).map((c) => c.slug)), ["weekly-report", "launch"]);
  assert.deepEqual(plain(tc.filterTenantCommands("WEE", all).map((c) => c.slug)), ["weekly-report"]);
  assert.deepEqual(plain(tc.filterTenantCommands("report", all)), []);
  assert.deepEqual(plain(tc.filterTenantCommands(" l ", all).map((c) => c.slug)), ["launch"]);
});

test("`/slug words` and a bare `/slug` both parse; the slug is read whole", () => {
  assert.deepEqual(plain(tc.matchTenantInvocation("/launch go now")), { slug: "launch", body: "go now" });
  assert.deepEqual(plain(tc.matchTenantInvocation("/launch")), { slug: "launch", body: "" });
  assert.deepEqual(plain(tc.matchTenantInvocation("/launch   ")), { slug: "launch", body: "" });
  assert.deepEqual(plain(tc.matchTenantInvocation("/launch line one\nline two")), { slug: "launch", body: "line one\nline two" });
  assert.deepEqual(plain(tc.matchTenantInvocation("/foo-bar baz")), { slug: "foo-bar", body: "baz" });
});

test("things that are not a command shape do not parse", () => {
  for (const no of ["hello", "/Launch go", "/1abc x", "/ launch", "//launch", "", "/", " /launch x"]) {
    assert.equal(tc.matchTenantInvocation(no), null, JSON.stringify(no));
  }
});

test("a command `foo` is never run by `/foo-bar words` (word boundary)", () => {
  const foo = [{ slug: "foo", name: "Foo", description: "" }];
  assert.deepEqual(plain(tc.sendableTenantCommand("/foo words", foo)), { slug: "foo", body: "words" });
  assert.equal(tc.sendableTenantCommand("/foo-bar words", foo), null);
});

test("only one of this workspace's commands with words after it can be sent", () => {
  const all = [weekly, launch];
  assert.deepEqual(plain(tc.sendableTenantCommand("/weekly-report for May", all)), { slug: "weekly-report", body: "for May" });
  assert.equal(tc.sendableTenantCommand("/weekly-report", all), null);
  assert.equal(tc.sendableTenantCommand("/weekly-report   ", all), null);
  assert.equal(tc.sendableTenantCommand("/other do it", all), null);
  assert.equal(tc.sendableTenantCommand("do /launch", all), null);
  assert.equal(tc.sendableTenantCommand("/launch x", []), null);
});

test("hint: nothing while the list loads, a plain line if it failed", () => {
  assert.equal(tc.tenantCommandHint("/launch go", state({ loaded: false, commands: [] })), null);
  assert.equal(
    tc.tenantCommandHint("/launch go", state({ failed: true, commands: [] })),
    "Couldn't load your workspace commands. Try again in a moment.",
  );
});

test("hint: a known command says what Send does, or what is missing", () => {
  assert.equal(tc.tenantCommandHint("/launch go", state()), "Send to run /launch.");
  assert.equal(tc.tenantCommandHint("/launch", state()), "/launch needs a message.");
});

test("hint: not ours (unknown slug, or no command shape) is left to the caller", () => {
  assert.equal(tc.tenantCommandHint("/nope x", state()), undefined);
  assert.equal(tc.tenantCommandHint("hello", state()), undefined);
});

test("the slugs named in the unknown-command line: up to five, then a count", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ slug: `c${i}`, name: `C${i}`, description: "" }));
  assert.equal(tc.tenantSlugList([weekly, launch]), "/weekly-report, /launch");
  assert.equal(tc.tenantSlugList(many), "/c0, /c1, /c2, /c3, /c4 and 2 more");
});

test("workspace commands are off while a sent message is being edited, and with a channel picked", () => {
  const st = state();
  assert.equal(tc.usableCommands(st, { editing: false, channelPicked: false }), st);
  assert.equal(tc.usableCommands(st, { editing: true, channelPicked: false }), undefined);
  assert.equal(tc.usableCommands(st, { editing: false, channelPicked: true }), undefined);
  assert.equal(tc.usableCommands(st, { editing: true, channelPicked: true }), undefined);
  assert.equal(tc.NO_COMMANDS.length, 0);
});

test("editing: a typed /slug is not sendable and the hint no longer promises a run", () => {
  const own = tc.usableCommands(state(), { editing: true, channelPicked: false });
  const list = own?.commands ?? tc.NO_COMMANDS;
  assert.equal(tc.sendableTenantCommand("/weekly-report for May", list), null);
  assert.equal(tools.slashHint("/weekly-report for May", own), "Unknown command. Available: /feedback, /clear, /help, /run, /decision <uuid>.");
  const open = tc.usableCommands(state(), { editing: false, channelPicked: false });
  assert.deepEqual(plain(tc.sendableTenantCommand("/weekly-report for May", open.commands)), { slug: "weekly-report", body: "for May" });
  assert.equal(tools.slashHint("/weekly-report for May", open), "Send to run /weekly-report.");
});

test("a channel picked: the hint and Send agree (neither offers the workspace command)", () => {
  const own = tc.usableCommands(state(), { editing: false, channelPicked: true });
  assert.equal(tc.sendableTenantCommand("/launch go", own?.commands ?? tc.NO_COMMANDS), null);
  assert.match(tools.slashHint("/launch go", own), /^Unknown command/);
});

test("slashHint: a workspace command reads its own line; an unknown one lists yours", () => {
  assert.equal(tools.slashHint("/launch go", state()), "Send to run /launch.");
  assert.equal(tools.slashHint("/launch", state()), "/launch needs a message.");
  assert.equal(
    tools.slashHint("/nope", state()),
    "Unknown command. Available: /feedback, /clear, /help, /run, /decision <uuid>, /weekly-report, /launch.",
  );
  assert.equal(
    tools.slashHint("/nope", state({ commands: [] })),
    "Unknown command. Available: /feedback, /clear, /help, /run, /decision <uuid>.",
  );
  assert.equal(tools.slashHint("/nope"), "Unknown command. Available: /feedback, /clear, /help, /run, /decision <uuid>.");
});

test("slashHint: a built-in always wins over a workspace command", () => {
  assert.match(tools.slashHint("/feedback", state()), /^Add <rule> after \/feedback/);
  assert.equal(tools.slashHint("/clear", state()), "Send to start a fresh chat.");
  assert.match(tools.slashHint("/help me", state()), /^Send to list every command/);
});

test("every command in @zavi/shared has phone words and is understood by the parser", () => {
  const sample = {
    clear: "/clear",
    help: "/help",
    run: "/run go",
    decision: "/decision 3f2a9c1e-0000-4000-8000-000000000000 hi",
    feedback: "/feedback be brief",
  };
  assert.deepEqual(plain(tools.SLASH_COMMANDS.map((c) => c.kind)), plain(shared.COMPOSER_SLASH_COMMANDS.map((c) => c.name)));
  for (const c of shared.COMPOSER_SLASH_COMMANDS) {
    assert.ok(sample[c.name], `no sample input for /${c.name}: add it here and to parseSend`);
    assert.notEqual(tools.parseSend(sample[c.name]).kind, "unknown_command", `/${c.name} is not parsed`);
  }
  for (const c of tools.SLASH_COMMANDS) {
    assert.ok(c.label && c.description && c.command === `/${c.kind}`);
  }
});
