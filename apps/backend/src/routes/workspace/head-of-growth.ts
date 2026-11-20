
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { goalRev } from "@/services/growth/goal-owner";
import { clipAtWord, clipKeepingLines } from "@/services/growth/question-text";
import { writeAutopilotGoal, type GoalActor } from "@/services/growth/goal-write";
import { resolveSchedulerCapability } from "@/services/agents/scheduler-capability";

const AutopilotBody = z.object({ enabled: z.boolean() });

export async function getGrowthScheduler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json(await resolveSchedulerCapability(auth.tenant_id));
  } catch (e) {
    res.status(500).json({ error: { code: "scheduler_read_failed", message: (e as Error).message } });
  }
}

export async function putGrowthAutopilot(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    return;
  }
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const parsed = AutopilotBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: "enabled must be true or false" } });
    return;
  }
  const enabled = parsed.data.enabled;
  let out: { ok?: boolean; code?: string; prior?: boolean | null; on_at?: string | null } | null;
  try {
    const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "set_cgo_autopilot", {
      p_enabled: enabled,
      p_actor_user_id: auth.user_id,
    });
    if (error) throw new Error(error.message);
    out = data as typeof out;
  } catch (e) {
    console.warn(JSON.stringify({ evt: "cgo.autopilot_set_failed", tenant_id: auth.tenant_id, enabled, error: (e as Error).message }));
    res.status(500).json({ error: { code: "autopilot_failed", message: (e as Error).message } });
    return;
  }
  if (out?.ok !== true) {
    const forbidden = out?.code === "not_owner_or_admin";
    res.status(forbidden ? 403 : 500).json({
      error: forbidden
        ? { code: "forbidden", message: "Only owners and admins can change Autopilot." }
        : { code: "autopilot_unconfirmed", message: "The change did not save. Try again." },
    });
    return;
  }
  console.info(JSON.stringify({ evt: enabled ? "cgo.autopilot_on" : "cgo.autopilot_off", tenant_id: auth.tenant_id, user_id: auth.user_id, prior: out.prior ?? null, on_at: out.on_at ?? null }));
  const { logEvent } = await import("@/services/logging/logEvent");
  await logEvent({ level: "info", source: "cgo.autopilot", code: enabled ? "autopilot_on" : "autopilot_off", tenant_id: auth.tenant_id });
  res.json({ autopilot: enabled });
}

const SeenBody = z.object({ slug: z.string().min(1).max(64) });

export async function postChannelSeen(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = SeenBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: "slug required" } });
    return;
  }
  const { error } = await serverClientFromBearer(auth.access_token).rpc("mark_channel_seen", {
    p_channel_slug: parsed.data.slug,
  });
  if (error) console.warn(`[channel-seen] mark_channel_seen failed: ${error.message}`);
  res.status(204).end();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Undo = {
  prev?: {
    objective?: string;
    target_metric?: string;
    target_value?: number | null;
    due_date?: string | null;
    current_value?: number | null;
    baseline_value?: number | null;
    measurement_mode?: string | null;
    measure_source?: string | null;
    value_kind?: string | null;
    value_period_start?: string | null;
  };
  rev?: string;
};

type UndoResult =
  | { ok: true; objective: string; why: string; at: string; run_id: string | null }
  | { ok: false; status: number; code: string; message: string };

const DAY_MS = 86_400_000;
export const MISTAKE_WINDOW_DAYS = 30;
const MANUAL_REFUND = new Set(["failed", "no_run", "pending"]);

