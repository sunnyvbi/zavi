#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  loadEnv, TARGETS, mintToken, mintStaffToken, http, pollUntil, sleep, runMarker,
  subsetMismatch, missingKeys, findLeakedSecret, localInfraReason,
} from "./helpers.mjs";
import { judge } from "./judge.mjs";
import { cases, setup, teardown } from "./cases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

const TENANT_B = "e0fe9ea8";

function parseArgs(argv) {
  const a = { target: "local", baseUrl: null, fast: false, deep: false, only: null, case: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--target") a.target = argv[++i];
    else if (v === "--base-url") a.baseUrl = argv[++i];
    else if (v === "--fast") a.fast = true;
    else if (v === "--deep") a.deep = true;
    else if (v === "--only") a.only = argv[++i];
    else if (v === "--case") a.case = argv[++i];
    else if (v === "--json") a.json = argv[++i];
  }
  return a;
}

const C = { gray: "\x1b[90m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", cyn: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" };
const paint = (c, s) => `${c}${s}${C.off}`;

function curlRepro(base, req, token) {
  const parts = [`curl -s -X ${req.method} ${base}${req.path}`];
  if (token) parts.push(`-H "Authorization: Bearer $TOK"`);
  if (req.body !== undefined) parts.push(`-H 'Content-Type: application/json' -d '${JSON.stringify(req.body)}'`);
  return parts.join(" ");
}

function evalDeclarative(c, res, ctx) {
  const exp = c.expect || {};
  if (exp.status !== undefined) {
    const ok = Array.isArray(exp.status) ? exp.status.includes(res.status) : res.status === exp.status;
    if (!ok) return `expected status ${JSON.stringify(exp.status)}, got ${res.status}` + (res.networkError ? ` (network: ${res.text.slice(0, 60)})` : "");
  }
  if (exp.keys) {
    const m = missingKeys(exp.keys, res.json);
    if (m) return m;
  }
  if (exp.json) {
    const m = subsetMismatch(exp.json, res.json);
    if (m) return m;
  }
  if (typeof c.check === "function") {
    const m = c.check(res, ctx);
    if (m) return m;
  }
  return null;
}

const isTransient = (res) => res && (res.status === 0 || res.status >= 500);

async function runDeclarativeOnce(c, ctx) {
  const token = c.req.auth === "A" ? ctx.tokens.A : c.req.auth === "B" ? ctx.tokens.B : undefined;
  if ((c.req.auth === "A" && !token) || (c.req.auth === "B" && !token)) {
    return { transient: false, reason: `no ${c.req.auth} token available`, res: null };
  }
  const res = await http(ctx.base, { method: c.req.method, path: c.req.path, token, body: c.req.body, headers: c.req.headers });
  const reason = evalDeclarative(c, res, ctx);
  return { reason, res, transient: reason ? isTransient(res) : false, token };
}

async function runCase(c, ctx) {
  const attempts = [];

  if (typeof c.skipIf === "function") {
    const why = c.skipIf(ctx);
    if (why) return { status: "SKIP", reason: why, attempts };
  }

  if (c.tier === "C" && !ctx.env?.ANTHROPIC_API_KEY) {
    return {
      status: "SKIP",
      reason: "ANTHROPIC_API_KEY not set — Tier-C judge unavailable (run --target prod or set the key for behavioral grading)",
      attempts,
    };
  }

  if (typeof c.flow === "function") {
    const maxTries = c.tier === "C" ? 2 : 2;
    let last;
    for (let i = 0; i < maxTries; i++) {
      try {
        last = await c.flow(ctx);
      } catch (e) {
        last = { pass: false, reason: `flow threw: ${String(e).slice(0, 120)}` };
      }
      attempts.push(last.reason);
      if (last.pass || last.skip) break;
      if (i < maxTries - 1) await sleep(c.tier === "C" ? 1500 : 800);
    }
    if (last.skip) return { status: "SKIP", reason: last.reason, attempts };
    return {
      status: last.pass ? "PASS" : "FAIL",
      reason: last.reason,
      evidence: last.evidence,
      repro: last.repro,
      costUsd: last.costUsd || 0,
      attempts,
      retried: attempts.length > 1,
    };
  }

  let r = await runDeclarativeOnce(c, ctx);
  attempts.push(r.reason || "ok");
  if (r.reason && r.transient) {
    await sleep(1200);
    r = await runDeclarativeOnce(c, ctx);
    attempts.push(r.reason || "ok");
  }
  if (r.reason && ctx.target === "local") {
    const infra = localInfraReason(r.res);
    if (infra) return { status: "SKIP", reason: infra, attempts };
  }
  return {
    status: r.reason ? "FAIL" : "PASS",
    reason: r.reason || "",
    repro: c.req ? curlRepro(ctx.base, c.req, r.token) : undefined,
    attempts,
    retried: attempts.length > 1,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...loadEnv(), ...(process.env.QA_ENV_FILE ? loadEnv(process.env.QA_ENV_FILE) : {}) };
  const base = args.baseUrl || env.QA_API_BASE_URL || TARGETS[args.target] || args.target;
  const t0 = Date.now();

  const tokens = { A: null, B: null, staff: null };
  const decoded = { A: null, B: null, staff: null };
  try {
    if (!env.QA_TEST_EMAIL || !env.QA_TEST_PASSWORD) throw new Error("QA_TEST_EMAIL and QA_TEST_PASSWORD must both be set in apps/backend/.env");
    const a = await mintToken(env, env.QA_TEST_EMAIL, env.QA_TEST_PASSWORD);
    tokens.A = a.access_token; decoded.A = a.decoded;
  } catch (e) {
    console.error(paint(C.red, `FATAL: could not mint token A — ${e.message}`));
    process.exit(2);
  }
  if (env.QA_PRIVATE_TEST_PASSWORD) {
    try {
      const b = await mintToken(env, "ravi+private@upcar.ai", env.QA_PRIVATE_TEST_PASSWORD);
      tokens.B = b.access_token; decoded.B = b.decoded;
    } catch {  }
  }
  try {
    const s = await mintStaffToken(env);
    if (s) { tokens.staff = s.access_token; decoded.staff = s.decoded; }
  } catch (e) {
    console.error(paint(C.red, `WARN: QA_STAFF credential present but invalid — staff cases will SKIP. ${e.message}`));
  }

  const ctx = {
    env, base, target: args.target, tokens, decoded, marker: runMarker(),
    TENANT_B, repoRoot: REPO_ROOT,
    fast: args.fast, deep: args.deep,
    sweep: { noteIds: [] },
    http, pollUntil, sleep, judge, findLeakedSecret, localInfraReason,
  };

  const health = await http(base, { method: "GET", path: "/health" });
  if (health.status !== 200) {
    console.error(paint(C.red, `FATAL: ${base}/health returned ${health.status} — start the stack first (npm run dev).`));
    process.exit(2);
  }

  let selected = cases;
  if (args.case) selected = cases.filter((c) => c.id.toLowerCase() === args.case.toLowerCase());
  else if (args.only) {
    const q = args.only.toLowerCase();
    selected = cases.filter((c) => c.id.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }

  let dispatches = 0;
  await setup(ctx);
  if (ctx.shared?.pm?.thread_id) dispatches++;
  if (ctx.shared?.cto?.thread_id) dispatches++;

  const results = [];
  for (const c of selected) {
    process.stdout.write(paint(C.gray, `  · ${c.id} ${c.desc.slice(0, 54)} … `));
    const r = await runCase(c, ctx);
    results.push({ id: c.id, group: c.group, tier: c.tier, gate: c.gate, desc: c.desc, ...r });
    const mark = r.status === "PASS" ? paint(C.grn, "PASS") : r.status === "SKIP" ? paint(C.yel, "SKIP") : (c.gate ? paint(C.red, "FAIL") : paint(C.yel, "WATCH-RED"));
    process.stdout.write(`${mark}\n`);
  }

  await teardown(ctx).catch(() => {});

  const judgeCost = results.reduce((s, r) => s + (r.costUsd || 0), 0);
  const gate = results.filter((r) => r.gate);
  const watch = results.filter((r) => !r.gate);
  const gatePass = gate.filter((r) => r.status === "PASS").length;
  const gateFail = gate.filter((r) => r.status === "FAIL");
  const gateSkip = gate.filter((r) => r.status === "SKIP").length;
  const watchRed = watch.filter((r) => r.status === "FAIL");
  const durS = ((Date.now() - t0) / 1000).toFixed(0);

  console.log("");
  console.log(paint(C.bold, `QA-API regression — ${new Date().toISOString()} — target: ${args.target} (${base})`));
  const gateLine = gateFail.length === 0
    ? paint(C.grn, `GREEN GATE: ${gatePass}/${gate.length - gateSkip} PASS  ✅  (gate green → safe to push)`)
    : paint(C.red, `GREEN GATE: ${gateFail.length} RED  ❌  — BLOCKS PUSH`);
  console.log(gateLine);
  if (gateSkip) console.log(paint(C.yel, `CONDITIONAL: ${gateSkip} SKIP (precondition/flag/--fast)`));
  console.log(paint(C.gray, `run ${durS}s · ${dispatches} agent dispatch(es) · est. judge $${judgeCost.toFixed(3)}`));

  if (gateFail.length) {
    console.log("\n" + paint(C.red, "── GATE REGRESSIONS (block push) ──"));
    for (const r of gateFail) {
      console.log(paint(C.red, `  ❌ ${r.id}  ${r.desc}`));
      console.log(`     ${r.reason}`);
      if (r.retried) console.log(paint(C.gray, `     (failed ${r.attempts.length}/${r.attempts.length} attempts — not a flake)`));
      if (r.repro) console.log(paint(C.gray, `     repro: ${r.repro}`));
    }
  }
  if (watchRed.length) {
    console.log("\n" + paint(C.yel, "── WATCHLIST (known gaps — NOT gating) ──"));
    for (const r of watchRed) console.log(paint(C.yel, `  ⚠︎ ${r.id}  ${r.reason}`));
  }
  console.log("");

  const report = {
    timestamp: new Date().toISOString(),
    target: args.target, base, durationS: Number(durS),
    dispatches, judgeCostUsd: Number(judgeCost.toFixed(4)),
    summary: { gateTotal: gate.length, gatePass, gateFail: gateFail.length, gateSkip, watchRed: watchRed.length },
    results,
  };
  const jsonPath = args.json || join(__dirname, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  try { writeFileSync(jsonPath, JSON.stringify(report, null, 2)); console.log(paint(C.gray, `report → ${jsonPath}`)); } catch {  }

  process.exit(gateFail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(paint(C.red, `runner crashed: ${e?.stack || e}`));
  process.exit(2);
});
