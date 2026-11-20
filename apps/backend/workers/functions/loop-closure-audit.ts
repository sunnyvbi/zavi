
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { alert } from "@/services/logging/alert";
import { isCommsReplyHandler } from "./email-triage-reply";

const AUDIT_WINDOW_HOURS = 26;
const MAX_DETAIL_LOGS = 20;

type AuditDecision = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown> | null;
};

type AuditRun = {
  id: string;
  trigger: string | null;
  parsed: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
};

export type Violation = {
  kind: "pr_url_missing" | "notice_missing" | "email_outcome_gap" | "push_to_main_unverified";
  decision_id: string;
  tenant_id: string;
  run_id: string | null;
  handler: string | null;
};

const PAGING_KINDS = new Set(["pr_url_missing", "notice_missing", "email_outcome_gap"]);

function slackRoutingPresent(run: AuditRun): boolean {
  const slack = (run.payload as { slack?: { channel_id?: unknown; thread_ts?: unknown } } | null)
    ?.slack;
  return typeof slack?.channel_id === "string" && typeof slack?.thread_ts === "string";
}

function chatThreadPresent(run: AuditRun): boolean {
  const tid = (run.payload as { thread_id?: unknown } | null)?.thread_id;
  return typeof tid === "string" && tid.length > 0;
}

export function classifyViolations(args: {
  decisions: AuditDecision[];
  runsById: Map<string, AuditRun>;
  slackClaimIds: Set<string>;
  noticedDecisionIds: Set<string>;
}): Violation[] {
  const out: Violation[] = [];
  for (const d of args.decisions) {
    const run = d.agent_run_id ? args.runsById.get(d.agent_run_id) : undefined;

    if (
      d.handler === "github.open_pr" &&
      run &&
      typeof (run.parsed as { pr_url?: unknown } | null)?.pr_url !== "string"
    ) {
      const isPushToMain = (d.body as { push_to_main?: unknown } | null)?.push_to_main === true;
      out.push({
        kind: isPushToMain ? "push_to_main_unverified" : "pr_url_missing",
        decision_id: d.id,
        tenant_id: d.tenant_id,
        run_id: d.agent_run_id,
        handler: d.handler,
      });
    }

    if (!run) continue;

    if (run.trigger === "slack" && slackRoutingPresent(run)) {
      if (!args.slackClaimIds.has(`dispatch-notice:${d.id}`)) {
        out.push({
          kind: "notice_missing",
          decision_id: d.id,
          tenant_id: d.tenant_id,
          run_id: d.agent_run_id,
          handler: d.handler,
        });
      }
    } else if (run.trigger === "chat" && chatThreadPresent(run)) {
      if (!args.noticedDecisionIds.has(d.id)) {
        out.push({
          kind: "notice_missing",
          decision_id: d.id,
          tenant_id: d.tenant_id,
          run_id: d.agent_run_id,
          handler: d.handler,
        });
      }
    } else if (run.trigger === "email" && d.handler !== null && !isCommsReplyHandler(d.handler)) {
      out.push({
        kind: "email_outcome_gap",
        decision_id: d.id,
        tenant_id: d.tenant_id,
        run_id: d.agent_run_id,
        handler: d.handler,
      });
    }
  }
  return out;
}

async function auditOnce(): Promise<Record<string, number>> {
  const svc = serviceClient();
  const since = new Date(Date.now() - AUDIT_WINDOW_HOURS * 3600_000).toISOString();

  const { data: decisionRows, error: decErr } = await svc
    .from("decisions")
    .select("id, tenant_id, agent_run_id, decision_class, handler, body")
    .eq("status", "acted")
    .gte("dispatched_at", since);
  if (decErr) throw new Error(`loop-closure-audit decisions read failed: ${decErr.message}`);
  const decisions = (decisionRows ?? []) as AuditDecision[];
  if (decisions.length === 0) return { decisions_checked: 0, violations: 0 };

  const IN_CHUNK = 50;
  const chunks = <T,>(xs: T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
    return out;
  };

  const runIds = [...new Set(decisions.map((d) => d.agent_run_id).filter(Boolean))] as string[];
  const runsById = new Map<string, AuditRun>();
  for (const chunk of chunks(runIds)) {
    const { data: runRows, error: runErr } = await svc
      .from("agent_runs")
      .select("id, trigger, parsed, payload")
      .in("id", chunk);
    if (runErr) throw new Error(`loop-closure-audit runs read failed: ${runErr.message}`);
    for (const r of (runRows ?? []) as AuditRun[]) runsById.set(r.id, r);
  }

  const slackClaimIds = new Set<string>();
  for (const chunk of chunks(decisions.map((d) => `dispatch-notice:${d.id}`))) {
    const { data: claimRows, error: claimErr } = await svc
      .from("slack_triage_claims")
      .select("event_id")
      .in("event_id", chunk);
    if (claimErr) throw new Error(`loop-closure-audit claims read failed: ${claimErr.message}`);
    for (const c of claimRows ?? []) slackClaimIds.add((c as { event_id: string }).event_id);
  }

  const noticedDecisionIds = new Set<string>();
  {
    const { data: msgRows, error: msgErr } = await svc
      .from("agent_thread_messages")
      .select("meta")
      .eq("meta->>dispatch_notice", "true")
      .gte("created_at", since);
    if (msgErr) throw new Error(`loop-closure-audit notices read failed: ${msgErr.message}`);
    for (const m of msgRows ?? []) {
      const did = (m as { meta?: { decision_id?: unknown } }).meta?.decision_id;
      if (typeof did === "string") noticedDecisionIds.add(did);
    }
  }

  const violations = classifyViolations({ decisions, runsById, slackClaimIds, noticedDecisionIds });

  const counts: Record<string, number> = {
    decisions_checked: decisions.length,
    violations: 0,
    pr_url_missing: 0,
    notice_missing: 0,
    email_outcome_gap: 0,
    push_to_main_unverified: 0,
  };
  for (const v of violations) {
    counts[v.kind]++;
    if (PAGING_KINDS.has(v.kind)) counts.violations++;
  }

  const paging = violations.filter((v) => PAGING_KINDS.has(v.kind));
  for (const v of paging.slice(0, MAX_DETAIL_LOGS)) {
    await logEvent({
      level: "error",
      source: "loop-closure-audit",
      code: `loop_closure_${v.kind}`,
      tenant_id: v.tenant_id,
      run_id: v.run_id,
      message: `${v.kind} decision=${v.decision_id} handler=${v.handler ?? "null"}`,
      meta: { decision_class: v.handler ?? "unknown" },
    });
  }

  if (paging.length > 0) {
    await alert({
      msg: `loop-closure-audit: ${paging.length} violation(s) in last ${AUDIT_WINDOW_HOURS}h — pr_url_missing=${counts.pr_url_missing} notice_missing=${counts.notice_missing} email_outcome_gap=${counts.email_outcome_gap} (push_to_main_unverified=${counts.push_to_main_unverified}, non-paging). Details in praxis_logs source=loop-closure-audit.`,
      source: "loop-closure-audit",
      code: "loop_closure_violation",
    });
  }

  return counts;
}

export const loopClosureAuditFn = inngest.createFunction(
  { id: "loop-closure-audit", retries: 1 },
  { cron: "13 14 * * *" },
  async ({ step, logger }) => {
    const counts = await step.run("audit", () => auditOnce());
    logger.info(`loop-closure-audit: ${JSON.stringify(counts)}`);
    return counts;
  },
);
