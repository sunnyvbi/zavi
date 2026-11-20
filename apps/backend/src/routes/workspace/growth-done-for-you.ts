
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { loadTierGateConfig, resolveTenantTier } from "@/services/agents/entitlement";
import { enqueueAgentRun } from "@/services/agents/runner";
import { requestStopForRun } from "@/services/agents/request-stop";
import { runChannelRecipe } from "@/services/channels/engine";
import { defaultChannelContext } from "@/services/channels/context";
import { isChannelLocked } from "@/services/channels/lock";
import { recipeExists } from "@/services/channels/recipe";
import { trackDoneForYou } from "@/services/analytics/action-events";
import { logEvent } from "@/services/logging/logEvent";
import type { Tier } from "@/services/billing/tiers";
import {
  doneForYouEligibility,
  doneForYouKey,
  doneForYouKeys,
  doneForYouNote,
  doneForYouResult,
  summarizeDoneForYou,
  type DfyActionRow,
  type DfyAttempt,
  type DfyAttemptRow,
  type DfyGates,
  type DfyStateSummary,
  type ChannelFacts,
} from "@/services/growth/done-for-you";

const LOG_SOURCE = "growth.done_for_you";

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function readDoneForYouGates(
  tenant_id: string,
): Promise<DfyGates & { facts: ChannelFacts; tierUnreadable: boolean }> {
  let enabled: boolean | null = null;
  try {
    enabled = await getBoolSettingStrictResolved("done_for_you_enabled", tenant_id);
  } catch {
    enabled = null;
  }
  let tier: Tier | null = null;
  const facts: ChannelFacts = { hasRecipe: recipeExists };
  try {
    const cfg = await loadTierGateConfig();
    if (!cfg.deferred) {
      facts.agentMin = cfg.agentMin;
      facts.alwaysPro = cfg.alwaysPro;
      tier = await resolveTenantTier(tenant_id, cfg);
    }
  } catch {
    tier = null;
  }
  return { enabled, tier, facts, tierUnreadable: tier === null };
}

const ATTEMPT_COLUMNS = "id, cron_dedupe_key, trigger, enqueued_by, status, enqueued_at, channel_slug, dfy:payload->done_for_you, parsed, output_text";

type RawAttempt = {
  id: string;
  cron_dedupe_key: string | null;
  trigger: string | null;
  enqueued_by: string | null;
  status: string;
  enqueued_at: string | null;
  channel_slug: string | null;
  dfy: unknown;
  parsed: unknown;
  output_text: string | null;
};

export async function readDoneForYouAttempts(tenant_id: string): Promise<DfyAttemptRow[]> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select(ATTEMPT_COLUMNS)
    .eq("tenant_id", tenant_id)
    .in("cron_dedupe_key", doneForYouKeys(tenant_id))
    .limit(10);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as RawAttempt[]).map((r) => ({
    id: r.id,
    cron_dedupe_key: r.cron_dedupe_key,
    trigger: r.trigger,
    enqueued_by: r.enqueued_by,
    status: r.status,
    enqueued_at: r.enqueued_at,
    payload: { done_for_you: r.dfy, channel_slug: r.channel_slug },
    parsed: r.parsed,
    output_text: r.output_text,
  }));
}

export type DoneForYouRead = {
  summary: DfyStateSummary;
  rows: DfyAttemptRow[];
  facts: ChannelFacts;
};

export async function readAndSettleDoneForYou(tenant_id: string, now: number = Date.now()): Promise<DoneForYouRead> {
  const [gates, rows] = await Promise.all([readDoneForYouGates(tenant_id), readDoneForYouAttempts(tenant_id)]);
  const summary = summarizeDoneForYou(tenant_id, rows, gates, now);
  await settleDoneForYou(tenant_id, summary);
  return { summary, rows, facts: gates.facts };
}

export async function settleDoneForYou(tenant_id: string, summary: DfyStateSummary): Promise<void> {
  const tid = asTenantId(tenant_id);
  for (const a of summary.attempts) {
    if (a.outcome === "running" || a.stale) continue;
    try {
      if (a.outcome === "executed" && summary.winner?.run_id === a.run_id && a.action_id) {
        if (!(await markCardDone(tenant_id, a))) continue;
      }
      const { data, error } = await tenantRpc(tid, "claim_done_for_you_settle", {
        p_run_id: a.run_id,
        p_outcome: a.outcome,
      });
      if (error || data !== true) continue;
      const event = a.outcome === "executed" ? "dfy_executed" : a.outcome === "cannot_do" ? "dfy_cannot_do" : "dfy_failed";
      trackDoneForYou(event, {
        tenant_id,
        run_id: a.run_id,
        action_id: a.action_id ?? undefined,
        channel_slug: a.channel_slug,
        mode: a.mode,
        attempt: a.attempt,
        status: a.status,
      });
      void logEvent({
        level: "info",
        source: LOG_SOURCE,
        code: event,
        tenant_id,
        run_id: a.run_id,
        meta: { agent_slug: a.channel_slug ?? undefined, stage: a.mode ?? undefined, count: a.attempt, outcome: a.outcome, final_status: a.status },
      });
    } catch (e) {
      console.warn(`[done-for-you] settle failed for run ${a.run_id}: ${(e as Error).message}`);
    }
  }
}

