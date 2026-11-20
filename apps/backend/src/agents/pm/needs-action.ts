
import { serviceClient } from "@/services/supabase";
import type { AgentContext } from "@/services/agents/types";
import { getBoolSetting } from "@/services/settings";
import { deriveDispatchStage, isStuckEligibleStage, STUCK_DAYS } from "./roadmap";
import { isInteractiveResumeTrigger } from "@/services/agents/approve-resume";

export const PM_NEEDS_ACTION_CLASS = "pm.needs_action";

const STUCK_MS = STUCK_DAYS * 24 * 60 * 60 * 1000;

type Svc = ReturnType<typeof serviceClient>;

type ExceptionKind = "recurred" | "failed_to_open" | "stuck" | "dispatch_died";

const CHILD_HARD_FAIL_STATUS = new Set(["failed", "parse_failed", "error", "dispatch_error"]);
const CHILD_INFRA_DEATH =
  /boot_reap|stale_reap|watchdog_reap|orphaned by (a )?container|container restart|hit your limit|usage limit|Inngest exhausted|exhausted retries|dispatch_inner/i;
function childDiedOnInfra(child: { status?: string | null; error?: string | null }): boolean {
  const status = child.status ?? "";
  const err = child.error ?? "";
  return CHILD_HARD_FAIL_STATUS.has(status) || CHILD_INFRA_DEATH.test(err);
}

export type ThemeSeverity = "high" | "normal";
const HIGH_SEVERITY_RE =
  /\bP0\b|\bP1\b|IDOR|injection|\bXSS\b|\bCSRF\b|\bSSRF\b|\bRCE\b|privilege|escalat|cross[- ]?tenant|unauthori|unauthenticated|bypass|expos|exfiltrat|\bany user\b|other users|other companies|admin|password|pay(?:ment|out)|double[- ]?charge|\bcharge(?:d|s|back)?\b|refund|escrow|dispute|takeover|credential|\bauth\b|oauth|\bSSO\b|\bPII\b|\bSSN\b|\btoken\b|leak|breach|exploit|vulnerab|security|\blogin\b|checkout|invoice|fraud/i;
export function themeSeverity(theme: string | null | undefined): ThemeSeverity {
  return HIGH_SEVERITY_RE.test(theme ?? "") ? "high" : "normal";
}

const EXCEPTION_SUMMARY: Record<ExceptionKind, string> = {
  recurred: "A prior fix shipped but the problem came back — it needs another pass.",
  failed_to_open: "The engineer ran but could not open a pull request.",
  dispatch_died:
    "The engineer run died on infrastructure (container reap / usage limit / aborted) before it could open a pull request — nothing was produced.",
  stuck: "A dispatched fix has sat past the review window with no open pull request.",
};

export function needsActionMarkdown(args: {
  theme: string;
  kind: ExceptionKind;
  pr_url: string | null;
  proposed_action: "redispatch" | "redispatch_and_close_pr";
  severity?: ThemeSeverity;
}): string {
  const action =
    args.proposed_action === "redispatch_and_close_pr" && parsePrUrl(args.pr_url)
      ? "re-dispatch the engineer to retry, and close the stale PR."
      : "re-dispatch the engineer to retry.";
  const lines: string[] = [];
  if (args.severity === "high") lines.push("🔴 **High severity — needs your review.**", "");
  lines.push(`**${args.theme}**`, "", EXCEPTION_SUMMARY[args.kind]);
  if (args.pr_url) lines.push("", `Prior PR: ${args.pr_url}`);
  lines.push("", `**On approve:** ${action}`);
  return lines.join("\n");
}

export type EmitNeedsActionDeps = {
  svc?: Svc;
  isEnabled?: (tenant_id: string) => Promise<boolean>;
  now?: Date;
};

