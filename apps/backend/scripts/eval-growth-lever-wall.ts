#!/usr/bin/env tsx

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { enqueueAgentRun, getAgentRunById } from "../src/services/agents/runner";
import { serviceClient } from "../src/services/supabase";

const VALID_LEVERS = new Set(["budget", "lifecycle", "social"]);

type Scenario = {
  key: string;
  expect_terms: string[];
  message: string;
};

const SCENARIOS: Scenario[] = [
  {
    key: "pricing",
    expect_terms: ["pric", "packag", "monetiz"],
    message:
      "Paid is efficient and the funnel converts fine, but we have not changed our prices in two years and I think we are badly underpriced. What should I do about it? Formalize a proposal I can act on.",
  },
  {
    key: "involuntary_churn",
    expect_terms: ["failed payment", "involuntary", "dunning", "card", "retry"],
    message:
      "Signups are flat-to-up but revenue is leaking. A lot of our subscription renewals seem to fail on the card charge and those customers just disappear. What should I do? Formalize a proposal I can act on.",
  },
  {
    key: "referral",
    expect_terms: ["referral", "refer", "word of mouth", "viral", "invite"],
    message:
      "Paid is maxed out and CAC keeps climbing. Our customers are happy but we have no referral mechanism at all. What should I do? Formalize a proposal I can act on.",
  },
  {
    key: "match_rate",
    expect_terms: ["match", "search", "discover", "relevan"],
    message:
      "We have plenty of listings and plenty of search traffic, but people search and do not find what they want, so they leave. What should I do? Formalize a proposal I can act on.",
  },
  {
    key: "take_rate",
    expect_terms: ["take rate", "commission", "fee", "monetiz"],
    message:
      "We are on a 5% take rate and I am wondering whether we are leaving money on the table. What should I do? Formalize a proposal I can act on.",
  },
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

function tier1LeverValues(machine: string): string[] {
  const m = machine.match(/##\s*Tier\s*1[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return [];
  return Array.from(m[1].matchAll(/^Lever:[ \t]*(.+)$/gm)).map((x) =>
    x[1].toLowerCase().trim(),
  );
}

const PROVENANCE_RE =
  /\{tool:|\{memory:|\{agent:|per (company )?memory|prior (run|memo|pull|cohort)|as of |re-verify|you state|your stated|taking your|at face|estimate|approx|~|\bper prior\b|live .{0,20}pull|pulled|returned/i;

function numberedLeverClaims(text: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n/)) {
    const s = raw.trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (!terms.some((t) => low.includes(t))) continue;
    if (!/\b\d+(\.\d+)?\s?%|\$\s?\d|\b\d+(\.\d+)?x\b|\b\d{2,}\b/.test(s)) continue;
    if (/\b\d+\s?(second|sec|minute|min|hour|day|week|month|yr|year)s?\b/i.test(s)
        && !/%|\$/.test(s)) continue;
    if (PROVENANCE_RE.test(s)) continue;
    hits.push(s);
  }
  return hits;
}

async function mintUserToken(): Promise<string> {
  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const email = process.env.QA_TEST_EMAIL;
  const password = process.env.QA_TEST_PASSWORD!;
  if (!email) throw new Error("QA_TEST_EMAIL missing from apps/backend/.env");
  if (!password) throw new Error("QA_TEST_PASSWORD missing from apps/backend/.env");
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j: any = await res.json();
  if (!j.access_token) throw new Error(`token mint failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token as string;
}

async function resolveTenantId(slug: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (error || !data) throw new Error(`tenant lookup failed for ${slug}: ${error?.message}`);
  return data.id as string;
}

async function poll(tenantId: string, runId: string, timeoutMs = 900_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row: any = await getAgentRunById(tenantId as any, runId);
    if (row && ["success", "parse_failed", "dispatch_error", "failed"].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function main() {
  const n = Number(arg("n", "2"));
  const tenantSlug = arg("tenant-slug", "upcar-ai");
  const tenantId = await resolveTenantId(tenantSlug);
  const outDir = arg("out", "/tmp/growth-lever-eval");
  fs.mkdirSync(outDir, { recursive: true });

  const userToken = await mintUserToken();
  console.log(`[eval] tenant=${tenantSlug} (${tenantId}) n=${n} scenarios=${SCENARIOS.length}`);

  const jobs: Array<{ sc: Scenario; i: number; runId: string }> = [];
  const resume = arg("resume", "");
  if (resume) {
    const ids = resume.split(",").map((s) => s.trim()).filter(Boolean);
    let k = 0;
    for (const sc of SCENARIOS) for (let i = 0; i < n; i++) {
      if (k < ids.length) jobs.push({ sc, i, runId: ids[k++] });
    }
    console.log(`[eval] resume mode — scoring ${jobs.length} existing runs, no new spend`);
  } else
  for (const sc of SCENARIOS) {
    for (let i = 0; i < n; i++) {
      const { run_id } = await enqueueAgentRun({
        tenant_id: tenantId as any,
        agent_slug: "growth-lead",
        trigger: "a2a",
        payload: {
          prior_messages: [],
          current_message: sc.message,
          current_user_text_raw: sc.message,
        },
        user_access_token: userToken,
      } as any);
      jobs.push({ sc, i, runId: run_id });
      console.log(`[eval] enqueued ${sc.key}#${i} run_id=${run_id}`);
    }
  }

  const results: any[] = [];
  for (const j of jobs) {
    const row = await poll(tenantId, j.runId);
    const label = `${j.sc.key}#${j.i}`;
    if (!row) { console.log(`[eval] ${label} TIMEOUT`); results.push({ label, status: "timeout" }); continue; }

    const parsed = row.parsed ?? {};
    const machine: string = parsed.machine_digest ?? "";
    const rendered: string = parsed.rendered_markdown ?? row.output_text ?? "";
    const all = `${machine}\n${rendered}`;
    fs.writeFileSync(path.join(outDir, `${label}.md`),
      `# ${label}\nstatus=${row.status}\nrun_id=${j.runId}\n\n## machine_digest\n${machine}\n\n## rendered_markdown\n${rendered}\n`);

    const levers = tier1LeverValues(machine);
    const badLevers = levers.filter((l) => !VALID_LEVERS.has(l));
    const named = j.sc.expect_terms.some((t) => all.toLowerCase().includes(t));
    const fabricated = numberedLeverClaims(all, j.sc.expect_terms);

    const r = {
      label, status: row.status, run_id: j.runId,
      A_wall: badLevers.length === 0, bad_levers: badLevers, all_levers: levers,
      B_named: named,
      C_no_fabrication: fabricated.length === 0, suspect_claims: fabricated,
    };
    results.push(r);
    console.log(
      `[eval] ${label} status=${row.status} A_wall=${r.A_wall}${badLevers.length ? ` (${badLevers.join(",")})` : ""} B_named=${named} C_clean=${r.C_no_fabrication}${fabricated.length ? ` (${fabricated.length} suspect)` : ""}`,
    );
  }

  const scored = results.filter((r) => r.status === "success");
  const pct = (f: (r: any) => boolean) =>
    scored.length ? `${scored.filter(f).length}/${scored.length}` : "0/0";
  console.log(`\n=== SUMMARY (scored ${scored.length}/${results.length}) ===`);
  console.log(`A. Lever wall held      : ${pct((r) => r.A_wall)}`);
  console.log(`B. True lever named     : ${pct((r) => r.B_named)}`);
  console.log(`C. No fabricated number : ${pct((r) => r.C_no_fabrication)}`);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\noutputs: ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