async function markCardDone(tenant_id: string, a: DfyAttempt): Promise<boolean> {
  const call = (actor: string | null) =>
    tenantRpc(asTenantId(tenant_id), "set_channel_action", {
      p_action_id: a.action_id,
      p_status: "acted",
      p_note: "Done by Zavi",
      p_snoozed_until: null,
      p_event_key: `dfy:${a.run_id}`,
      p_actor_user_id: actor,
    });
  let r = await call(a.by_user_id);
  if (!r.error && a.by_user_id && (r.data as { ok?: boolean; code?: string } | null)?.code === "not_found") {
    r = await call(null);
  }
  if (r.error) return false;
  const out = (r.data ?? {}) as { ok?: boolean; code?: string };
  return out.ok === true || out.code === "illegal_transition" || out.code === "not_found";
}

export async function getDoneForYou(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const tenant_id = auth.tenant_id;
  try {
    const { summary, rows } = await readAndSettleDoneForYou(tenant_id);
    const cur = summary.current;
    let result: { markdown: string; caption: string | null; images: Array<{ id: string }> } | null = null;
    if (summary.state === "done" && summary.winner) {
      const row = rows.find((r) => r.id === summary.winner?.run_id);
      const text = row ? doneForYouResult(row) : null;
      const { data: imgs, error: imgErr } = await tenantClient(asTenantId(tenant_id))
        .from("run_artifacts")
        .select("id, mime")
        .eq("tenant_id", tenant_id)
        .eq("run_id", summary.winner.run_id)
        .like("mime", "image/%")
        .limit(12);
      if (imgErr) throw new Error(imgErr.message);
      const images = ((imgs ?? []) as Array<{ id: string }>).map((i) => ({ id: i.id }));
      result = text || images.length > 0 ? { markdown: text?.markdown ?? "", caption: text?.caption ?? null, images } : null;
    }
    const latest = summary.attempts[summary.attempts.length - 1] ?? null;
    res.json({
      state: summary.state,
      run_id: cur?.run_id ?? null,
      action_id: cur?.action_id ?? null,
      mode: cur?.mode ?? null,
      attempts_used: latest?.attempt ?? 0,
      last_outcome: latest && latest.outcome !== "running" ? latest.outcome : null,
      result,
    });
  } catch (e) {
    console.warn(`[done-for-you] state unreadable for tenant ${tenant_id}: ${(e as Error).message}`);
    fail(res, 503, "dfy_unavailable", "Could not load Zavi's free task.");
  }
}

const StartBody = z.object({
  action_id: z.string().uuid(),
  request_id: z.string().min(8).max(200),
});