export async function emitNeedsActionDecisions(
  ctx: AgentContext,
  deps: EmitNeedsActionDeps = {},
): Promise<{ emitted: number; skipped: number }> {
  if (isInteractiveResumeTrigger(ctx.trigger)) return { emitted: 0, skipped: 0 };

  const isEnabled =
    deps.isEnabled ?? ((t: string) => getBoolSetting("pm_hybrid_surface", t));
  let enabled = false;
  try {
    enabled = await isEnabled(ctx.tenant_id);
  } catch {
    enabled = false;
  }
  if (!enabled) return { emitted: 0, skipped: 0 };

  const svc = deps.svc ?? serviceClient();
  const now = deps.now ?? new Date();

  const { data: rowsData, error } = await svc
    .from("pm_roadmap")
    .select("id, theme, theme_normalized, status, outcome, child_run_id, last_dispatched_at")
    .eq("tenant_id", ctx.tenant_id)
    .in("status", ["proposed", "in_flight"])
    .limit(100);
  if (error) {
    console.warn(
      `[pm needs-action] roadmap read failed for tenant=${ctx.tenant_id}: ${error.message}`,
    );
    return { emitted: 0, skipped: 0 };
  }
  const rows = ((rowsData ?? []) as Array<{
    id: string;
    theme: string | null;
    theme_normalized: string | null;
    status: string;
    outcome: string | null;
    child_run_id: string | null;
    last_dispatched_at: string | null;
  }>).filter((r) => !!r && typeof r.id === "string");

  const childIds = Array.from(
    new Set(
      rows
        .filter((r) => r.status === "in_flight" && r.child_run_id)
        .map((r) => r.child_run_id as string),
    ),
  );
  const childById = new Map<
    string,
    { status?: string | null; error?: string | null; finished_at?: string | null; parsed?: Record<string, unknown> | null }
  >();
  if (childIds.length > 0) {
    const { data: childData, error: childErr } = await svc
      .from("agent_runs")
      .select("id, status, error, finished_at, parsed")
      .eq("tenant_id", ctx.tenant_id)
      .in("id", childIds);
    if (childErr) {
      console.warn(`[pm needs-action] child-run read failed: ${childErr.message}`);
    } else {
      for (const run of (childData ?? []) as Array<Record<string, unknown>>) {
        const id = typeof run.id === "string" ? run.id : "";
        if (!id) continue;
        childById.set(id, {
          status: typeof run.status === "string" ? run.status : null,
          error: typeof run.error === "string" ? run.error : null,
          finished_at: typeof run.finished_at === "string" ? run.finished_at : null,
          parsed:
            run.parsed && typeof run.parsed === "object"
              ? (run.parsed as Record<string, unknown>)
              : null,
        });
      }
    }
  }

  let emitted = 0;
  let skipped = 0;
  const deadThemes: string[] = [];
  const normalStuck: Array<{ theme: string; roadmap_id: string }> = [];

  for (const row of rows) {
    let kind: ExceptionKind | null = null;
    let pr_url: string | null = null;
    let pr_state: string | null = null;

    if (row.outcome === "recurred") {
      kind = "recurred";
    } else if (row.status === "in_flight" && row.child_run_id) {
      const child = childById.get(row.child_run_id) ?? {};
      const parsed = (child.parsed ?? {}) as Record<string, unknown>;
      pr_url = typeof parsed.pr_url === "string" && parsed.pr_url.length > 0 ? parsed.pr_url : null;
      pr_state =
        typeof parsed.pr_state === "string" && parsed.pr_state.length > 0 ? parsed.pr_state : null;
      const stage = deriveDispatchStage(child);
      if (stage === "failed_to_open") {
        kind = childDiedOnInfra(child) ? "dispatch_died" : "failed_to_open";
      } else if (isStuckEligibleStage(stage) && row.last_dispatched_at) {
        const ageMs = now.getTime() - Date.parse(row.last_dispatched_at);
        if (Number.isFinite(ageMs) && ageMs >= STUCK_MS) kind = "stuck";
      }
    }

    if (!kind) continue;

    if (kind === "dispatch_died") {
      deadThemes.push((row.theme ?? row.theme_normalized ?? "(untitled)").slice(0, 200));
      continue;
    }

    const severity = themeSeverity(row.theme ?? row.theme_normalized);
    if (severity === "normal") {
      normalStuck.push({
        theme: (row.theme ?? row.theme_normalized ?? "(untitled)").slice(0, 200),
        roadmap_id: row.id,
      });
      continue;
    }

    const { data: existing, error: existErr } = await svc
      .from("decisions")
      .select("id")
      .eq("tenant_id", ctx.tenant_id)
      .eq("decision_class", PM_NEEDS_ACTION_CLASS)
      .eq("status", "proposed")
      .eq("body->>roadmap_id", row.id)
      .limit(1)
      .maybeSingle();
    if (existErr) {
      console.warn(`[pm needs-action] dedup read failed for roadmap=${row.id}: ${existErr.message}`);
      skipped += 1;
      continue;
    }
    if (existing) {
      skipped += 1;
      continue;
    }

    const theme = (row.theme ?? row.theme_normalized ?? "(untitled)").slice(0, 400);
    const proposed_action = "redispatch_and_close_pr" as const;
    const body = {
      theme,
      roadmap_id: row.id,
      child_run_id: row.child_run_id ?? null,
      pr_url,
      pr_state,
      exception_kind: kind,
      proposed_action,
      severity,
      rendered_markdown: needsActionMarkdown({ theme, kind, pr_url, proposed_action, severity }),
    };

    const { error: emitErr } = await svc.rpc("emit_decision", {
      p_tenant_id: ctx.tenant_id,
      p_agent_run_id: ctx.runId,
      p_decision_class: PM_NEEDS_ACTION_CLASS,
      p_body: body,
    });
    if (emitErr) {
      console.warn(`[pm needs-action] emit_decision failed for roadmap=${row.id}: ${emitErr.message}`);
      skipped += 1;
      continue;
    }
    emitted += 1;
  }

  try {
    const { data: openCoalesced } = await svc
      .from("decisions")
      .select("id, body")
      .eq("tenant_id", ctx.tenant_id)
      .eq("decision_class", PM_NEEDS_ACTION_CLASS)
      .eq("status", "proposed")
      .eq("body->>coalesced", "true")
      .limit(1)
      .maybeSingle();
    const action = decideCoalesceAction(deadThemes.length, !!openCoalesced);
    if (action === "emit") {
      const body = buildCoalescedBody(deadThemes);
      const { error: cErr } = await svc.rpc("emit_decision", {
        p_tenant_id: ctx.tenant_id,
        p_agent_run_id: ctx.runId,
        p_decision_class: PM_NEEDS_ACTION_CLASS,
        p_body: body,
      });
      if (cErr) console.warn(`[pm needs-action] coalesced emit failed: ${cErr.message}`);
      else emitted += 1;
    } else if (action === "refresh" && openCoalesced) {
      await svc
        .from("decisions")
        .update({ body: buildCoalescedBody(deadThemes) })
        .eq("id", (openCoalesced as { id: string }).id);
    } else if (action === "resolve" && openCoalesced) {
      const prevBody = ((openCoalesced as { body?: Record<string, unknown> }).body) ?? {};
      await svc
        .from("decisions")
        .update({ status: "rejected", body: { ...prevBody, auto_resolved: true } })
        .eq("id", (openCoalesced as { id: string }).id);
    }
  } catch (e) {
    console.warn(`[pm needs-action] coalesced dispatch_died pass failed: ${(e as Error).message}`);
  }

  try {
    const { data: openRollup } = await svc
      .from("decisions")
      .select("id, body")
      .eq("tenant_id", ctx.tenant_id)
      .eq("decision_class", PM_NEEDS_ACTION_CLASS)
      .eq("status", "proposed")
      .eq("body->>stuck_rollup", "true")
      .limit(1)
      .maybeSingle();
    const action = decideCoalesceAction(normalStuck.length, !!openRollup);
    if (action === "emit") {
      const { error: rErr } = await svc.rpc("emit_decision", {
        p_tenant_id: ctx.tenant_id,
        p_agent_run_id: ctx.runId,
        p_decision_class: PM_NEEDS_ACTION_CLASS,
        p_body: buildStuckRollupBody(normalStuck),
      });
      if (rErr) console.warn(`[pm needs-action] stuck rollup emit failed: ${rErr.message}`);
      else emitted += 1;
    } else if (action === "refresh" && openRollup) {
      const { error: uErr } = await svc
        .from("decisions")
        .update({ body: buildStuckRollupBody(normalStuck) })
        .eq("id", (openRollup as { id: string }).id);
      if (uErr) console.warn(`[pm needs-action] stuck rollup refresh failed: ${uErr.message}`);
    } else if (action === "resolve" && openRollup) {
      const prevBody = ((openRollup as { body?: Record<string, unknown> }).body) ?? {};
      const { error: uErr } = await svc
        .from("decisions")
        .update({ status: "rejected", body: { ...prevBody, auto_resolved: true } })
        .eq("id", (openRollup as { id: string }).id);
      if (uErr) console.warn(`[pm needs-action] stuck rollup resolve failed: ${uErr.message}`);
    }
  } catch (e) {
    console.warn(`[pm needs-action] stuck rollup pass failed: ${(e as Error).message}`);
  }

  return { emitted, skipped };
}

