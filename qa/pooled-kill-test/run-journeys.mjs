import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { KIT } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const dev = args.includes("--dev");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const compat = JSON.parse(readFileSync(`${KIT}/compat.json`, "utf8"));
let map = {};
if (!dev) {
  const f = args[args.indexOf("--sites") + 1];
  if (!args.includes("--sites") || !f) { console.error("usage: run-journeys.mjs --sites sites.map.json | --dev [--only 01,02]"); process.exit(2); }
  map = JSON.parse(readFileSync(f, "utf8"));
}

function runOne(n, base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, `${KIT}/journeys/${n}.mjs`, base], { env: process.env, stdio: ["inherit", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      let json = null;
      try { json = JSON.parse(out.slice(out.indexOf("{"))); } catch { json = { ok: false, error: "no JSON output", raw: out.slice(-500) }; }
      resolve({ n, base, exit: code, ...json });
    });
  });
}

const results = [];
for (const s of compat.sites) {
  if (only && !only.includes(s.n)) continue;
  const base = dev ? `dev:kk${s.n}` : map[s.n];
  if (!base) { results.push({ n: s.n, ok: false, error: "no host in the sites map" }); continue; }
  process.stderr.write(`journey ${s.n} -> ${base}\n`);
  results.push(await runOne(s.n, base));
}
const working = results.filter((r) => r.exit === 0 && r.ok && (dev || (r.summary?.skip ?? 1) === 0));
const complete = !only && compat.sites.every((s) => results.some((r) => r.n === s.n));
const verdict = Object.fromEntries(compat.sites.map((s) => [s.n, s.verdict]));
const tally = {
  mode: dev ? "DEV DRY RUN: not the kill test" : "real",
  ran: results.length,
  working: working.length,
  pooled_working: working.filter((r) => verdict[r.n] === "pooled").length,
  dedicated_working: working.filter((r) => verdict[r.n] === "dedicated").length,
  failing: results.filter((r) => !working.includes(r)).map((r) => ({ n: r.n, fails: (r.steps ?? []).filter((x) => x.status === "fail" || (!dev && x.status === "skip")).map((x) => `${x.id}: ${x.detail ?? ""}`).slice(0, 5), error: r.error })),
  skipped_steps: results.reduce((a, r) => a + (r.summary?.skip ?? 0), 0),
  bar: ">= 18/20 working",
  bar_met: dev ? "not evaluated in a dry run" : !complete ? "not evaluated: partial run (all 20 sites must run in one invocation)" : working.length >= 18,
};
mkdirSync(`${KIT}/results`, { recursive: true });
const file = `${KIT}/results/journeys-${dev ? "dev" : "real"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ tally, results }, null, 2) + "\n");
console.log(JSON.stringify({ ...tally, file }, null, 2));
process.exit(dev ? (tally.failing.length ? 1 : 0) : tally.bar_met === true ? 0 : 1);
