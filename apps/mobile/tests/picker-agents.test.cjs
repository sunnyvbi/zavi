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

const {
  chatSlug,
  pickerAgentName,
  pickerSlugs,
  customAgentRows,
  topicLabel,
  channelStarters,
  mergeAgentThreads,
} = load(
  "../src/features/agents/pickerAgents.ts",
);
const plain = (v) => JSON.parse(JSON.stringify(v));

test("built-in agent names are Web's registry", () => {
  assert.equal(pickerAgentName("operator"), "Zavi");
  assert.equal(pickerAgentName("engineer"), "Engineer");
  assert.equal(pickerAgentName("pm"), "Product Manager");
  assert.equal(pickerAgentName("support-lead"), "Support Lead");
  assert.equal(pickerAgentName("growth-lead"), "Head of Growth");
  assert.equal(pickerAgentName("some-new-agent"), "Some new agent");
});

test("a route slug falls back to Zavi only when it is empty or not a slug", () => {
  assert.equal(chatSlug(undefined), "operator");
  assert.equal(chatSlug(""), "operator");
  assert.equal(chatSlug("research"), "research");
  assert.equal(chatSlug(["engineer", "x"]), "engineer");
  assert.equal(chatSlug("performance-marketer"), "performance-marketer");
  assert.equal(chatSlug("../etc"), "operator");
});

test("Agents you built: only the workspace's own agents, in the server's order, by their own name", () => {
  const rows = customAgentRows([
    { slug: "operator" },
    { slug: "engineer" },
    { slug: "c-abcd1234efgh", name: "Weekly churn digest", custom: true },
    { slug: "cgo" },
    { slug: "c-zz99", name: "  ", custom: true, locked_tier: "starter" },
  ]);
  assert.deepEqual(
    plain(rows.map((r) => [r.slug, r.name, r.lockedTier])),
    [
      ["c-abcd1234efgh", "Weekly churn digest", null],
      ["c-zz99", "C zz99", "starter"],
    ],
  );
});

test("threads are read for Zavi, growth strategy, each channel's agent, then every agent the workspace built", () => {
  assert.deepEqual(plain(pickerSlugs(undefined)), ["operator", "cgo"]);
  assert.deepEqual(
    plain(pickerSlugs([{ slug: "engineer" }, { slug: "operator" }, { slug: "c-1", custom: true }])),
    ["operator", "cgo", "c-1"],
  );
  assert.deepEqual(
    plain(pickerSlugs([{ slug: "c-1", custom: true }], ["meta_ads", "seo", "meta_ads"])),
    ["operator", "cgo", "meta_ads", "seo", "c-1"],
  );
});

test("a chat is labelled by what it is about; a plain Zavi chat has no label", () => {
  const names = { channel: (s) => ({ reddit_organic: "Reddit" })[s] ?? s, agent: (s) => (s === "c-1" ? "Churn digest" : null) };
  assert.equal(topicLabel("operator", null, names), null);
  assert.equal(topicLabel("operator", undefined, names), null);
  assert.equal(topicLabel("operator", "reddit_organic", names), "Reddit");
  assert.equal(topicLabel("cgo", null, names), "Growth strategy");
  assert.equal(topicLabel("cgo", "reddit_organic", names), "Growth strategy");
  assert.equal(topicLabel("c-1", null, names), "Churn digest");
  assert.equal(topicLabel("engineer", null, names), "Engineer");
  assert.equal(topicLabel("reddit_organic", "reddit_organic", names), "Reddit");
});

test("a channel chat offers web's three starters, naming the channel", () => {
  assert.deepEqual(plain(channelStarters("Reddit")), [
    "How is Reddit doing?",
    "What should I do next on Reddit?",
    "What's holding Reddit back?",
  ]);
});

test("threads from every agent merge newest first, each tagged with its slug", () => {
  const t = (id, at) => ({ id, last_message_at: at });
  const merged = mergeAgentThreads([
    { slug: "operator", rows: [t("a", "2026-09-30T10:00:00Z"), t("b", null)] },
    { slug: "research", rows: [t("c", "2026-10-01T09:00:00Z")] },
    { slug: "engineer", rows: undefined },
  ]);
  assert.deepEqual(
    plain(merged.map((r) => [r.id, r.slug])),
    [
      ["c", "research"],
      ["a", "operator"],
      ["b", "operator"],
    ],
  );
});

test("a thread listed under two agents appears once, under its freshest listing", () => {
  const t = (id, at) => ({ id, last_message_at: at });
  const merged = mergeAgentThreads([
    { slug: "operator", rows: [t("a", "2026-10-01T09:00:00Z"), t("b", null)] },
    { slug: "reddit_organic", rows: [t("a", "2026-10-02T09:00:00Z"), t("b", null)] },
  ]);
  assert.deepEqual(
    plain(merged.map((r) => [r.id, r.slug])),
    [
      ["a", "reddit_organic"],
      ["b", "operator"],
    ],
  );
});