export type CoalesceAction = "emit" | "refresh" | "resolve" | "noop";
export function decideCoalesceAction(deadCount: number, hasOpenCoalesced: boolean): CoalesceAction {
  if (deadCount > 0) return hasOpenCoalesced ? "refresh" : "emit";
  return hasOpenCoalesced ? "resolve" : "noop";
}
export function buildCoalescedBody(deadThemes: string[]): Record<string, unknown> {
  const n = deadThemes.length;
  const shown = deadThemes.slice(0, 8);
  const more = n > shown.length ? ` (and ${n - shown.length} more)` : "";
  const rendered_markdown =
    `⚠️ *Engineer blocked by infrastructure.* ${n} work item${n === 1 ? "" : "s"} could not run: ` +
    `the engineer's sandbox ended before producing anything (repo too big for the workspace, a usage limit, ` +
    `or a container restart). Nothing was produced and there is no per item action here; these retry ` +
    `automatically once the infrastructure is cleared.` +
    (shown.length ? ` Affected: ${shown.join(", ")}${more}.` : "");
  return {
    coalesced: true,
    exception_kind: "dispatch_died",
    affected_count: n,
    affected_themes: shown,
    roadmap_id: null,
    child_run_id: null,
    pr_url: null,
    pr_state: null,
    proposed_action: "none",
    rendered_markdown,
  };
}