export async function undoGoalChange(
  tenant_id: string,
  id: string,
  maxAgeDays: number | undefined,
  actor: GoalActor,
): Promise<UndoResult> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: g, error } = await db
    .from("autopilot_goals")
    .select("id, status, objective, target_metric, target_value, due_date, updated_at, cgo_undo")
    .eq("tenant_id", tenant_id)
    .eq("id", id)
    .maybeSingle<{
      id: string;
      status: string;
      objective: string;
      target_metric: string;
      target_value: number | null;
      due_date: string | null;
      updated_at: string;
      cgo_undo: (Undo & { why?: string; at?: string; run_id?: string }) | null;
    }>();
  if (error) return { ok: false, status: 500, code: "undo_failed", message: error.message };
  const prev = g?.cgo_undo?.prev;
  if (!g || g.status !== "active" || !prev || !prev.objective || !prev.target_metric) {
    return { ok: false, status: 404, code: "nothing_to_undo", message: "There is no change to undo on this goal." };
  }
  if (g.cgo_undo?.rev !== goalRev(g)) {
    return { ok: false, status: 409, code: "goal_changed_since", message: "This goal was changed again since, so there is nothing to undo." };
  }
  const at = g.cgo_undo?.at ?? "";
  const why = g.cgo_undo?.why ?? "";
  const runId = g.cgo_undo?.run_id ?? null;
  if (maxAgeDays != null && !(Date.parse(at) >= Date.now() - maxAgeDays * DAY_MS)) {
    return { ok: false, status: 409, code: "outside_window", message: `This change is more than ${maxAgeDays} days old.` };
  }
  const metricReverts = prev.target_metric !== g.target_metric;
  const w = await writeAutopilotGoal(tenant_id, {
    op: "update",
    goal_id: id,
    values: {
      objective: prev.objective,
      target_metric: prev.target_metric,
      target_value: prev.target_value ?? null,
      due_date: prev.due_date ?? null,
      ...(metricReverts
        ? {
            current_value: prev.current_value ?? null,
            baseline_value: prev.baseline_value ?? null,
            ...(prev.measurement_mode ? { measurement_mode: prev.measurement_mode } : {}),
            ...("measure_source" in prev ? { measure_source: prev.measure_source ?? null } : {}),
            ...("value_kind" in prev ? { value_kind: prev.value_kind ?? null, value_period_start: prev.value_period_start ?? null } : {}),
          }
        :
          prev.value_kind === "period_total" && prev.value_period_start
          ? { value_period_start: prev.value_period_start, ...("current_value" in prev ? { current_value: prev.current_value ?? null } : {}) }
          : {}),
      cgo_undo: null,
      updated_at: new Date().toISOString(),
    },
    expect: { status: "active", updated_at: g.updated_at },
    actor,
  });
  if (w.status === "error") return { ok: false, status: 500, code: "undo_failed", message: w.error };
  if (w.status === "not_matched") {
    return { ok: false, status: 409, code: "goal_changed_since", message: "This goal was changed again since, so there is nothing to undo." };
  }
  return { ok: true, objective: prev.objective, why, at, run_id: runId };
}

export async function postUndoCgoChange(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid goal id" } });
    return;
  }
  const r = await undoGoalChange(auth.tenant_id, id, undefined, { source: "founder", user_id: auth.user_id, why: "Undo" });
  if (!r.ok) {
    res.status(r.status).json({ error: { code: r.code, message: r.message } });
    return;
  }
  res.json({ ok: true });
}

const MistakeBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal"), goal_id: z.string().regex(UUID_RE) }),
  z.object({ kind: z.literal("channel"), channel_slug: z.string().min(1).max(64) }),
]);

