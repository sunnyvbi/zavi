
import type { NextFunction, Request, Response } from "express";
import { decisionHomeFromStamp } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { approveNeedsOwnerOrAdmin } from "@/services/approvals/approve-role-gate";
import { logEvent } from "@/services/logging/logEvent";
import { socialDraftVersion } from "@/services/approvals/social-draft-version";
import { SOCIAL_PUBLISH_CLASS } from "./decision-channel";
import { cgoHoldView, founderAdviceView } from "@/services/approvals/hold-view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWER_ROLES = new Set(["owner", "admin", "member", "viewer"]);

const ONE_COLUMNS =
  "id, agent_run_id, decision_class, handler, body, status, autonomy_at_emit, emitted_at, approved_at, dispatched_at, dispatch_error, home, home_channel, cgo_hold, founder_advice";

export async function approvalsOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = typeof req.params.decision_id === "string" ? req.params.decision_id : "";
  if (!UUID_RE.test(id)) {
    next();
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("decisions")
    .select(ONE_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  if (error) {
    void logEvent({
      level: "error",
      source: "routes/approvals/one",
      code: "approvals.one_failed",
      tenant_id: auth.tenant_id,
      message: error.message,
      meta: { db_error_code: (error as { code?: string }).code ?? "unknown" },
    });
    res.status(500).json({ error: { code: "read_failed", message: "Could not read this card." } });
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "not_found", message: "decision not found" } });
    return;
  }
  const row = data as unknown as {
    id: string;
    agent_run_id: string | null;
    decision_class: string;
    body: unknown;
    home: string | null;
    home_channel: string | null;
  } & Record<string, unknown>;

  let agent_slug: string | null = null;
  let thread_id: string | null = null;
  if (row.agent_run_id) {
    const { data: run } = await supabase
      .from("agent_runs")
      .select("agent_slug, payload")
      .eq("id", row.agent_run_id)
      .eq("tenant_id", auth.tenant_id)
      .maybeSingle();
    const r = (run ?? null) as { agent_slug?: string | null; payload?: { thread_id?: unknown; operator_thread_id?: unknown } | null } | null;
    agent_slug = r?.agent_slug ?? null;
    const p = r?.payload ?? {};
    thread_id = typeof p.thread_id === "string" ? p.thread_id : typeof p.operator_thread_id === "string" ? p.operator_thread_id : null;
  }

  let viewer_role: string | null = null;
  try {
    const role = await loadTenantRoleFor(auth.user_id, auth.tenant_id);
    viewer_role = role && VIEWER_ROLES.has(role) ? role : null;
  } catch (e) {
    void logEvent({ level: "warn", source: "routes/approvals/one", code: "approvals.one_role_failed", tenant_id: auth.tenant_id, error: e });
  }

  const { budget_choice, move } = await budgetAndMove(auth.tenant_id, row);

  const { agent_run_id: _run, cgo_hold: rawHold, founder_advice: rawAdvice, ...decision } = row;
  res.json({
    decision: {
      ...decision,
      agent_slug,
      thread_id,
      ...(row.decision_class === SOCIAL_PUBLISH_CLASS ? { post_revision: socialDraftVersion(row.body) } : {}),
      cgo_hold: cgoHoldView(rawHold),
      founder_advice: founderAdviceView(rawAdvice),
    },
    home: decisionHomeFromStamp(row),
    needs_owner_admin: approveNeedsOwnerOrAdmin(row.decision_class, row.body),
    viewer_role,
    budget_choice,
    move,
  });
}

async function budgetAndMove(tenant_id: string, row: { id: string; decision_class: string; body: unknown; status?: unknown }): Promise<{ budget_choice: unknown; move: unknown }> {
  const none = { budget_choice: null, move: null };
  if (!/^(meta_ads|google_ads)\./.test(row.decision_class)) return none;
  try {
    const { adBudgetChoiceEnabled } = await import("@/services/decisions/ad-budget-choice-flag");
    if (!(await adBudgetChoiceEnabled())) return none;
  } catch {
    return none;
  }
  let move: unknown = null;
  try {
    const { moveView } = await import("@/services/growth/move-card");
    move = await moveView(tenant_id, row.id, row.body);
  } catch (e) {
    void logEvent({ level: "warn", source: "routes/approvals/one", code: "approvals.one_move_failed", tenant_id, error: e });
  }
  if (row.status !== "proposed") return { budget_choice: null, move };
  try {
    const { readRaiseFit } = await import("@/services/decisions/ad-month-counter");
    const { budgetChoiceView } = await import("@/services/approvals/budget-choice");
    const view = budgetChoiceView(await readRaiseFit(tenant_id, row.decision_class, row.body));
    if (view?.kind !== "over") return { budget_choice: view, move };
    let fm: { find_money: "available" | "none" | "unreadable" | null; find_money_why: string | null } = { find_money: null, find_money_why: null };
    if (view.raise_to_usd !== null) {
      try {
        const { findMoneyAvailability } = await import("@/services/growth/founder-cut-candidates");
        fm = await findMoneyAvailability(tenant_id, { id: row.id, decision_class: row.decision_class, body: row.body });
      } catch {
        fm = { find_money: "unreadable", find_money_why: null };
      }
    }
    return { budget_choice: { ...view, ...fm }, move };
  } catch (e) {
    void logEvent({ level: "warn", source: "routes/approvals/one", code: "approvals.one_budget_choice_failed", tenant_id, error: e });
    return { budget_choice: null, move };
  }
}
