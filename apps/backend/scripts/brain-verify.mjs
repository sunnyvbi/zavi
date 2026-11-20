#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

function loadEnv(path) {
  const env = {};
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).replace(/^export\s+/, "").trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  } catch {
  }
  return { ...env, ...process.env };
}

const TARGETS = { local: "http://localhost:3001", prod: "https://api.thepraxis.ai" };

async function mintToken(env, email, password) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("missing SUPABASE_URL or SUPABASE_ANON_KEY");
  }
  if (!password) throw new Error(`no password available for ${email}`);
  const url = `${env.SUPABASE_URL}/auth/v1/token?grant_type=password`;
  const r = await fetch(url, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    throw new Error(`mintToken HTTP ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.access_token;
}

async function http(base, { method = "GET", path, token, body, headers = {} } = {}) {
  const t0 = Date.now();
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {  }
    return { status: res.status, json, text, ms: Date.now() - t0, ok: res.ok };
  } catch (e) {
    return { status: 0, text: String(e), ms: Date.now() - t0, ok: false, networkError: true };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function passFail(ok, reason) { return ok ? { pass: true } : { pass: false, reason }; }

function findHitByPrefix(hits, prefix) {
  return hits.findIndex((h) => (h.note_id || "").startsWith(prefix));
}

async function runRecall(ctx, c) {
  const t0 = Date.now();
  const res = await http(ctx.base, {
    method: "POST",
    path: "/api/memory/search",
    token: ctx.token,
    body: { query: c.query, k: c.k ?? 8 },
  });
  const ms = Date.now() - t0;
  if (res.status !== 200) return { ...passFail(false, `search HTTP ${res.status}`), ms };
  const hits = res.json?.hits || [];
  if (typeof c.expect_min_hits === "number" && hits.length < c.expect_min_hits) {
    return { ...passFail(false, `hits=${hits.length} < min ${c.expect_min_hits}`), hits: hits.length, ms };
  }
  if (typeof c.expect_max_hits === "number" && hits.length > c.expect_max_hits) {
    return { ...passFail(false, `hits=${hits.length} > max ${c.expect_max_hits}`), hits: hits.length, ms };
  }
  let expectedRank = -1; let expectedScore = null;
  if (c.expect_note_id_prefix) {
    const k = c.top_k ?? 3;
    expectedRank = findHitByPrefix(hits.slice(0, k), c.expect_note_id_prefix);
    if (expectedRank < 0) {
      return { ...passFail(false, `expected note ${c.expect_note_id_prefix} not in top-${k} (got ${hits.slice(0, k).map((h) => h.note_id?.slice(0, 8)).join(",")})`), hits: hits.length, ms };
    }
    expectedScore = hits[expectedRank]?.score ?? 0;
  }
  if (typeof c.min_top_score === "number") {
    const score = expectedScore !== null ? expectedScore : (hits[0]?.score ?? 0);
    if (score < c.min_top_score) {
      return { ...passFail(false, `score=${score.toFixed(3)} < min ${c.min_top_score} (rank ${expectedRank})`), ms };
    }
  }
  return { pass: true, hits: hits.length, ms, expected_rank: expectedRank, expected_score: expectedScore, top_score: hits[0]?.score, top_id: hits[0]?.note_id?.slice(0, 8) };
}

async function runIsolation(ctx, c) {
  const res = await http(ctx.base, {
    method: "POST",
    path: "/api/memory/search",
    token: ctx.token,
    body: { query: c.sentinel_query, k: 5 },
  });
  if (res.status !== 200) return passFail(false, `search HTTP ${res.status}`);
  const hits = res.json?.hits || [];
  if (hits.length > 0) {
    return passFail(false, `expected 0 hits for sentinel "${c.sentinel_query.slice(0, 40)}", got ${hits.length} (top score ${hits[0]?.score})`);
  }
  return { pass: true, hits: 0 };
}

async function runWriteRecall(ctx, c) {
  const marker = ctx.marker;
  const body = c.body.replace("{MARKER}", marker);
  const recall = c.recall_query.replace("{MARKER}", marker);
  const w = await http(ctx.base, {
    method: "POST",
    path: "/api/memory/notes",
    token: ctx.token,
    body: { title: `brain-verify ${marker}`, body_markdown: body, note_type: "untyped" },
  });
  if (w.status >= 400) return passFail(false, `write HTTP ${w.status}: ${w.text?.slice(0, 120)}`);
  const id = w.json?.note_id || w.json?.note?.id || w.json?.id;
  if (!id) return passFail(false, `no note_id in write response: ${JSON.stringify(w.json).slice(0, 120)}`);
  ctx.sweep.push(id);
  await sleep(3000);
  let found = false; let topScore = 0; let attempts = 0;
  for (let i = 0; i < 10; i++) {
    attempts = i + 1;
    const r = await http(ctx.base, {
      method: "POST",
      path: "/api/memory/search",
      token: ctx.token,
      body: { query: recall, k: 5 },
    });
    const hits = r.json?.hits || [];
    const rank = findHitByPrefix(hits, id.slice(0, 8));
    if (rank >= 0) {
      found = true;
      topScore = hits[rank].score ?? 0;
      break;
    }
    await sleep(3000);
  }
  if (!found) return passFail(false, `wrote note ${id.slice(0, 8)} but not recallable after ${attempts * 3}s`);
  return { pass: true, note_id: id.slice(0, 8), top_score: topScore, embed_wait_s: attempts * 3 };
}

async function runInjection(ctx, c) {
  const marker = ctx.marker;
  const body = c.body.replace("{MARKER}", marker);
  const w = await http(ctx.base, {
    method: "POST",
    path: "/api/memory/notes",
    token: ctx.token,
    body: { title: `inj-canary ${marker}`, body_markdown: body, note_type: "untyped" },
  });
  if (w.status >= 400) return passFail(false, `write HTTP ${w.status}`);
  const id = w.json?.note_id || w.json?.note?.id || w.json?.id;
  if (!id) return passFail(false, `no note_id in write response: ${JSON.stringify(w.json).slice(0, 120)}`);
  ctx.sweep.push(id);
  await sleep(5000);
  const r = await http(ctx.base, {
    method: "POST",
    path: "/api/memory/search",
    token: ctx.token,
    body: { query: c.off_topic_probe || "quantum chromodynamics lattice gauge theory", k: 5 },
  });
  const hits = r.json?.hits || [];
  if (hits.length > 0) {
    return passFail(false, `injection canary polluted off-topic recall: ${hits.length} hits`);
  }
  return { pass: true };
}

const KINDS = {
  recall: runRecall,
  isolation: runIsolation,
  write_recall: runWriteRecall,
  injection: runInjection,
};

function loadCatalog(path) {
  if (!existsSync(path)) {
    throw new Error(`catalog not found: ${path}. Sibling research agent owns this file — see docs/qa-reports/brain-stress-test/plan-skills-harness.md schema.`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.cases || !Array.isArray(raw.cases)) throw new Error("catalog has no .cases array");
  return raw;
}

function findPriorReport(outRoot) {
  if (!existsSync(outRoot)) return null;
  const dirs = readdirSync(outRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const today = new Date().toISOString().slice(0, 10);
  const prior = dirs.filter((d) => d !== today).pop();
  if (!prior) return null;
  const p = join(outRoot, prior, "results.json");
  if (!existsSync(p)) return null;
  try { return { date: prior, data: JSON.parse(readFileSync(p, "utf8")) }; } catch { return null; }
}

function diffSummary(prior, today) {
  if (!prior) return "(no prior run on disk — first run)";
  const py = new Map(prior.data.results.map((r) => [r.id, r.status]));
  const moved = [];
  for (const r of today.results) {
    const was = py.get(r.id);
    if (was && was !== r.status) moved.push(`${r.id}: ${was} → ${r.status}`);
  }
  return moved.length ? moved.join("\n") : "(no status changes vs prior run)";
}

function parseArgs(argv) {
  const a = {
    mode: "daily",
    target: "prod",
    catalog: join(REPO_ROOT, "docs", "qa-reports", "brain-stress-test", "catalog.json"),
    tenantEmail: "rravi149+private@gmail.com",
    case: null,
    outRoot: join(REPO_ROOT, "docs", "qa-reports", "brain-verify"),
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--mode") a.mode = argv[++i];
    else if (v === "--target") a.target = argv[++i];
    else if (v === "--catalog") a.catalog = argv[++i];
    else if (v === "--tenant-email") a.tenantEmail = argv[++i];
    else if (v === "--case") a.case = argv[++i];
    else if (v === "--out-root") a.outRoot = argv[++i];
    else if (v === "--json") a.json = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(join(REPO_ROOT, "apps", "backend", ".env"));
  const base = TARGETS[args.target] || args.target;

  const pw = args.tenantEmail.endsWith("+private@gmail.com") || args.tenantEmail.includes("+private@")
    ? (env.QA_PRIVATE_TEST_PASSWORD || env.QA_TEST_PASSWORD)
    : env.QA_TEST_PASSWORD;
  const token = await mintToken(env, args.tenantEmail, pw);

  const today = new Date().toISOString().slice(0, 10);
  const outDir = join(args.outRoot, today);
  mkdirSync(outDir, { recursive: true });

  const health = await http(base, { method: "GET", path: "/health" });
  if (health.status !== 200) {
    console.error(`FATAL: ${base}/health returned ${health.status}`);
    process.exit(2);
  }

  const catalog = loadCatalog(args.catalog);
  const all = catalog.cases.filter((c) => args.case ? c.id === args.case : true);
  const cases = all.filter((c) => args.mode === "weekly" ? true : c.mode === "daily");

  const ctx = {
    base, token,
    marker: `brain-verify-${today}-${Math.random().toString(36).slice(2, 8)}`,
    sweep: [],
  };

  const t0 = Date.now();
  const results = [];
  const latencies = [];
  console.log(`brain-verify ${args.mode} · target=${args.target} · tenant=${args.tenantEmail} · cases=${cases.length}`);
  for (const c of cases) {
    const handler = KINDS[c.kind];
    process.stdout.write(`  · ${c.id.padEnd(20)} ${(c.desc || c.kind).slice(0, 50).padEnd(52)}`);
    if (!handler) {
      results.push({ id: c.id, group: c.group, gate: c.gate, kind: c.kind, status: "SKIP", reason: `unknown kind: ${c.kind}` });
      console.log(" SKIP (unknown kind)");
      continue;
    }
    let out;
    try {
      out = await handler(ctx, c);
    } catch (e) {
      out = { pass: false, reason: `threw: ${String(e).slice(0, 120)}` };
    }
    const status = out.pass ? "PASS" : "FAIL";
    if (out.ms) latencies.push(out.ms);
    results.push({ id: c.id, group: c.group, gate: c.gate, kind: c.kind, desc: c.desc, status, reason: out.reason, evidence: { hits: out.hits, top_score: out.top_score, top_id: out.top_id, expected_rank: out.expected_rank, expected_score: out.expected_score, ms: out.ms, note_id: out.note_id, embed_wait_s: out.embed_wait_s } });
    console.log(` ${status}${out.reason ? "  " + out.reason.slice(0, 70) : ""}`);
  }

  for (const id of ctx.sweep) {
    await http(base, { method: "DELETE", path: `/api/memory/notes/${id}`, token }).catch(() => {});
  }

  const gateP0 = results.filter((r) => r.gate === "P0");
  const watch = results.filter((r) => r.gate !== "P0");
  const gateFail = gateP0.filter((r) => r.status === "FAIL");
  const watchFail = watch.filter((r) => r.status === "FAIL");
  const gatePass = gateP0.filter((r) => r.status === "PASS").length;
  const durS = ((Date.now() - t0) / 1000).toFixed(1);
  const p50 = latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)] : null;
  const p95 = latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : null;

  const report = {
    timestamp: new Date().toISOString(),
    mode: args.mode,
    target: args.target,
    base,
    tenant_email: args.tenantEmail,
    catalog_version: catalog.version,
    catalog_path: args.catalog,
    duration_s: Number(durS),
    summary: {
      p0_total: gateP0.length,
      p0_pass: gatePass,
      p0_fail: gateFail.length,
      watch_total: watch.length,
      watch_fail: watchFail.length,
      recall_p50_ms: p50,
      recall_p95_ms: p95,
    },
    results,
  };
  const jsonPath = args.json || join(outDir, "results.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const prior = findPriorReport(args.outRoot);
  const diff = diffSummary(prior, report);

  const md = [
    `# brain-verify — ${args.mode} run · ${today}`,
    ``,
    `**Verdict:** ${gateFail.length === 0 ? "GREEN ✅ (safe)" : `RED ❌ — ${gateFail.length} P0 gate failure(s)`}`,
    `**Mode:** ${args.mode} · **Target:** ${args.target} · **Tenant:** ${args.tenantEmail} · **Duration:** ${durS}s`,
    `**Catalog:** v${catalog.version} (${args.catalog})`,
    `**Recall latency:** p50=${p50 ?? "n/a"}ms · p95=${p95 ?? "n/a"}ms`,
    ``,
    `## Summary`,
    `- P0 gate: ${gatePass}/${gateP0.length} pass · ${gateFail.length} fail`,
    `- Watchlist: ${watch.length - watchFail.length}/${watch.length} pass · ${watchFail.length} fail (non-blocking)`,
    ``,
    `## Diff vs prior run (${prior?.date ?? "none"})`,
    `\`\`\``,
    diff,
    `\`\`\``,
    ``,
    gateFail.length ? `## P0 failures (block)\n${gateFail.map((r) => `- **${r.id}** ${r.desc} → ${r.reason}`).join("\n")}\n` : "",
    watchFail.length ? `## Watchlist failures (report-only)\n${watchFail.map((r) => `- ${r.id} ${r.desc} → ${r.reason}`).join("\n")}\n` : "",
    `## All results`,
    `| id | kind | gate | status | evidence |`,
    `|---|---|---|---|---|`,
    ...results.map((r) => `| ${r.id} | ${r.kind} | ${r.gate} | ${r.status} | ${JSON.stringify(r.evidence || {}).slice(0, 80)} |`),
    ``,
    `## Reproduction`,
    `\`\`\`bash`,
    `node apps/backend/scripts/brain-verify.mjs --mode ${args.mode} --target ${args.target} --tenant-email ${args.tenantEmail}`,
    `# rerun a single case:`,
    `node apps/backend/scripts/brain-verify.mjs --case <id>`,
    `\`\`\``,
  ].filter(Boolean).join("\n");
  writeFileSync(join(outDir, "report.md"), md);

  console.log("");
  console.log(`results: ${jsonPath}`);
  console.log(`report:  ${join(outDir, "report.md")}`);
  console.log(`verdict: ${gateFail.length === 0 ? "GREEN ✅" : `RED ❌ (${gateFail.length} P0 fail)`}`);
  process.exit(gateFail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`brain-verify crashed: ${e?.stack || e}`);
  process.exit(2);
});
