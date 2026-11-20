#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

const JSON_OUT = process.argv.includes("--json");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GH_TOKEN = process.env.GITHUB_PROVISION_TOKEN ?? process.env.GITHUB_TOKEN;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env)");
  process.exit(1);
}
if (!GH_TOKEN) {
  console.error("missing GITHUB_PROVISION_TOKEN — needed to read provisioned repos");
  process.exit(1);
}

const MIN_AGE_DAYS = 90;
const MIN_WEEKLY_DOWNLOADS = 1000;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

async function ghFile(owner, repo, path) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    { headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${owner}/${repo}/${path} -> HTTP ${res.status}`);
  const body = await res.json();
  return Buffer.from(body.content, "base64").toString("utf-8");
}

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWithRetry(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      if (i === attempts - 1) return null;
      await sleep(400 * 2 ** i);
      continue;
    }
    if (!RETRY_STATUSES.has(res.status)) return res;
    if (i === attempts - 1) return null;
    await sleep(400 * 2 ** i);
  }
  return null;
}

const depCache = new Map();

async function classifyDep(name) {
  if (depCache.has(name)) return depCache.get(name);

  const out = await (async () => {
    const meta = await getWithRetry(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (!meta) return { name, verdict: "UNKNOWN", detail: "registry unreachable after retries" };
    if (meta.status === 404) {
      return { name, verdict: "PHANTOM", detail: "404 — does not exist on npm" };
    }
    if (!meta.ok) return { name, verdict: "UNKNOWN", detail: `registry HTTP ${meta.status}` };

    const { time } = await meta.json();
    const created = time?.created;
    const ageDays = created ? (Date.now() - new Date(created).getTime()) / 86_400_000 : Infinity;

    const dl = await getWithRetry(
      `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
    );
    if (!dl || !dl.ok) {
      return {
        name,
        verdict: ageDays < MIN_AGE_DAYS ? "SUSPECT" : "UNKNOWN",
        detail: `age ${Math.floor(ageDays)}d; downloads UNCHECKABLE (rate-limited)`,
      };
    }
    const body = await dl.json();
    if (typeof body.downloads !== "number") {
      return { name, verdict: "UNKNOWN", detail: `age ${Math.floor(ageDays)}d; no download count` };
    }
    const weekly = body.downloads;

    if (ageDays < MIN_AGE_DAYS || weekly < MIN_WEEKLY_DOWNLOADS) {
      return {
        name,
        verdict: "SUSPECT",
        detail: `age ${Math.floor(ageDays)}d, ${weekly} weekly downloads — slopsquat signature`,
      };
    }
    return { name, verdict: "OK", detail: `age ${Math.floor(ageDays)}d, ${weekly} weekly dl` };
  })();

  depCache.set(name, out);
  return out;
}

async function main() {
  const { data: resources, error } = await sb
    .from("tenant_resources")
    .select("tenant_id, external_ref, status, mode")
    .eq("resource_kind", "repo")
    .eq("provider", "github");

  if (error) {
    console.error("could not read tenant_resources:", error.message);
    process.exit(1);
  }

  const repos = [];
  for (const r of resources ?? []) {
    if (r.status === "torn_down" || r.status === "teardown") continue;
    const full = r.external_ref?.github_full_name ?? "";
    const [owner, repo] = String(full).split("/");
    if (owner && repo) repos.push({ owner, repo, tenant_id: r.tenant_id });
  }

  if (repos.length === 0) {
    console.log("No provisioned app repos found. Nothing to audit.");
    return;
  }

  const rows = [];
  for (const { owner, repo, tenant_id } of repos) {
    const row = { tenant_id, repo: `${owner}/${repo}`, next: "?", lockfile: false, findings: [] };
    try {
      const pkgRaw = await ghFile(owner, repo, "package.json");
      if (!pkgRaw) {
        row.next = "no package.json";
        rows.push(row);
        continue;
      }
      const pkg = JSON.parse(pkgRaw);
      row.lockfile = (await ghFile(owner, repo, "package-lock.json")) !== null;
      row.next = pkg.dependencies?.next ?? "none";

      const names = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      for (const n of names) {
        const c = await classifyDep(n);
        if (c.verdict !== "OK") row.findings.push(c);
      }
    } catch (e) {
      row.next = `ERROR: ${e.message}`;
    }
    rows.push(row);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`\nProvisioned customer apps: ${rows.length}\n`);
  console.log("repo".padEnd(42), "next".padEnd(12), "lock".padEnd(6), "findings");
  console.log("-".repeat(96));
  for (const r of rows) {
    const flag = r.findings.length ? `${r.findings.length} !!` : "clean";
    console.log(r.repo.padEnd(42), String(r.next).padEnd(12), (r.lockfile ? "yes" : "NO").padEnd(6), flag);
    for (const f of r.findings) {
      console.log(`    ${f.verdict}  ${f.name} — ${f.detail}`);
    }
  }

  const all = rows.flatMap((r) => r.findings);
  const phantom = all.filter((f) => f.verdict === "PHANTOM");
  const suspect = all.filter((f) => f.verdict === "SUSPECT");
  const unknown = all.filter((f) => f.verdict === "UNKNOWN");
  const noLock = rows.filter((r) => !r.lockfile).length;
  const vulnNext = rows.filter((r) => /^14\.2\.(1[0-9]|2[0-4])\b/.test(String(r.next))).length;

  console.log("\n── SUMMARY ──");
  console.log(`  apps audited:         ${rows.length}`);
  console.log(`  no lockfile:          ${noLock}/${rows.length}  (build resolves dep names live)`);
  console.log(`  next < 14.2.25 (CVE): ${vulnNext}/${rows.length}  (GHSA-f82v-jwr5-mffw auth bypass)`);
  console.log(`  PHANTOM deps:         ${phantom.length}  ${phantom.length ? "<-- INCIDENT" : "<-- no hallucinated package has landed"}`);
  console.log(`  SUSPECT deps:         ${suspect.length}`);
  console.log(`  UNKNOWN (uncheckable):${unknown.length}  (rate-limited; re-run to resolve — NOT a finding)`);
  if (phantom.length) {
    console.log("\n  A PHANTOM dep means a package name in a LIVE customer app does not resolve on");
    console.log("  npm — that name is squattable RIGHT NOW. Treat as an incident, not a chore.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