export async function postAutopilotMistake(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const parsed = MistakeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: "Say which change was a mistake." } });
    return;
  }
  const b = parsed.data;
  let what: string;
  let changedAt: string;
  let runId: string | null = null;

  if (b.kind === "goal") {
    const r = await undoGoalChange(auth.tenant_id, b.goal_id, MISTAKE_WINDOW_DAYS, {
      source: "founder",
      user_id: auth.user_id,
      why: "Marked as an Autopilot mistake",
    });
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    what = `Goal change on "${r.objective}"${r.why ? ` (${r.why})` : ""}`;
    changedAt = r.at;
    runId = r.run_id;
  } else {
    const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "claim_cgo_pause", {
      p_channel_slug: b.channel_slug,
      p_window_days: MISTAKE_WINDOW_DAYS,
    });
    if (error) {
      res.status(500).json({ error: { code: "undo_failed", message: error.message } });
      return;
    }
    const r = (data ?? {}) as { ok?: boolean; code?: string; why?: string | null; at?: string | null; run_id?: string | null };
    if (!r.ok) {
      const refusal: Record<string, [number, string]> = {
        nothing_to_undo: [404, "Autopilot has not paused this channel."],
        outside_window: [409, `This change is more than ${MISTAKE_WINDOW_DAYS} days old.`],
        plan_changed: [409, "Your plan changed since this pause, so there is nothing to undo."],
      };
      const [status, message] = refusal[r.code ?? ""] ?? [500, "Could not undo that."];
      res.status(status).json({ error: { code: r.code ?? "undo_failed", message } });
      return;
    }
    what = `Paused channel ${b.channel_slug} (${r.why ?? ""})`;
    changedAt = r.at ?? "";
    runId = r.run_id ?? null;
  }

  type Refund = { status: string; credits: number; forfeited: number; untracked: number };
  let refund: Refund = { status: "failed", credits: 0, forfeited: 0, untracked: 0 };
  try {
    const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "refund_autopilot_run", { p_run_id: runId });
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as { status?: string; credits?: number; forfeited?: number; untracked?: number };
    const n = (v: unknown) => Math.max(0, Math.floor(Number(v ?? 0)) || 0);
    refund = { status: String(d.status ?? "failed"), credits: n(d.credits), forfeited: n(d.forfeited), untracked: n(d.untracked) };
  } catch (e) {
    console.error(`[autopilot-mistake] refund failed (tenant ${auth.tenant_id}, run ${runId}): ${(e as Error).message}`);
  }

  let claimSent = true;
  try {
    const { sgSend } = await import("@/email/sendAuthEmail");
    const { alertRecipient } = await import("@/services/tenants/new-tenant-alert");
    const lines = [
      MANUAL_REFUND.has(refund.status)
        ? `An Autopilot change was marked as a mistake. No automatic refund (${refund.status}): refund the credits it used by hand.`
        : `An Autopilot change was marked as a mistake. Refund: ${refund.status} (${refund.credits} credits back, ${refund.forfeited} forfeited from a window that has since reset${
            refund.untracked > 0
              ? `, ${refund.untracked} unverified: their source could not be checked automatically. Review the settle and refund only what is owed, to the bucket it came from`
              : ""
          }).`,
      `Tenant: ${auth.tenant_id}`,
      `Claimed by user: ${auth.user_id}`,
      `Change: ${what}`,
      `Changed at: ${changedAt || "unknown"}`,
      `Review run: ${runId ?? "see the tenant's latest cgo own_goals run"}`,
      `Claimed at: ${new Date().toISOString()}`,
    ];
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
    await sgSend(
      alertRecipient(),
      `Autopilot Guarantee claim: tenant ${auth.tenant_id.slice(0, 8)}`,
      `<p>${lines.map(esc).join("<br>")}</p>`,
      lines.join("\n"),
    );
  } catch (e) {
    claimSent = false;
    console.error(`[autopilot-mistake] claim email failed (tenant ${auth.tenant_id}): ${(e as Error).message}`);
  }
  res.json({ ok: true, refund, claim_sent: claimSent });
}

export async function getGrowthQuestions(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const db = tenantClient(asTenantId(auth.tenant_id));
  const queuedRead = db.from("cgo_questions").select("id", { count: "exact", head: true }).eq("tenant_id", auth.tenant_id).eq("status", "queued");
  const { data, error } = await db
    .from("cgo_questions")
    .select("id, ordinal, ask, recommended, why, asked_at, topic_key")
    .eq("tenant_id", auth.tenant_id)
    .eq("status", "open")
    .order("asked_at", { ascending: true })
    .limit(100);
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  const { loadTenantRole } = await import("@/services/auth/tenant-role");
  const role = await loadTenantRole(auth).catch(() => null);
  const { isYesNoAsk, HYPOTHESIS_TOPIC } = await import("@/services/growth/cgo-questions");
  const { count: queued } = await queuedRead;
  res.json({
    can_answer: role === "owner",
    queued_count: typeof queued === "number" ? queued : 0,
    questions: ((data ?? []) as Array<{ id: string; ordinal: number | null; ask: string; recommended: string | null; why: string | null; asked_at: string; topic_key: string }>).map(
      ({ topic_key, ...q }) => ({
        ...q,
        yes_no: isYesNoAsk(q.ask),
        ...(topic_key.startsWith(HYPOTHESIS_TOPIC) ? { fact_check: true } : {}),
      }),
    ),
  });
}

export async function getGrowthAdHolds(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const { readHoldLines } = await import("@/services/growth/ad-holds");
    res.json({ holds: await readHoldLines(auth.tenant_id) });
  } catch (e) {
    res.status(500).json({ error: { code: "read_failed", message: (e as Error).message } });
  }
}

const AnswerBody = z.object({
  answer: z.union([z.enum(["yes", "no", "not_now"]), z.object({ text: z.string().trim().min(1).max(500) })]),
});

