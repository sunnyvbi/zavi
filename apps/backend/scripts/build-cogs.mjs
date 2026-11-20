
import { createClient } from "@supabase/supabase-js";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DAYS = Number(arg("days", "60"));
const E2B_RATE_HR = Number(arg("rate", "0.10"));
const MARGIN = Number(arg("margin", "0.70"));
const SANDBOX_AGENTS = new Set(["engineer", "qa"]);
const BUILD_AGENTS = new Set(["engineer"]);

const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const usd = (n) => `$${n.toFixed(3)}`;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
let rows = [], from = 0;
for (;;) {
  const { data, error } = await sb
    .from("agent_runs")
    .select("agent_slug, cost_usd, started_at, finished_at, status")
    .gte("enqueued_at", since)
    .range(from, from + 999);
  if (error) { console.error("ERR:", error.message); process.exit(1); }
  rows.push(...data);
  if (data.length < 1000) break;
  from += 1000;
}

const sandboxCost = (durS, slug) =>
  SANDBOX_AGENTS.has(slug) && durS > 0 ? (durS / 3600) * E2B_RATE_HR : 0;

const by = {};
for (const r of rows) {
  const s = r.agent_slug || "?";
  (by[s] ??= { n: 0, loaded: [], tok: [], sbx: [] });
  by[s].n++;
  const tok = Number(r.cost_usd) || 0;
  let dur = 0;
  if (r.started_at && r.finished_at) {
    const d = (new Date(r.finished_at) - new Date(r.started_at)) / 1000;
    if (d > 0 && d < 7200) dur = d;
  }
  const sbx = sandboxCost(dur, s);
  by[s].tok.push(tok);
  by[s].sbx.push(sbx);
  by[s].loaded.push(tok + sbx);
}

const table = Object.entries(by)
  .map(([s, v]) => ({
    agent: s,
    runs: v.n,
    avg_loaded: +(v.loaded.reduce((a, b) => a + b, 0) / (v.loaded.length || 1)).toFixed(3),
    p50: +pct(v.loaded, 50).toFixed(3),
    p90: +pct(v.loaded, 90).toFixed(3),
    avg_tok: +(v.tok.reduce((a, b) => a + b, 0) / (v.tok.length || 1)).toFixed(3),
    avg_sbx: +(v.sbx.reduce((a, b) => a + b, 0) / (v.sbx.length || 1)).toFixed(4),
  }))
  .sort((a, b) => b.avg_loaded - a.avg_loaded);

console.log(`\n=== Per-agent fully-loaded COGS (last ${DAYS}d · e2b $${E2B_RATE_HR}/hr active) ===`);
console.table(table);

const eng = by["engineer"];
if (eng && eng.loaded.length) {
  const avg = eng.loaded.reduce((a, b) => a + b, 0) / eng.loaded.length;
  const p90 = pct(eng.loaded, 90);
  const creditCost = p90;
  const creditPrice = creditCost / (1 - MARGIN);
  console.log(`\n=== Build-credit pricing (1 build ≈ 1 credit) ===`);
  console.log(`engineer loaded COGS: avg ${usd(avg)} · p50 ${usd(pct(eng.loaded, 50))} · p90 ${usd(p90)}`);
  console.log(`token vs sandbox: tokens dominate (sandbox active ≈ ${usd(by.engineer.sbx.reduce((a,b)=>a+b,0)/by.engineer.sbx.length)}/build at $${E2B_RATE_HR}/hr)`);
  console.log(`→ credit unit cost (p90): ${usd(creditCost)}  → credit PRICE at ${MARGIN*100}% margin: ${usd(creditPrice)}`);
  console.log(`\nPer-tier build allowance (flat fee ÷ credit price), if ~50% of the flat fee funds builds:`);
  for (const [tier, fee] of [["Starter", 99], ["Growth", 399], ["Scale", 1299]]) {
    const builds = Math.floor((fee * 0.5) / creditPrice);
    console.log(`  ${tier} $${fee}/mo → ~${builds} builds/mo included`);
  }
  console.log(`\nNOTE: rate $${E2B_RATE_HR}/hr is a placeholder — set --rate to your real e2b plan.`);
  console.log(`NOTE: this captures ACTIVE sandbox only. IDLE/paused e2b storage (reaper gap) is`);
  console.log(`      fleet-level COGS NOT in here — quantify + reap separately before final credit price.`);
}
