
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import {
  decisionCardTitle,
  decisionConsequence,
  statusChip,
  STATUS_CHIP_KEYS,
  type StatusChip,
} from "@/services/approvals/decision-copy";

type Row = {
  key: string;
  signal: "pending_decision" | "errored" | "stuck" | "low_score" | "task" | "needs_answer";
  severity: number;
  agent_slug: string | null;
  title: string;
  why: string;
  run_id: string | null;
  decision_id: string | null;
  task_id: string | null;
  decision_class: string | null;
  body: Record<string, unknown> | null;
  detail: Array<{ label: string; value: string }> | null;
  chips: StatusChip[] | null;
  approve_hint: string | null;
  reject_hint: string | null;
  at: string | null;
  actions: string[];
};

const FAILED_STATUSES = ["failed", "parse_failed", "dispatch_error", "error"];

function redactEmail(addr: string): string {
  const at = addr.indexOf("@");
  if (at <= 0) return addr;
  const local = addr.slice(0, at);
  const dom = addr.slice(at + 1);
  const head = local.length <= 2 ? local[0] ?? "" : local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - head.length))}@${dom}`;
}

const DETAIL_SKIP = new Set([
  "source_run_id",
  "source_signals",
  "critic",
  "over_cap",
  "expected_current_daily_budget_usd",
  "amount_qualitative",
  "files",
  "targeting",
  "base_branch",
  "head_branch",
  "artifact_id",
  "push_to_main",
  "rendered_markdown",
]);

const LABELS: Record<string, string> = {
  bet_claim: "Bet",
  to_channel: "To channel",
  from_channel: "From channel",
  amount_usd: "Amount",
  confidence: "Confidence",
  rationale: "Rationale",
  to: "Recipient",
  subject: "Subject",
  body_text: "Preview",
  target_agent_slug: "Dispatch to",
  intent: "Intent",
  title: "Title",
  target_keyword: "Keyword",
  body: "Summary",
  ad_set_id: "Ad set",
  object_id: "Object",
  level: "Level",
  status: "New status",
  daily_budget_usd: "Daily budget",
  name: "Name",
  optimization_goal: "Optimization goal",
  billing_event: "Billing event",
  campaign_id: "Campaign",
};

const EMPTY_CHANNEL = new Set(["n/a", "na", "none", "-", "(new test)", "new test"]);
function isEmptyChannel(v: unknown): boolean {
  return typeof v === "string" && EMPTY_CHANNEL.has(v.trim().toLowerCase());
}

function fmtVal(key: string, v: unknown): string | null {
  if (v == null) return null;
  if (key === "from_channel" && isEmptyChannel(v)) return null;
  if (key === "to" && typeof v === "string") return redactEmail(v);
  if ((key === "amount_usd" || key === "daily_budget_usd") && typeof v === "number") {
    return `$${v}/wk`;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    return t.length > 400 ? `${t.slice(0, 400)}…` : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

export function buildDecisionDetail(
  body: Record<string, unknown> | null,
): Array<{ label: string; value: string }> {
  if (!body) return [];
  const ORDER = [
    "bet_claim",
    "intent",
    "target_agent_slug",
    "from_channel",
    "to_channel",
    "to",
    "subject",
    "title",
    "target_keyword",
    "name",
    "campaign_id",
    "ad_set_id",
    "object_id",
    "level",
    "status",
    "amount_usd",
    "daily_budget_usd",
    "optimization_goal",
    "billing_event",
    "confidence",
    "body_text",
    "body",
    "rationale",
  ];
  const seen = new Set<string>();
  const out: Array<{ label: string; value: string }> = [];
  const push = (k: string) => {
    if (seen.has(k) || DETAIL_SKIP.has(k) || STATUS_CHIP_KEYS.has(k)) return;
    seen.add(k);
    const val = fmtVal(k, body[k]);
    if (val == null) return;
    out.push({ label: LABELS[k] ?? k.replace(/_/g, " "), value: val });
  };
  for (const k of ORDER) push(k);
  for (const k of Object.keys(body)) push(k);
  return out;
}

export function buildDecisionChips(body: Record<string, unknown> | null): StatusChip[] {
  if (!body) return [];
  const out: StatusChip[] = [];
  for (const k of STATUS_CHIP_KEYS) {
    const chip = statusChip(k, body[k]);
    if (chip) out.push(chip);
  }
  return out;
}

export function summarizeDecisionBody(
  decisionClass: string,
  body: Record<string, unknown> | null,
): string {
  const fallback = "The agent proposed an action that needs your approval before it can run.";
  if (!body) return fallback;
  const str = (k: string): string | null =>
    typeof body[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim() : null;
  const num = (k: string): number | null =>
    typeof body[k] === "number" ? (body[k] as number) : null;

  const bet = str("bet_claim");
  if (bet) {
    const to = str("to_channel");
    const from = str("from_channel");
    const amt = num("amount_usd");
    const conf = str("confidence");
    const parts = [bet];
    const realFrom = from && !isEmptyChannel(from) ? from : null;
    if (to) parts.push(realFrom ? `${realFrom} → ${to}` : to);
    if (amt != null) parts.push(`$${amt}/wk`);
    if (conf) parts.push(`confidence ${conf}`);
    return parts.join(" · ");
  }
  if (decisionClass === "send_email" || (str("to") && str("subject"))) {
    const to = str("to");
    const subj = str("subject");
    return `Send email${to ? ` to ${redactEmail(to)}` : ""}${subj ? ` — "${subj}"` : ""}`;
  }
  const target = str("target_agent_slug");
  if (target) {
    const intent = str("intent");
    return `Dispatch ${target}${intent ? `: ${intent}` : ""}`;
  }
  const budget = num("daily_budget_usd");
  if (budget != null) {
    const adset = str("ad_set_id");
    return `Set ${adset ? `ad set ${adset} ` : "ad set "}daily budget to $${budget}`;
  }
  const status = str("status");
  if (status) {
    const lvl = str("level");
    const obj = str("object_id");
    return `${status} ${lvl ?? "object"}${obj ? ` ${obj}` : ""}`;
  }
  const headline = str("rendered_markdown") || str("title") || str("body") || str("rationale");
  if (headline) return headline.length > 220 ? `${headline.slice(0, 220)}…` : headline;
  return fallback;
}

export async function staffTenantNeedsHelp(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;

  const sb = serviceClient();
  const { data: tenant } = await sb.from("tenants").select("id").eq("id", tenantId).maybeSingle();
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const nowMs = Date.now();
  const since24h = new Date(nowMs - 24 * 3600_000).toISOString();
  const since7d = new Date(nowMs - 7 * 86400_000).toISOString();
  const stuckRunning = new Date(nowMs - 5 * 60_000).toISOString();
  const stuckQueued = new Date(nowMs - 10 * 60_000).toISOString();

  const rows: Row[] = [];

  const { data: decisions } = await sb
    .from("decisions")
    .select("id, agent_run_id, decision_class, body, emitted_at")
    .eq("tenant_id", tenantId)
    .eq("status", "proposed")
    .order("emitted_at", { ascending: false })
    .limit(25);
  const pendingDecisions = (decisions ?? []) as Array<{ id: string; agent_run_id: string | null; decision_class: string; body: Record<string, unknown> | null; emitted_at: string }>;
  const handlerByClass = new Map<string, string | null>();
  const classSlugs = [...new Set(pendingDecisions.map((d) => d.decision_class))];
  if (classSlugs.length > 0) {
    const { data: classRows } = await sb
      .from("decision_classes")
      .select("slug, dispatch_handler")
      .in("slug", classSlugs);
    for (const c of (classRows ?? []) as Array<{ slug: string; dispatch_handler: string | null }>) {
      handlerByClass.set(c.slug, c.dispatch_handler);
    }
  }
  for (const d of pendingDecisions) {
    const consequence = decisionConsequence(
      handlerByClass.get(d.decision_class),
      d.decision_class,
      d.body ?? undefined,
    );
    rows.push({
      key: `decision:${d.id}`,
      signal: "pending_decision",
      severity: 90,
      agent_slug: d.decision_class.split(".")[0] ?? null,
      title: decisionCardTitle(d.decision_class, d.body ?? undefined),
      why: summarizeDecisionBody(d.decision_class, d.body ?? null),
      run_id: d.agent_run_id,
      decision_id: d.id,
      task_id: null,
      decision_class: d.decision_class,
      body: d.body ?? null,
      detail: buildDecisionDetail(d.body ?? null),
      chips: buildDecisionChips(d.body ?? null),
      approve_hint: consequence.approve,
      reject_hint: consequence.reject,
      at: d.emitted_at,
      actions: ["approve", "reject", "edit", "open_run"],
    });
  }

  const { data: errored } = await sb
    .from("agent_runs")
    .select("id, agent_slug, status, finished_at")
    .eq("tenant_id", tenantId)
    .in("status", FAILED_STATUSES)
    .gte("finished_at", since24h)
    .order("finished_at", { ascending: false })
    .limit(25);
  for (const r of (errored ?? []) as Array<{ id: string; agent_slug: string; status: string; finished_at: string | null }>) {
    rows.push({
      key: `run:${r.id}`,
      signal: "errored",
      severity: 85,
      agent_slug: r.agent_slug,
      title: `${r.agent_slug} run ${r.status}`,
      why: `The last run ended in '${r.status}'. Open the thread to see where it broke, then retry or steer it.`,
      run_id: r.id,
      decision_id: null,
      task_id: null,
      decision_class: null,
      body: null,
      detail: null,
      chips: null,
      approve_hint: null,
      reject_hint: null,
      at: r.finished_at,
      actions: ["open_run", "retry", "steering_note", "engine_flip"],
    });
  }

  const { data: stuck } = await sb
    .from("agent_runs")
    .select("id, agent_slug, status, started_at, enqueued_at, last_progress_at")
    .eq("tenant_id", tenantId)
    .or(
      `and(status.eq.running,or(last_progress_at.lt.${stuckRunning},and(last_progress_at.is.null,started_at.lt.${stuckRunning}))),and(status.eq.queued,enqueued_at.lt.${stuckQueued})`,
    )
    .limit(25);
  for (const r of (stuck ?? []) as Array<{ id: string; agent_slug: string; status: string; started_at: string | null; enqueued_at: string | null; last_progress_at: string | null }>) {
    if (rows.some((x) => x.key === `run:${r.id}`)) continue;
    rows.push({
      key: `run:${r.id}`,
      signal: "stuck",
      severity: 70,
      agent_slug: r.agent_slug,
      title: `${r.agent_slug} run looks stuck (${r.status})`,
      why:
        r.status === "queued"
          ? "Queued for over 10 minutes without starting."
          : "Running for over 5 minutes with no progress.",
      run_id: r.id,
      decision_id: null,
      task_id: null,
      decision_class: null,
      body: null,
      detail: null,
      chips: null,
      approve_hint: null,
      reject_hint: null,
      at: r.last_progress_at ?? r.started_at ?? r.enqueued_at,
      actions: ["open_run", "retry", "steering_note"],
    });
  }

  const { data: low } = await sb
    .from("agent_runs")
    .select("id, agent_slug, quality_score, quality_rationale, finished_at")
    .eq("tenant_id", tenantId)
    .lt("quality_score", 50)
    .gte("finished_at", since7d)
    .order("finished_at", { ascending: false })
    .limit(25);
  for (const r of (low ?? []) as Array<{ id: string; agent_slug: string; quality_score: number; quality_rationale: string | null; finished_at: string | null }>) {
    if (rows.some((x) => x.key === `run:${r.id}`)) continue;
    rows.push({
      key: `run:${r.id}`,
      signal: "low_score",
      severity: 55,
      agent_slug: r.agent_slug,
      title: `${r.agent_slug} scored ${r.quality_score}/100`,
      why: r.quality_rationale ? `Judge: ${r.quality_rationale}`.slice(0, 240) : "A recent run scored low on quality. Open it to see why, then steer or retry.",
      run_id: r.id,
      decision_id: null,
      task_id: null,
      decision_class: null,
      body: null,
      detail: null,
      chips: null,
      approve_hint: null,
      reject_hint: null,
      at: r.finished_at,
      actions: ["open_run", "retry", "steering_note", "engine_flip"],
    });
  }

  const { data: tasks } = await sb
    .from("admin_tasks")
    .select("id, kind, agent_slug, block_reason, source_run_id, source_decision_id, priority, created_at")
    .eq("tenant_id", tenantId)
    .in("state", ["open", "claimed", "in_progress", "snoozed"])
    .order("priority", { ascending: false })
    .limit(25);
  for (const t of (tasks ?? []) as Array<{ id: string; kind: string; agent_slug: string | null; block_reason: string | null; source_run_id: string | null; source_decision_id: string | null; priority: number | null; created_at: string }>) {
    rows.push({
      key: `task:${t.id}`,
      signal: "task",
      severity: 60 + Math.min(20, Number(t.priority ?? 0)),
      agent_slug: t.agent_slug,
      title: `${t.kind} task${t.block_reason ? ` — ${t.block_reason}` : ""}`,
      why: "An admin-assist task is open for this tenant.",
      run_id: t.source_run_id,
      decision_id: t.source_decision_id,
      task_id: t.id,
      decision_class: null,
      body: null,
      detail: null,
      chips: null,
      approve_hint: null,
      reject_hint: null,
      at: t.created_at,
      actions: ["resolve_task", "snooze_task", "open_run", "steering_note"],
    });
  }

  const { data: recent } = await sb
    .from("agent_runs")
    .select("id, agent_slug, output_text, finished_at")
    .eq("tenant_id", tenantId)
    .eq("status", "success")
    .gte("finished_at", since7d)
    .order("finished_at", { ascending: false })
    .limit(40);
  for (const r of (recent ?? []) as Array<{ id: string; agent_slug: string; output_text: string | null; finished_at: string | null }>) {
    const out = r.output_text ?? "";
    const isClar = /"kind"\s*:\s*"(clarification|needs_help)"/.test(out);
    if (!isClar) continue;
    if (rows.some((x) => x.key === `run:${r.id}`)) continue;
    rows.push({
      key: `run:${r.id}`,
      signal: "needs_answer",
      severity: 80,
      agent_slug: r.agent_slug,
      title: `${r.agent_slug} is waiting on your answer`,
      why: "The agent stopped to ask a clarifying question instead of finishing. Answer it via retry — your answer becomes the hint it reads.",
      run_id: r.id,
      decision_id: null,
      task_id: null,
      decision_class: null,
      body: null,
      detail: null,
      chips: null,
      approve_hint: null,
      reject_hint: null,
      at: r.finished_at,
      actions: ["open_run", "retry", "steering_note"],
    });
  }

  rows.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return (b.at ?? "").localeCompare(a.at ?? "");
  });

  res.json({ tenant_id: tenantId, count: rows.length, items: rows.slice(0, 60) });
}