export async function postDoneForYou(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    return fail(res, 403, "tenant_override_forbidden", "Not available for an overridden tenant.");
  }
  const parsed = StartBody.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "bad_request", "action_id and request_id are required.");
  const { action_id } = parsed.data;
  const tenant_id = auth.tenant_id;
  const tid = asTenantId(tenant_id);

  const gates = await readDoneForYouGates(tenant_id);
  if (gates.enabled === null) return fail(res, 503, "dfy_unreadable", "Couldn't check this right now. Try again.");
  if (!gates.enabled) return fail(res, 409, "dfy_off", "This isn't available right now.");
  if (gates.tierUnreadable) return fail(res, 503, "tier_unreadable", "Couldn't check your plan. Try again.");
  if (gates.tier !== "free") return fail(res, 409, "not_free", "Your plan already lets Zavi do this on its own.");

  try {
    let now = Date.now();
    let summary = summarizeDoneForYou(tenant_id, await readDoneForYouAttempts(tenant_id), gates, now);
    const stale = summary.attempts.filter((a) => a.stale);
    if (stale.length > 0) {
      const scoped = tenantClient(tid) as unknown as SupabaseClient;
      for (const a of stale) await requestStopForRun(scoped, tenant_id, a.run_id);
      const after = await readDoneForYouAttempts(tenant_id);
      if (after.some((r) => stale.some((a) => a.run_id === r.id) && (r.status === "queued" || r.status === "running"))) {
        return fail(res, 409, "dfy_finishing", "Zavi is stopping the last try. Try again in a minute.");
      }
      now = Date.now();
      summary = summarizeDoneForYou(tenant_id, after, gates, now);
    }
    if (summary.state === "running" && summary.current) {
      res.status(200).json({ ok: true, run_id: summary.current.run_id, attempt: summary.current.attempt, duplicate: true });
      return;
    }
    if (summary.state === "done") return fail(res, 409, "dfy_used", "Zavi already did your free task.");
    if (summary.state === "used_up") return fail(res, 409, "dfy_used_up", "Zavi couldn't finish a free task this time.");
    if (summary.state !== "available" || summary.nextAttempt === null) {
      return fail(res, 409, "dfy_unavailable", "This isn't available right now.");
    }

    const { data: row, error: rowErr } = await tenantClient(tid)
      .from("channel_actions")
      .select("id, channel_slug, status, snoozed_until, body, exec_class, exec_status, card_kind")
      .eq("tenant_id", tenant_id)
      .eq("id", action_id)
      .maybeSingle();
    if (rowErr) throw new Error(rowErr.message);
    if (!row) return fail(res, 404, "not_found", "That card is no longer there.");
    const card = row as DfyActionRow;
    const elig = doneForYouEligibility(card, now, summary.priorCantDo, gates.facts);
    if (!elig.eligible) {
      res.status(409).json({ error: { code: "dfy_not_eligible", reason: elig.reason, message: "Zavi can't do this card on the free plan." } });
      return;
    }
    if (await isChannelLocked(card.channel_slug)) {
      res.status(409).json({ error: { code: "dfy_not_eligible", reason: "channel_not_free_previewable", message: "Zavi can't do this card on the free plan." } });
      return;
    }

    const n = summary.nextAttempt;
    const key = doneForYouKey(tenant_id, n);
    const step = obj(obj(card.body).step);
    const why = typeof step.body === "string" ? step.body : null;
    const title = typeof step.title === "string" && step.title.trim() ? step.title.trim().slice(0, 200) : "This card";
    let result;
    try {
      result = await runChannelRecipe(
        tenant_id,
        card.channel_slug,
        {
          channelContext: defaultChannelContext,
          enqueue: async (input) =>
            enqueueAgentRun({
              agent_slug: input.slug,
              tenant_id: input.tenant_id,
              trigger: "channel_recipe",
              payload: input.payload,
              cron_dedupe_key: key,
              actor_user_id: auth.user_id,
            }),
        },
        { action_key: card.id, action_title: title, note: doneForYouNote(elig.mode, why), kind: "do" },
        { done_for_you: { action_id: card.id, attempt: n, mode: elig.mode, by_user_id: auth.user_id } },
        key,
      );
    } catch (e) {
      const again = await winnerOf(tenant_id, key);
      if (again) {
        res.status(202).json({ ok: true, run_id: again, attempt: n, duplicate: true });
        return;
      }
      throw e;
    }
    if (!result.ok) {
      const again = await winnerOf(tenant_id, key);
      if (again) {
        res.status(202).json({ ok: true, run_id: again, attempt: n, duplicate: true });
        return;
      }
      if (result.reason === "founder_stopped") return fail(res, 409, "founder_stopped", result.message);
      if (result.reason === "coming_soon" || result.reason === "retired" || result.reason === "no_recipe" || result.reason === "unknown_channel") {
        res.status(409).json({ error: { code: "dfy_not_eligible", reason: "channel_not_free_previewable", message: result.message } });
        return;
      }
      return fail(res, 503, result.reason ?? "start_failed", result.message ?? "Couldn't start it. Try again.");
    }
    trackDoneForYou("dfy_approved", {
      tenant_id,
      user_id: auth.user_id,
      action_id: card.id,
      channel_slug: card.channel_slug,
      mode: elig.mode,
      attempt: n,
      run_id: result.run_id ?? undefined,
    });
    void logEvent({
      level: "info",
      source: LOG_SOURCE,
      code: "dfy_approved",
      tenant_id,
      run_id: result.run_id ?? null,
      meta: { agent_slug: card.channel_slug, stage: elig.mode, count: n },
    });
    res.status(202).json({ ok: true, run_id: result.run_id ?? null, attempt: n, ...(result.duplicate ? { duplicate: true } : {}) });
  } catch (e) {
    console.warn(`[done-for-you] start failed for tenant ${tenant_id}: ${(e as Error).message}`);
    fail(res, 500, "start_failed", "Couldn't start it. Try again.");
  }
}

async function winnerOf(tenant_id: string, key: string): Promise<string | null> {
  try {
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("agent_runs")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("cron_dedupe_key", key)
      .maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}
