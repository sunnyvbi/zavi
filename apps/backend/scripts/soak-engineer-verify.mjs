#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const sinceArg = args[args.indexOf("--since") + 1];
const SINCE = args.includes("--since") ? sinceArg : "2026-07-05T09:00:00Z";
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 40;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const hasRunTests = (toolCalls) =>
  Array.isArray(toolCalls) &&
  toolCalls.some((t) => typeof t?.name === "string" && /(?:^|__)run_tests$/.test(t.name));

const receiptFrom = (toolCalls) => {
  if (!Array.isArray(toolCalls)) return null;
  for (const t of toolCalls) if (t?.test_receipt) return t.test_receipt;
  return null;
};

async function main() {
  const { data: runs, error } = await sb
    .from("agent_runs")
    .select("id, tenant_id, status, finished_at, parsed, tool_calls")
    .eq("agent_slug", "engineer")
    .gt("finished_at", SINCE)
    .order("finished_at", { ascending: false })
    .limit(LIMIT);
  if (error) {
    console.error("query error:", error.message);
    process.exit(2);
  }

  const shipRuns = (runs || []).filter((r) => r?.parsed && r.parsed.pr_url);
  console.log(`soak-engineer-verify · since ${SINCE} · ${(runs || []).length} engineer runs, ${shipRuns.length} opened a PR`);

  const p0 = [];
  const p1 = [];

  for (const r of shipRuns) {
    const verify = r.parsed?.verify;
    const ranTests = hasRunTests(r.tool_calls) || !!receiptFrom(r.tool_calls);

    const { data: notes } = await sb
      .from("agent_thread_messages")
      .select("body, created_at, meta")
      .contains("meta", { dispatch_notice: true })
      .order("created_at", { ascending: false })
      .limit(200);
    const notice = (notes || []).find((n) => n?.meta?.decision_class === "engineer.ship-pr" && (n.body || "").includes("Opened"));
    const noticeBody = notice?.body ?? "";
    const noticeSaysPassed = /✅ tests passed/.test(noticeBody);

    if (noticeSaysPassed && verify?.status && verify.status !== "passed") {
      p0.push({ run: r.id, verify: verify.status, notice: "✅ tests passed" });
    }
    if (ranTests && !verify) {
      p1.push({ run: r.id, finished: r.finished_at });
    }

    const line = `  ${(r.finished_at || "").slice(0, 19)} ${r.id.slice(0, 8)} verify=${verify ? verify.status : "NONE"} ran_tests=${ranTests} notice_passed=${noticeSaysPassed}`;
    console.log(line);
  }

  if (p0.length) {
    console.error(`\n❌ P0 (customer-dangerous false ✅): ${p0.length}`);
    for (const x of p0) console.error("   ", JSON.stringify(x));
  }
  if (p1.length) {
    console.warn(`\n⚠️  P1 (run_tests ran, verify NOT populated — wiring gap): ${p1.length}`);
    for (const x of p1) console.warn("   ", JSON.stringify(x));
  }
  if (!shipRuns.length) {
    console.log("\n(no post-deploy ship-PR runs yet — re-run after the next engineer PR to confirm the live seam)");
  } else if (!p0.length && !p1.length) {
    console.log("\n✅ all post-deploy ship-PR runs: verify populated + notice honest.");
  }
  process.exit(p0.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