export function buildStuckRollupBody(
  items: Array<{ theme: string; roadmap_id: string }>,
): Record<string, unknown> {
  const n = items.length;
  const shown = items.slice(0, 8);
  const more = n > shown.length ? ` (and ${n - shown.length} more)` : "";
  const rendered_markdown =
    `🕒 *${n} fix${n === 1 ? "" : "es"} stuck in review.* ` +
    `Each was dispatched but has sat past the review window with no open pull request. ` +
    `These are routine, not urgent; open Product PM to see each one, or ask it or the engineer for status. ` +
    (shown.length ? `Affected: ${shown.map((i) => i.theme).join(", ")}${more}.` : "");
  return {
    stuck_rollup: true,
    exception_kind: "stuck",
    severity: "normal",
    affected_count: n,
    affected_themes: shown.map((i) => i.theme),
    affected_roadmap_ids: shown.map((i) => i.roadmap_id),
    roadmap_id: null,
    child_run_id: null,
    pr_url: null,
    pr_state: null,
    proposed_action: "none",
    rendered_markdown,
  };
}

export type NeedsActionDecision = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  status: string;
  body: Record<string, unknown> | null;
};

export type ClosePrResult = { ok: boolean; error?: string };

export type PerformNeedsActionDeps = {
  enqueue: (input: {
    agent_slug: string;
    tenant_id: string;
    trigger: "a2a";
    payload: Record<string, unknown>;
  }) => Promise<{ run_id: string }>;
  closePr: (args: {
    tenant_id: string;
    run_id: string;
    owner: string;
    repo: string;
    pull_number: number;
  }) => Promise<ClosePrResult>;
  svc?: Svc;
  log?: (evt: {
    level: "info" | "warn";
    source: string;
    code: string;
    message: string;
    tenant_id: string;
    meta: Record<string, unknown>;
  }) => void | Promise<void>;
};

export function parsePrUrl(
  url: string | null | undefined,
): { owner: string; repo: string; pull_number: number } | null {
  if (typeof url !== "string") return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const pull_number = Number(m[3]);
  if (!Number.isInteger(pull_number) || pull_number < 1) return null;
  return { owner: m[1], repo: m[2], pull_number };
}

