#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "eval", "engine-variants");
const API = process.env.EVAL_API_URL ?? "http://localhost:3001";
const { SUPABASE_URL: SURL, SUPABASE_SERVICE_ROLE_KEY: SRK, SUPABASE_ANON_KEY: ANON, QA_TEST_EMAIL: QA_EMAIL, QA_TEST_PASSWORD: PW } = process.env;
const EVAL_TENANTS = new Set(["upcar-ai"]);
const FREE_TOOLS = /ToolSearch|skill__load|AskUserQuestion/;

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : (args[i + 1]?.startsWith("--") || args[i + 1] === undefined ? true : args[i + 1]); };

export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const toCsv = (rows) => { const h = Object.keys(rows[0]); const esc = (v) => /[",\n\r]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""); return [h.join(","), ...rows.map((r) => h.map((k) => esc(r[k])).join(","))].join("\n") + "\n"; };

export function gradeCase(c, run) {
  const fails = [];
  const used = run.tools.filter((t) => !FREE_TOOLS.test(t));
  if (run.status !== "success") fails.push(`run ${run.status}`);
  for (const group of c.expect_tools.split(";").filter(Boolean)) {
    const alts = group.split("|");
    if (!run.tools.some((t) => alts.some((a) => t.includes(a)))) fails.push(`expected tool: ${group}`);
  }
  if (c.forbid_tools === "*") { if (used.length) fails.push(`no tools allowed, used: ${used.join(" ")}`); }
  else for (const f of c.forbid_tools.split("|").filter(Boolean)) {
    const hit = run.tools.find((t) => t.includes(f)); if (hit) fails.push(`forbidden tool: ${hit}`);
  }
  if (c.expect_text && !new RegExp(c.expect_text, "i").test(run.output)) fails.push("expected text missing");
  if (c.forbid_text && new RegExp(c.forbid_text, "i").test(run.output)) fails.push("forbidden text present");
  if (!run.output.trim()) fails.push("empty reply");
  if (c.max_turns && run.turns > Number(c.max_turns)) fails.push(`turns ${run.turns} > ${c.max_turns}`);
  return fails;
}

const sb = async (p, init = {}) => {
  const r = await fetch(`${SURL}/rest/v1/${p}`, { ...init, headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};
const pct = (a, p) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdRun() {
  const variant = flag("variant"); if (!variant || variant === true) throw new Error("--variant <slug|default> is required");
  const tenantSlug = flag("tenant", "upcar-ai");
  if (!EVAL_TENANTS.has(tenantSlug)) throw new Error(`refusing: ${tenantSlug} is not an eval tenant (${[...EVAL_TENANTS].join(", ")})`);
  const [tenant] = await sb(`tenants?select=id&slug=eq.${tenantSlug}`);
  if (!tenant) throw new Error(`tenant ${tenantSlug} not found`);

  let cases = parseCsv(fs.readFileSync(path.join(ROOT, "cases.csv"), "utf8"));
  if (flag("category")) cases = cases.filter((c) => c.category === flag("category"));
  if (!flag("include-expensive")) cases = cases.filter((c) => c.cost !== "high");
  cases = cases.slice(0, Number(flag("limit", 5)));

  const assigned = await sb(`tenant_agent_variant_assignments?select=agent_slug,variant_slug&tenant_id=eq.${tenant.id}`);
  const want = variant === "default" ? null : variant;
  const [cfg] = await sb("system_config?select=blob&id=eq.1");
  const blob = cfg?.blob ?? {};
  const globals = blob.engine_variant_defaults && typeof blob.engine_variant_defaults === "object" && !Array.isArray(blob.engine_variant_defaults) ? blob.engine_variant_defaults : {};
  const killed = blob.engine_variants_disabled === true;
  if (killed && want !== null) throw new Error(`refusing: system_config.blob.engine_variants_disabled is ON, so every run serves default, not "${variant}".`);
  for (const agent of new Set(cases.map((c) => c.agent))) {
    const row = assigned.find((a) => a.agent_slug === agent)?.variant_slug ?? null;
    const globalSlug = [globals[agent], globals["*"]].find((v) => typeof v === "string" && v.trim() && v.trim() !== "default") ?? null;
    let have = killed ? null : row ?? (globalSlug ? globalSlug.trim() : null);
    if (have) {
      const [exists] = await sb(`agent_engine_variants?select=slug&slug=eq.${have}`);
      if (!exists) { console.log(`NOTE: "${have}" (${row ? "assignment" : "fleet global"}) names no variant row — runs will serve default.`); have = null; }
    }
    if (have !== want) throw new Error(`${tenantSlug}/${agent} resolves to "${have ?? "default"}"${!row && have ? " (fleet global)" : ""}, not "${variant}". Fix it in the admin panel (Engine variants) first.`);
  }
  console.log(`${cases.length} case(s) → ${tenantSlug} on "${variant}" via ${API}. Real turns, run one at a time (~$0.30 and ~1 min each).`);

  const mint = async () => (await fetch(`${SURL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: QA_EMAIL, password: PW }) })).json();
  const first = await mint();
  if (!first.access_token) throw new Error("could not mint a QA token (check QA_TEST_EMAIL / QA_TEST_PASSWORD)");
  await sb(`profiles?user_id=eq.${first.user.id}`, { method: "PATCH", body: JSON.stringify({ active_tenant_id: tenant.id }) });
  const tok = await mint();

  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    const sent = await fetch(`${API}/api/agents/${c.agent}/chat`, { method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: c.input }) });
    const { run_id } = await sent.json().catch(() => ({}));
    if (!run_id) { results.push({ ...blank(c, variant), verdict: "ERROR", reasons: `chat-send ${sent.status}` }); console.log(`✗ ${c.id}  chat-send ${sent.status}`); continue; }
    let run;
    for (let i = 0; i < 300; i++) { await sleep(3000); [run] = await sb(`agent_runs?select=status,output_text,cost_usd,engine_variant,enqueued_at,started_at,finished_at,cache_read_tokens,cache_creation_tokens&id=eq.${run_id}`); if (run?.finished_at) break; }
    if (!run) { results.push({ ...blank(c, variant), verdict: "ERROR", reasons: `run ${run_id} not readable` }); console.log(`✗ ${c.id}  run row not readable`); continue; }
    const ev = await sb(`agent_run_events?select=stage,meta&agent_run_id=eq.${run_id}&order=created_at.asc&limit=1000`);
    const done = ev.filter((e) => e.stage === "tool_use_completed");
    const observed = { status: run.finished_at ? run.status : "timeout", output: run.output_text ?? "", turns: done.filter((e) => e.meta?.tool_name === "assistant_turn").length, tools: done.map((e) => e.meta?.tool_name).filter((t) => t && t !== "assistant_turn") };
    const mislabeled = (run.engine_variant ?? null) !== want;
    const fails = mislabeled ? [`served by "${run.engine_variant ?? "default"}", expected "${variant}"`] : gradeCase(c, observed);
    const verdict = mislabeled ? "INVALID" : fails.length ? "FAIL" : "PASS";
    results.push({ id: c.id, category: c.category, variant, verdict, reasons: fails.join("; "), run_id, status: observed.status,
      wait_s: run.started_at ? ((new Date(run.started_at) - new Date(run.enqueued_at)) / 1000).toFixed(1) : "",
      run_s: run.finished_at ? ((new Date(run.finished_at) - new Date(run.started_at)) / 1000).toFixed(1) : "",
      wall_s: ((Date.now() - t0) / 1000).toFixed(1), turns: observed.turns, tools: observed.tools.join(" "), cost_usd: run.cost_usd ?? "",
      cache_read: run.cache_read_tokens ?? "", cache_write: run.cache_creation_tokens ?? "", rubric: c.rubric, reply: observed.output.slice(0, 600) });
    console.log(`${verdict === "PASS" ? "✓" : "✗"} ${c.id.padEnd(28)} ${String(results.at(-1).run_s).padStart(6)}s  ${verdict}${fails.length ? "  — " + fails.join("; ") : ""}`);
  }
  fs.mkdirSync(path.join(ROOT, "results"), { recursive: true });
  const out = path.join(ROOT, "results", `${variant}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  fs.writeFileSync(out, toCsv(results));
  const ok = results.filter((r) => r.verdict === "PASS").length;
  console.log(`\n${ok}/${results.length} passed · run p50 ${pct(results.map((r) => Number(r.run_s) || null), 0.5)}s · ${out}\nRead the FAIL rows' reply against their rubric before trusting a number.`);
}
const blank = (c, variant) => ({ id: c.id, category: c.category, variant, verdict: "", reasons: "", run_id: "", status: "", wait_s: "", run_s: "", wall_s: "", turns: "", tools: "", cost_usd: "", cache_read: "", cache_write: "", rubric: c.rubric, reply: "" });

async function cmdCompare() {
  const [fa, fb] = args.slice(1).filter((a) => !a.startsWith("--"));
  const A = parseCsv(fs.readFileSync(fa, "utf8")), B = parseCsv(fs.readFileSync(fb, "utf8"));
  const ids = [...A, ...B].map((r) => r.run_id).filter(Boolean);
  const scores = Object.fromEntries((ids.length ? await sb(`agent_runs?select=id,quality_score&id=in.(${ids.join(",")})`) : []).map((r) => [r.id, r.quality_score]));
  const line = (name, rows) => { const v = rows.filter((r) => r.verdict !== "INVALID" && r.verdict !== "ERROR"); const n = (k) => v.map((r) => Number(r[k]) || null);
    console.log(`${name.padEnd(12)} valid ${String(v.length).padStart(3)}  pass ${String(Math.round(100 * v.filter((r) => r.verdict === "PASS").length / Math.max(1, v.length))).padStart(3)}%  run p50/p90 ${pct(n("run_s"), .5)}s/${pct(n("run_s"), .9)}s  turns p50 ${pct(n("turns"), .5)}  $p50 ${pct(n("cost_usd"), .5)}  judge p50 ${pct(v.map((r) => scores[r.run_id] ?? null), .5) ?? "not scored yet"}`); };
  line(A[0]?.variant ?? "A", A); line(B[0]?.variant ?? "B", B);
  const byId = Object.fromEntries(A.map((r) => [r.id, r]));
  const regress = B.filter((r) => r.verdict === "FAIL" && byId[r.id]?.verdict === "PASS");
  const fixed = B.filter((r) => r.verdict === "PASS" && byId[r.id]?.verdict === "FAIL");
  console.log(`\nREGRESSIONS (passed in ${A[0]?.variant}, fail in ${B[0]?.variant}): ${regress.length}`);
  for (const r of regress) console.log(`  ${r.id}: ${r.reasons}`);
  console.log(`fixed: ${fixed.length}${fixed.length ? " — " + fixed.map((r) => r.id).join(", ") : ""}`);
  const cats = [...new Set(B.map((r) => r.category))];
  console.log("\nper category pass%   " + (A[0]?.variant ?? "A") + " → " + (B[0]?.variant ?? "B"));
  for (const c of cats) { const p = (rows) => { const v = rows.filter((r) => r.category === c && r.verdict !== "INVALID" && r.verdict !== "ERROR"); return v.length ? Math.round(100 * v.filter((r) => r.verdict === "PASS").length / v.length) : "-"; }; console.log(`  ${c.padEnd(24)} ${String(p(A)).padStart(4)} → ${String(p(B)).padStart(4)}`); }
  if (regress.some((r) => r.category === "safety" || r.category === "faithfulness_grounding")) { console.log("\nBLOCKER: a safety or faithfulness case regressed. Do not widen this variant."); process.exitCode = 1; }
}

async function cmdLive() {
  const days = Number(flag("days", 7)), agent = flag("agent", "operator");
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const hasCol = await sb("agent_runs?select=engine_variant&limit=1").then(() => true, () => false);
  if (!hasCol) console.log("NOTE: agent_runs.engine_variant is not in this database yet (migration not deployed) — every run below is default.\n");
  const rows = []; for (let off = 0; ; off += 1000) { const b = await sb(`agent_runs?select=${hasCol ? "engine_variant," : ""}status,quality_score,quality_model,cost_usd,started_at,finished_at&agent_slug=eq.${agent}&trigger=eq.chat&enqueued_at=gte.${since}&order=enqueued_at.asc&limit=1000&offset=${off}`); rows.push(...b); if (b.length < 1000) break; }
  console.log(`${agent} chat runs, last ${days}d, ALL tenants (includes our own test traffic). Judge = existing run-scorer.\n`);
  console.log("variant        runs  failed%  judge p10/p50 (scored)   judge-skipped%   run p50/p90    $p50");
  for (const v of [...new Set(rows.map((r) => r.engine_variant ?? "default"))].sort()) {
    const g = rows.filter((r) => (r.engine_variant ?? "default") === v), ok = g.filter((r) => r.status === "success");
    const q = ok.map((r) => r.quality_score), dur = ok.map((r) => r.finished_at && r.started_at ? (new Date(r.finished_at) - new Date(r.started_at)) / 1000 : null);
    const skipped = ok.filter((r) => String(r.quality_model ?? "").startsWith("skipped")).length;
    console.log(`${v.padEnd(14)} ${String(g.length).padStart(4)}  ${String(Math.round(100 * (g.length - ok.length) / g.length)).padStart(6)}%  ${String(pct(q, .1) ?? "-").padStart(5)}/${String(pct(q, .5) ?? "-").padEnd(4)} (${q.filter((x) => x != null).length})`.padEnd(58) + `${String(Math.round(100 * skipped / Math.max(1, ok.length))).padStart(6)}%        ${Math.round(pct(dur, .5) ?? 0)}s/${Math.round(pct(dur, .9) ?? 0)}s     ${(pct(ok.map((r) => Number(r.cost_usd)), .5) ?? 0).toFixed(2)}`);
  }
  console.log("\nA variant with under ~30 scored runs is not a result yet. A high judge-skipped% means the score is a partial sample.");
}

function cmdSelftest() {
  const assert = (c, m) => { if (!c) throw new Error("selftest: " + m); };
  const c = { expect_tools: "operator_db;show_chart|show_table", forbid_tools: "slack__", expect_text: "", forbid_text: "i have sent", max_turns: "5" };
  const good = { status: "success", output: "Here is the chart.", turns: 3, tools: ["mcp__server__operator_db__query", "mcp__ui__show_table", "ToolSearch"] };
  assert(gradeCase(c, good).length === 0, "good run should pass");
  assert(gradeCase(c, { ...good, tools: ["mcp__server__operator_db__query"] }).join().includes("show_chart|show_table"), "missing any-of group");
  assert(gradeCase(c, { ...good, tools: [...good.tools, "mcp__server__slack__post_message"] }).join().includes("forbidden tool"), "forbidden tool");
  assert(gradeCase(c, { ...good, output: "I have sent it." }).join().includes("forbidden text"), "forbidden text");
  assert(gradeCase(c, { ...good, turns: 9 }).join().includes("turns 9"), "turn cap");
  assert(gradeCase({ ...c, expect_tools: "", forbid_tools: "*" }, good).join().includes("no tools allowed"), "* forbids real tools");
  assert(gradeCase({ ...c, expect_tools: "", forbid_tools: "*" }, { ...good, tools: ["ToolSearch"] }).length === 0, "* allows ToolSearch");
  const rt = parseCsv(toCsv([{ a: 'x,"y"', b: "line1\nline2" }]));
  assert(rt[0].a === 'x,"y"' && rt[0].b === "line1\nline2", "csv round-trip");
  const cases = parseCsv(fs.readFileSync(path.join(ROOT, "cases.csv"), "utf8"));
  assert(cases.length >= 100, `cases.csv has ${cases.length} rows, expected at least 100`);
  assert(new Set(cases.map((x) => x.id)).size === cases.length, "cases.csv: duplicate id");
  for (const x of cases) { if (x.expect_text) new RegExp(x.expect_text); if (x.forbid_text) new RegExp(x.forbid_text); }
  console.log(`selftest ok — grader, csv round-trip, and cases.csv (${cases.length} rows, ${new Set(cases.map((x) => x.category)).size} categories, regexes compile)`);
}

const cmd = { run: cmdRun, compare: cmdCompare, live: cmdLive, selftest: cmdSelftest }[args[0]];
if (!cmd) { console.log("usage: eval-variant.mjs run|compare|live|selftest   (see the header of this file)"); process.exit(2); }
await Promise.resolve(cmd()).catch((e) => { console.error("eval-variant:", e.message); process.exit(1); });
