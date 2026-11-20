
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const DAYS = Number(process.argv[2]) || 7;

function parseToolName(raw) {
  const name = String(raw ?? "").toLowerCase().trim();
  const segs = name.split("__").filter((s) => s.length > 0);
  const verb = segs.length > 0 ? segs[segs.length - 1] : name;
  const area = segs.length >= 2 ? segs[segs.length - 2] : "";
  return { area, verb };
}
const LOW_SIGNAL_AREA_RE = /^(memory|brain)$/;
const LOW_SIGNAL_VERB_RE = /(anchor|distill)/;
const PROPOSE_VERB_RE = /^propose(_|$)/;
const MUTATING_AREA_VERBS = {
  slack: /^(post_message|upload_file)$/,
  stripe: /^(create_payment|remit_to_tenant|submit_dispute_evidence)$/,
  email: /^(send|send_email)$/,
  provision: /.*/,
  github: /^(open_pr|create|write|commit|push|merge|update|create_pr|update_pr)$/,
  meta_ads: /^(create|update|pause|edit|delete)(_|$)/,
  google_ads: /^(create|update|pause|edit|delete)(_|$)/,
  paid_acquisition: /^(create|update|pause|edit|delete)(_|$)/,
  operator_db: /^(insert|update|write|create|delete|mutate)(_|$)/,
  outbound: /^(send)(_|$)/,
};
const MUTATING_VERB_ANYAREA_RE =
  /^(post_message|upload_file|create_payment|remit_to_tenant|submit_dispute_evidence|open_pr)$/;
function isMutatingToolName(raw) {
  const { area, verb } = parseToolName(raw);
  if (!verb) return false;
  if (LOW_SIGNAL_AREA_RE.test(area) || LOW_SIGNAL_VERB_RE.test(verb)) return false;
  if (PROPOSE_VERB_RE.test(verb)) return false;
  const areaRe = MUTATING_AREA_VERBS[area];
  if (areaRe && areaRe.test(verb)) return true;
  if (MUTATING_VERB_ANYAREA_RE.test(verb)) return true;
  return false;
}
function hasMutatingSideEffect(toolCalls) {
  if (!Array.isArray(toolCalls)) return false;
  for (const t of toolCalls) {
    if (t && t.status === "ok" && typeof t.name === "string" && isMutatingToolName(t.name)) return true;
  }
  return false;
}

function classifyRow(row) {
  const outcome = row.outcome && typeof row.outcome === "object" ? row.outcome : null;
  const kind = outcome?.side_effect?.kind ?? "unknown";
  const deliverableStr =
    (typeof outcome?.deliverable === "string" ? outcome.deliverable : row.output_text) ?? "";
  const hasDeliverable = String(deliverableStr).trim().length > 0;
  const stamped = kind !== "unknown";

  if (stamped) {
    if (kind === "shipped") return "shipped";
    if (kind === "refused") return "plan_only";
    return hasDeliverable ? "answered" : "empty";
  }
  if (hasMutatingSideEffect(row.tool_calls)) return "shipped";
  return hasDeliverable ? "answered" : "empty";
}

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString();
  let from = 0;
  const page = 1000;
  const rows = [];
  while (true) {
    const { data, error } = await sb
      .from("agent_runs")
      .select("agent_slug, outcome, tool_calls, output_text")
      .eq("status", "success")
      .gte("finished_at", since)
      .order("finished_at", { ascending: false })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < page) break;
    from += page;
  }

  const TIERS = ["shipped", "answered", "plan_only", "empty"];
  const perAgent = new Map();
  let nullOutcome = 0;
  for (const r of rows) {
    if (!r.outcome) nullOutcome++;
    const slug = r.agent_slug || "(none)";
    if (!perAgent.has(slug)) perAgent.set(slug, { shipped: 0, answered: 0, plan_only: 0, empty: 0, total: 0 });
    const b = perAgent.get(slug);
    b[classifyRow(r)]++;
    b.total++;
  }

  const total = rows.length;
  const fleet = { shipped: 0, answered: 0, plan_only: 0, empty: 0, total };
  for (const b of perAgent.values()) for (const t of TIERS) fleet[t] += b[t];
  const fakeDone = fleet.plan_only + fleet.empty;
  const rate = total ? (100 * fakeDone) / total : 0;

  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + "%" : "  -  ");
  console.log(`\n=== Liveness-tier distribution — status='success' runs, last ${DAYS} days ===`);
  console.log(`window since: ${since}`);
  console.log(`total success runs: ${total}   (rows with null outcome jsonb: ${nullOutcome})\n`);

  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(
    pad("agent_slug", 24) + num("total", 7) + num("shipped", 9) + num("answered", 10) + num("plan_only", 11) + num("empty", 8) + num("fake%", 8),
  );
  console.log("-".repeat(77));
  const sorted = [...perAgent.entries()].sort(
    (a, b) => (b[1].plan_only + b[1].empty) / b[1].total - (a[1].plan_only + a[1].empty) / a[1].total,
  );
  for (const [slug, b] of sorted) {
    const fake = b.plan_only + b.empty;
    console.log(
      pad(slug, 24) + num(b.total, 7) + num(b.shipped, 9) + num(b.answered, 10) + num(b.plan_only, 11) + num(b.empty, 8) + num(pct(fake, b.total), 8),
    );
  }
  console.log("-".repeat(77));
  console.log(
    pad("FLEET", 24) + num(fleet.total, 7) + num(fleet.shipped, 9) + num(fleet.answered, 10) + num(fleet.plan_only, 11) + num(fleet.empty, 8) + num(pct(fakeDone, total), 8),
  );

  console.log(`\n>>> Fleet fake-done rate  (plan_only + empty) / success = ${fakeDone}/${total} = ${rate.toFixed(2)}%`);
  console.log(`>>> Phase-4 badge decision rule: ${rate >= 2 ? "JUSTIFIED (>= 2%) — surface rate + sample runs + copy to Ravi" : "NOT justified (< 2%) — ship Phases 1-3 (metric only), set a watch-trigger"}\n`);
}

main().catch((e) => {
  console.error("measure-liveness-tiers failed:", e.message);
  process.exit(1);
});