export async function postGrowthQuestionAnswer(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner"], res))) return;
  const id = req.params.id;
  const parsed = AnswerBody.safeParse(req.body ?? {});
  if (typeof id !== "string" || !UUID_RE.test(id) || !parsed.success) {
    res.status(400).json({ error: { code: "bad_request", message: "a question id and an answer" } });
    return;
  }
  const { answerQuestion, deferredWake } = await import("@/services/growth/cgo-answers");
  const later = deferredWake();
  const r = await answerQuestion(
    { tenant_id: auth.tenant_id, question_id: id, answer: parsed.data.answer, via: "web", actor_user_id: auth.user_id },
    { wake: later.wake },
  );
  if (r.outcome === "not_found") {
    res.status(404).json({ error: { code: "not_found", message: "No such question." } });
    return;
  }
  res.json(r);
  await later.run();
}

const YOU_ASKED_DAYS = 7;
const YOU_ASKED_QUESTION_MAX = 300;
const YOU_ASKED_ANSWER_MAX = 600;

export type YouAskedMessage = {
  id: string;
  thread_id: string;
  sender_role: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  agent_run_id: string | null;
  created_at: string;
};

export function pickYouAsked(msgs: readonly YouAskedMessage[]): { question: string; at: string; answer: string | null } | null {
  const byTime = [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const asked = [...byTime]
    .reverse()
    .find(
      (m) =>
        m.sender_role === "user" &&
        m.meta?.via === "email" &&
        m.meta?.superseded_by == null &&
        typeof m.body === "string" &&
        m.body.includes("?"),
    );
  if (!asked) return null;
  const runId = typeof asked.meta?.reply_run_id === "string" ? asked.meta.reply_run_id : null;
  let answer: string | null = null;
  if (runId) {
    const after = byTime.filter((m) => m.thread_id === asked.thread_id && m.created_at > asked.created_at);
    const nextUser = after.find((m) => m.sender_role === "user");
    const reply = after.find(
      (m) =>
        m.sender_role === "assistant" &&
        m.agent_run_id === runId &&
        (!nextUser || m.created_at < nextUser.created_at) &&
        typeof m.body === "string" &&
        m.body.trim().length > 0,
    );
    answer = reply ? clipKeepingLines(reply.body as string, YOU_ASKED_ANSWER_MAX) : null;
  }
  return { question: clipAtWord(asked.body as string, YOU_ASKED_QUESTION_MAX), at: asked.created_at, answer };
}

export async function getGrowthYouAsked(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const db = tenantClient(asTenantId(auth.tenant_id));
  const { data: threads, error } = await db
    .from("agent_threads")
    .select("id")
    .eq("tenant_id", auth.tenant_id)
    .eq("user_id", auth.user_id)
    .eq("agent_slug", "cgo")
    .is("deleted_at", null)
    .not("synthetic", "is", true)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(20);
  if (error) {
    res.status(500).json({ error: { code: "read_failed", message: error.message } });
    return;
  }
  const ids = ((threads ?? []) as Array<{ id: string }>).map((t) => t.id);
  if (ids.length === 0) {
    res.json({ asked: null });
    return;
  }
  const since = new Date(Date.now() - YOU_ASKED_DAYS * 86_400_000).toISOString();
  const cols = "id, thread_id, sender_role, body, meta, agent_run_id, created_at";
  const { data: asks, error: aErr } = await db
    .from("agent_thread_messages")
    .select(cols)
    .eq("tenant_id", auth.tenant_id)
    .in("thread_id", ids)
    .eq("sender_role", "user")
    .filter("meta->>via", "eq", "email")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  if (aErr) {
    res.status(500).json({ error: { code: "read_failed", message: aErr.message } });
    return;
  }
  const asked = pickYouAsked((asks ?? []) as YouAskedMessage[]);
  const row = asked ? ((asks ?? []) as YouAskedMessage[]).find((m) => m.created_at === asked.at) : undefined;
  if (!row) {
    res.json({ asked: null });
    return;
  }
  const { data: after, error: rErr } = await db
    .from("agent_thread_messages")
    .select(cols)
    .eq("tenant_id", auth.tenant_id)
    .eq("thread_id", row.thread_id)
    .gt("created_at", row.created_at)
    .order("created_at", { ascending: true })
    .limit(50);
  if (rErr) {
    res.status(500).json({ error: { code: "read_failed", message: rErr.message } });
    return;
  }
  res.json({ asked: pickYouAsked([row, ...((after ?? []) as YouAskedMessage[])]) });
}
