
import type { CardRef, DraftItem, OutboxRow, PassDeps, PlanJob, ScheduleRow, Unattended } from "./pass";
import { WEEKLY_PLAN_CRON } from "./time";
import type { DraftRun } from "./draft-blocker";

export async function deadlineUnattended(tenantId: string, card: CardRef): Promise<Unattended> {
  try {
    const { liveCardCount } = await import("@/services/email-cards/cards");
    const count = await liveCardCount(tenantId, card.class, card.body);
    const gate = await import("@/services/growth/unattended-email");
    const v =
      card.class === "bulk_outbound.send"
        ? await gate.authorizeUnattendedListSend(tenantId, count)
        : await gate.authorizeUnattendedEmail(tenantId, { action_id: card.id, exec_class: card.class, payload: card.body, audience_count: count }, { where: "deadline" });
    return { allow: v.verdict === "allow", count, reasons: v.reasons };
  } catch {
    return { allow: false, count: null, reasons: ["gate_error"] };
  }
}

export async function startEmailRun(tenantId: string, extra: Record<string, unknown>, requestId: string): Promise<{ ok: boolean; run_id?: string | null; reason?: string }> {
  const { runChannelRecipe } = await import("@/services/channels/engine");
  const { defaultChannelContext } = await import("@/services/channels/context");
  const { enqueueAgentRun } = await import("@/services/agents/runner");
  try {
    const r = await runChannelRecipe(
      tenantId,
      "email_marketing",
      {
        channelContext: defaultChannelContext,
        enqueue: async ({ slug, tenant_id, trigger, payload }) =>
          enqueueAgentRun({ agent_slug: slug, tenant_id, trigger: trigger as "channel_recipe", payload }),
      },
      undefined,
      undefined,
      requestId,
      extra.email_plan as Record<string, unknown>,
    );
    return r.ok ? { ok: true, run_id: r.run_id } : { ok: false, reason: r.reason };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 120) };
  }
}

export async function weeklyBlock(tenantId: string, opts: { connectedToolIsEnough?: boolean } = {}): Promise<WeeklyBlock | "lists_unread" | null> {
  const { readAutopilotState } = await import("@/services/growth/channel-autorun");
  if (!(await readAutopilotState(tenantId)).enabled) return "autopilot_off";
  const { emailSendPaused } = await import("@/services/email-cards/pause");
  if (await emailSendPaused(tenantId)) return "paused";
  const { readTestListKeys, testListKey } = await import("@/services/email-cards/variants");
  const testKeys = await readTestListKeys(tenantId);
  const { listSummaries } = await import("@/services/comms/bulk-outbound/lists");
  const zaviList = (await listSummaries(tenantId)).some((l) => l.active && l.active.sendable > 0 && !l.needs_consent && !testKeys.has(testListKey("zavi_list", l.id)));
  if (zaviList) {
    const { emailRunPreflight } = await import("./preflight");
    if ((await emailRunPreflight(tenantId, { route: "zavi_list" })).verdict === "ok") return null;
  }
  const { resolveEmailTool } = await import("@/services/connectors/email-campaign/account");
  const { EMAIL_TOOLS } = await import("@/services/connectors/email-campaign/providers");
  const { readToolLists, liveToolCaller } = await import("@/services/email-test-lists/lists");
  let unread = false;
  for (const tool of EMAIL_TOOLS) {
    const ok = await resolveEmailTool(tenantId, tool).then(
      () => true,
      () => false,
    );
    if (!ok) continue;
    if (opts.connectedToolIsEnough) return null;
    const real = (lists: { id: string }[]) => lists.some((a) => !testKeys.has(testListKey(tool, a.id)));
    const read = await readToolLists(tenantId, tool, { caller: liveToolCaller }, real).catch(() => null);
    if (read && real(read.lists)) return null;
    if (!read || read.status !== "complete") unread = true;
  }
  if (unread) return "lists_unread";
  return zaviList ? "sender_unavailable" : "no_list";
}

export type WeeklyBlock = "autopilot_off" | "paused" | "no_list" | "sender_unavailable";

export async function weeklyEligible(tenantId: string): Promise<boolean | "retry"> {
  const { tenantIsIdle } = await import("@/services/growth/tenant-idle");
  if (await tenantIsIdle(tenantId)) return false;
  const block = await weeklyBlock(tenantId);
  return block === "lists_unread" ? "retry" : block === null;
}

