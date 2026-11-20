const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const ts = require("typescript");
const root = path.resolve(__dirname, "../../..");
const file = "apps/backend/src/services/agents/stream-draft.ts";
const baseline = process.argv[2];
if (!baseline) {
  console.error("Usage: node apps/backend/scripts/bench-chat-streaming.cjs <baseline-ref>");
  process.exit(1);
}
function emitter(source) {
  const m = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  new Function("require", "exports", "module", code)(name => {
    assert.equal(name, "@/services/supabase");
    return { serviceClient: () => { throw Error("Production access forbidden"); } };
  }, m.exports, m);
  return m.exports.createStreamDraftEmitter;
}
async function trial(create) {
  let inFlight = 0, maxInFlight = 0;
  const rows = [];
  let stored;
  function request(kind, row, options = {}) {
    rows.push(row); maxInFlight = Math.max(maxInFlight, ++inFlight);
    const filters = [];
    const result = new Promise(resolve => setTimeout(() => {
      inFlight--;
      const accepted = kind === "insert"
        ? !stored || !options.ignoreDuplicates
        : stored && filters.every(([op, key, value]) => op === "eq" ? stored[key] === value : stored[key] < value);
      if (accepted) stored = row;
      resolve({ data: accepted ? { run_id: row.run_id } : null, error: null });
    }, 10));
    result.select = result.maybeSingle = result.abortSignal = () => result;
    result.eq = (key, value) => { filters.push(["eq", key, value]); return result; };
    result.lt = (key, value) => { filters.push(["lt", key, value]); return result; };
    return result;
  }
  const sb = { from: () => ({
    upsert: (row, options) => request("insert", row, options),
    update: row => request("update", row),
  }) };
  const e = create({ runId: "synthetic", tenantId: "synthetic", threadId: null, agentSlug: "operator", sb });
  const text = "0123456789".repeat(4);
  const start = performance.now();
  for (let i = 0; i < 100; i++) await e.push(text);
  const consumedMs = performance.now() - start;
  await e.finish("complete");
  const settledMs = performance.now() - start;
  assert.equal(stored.text, text.repeat(100));
  assert.equal(stored.status, "complete");
  assert.equal(maxInFlight, 1);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].seq > rows[i - 1].seq);
  return { consumedMs, settledMs, writes: rows.length };
}
(async () => {
  const before = emitter(execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" }));
  const after = emitter(fs.readFileSync(path.join(root, file), "utf8"));
  const results = { before: [], after: [] };
  for (let i = 0; i < 5; i++) { results.before.push(await trial(before)); results.after.push(await trial(after)); }
  const median = values => values.slice().sort((a,b) => a-b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(Object.entries(results).map(([name, trials]) => [name, Object.fromEntries(["consumedMs", "settledMs", "writes"].map(k => [k, Math.round(median(trials.map(t => t[k])) * 100) / 100]))]));
  console.log(JSON.stringify({ baseline, workload: "100 x 40-character chunks, 10ms simulated storage latency, 5 paired trials", quality: "Final 4000 characters identical; terminal status and sequence verified; at most one write in flight", summary, trials: results }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