export async function performNeedsAction(
  d: NeedsActionDecision,
  deps: PerformNeedsActionDeps,
): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const svc = deps.svc ?? serviceClient();
  const log = deps.log ?? (() => {});
  const body = (d.body ?? {}) as Record<string, unknown>;
  const theme = typeof body.theme === "string" ? body.theme.slice(0, 200) : "(untitled)";
  const roadmap_id = typeof body.roadmap_id === "string" ? body.roadmap_id : null;
  const exception_kind =
    typeof body.exception_kind === "string" ? body.exception_kind : "exception";
  const pr_url = typeof body.pr_url === "string" ? body.pr_url : null;
  const priorChildId = typeof body.child_run_id === "string" ? body.child_run_id : null;
  const proposed_action =
    typeof body.proposed_action === "string" ? body.proposed_action : null;

  if (proposed_action === "none" || roadmap_id === null) {
    await log({
      level: "info",
      source: "pm.needs_action",
      code: "pm.needs_action.acknowledged",
      message: "pm.needs_action informational card acknowledged (no side effect)",
      tenant_id: d.tenant_id,
      meta: { decision_id: d.id, exception_kind, proposed_action },
    });
    return { ok: true, notice: "Acknowledged. Nothing was re-run and no PR was closed." };
  }

  if (d.status === "acted" || d.status === "rejected") {
    return { ok: true, notice: "No action taken (decision already resolved)." };
  }

  let childRunId: string | null = null;
  let redispatched = false;
  const { data: existingRun } = await svc
    .from("agent_runs")
    .select("id")
    .eq("tenant_id", d.tenant_id)
    .eq("payload->>source_decision_id", d.id)
    .limit(1)
    .maybeSingle();
  if (existingRun && typeof (existingRun as { id?: unknown }).id === "string") {
    childRunId = (existingRun as { id: string }).id;
  } else {
    let repo_hint = "";
    let file_hints: string[] = [];
    if (priorChildId) {
      const { data: prior } = await svc
        .from("agent_runs")
        .select("payload")
        .eq("tenant_id", d.tenant_id)
        .eq("id", priorChildId)
        .maybeSingle();
      const pl = (prior as { payload?: unknown } | null)?.payload;
      if (pl && typeof pl === "object") {
        const p = pl as { repo_hint?: unknown; file_hints?: unknown };
        if (typeof p.repo_hint === "string") repo_hint = p.repo_hint;
        if (Array.isArray(p.file_hints)) {
          file_hints = p.file_hints.filter((x): x is string => typeof x === "string").slice(0, 5);
        }
      }
    }
    try {
      const { run_id } = await deps.enqueue({
        agent_slug: "engineer",
        tenant_id: d.tenant_id,
        trigger: "a2a",
        payload: {
          source_agent: "pm",
          source_decision_id: d.id,
          task_description: `re-scope and retry: ${theme} — prior attempt ${exception_kind}`,
          context_summary: `pm re-dispatch after ${exception_kind}. Prior child run ${priorChildId ?? "n/a"}.`,
          ...(repo_hint ? { repo_hint } : {}),
          ...(file_hints.length ? { file_hints } : {}),
        },
      });
      childRunId = run_id;
      redispatched = true;
    } catch (e) {
      if ((e as { code?: string }).code === "fleet_halted") {
        return { ok: false, error: "fleet_halted" };
      }
      return { ok: false, error: `redispatch failed: ${(e as Error).message}` };
    }
  }

  let closed = false;
  let closeNote = "";
  const pr = parsePrUrl(pr_url);
  if (pr) {
    try {
      const r = await deps.closePr({
        tenant_id: d.tenant_id,
        run_id: d.agent_run_id ?? "",
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.pull_number,
      });
      if (r.ok) {
        closed = true;
      } else {
        closeNote = ` (prior PR not closed: ${r.error ?? "already closed/merged"})`;
      }
    } catch (e) {
      closeNote = ` (prior PR not closed: ${(e as Error).message})`;
    }
  }

  await log({
    level: "info",
    source: "pm.needs_action",
    code: "pm.needs_action.acted",
    message: `pm.needs_action approved: redispatched=${redispatched} closed_pr=${closed}`,
    tenant_id: d.tenant_id,
    meta: {
      decision_id: d.id,
      roadmap_id,
      exception_kind,
      redispatched,
      child_run_id: childRunId,
      closed_pr: closed,
    },
  });

  const runNote = childRunId ? ` (run \`${childRunId}\`)` : "";
  const closedNote = closed ? " and closed the prior PR" : closeNote;
  return {
    ok: true,
    notice: `Re-dispatched engineer to re-scope "${theme}"${runNote}${closedNote}.`,
  };
}