export async function livePlanPassDeps(): Promise<PassDeps> {
  const { staffCrossTenantClient, tenantRpc, tenantClient, asTenantId } = await import("@/services/tenant-client");
  const { logEvent } = await import("@/services/logging/logEvent");
  const { inngest } = await import("@/../workers/client");
  const { nextLocalCronFire } = await import("@/../workers/functions/cron-match");
  const { resolveReportingTimezone } = await import("@/services/analytics/tenant-timezone");
  const cross = () => staffCrossTenantClient("email plan worker: claims due plan jobs and planning runs across tenants");
  const crossRpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await cross().rpc(name, args);
    if (error) throw new Error(`${name} failed`);
    return data as T;
  };
  const rpc = async <T>(tenantId: string, name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
    if (error) throw new Error(`${name} failed`);
    return data as T;
  };
  return {
    now: () => new Date(),
    repair: async (limit) => Number(await crossRpc<number>("repair_email_plan_jobs", { p_limit: limit })),
    alertStuckHolds: async (limit) => Number(await crossRpc<number>("alert_stuck_email_holds", { p_limit: limit })),
    outboxPending: async (limit) => (await crossRpc<OutboxRow[] | null>("email_plan_outbox_pending", { p_limit: limit })) ?? [],
    claimJobs: async (limit, leaseSeconds) => (await crossRpc<PlanJob[] | null>("claim_email_plan_jobs", { p_limit: limit, p_lease_seconds: leaseSeconds })) ?? [],
    completeJob: async (job, outcome, error, retrySeconds) =>
      Number(
        await rpc<number>(job.tenant_id, "complete_email_plan_job", {
          p_id: job.id,
          p_token: job.lease_token,
          p_outcome: outcome,
          p_error: error,
          p_retry_seconds: retrySeconds ?? null,
        }),
      ),
    rpc,
    send: async (e) => {
      if (e.name === "channel-action.approved") {
        await inngest.send({ id: e.id, name: "channel-action.approved", data: { action_id: String(e.data.action_id) } });
      } else if (e.name === "decision.approved") {
        await inngest.send({
          id: e.id,
          name: "decision.approved",
          data: { decision_id: String(e.data.decision_id), tenant_id: String(e.data.tenant_id), decision_class: String(e.data.decision_class) },
        });
      } else {
        throw new Error(`unknown plan event ${e.name}`);
      }
    },
    unattended: deadlineUnattended,
    startRun: startEmailRun,
    lastDraftRun: async (tenantId, itemId, version) => {
      const { data, error } = await tenantClient(asTenantId(tenantId))
        .from("agent_runs")
        .select("status, payload, tool_calls, finished_at, enqueued_at")
        .eq("channel_slug", "email_marketing")
        .eq("payload->email_plan->>item_id", itemId)
        .eq("payload->email_plan->>version", String(version))
        .order("enqueued_at", { ascending: false })
        .limit(1);
      if (error) throw new Error("last planned draft run unreadable");
      return ((data ?? []) as DraftRun[])[0] ?? null;
    },
    draftItem: async (tenantId, itemId) => {
      const { data, error } = await tenantClient(asTenantId(tenantId))
        .from("email_planned_sends")
        .select("route, list_id, status, card_id")
        .eq("id", itemId)
        .maybeSingle();
      if (error) throw new Error("planned send unreadable");
      return (data as DraftItem | null) ?? null;
    },
    preflight: async (tenantId, plan) => (await import("./preflight")).emailRunPreflight(tenantId, plan),
    schedulesMissing: async (limit) => ((await crossRpc<string[] | null>("email_plan_schedule_missing", { p_limit: limit })) ?? []).map(String),
    claimSchedules: async (limit) => (await crossRpc<ScheduleRow[] | null>("claim_email_plan_schedules", { p_limit: limit })) ?? [],
    claimZoneChecks: async (limit) => (await crossRpc<ScheduleRow[] | null>("claim_email_plan_zone_checks", { p_limit: limit })) ?? [],
    zoneOf: async (tenantId) => {
      const resolved = await resolveReportingTimezone(tenantId);
      if (resolved.source !== "default") return resolved.tz;
      const { liveTenantZone } = await import("./plan");
      return liveTenantZone(tenantId);
    },
    nextFire: (tz, from) => nextLocalCronFire(WEEKLY_PLAN_CRON, tz, from, 8),
    weeklyEligible,
    log: (code, message, tenantId, level) => {
      void logEvent({ level: level ?? "info", source: "email-plan", code, message, ...(tenantId ? { tenant_id: tenantId } : {}) }).catch(() => undefined);
    },
  };
}
