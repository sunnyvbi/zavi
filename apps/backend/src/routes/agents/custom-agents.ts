
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { tenantClient } from "@/services/tenant-client";
import { listGlobalAgentSlugs } from "@/services/agents/registry";
import { refusalFor } from "@/services/agents/refusal";
import { isPlanUpgradeError } from "@/services/billing/tiers";
import {
  enqueueAgentRun,
  AgentNotFoundError,
  FleetHaltedError,
  InsufficientCreditsError,
  SafetyGateError,
  BudgetExceededError,
} from "@/services/agents/runner";
import { asPlanUpgradeRequired, tierRank } from "@/services/billing/tiers";
import { tenantPlanForDisplay } from "@/services/agents/entitlement";
import { pauserNames, UNKNOWN_PAUSER } from "@/services/agents/custom-agent-pausers";
import { parseScheduleWords, SCHEDULE_REFUSAL_MESSAGES } from "@/services/agents/schedule-words";
import { isUsageLimitError } from "@/services/agents/infra-retry";
import { scheduleLabel } from "@/services/agents/custom-agent-schedule-label";
import { nextLocalCronFire, validateCronExpression } from "../../../workers/functions/cron-match";
import {
  CUSTOM_AGENT_COLUMNS,
  CUSTOM_AGENT_INSTRUCTIONS_MAX,
  CUSTOM_AGENT_NAME_MAX,
  CUSTOM_AGENT_ROLE_MAX,
  CUSTOM_AGENT_TOOLS_MAX,
  CUSTOM_AGENT_TRIGGERS_MAX,
  customAgentNameNorm,
  customAgentReservedNames,
  customDeliverSchema,
  customTestDedupeKey,
  customTriggerSchema,
  deliverBelongsToTenant,
  DestinationCheckUnavailable,
  DestinationNotConfigured,
  instructionsRejection,
  isReservedCustomAgentName,
  resolveCustomTriggers,
  resolveTenantTz,
  watchRefusal,
  type CustomAgentRow,
} from "@/services/agents/custom-agents";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRIGGER_COLUMNS = "id, agent_id, kind, cron, tz, interval_minutes, condition, enabled, next_due_at, last_fired_at";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(CUSTOM_AGENT_NAME_MAX),
  role: z.string().max(CUSTOM_AGENT_ROLE_MAX).optional(),
  instructions: z.string().trim().min(1).max(CUSTOM_AGENT_INSTRUCTIONS_MAX),
  tools: z.array(z.string().min(1).max(120)).max(CUSTOM_AGENT_TOOLS_MAX).optional(),
  triggers: z.array(customTriggerSchema).max(CUSTOM_AGENT_TRIGGERS_MAX).optional(),
  deliver: customDeliverSchema.nullable().optional(),
  status: z.enum(["draft", "active"]).optional(),
  origin_run_id: z.string().regex(UUID_RE).optional(),
});

const PatchBody = z.object({
  name: z.string().trim().min(1).max(CUSTOM_AGENT_NAME_MAX).optional(),
  role: z.string().max(CUSTOM_AGENT_ROLE_MAX).optional(),
  instructions: z.string().trim().min(1).max(CUSTOM_AGENT_INSTRUCTIONS_MAX).optional(),
  tools: z.array(z.string().min(1).max(120)).max(CUSTOM_AGENT_TOOLS_MAX).optional(),
  triggers: z.array(customTriggerSchema).max(CUSTOM_AGENT_TRIGGERS_MAX).optional(),
  deliver: customDeliverSchema.nullable().optional(),
  schedule_cron: z.string().trim().min(1).max(100).optional(),
});

const StatusBody = z.object({ status: z.enum(["active", "paused", "archived"]) });

type TriggerRow = {
  id: string;
  agent_id: string;
  kind: "schedule" | "watch";
  cron: string | null;
  tz: string | null;
  interval_minutes: number | null;
  condition: string | null;
  enabled: boolean;
  next_due_at: string | null;
  last_fired_at: string | null;
};

async function pauseView(auth: { user_id: string; tenant_id: string }, rows: CustomAgentRow[]): Promise<PauseView> {
  const others = rows
    .filter((r) => r.status === "paused" && r.paused_by && r.paused_by !== auth.user_id)
    .map((r) => r.paused_by);
  const names = others.length > 0 ? await pauserNames(auth.tenant_id, others).catch(() => new Map<string, string>()) : new Map<string, string>();
  return { viewer_user_id: auth.user_id, names };
}

export type PauseView = { viewer_user_id?: string | null; names?: Map<string, string> };

export function shapeCustomAgent(row: CustomAgentRow, triggers: TriggerRow[] = [], view: PauseView = {}) {
  const pausedBy = row.status === "paused" ? (row.paused_by ?? null) : null;
  const pausedBySelf = !!pausedBy && !!view.viewer_user_id && pausedBy === view.viewer_user_id;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    tools: Array.isArray(row.tools) ? row.tools : [],
    deliver: row.default_deliver ?? null,
    status: row.status,
    paused_reason: pausedBy ? null : row.paused_reason,
    paused_at: row.status === "paused" ? (row.paused_at ?? null) : null,
    paused_by_self: pausedBySelf,
    paused_by_name: pausedBy && !pausedBySelf ? (view.names?.get(pausedBy) ?? UNKNOWN_PAUSER) : null,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    triggers: triggers
      .filter((t) => t.agent_id === row.id)
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        cron: t.cron,
        tz: t.tz,
        interval_minutes: t.interval_minutes,
        condition: t.condition,
        enabled: t.enabled,
        next_due_at: t.next_due_at,
        last_fired_at: t.last_fired_at,
      })),
  };
}

function issuesMessage(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((i) => (i.message.startsWith("Unknown timezone") ? i.message : `${i.path.map(String).join(".")}: ${i.message}`))
    .join("; ");
}

function bad(res: Response, message: string): void {
  res.status(400).json({ error: { code: "validation", message } });
}

function sendWatchRefusal(res: Response, message: string): void {
  res.status(400).json({ error: { code: "watch_unobservable", message } });
}

function unavailable(res: Response, why: "unavailable" | "not_configured"): void {
  res.status(503).json({
    error:
      why === "not_configured"
        ? { code: "destination_not_configured", message: "Zavi can't post to Discord right now. Pick another place to send results." }
        : { code: "destination_check_unavailable", message: "We couldn't check that channel just now. Try again in a minute." },
  });
}

async function deliverCheck(
  tenant_id: string,
  deliver: Parameters<typeof deliverBelongsToTenant>[1],
): Promise<boolean | "unavailable" | "not_configured"> {
  try {
    return await deliverBelongsToTenant(tenant_id, deliver);
  } catch (e) {
    if (e instanceof DestinationCheckUnavailable) return "unavailable";
    if (e instanceof DestinationNotConfigured) return "not_configured";
    throw e;
  }
}

function sendRpcError(res: Response, error: { message?: string | null; code?: string | null }): void {
  const msg = error.message ?? "";
  if (isPlanUpgradeError(error)) {
    res.status(403).json({ error: { ...refusalFor({ kind: "custom_agents_plan" }), required_tier: "starter" } });
    return;
  }
  if (msg.includes("custom_agent_already_created") || msg.includes("custom_agents_tenant_origin_run")) {
    res.status(409).json({
      error: { code: "already_created", message: "This agent was already created." },
    });
    return;
  }
  if (msg.includes("custom_agent_origin_invalid")) {
    res.status(400).json({ error: { code: "validation", message: "That draft isn't in this workspace." } });
    return;
  }
  if (msg.includes("custom_agent_name_invalid")) {
    res.status(400).json({
      error: { code: "name_invalid", message: "Give the agent a name with at least one letter or number." },
    });
    return;
  }
  if (msg.includes("custom_agent_name_reserved")) {
    res.status(409).json({
      error: { code: "name_reserved", message: "That name belongs to a built-in agent. Pick another name." },
    });
    return;
  }
  if (msg.includes("custom_agent_name_taken") || msg.includes("custom_agents_tenant_name_live")) {
    res.status(409).json({
      error: { code: "name_taken", message: "You already have an agent with that name. Pick another name." },
    });
    return;
  }
  if (msg.includes("custom_agent_not_found")) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }
  if (error.code === "42501" || msg.includes("not a member")) {
    res.status(403).json({ error: { code: "forbidden", message: "You are not a member of this workspace." } });
    return;
  }
  res.status(500).json({ error: { code: "internal", message: msg || "custom agent write failed" } });
}

async function loadRow(tenant_id: Parameters<typeof tenantClient>[0], id: string): Promise<CustomAgentRow | null> {
  const { data, error } = await tenantClient(tenant_id)
    .from("custom_agents")
    .select(CUSTOM_AGENT_COLUMNS)
    .eq("id", id)
    .neq("status", "archived")
    .maybeSingle<CustomAgentRow>();
  if (error) throw new Error(`custom_agents read failed: ${error.message}`);
  return data ?? null;
}

async function loadTriggers(tenant_id: Parameters<typeof tenantClient>[0], agentIds: string[]): Promise<TriggerRow[]> {
  if (agentIds.length === 0) return [];
  const { data, error } = await tenantClient(tenant_id)
    .from("custom_agent_triggers")
    .select(TRIGGER_COLUMNS)
    .in("agent_id", agentIds);
  if (error) throw new Error(`custom_agent_triggers read failed: ${error.message}`);
  return (data ?? []) as TriggerRow[];
}

export async function customAgentsCreate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = CreateBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, issuesMessage(parsed.error.issues));
  const body = parsed.data;

  if (!customAgentNameNorm(body.name)) return sendRpcError(res, { message: "custom_agent_name_invalid" });
  const reserved = customAgentReservedNames(listGlobalAgentSlugs());
  if (isReservedCustomAgentName(body.name, reserved)) {
    return sendRpcError(res, { message: "custom_agent_name_reserved" });
  }
  const secret = instructionsRejection(body.instructions);
  if (secret) return bad(res, secret);
  const deliver = body.deliver ?? null;
  const owns = await deliverCheck(auth.tenant_id, deliver);
  if (owns === "unavailable" || owns === "not_configured") return unavailable(res, owns);
  if (!owns) return bad(res, "That conversation isn't in this workspace.");
  const tz = await resolveTenantTz(auth.tenant_id);
  const triggers = resolveCustomTriggers(body.triggers ?? [], tz);
  if (!triggers.ok) return bad(res, `triggers: ${triggers.error}`);
  const unobservable = await watchRefusal(auth.tenant_id, body.triggers ?? [], {
    instructions: body.instructions,
    tools: body.tools ?? [],
  });
  if (unobservable) return sendWatchRefusal(res, unobservable);

  const { data, error } = await serverClientFromBearer(auth.access_token).rpc("create_custom_agent", {
    p_tenant_id: auth.tenant_id,
    p_name: body.name,
    p_role: body.role ?? "",
    p_instructions: body.instructions,
    p_tools: body.tools ?? [],
    p_default_deliver: deliver,
    p_status: body.status ?? "active",
    p_triggers: triggers.triggers,
    p_reserved_names: reserved,
    p_origin_run_id: body.origin_run_id ?? null,
  });
  if (error) return sendRpcError(res, error);
  const row = data as CustomAgentRow;
  res.status(201).json({ agent: shapeCustomAgent(row, await loadTriggers(auth.tenant_id, [row.id])) });
}

export async function customAgentsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const origin = typeof req.query?.origin_run_id === "string" ? req.query.origin_run_id : null;
  if (origin !== null && !UUID_RE.test(origin)) return bad(res, "origin_run_id must be a uuid");
  const archived = !origin && req.query?.status === "archived";
  try {
    const base = tenantClient(auth.tenant_id).from("custom_agents").select(CUSTOM_AGENT_COLUMNS);
    const { data, error } = await (origin
      ? base.eq("origin_run_id", origin)
      : archived
        ? base.eq("status", "archived")
        : base.in("status", ["active", "paused"])
    ).order("created_at", { ascending: false });
    if (error) throw new Error(`custom_agents read failed: ${error.message}`);
    const rows = (data ?? []) as CustomAgentRow[];
    const triggers = await loadTriggers(auth.tenant_id, rows.map((r) => r.id));
    if (origin || archived) {
      const view = await pauseView(auth, rows);
      res.json({ agents: rows.map((r) => shapeCustomAgent(r, triggers, view)) });
      return;
    }
    const [lastRuns, plan, view] = await Promise.all([
      loadLastRuns(auth.tenant_id, rows.map((r) => r.slug)),
      tenantPlanForDisplay(auth.tenant_id),
      pauseView(auth, rows),
    ]);
    res.json({
      agents: rows.map((r) => ({ ...shapeCustomAgent(r, triggers, view), last_run: lastRuns.get(r.slug) ?? null })),
      refusal:
        plan !== null && tierRank(plan) < tierRank("starter")
          ? { ...refusalFor({ kind: "custom_agents_plan" }), required_tier: "starter" }
          : null,
    });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function customAgentsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id ?? "")) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }
  try {
    const row = await loadRow(auth.tenant_id, id);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
      return;
    }
    res.json({ agent: shapeCustomAgent(row, await loadTriggers(auth.tenant_id, [row.id]), await pauseView(auth, [row])) });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function customAgentsPatch(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id ?? "")) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }
  const parsed = PatchBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, issuesMessage(parsed.error.issues));
  const body = parsed.data;

  if (body.name !== undefined && !customAgentNameNorm(body.name)) {
    return sendRpcError(res, { message: "custom_agent_name_invalid" });
  }
  const reserved = customAgentReservedNames(listGlobalAgentSlugs());
  if (body.name !== undefined && isReservedCustomAgentName(body.name, reserved)) {
    return sendRpcError(res, { message: "custom_agent_name_reserved" });
  }
  if (body.instructions !== undefined) {
    const secret = instructionsRejection(body.instructions);
    if (secret) return bad(res, secret);
  }
  if (body.deliver !== undefined) {
    const owns = await deliverCheck(auth.tenant_id, body.deliver);
    if (owns === "unavailable" || owns === "not_configured") return unavailable(res, owns);
    if (!owns) return bad(res, "That conversation isn't in this workspace.");
  }
  if (body.schedule_cron !== undefined) {
    if (body.triggers !== undefined) return bad(res, "Send a schedule or triggers, not both.");
    const invalid = validateCronExpression(body.schedule_cron);
    if (invalid) return bad(res, `schedule_cron: ${invalid}`);
    if (!(await loadRow(auth.tenant_id, id))) {
      res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
      return;
    }
    if (!(await hasScheduleTrigger(auth.tenant_id, id))) return bad(res, "This agent doesn't run on a schedule.");
    if (!nextLocalCronFire(body.schedule_cron, await resolveTenantTz(auth.tenant_id), nextMinute(new Date()))) {
      return bad(res, NEVER_FIRES_MESSAGE);
    }
  }
  let storedTriggers: unknown = null;
  if (body.triggers !== undefined) {
    const resolved = resolveCustomTriggers(body.triggers, await resolveTenantTz(auth.tenant_id));
    if (!resolved.ok) return bad(res, `triggers: ${resolved.error}`);
    storedTriggers = resolved.triggers;
    if (body.triggers.some((t) => t.kind === "watch")) {
      const current = body.instructions === undefined || body.tools === undefined
        ? await loadRow(auth.tenant_id, id).catch(() => null)
        : null;
      const unobservable = await watchRefusal(auth.tenant_id, body.triggers, {
        instructions: body.instructions ?? current?.instructions ?? "",
        tools: body.tools ?? (Array.isArray(current?.tools) ? (current?.tools as string[]) : []),
      });
      if (unobservable) return sendWatchRefusal(res, unobservable);
    }
  }

  const { data, error } = await serverClientFromBearer(auth.access_token).rpc("update_custom_agent", {
    p_tenant_id: auth.tenant_id,
    p_agent_id: id,
    p_name: body.name ?? null,
    p_role: body.role ?? null,
    p_instructions: body.instructions ?? null,
    p_tools: body.tools ?? null,
    p_default_deliver: body.deliver ?? null,
    p_triggers: storedTriggers,
    p_reserved_names: reserved,
    p_clear_deliver: body.deliver === null,
  });
  if (error) return sendRpcError(res, error);
  const row = data as CustomAgentRow;
  if (body.schedule_cron !== undefined) {
    let replaced: Awaited<ReturnType<typeof replaceScheduleTrigger>>;
    try {
      replaced = await replaceScheduleTrigger(auth.tenant_id, row.id, body.schedule_cron);
    } catch {
      res.status(500).json({ error: { code: "internal", message: "Couldn't save the schedule. Try again." } });
      return;
    }
    if (replaced === "no_schedule") return bad(res, "This agent doesn't run on a schedule.");
    if (replaced === "never_fires") return bad(res, NEVER_FIRES_MESSAGE);
  }
  res.json({ agent: shapeCustomAgent(row, await loadTriggers(auth.tenant_id, [row.id]), await pauseView(auth, [row])) });
}

const nextMinute = (now: Date): Date => new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);

const NEVER_FIRES_MESSAGE = "That schedule never comes round. Try something like 'weekdays at 10am'.";

async function hasScheduleTrigger(tenant_id: Parameters<typeof tenantClient>[0], agent_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(tenant_id)
    .from("custom_agent_triggers")
    .select("id")
    .eq("agent_id", agent_id)
    .eq("kind", "schedule")
    .limit(1);
  if (error) throw new Error(`custom_agent_triggers read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

async function replaceScheduleTrigger(
  tenant_id: Parameters<typeof tenantClient>[0],
  agent_id: string,
  cron: string,
  now: Date = new Date(),
): Promise<"ok" | "no_schedule" | "never_fires"> {
  const db = tenantClient(tenant_id);
  const { data, error } = await db
    .from("custom_agent_triggers")
    .select("id, created_at")
    .eq("agent_id", agent_id)
    .eq("kind", "schedule")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`custom_agent_triggers read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length === 0) return "no_schedule";
  const tz = await resolveTenantTz(tenant_id);
  const next = nextLocalCronFire(cron, tz, nextMinute(now));
  if (!next) return "never_fires";
  const extra = rows.slice(1).map((r) => r.id);
  if (extra.length > 0) {
    const { error: delErr } = await db.from("custom_agent_triggers").delete().in("id", extra).eq("agent_id", agent_id);
    if (delErr) throw new Error(`schedule trigger cleanup failed: ${delErr.message}`);
  }
  const { error: upErr } = await db
    .from("custom_agent_triggers")
    .update({ cron, tz, next_due_at: next.toISOString(), updated_at: now.toISOString() })
    .eq("id", rows[0].id)
    .eq("agent_id", agent_id);
  if (upErr) throw new Error(`schedule trigger write failed: ${upErr.message}`);
  return "ok";
}

const PreviewBody = z.object({ text: z.string().max(200) });
export const SCHEDULE_TRY_AGAIN = "Try something like 'weekdays at 10am' or 'every Monday at 9am'.";

export async function customAgentsSchedulePreview(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = PreviewBody.safeParse(req.body ?? {});
  const words = parsed.success ? parseScheduleWords(parsed.data.text) : { ok: false as const };
  if (!words.ok) {
    res.json({ ok: false, message: words.reason ? SCHEDULE_REFUSAL_MESSAGES[words.reason] : SCHEDULE_TRY_AGAIN });
    return;
  }
  const tz = await resolveTenantTz(auth.tenant_id);
  const next: string[] = [];
  let from = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 3; i++) {
    const fire = nextLocalCronFire(words.cron, tz, from);
    if (!fire) break;
    next.push(fire.toISOString());
    from = new Date(fire.getTime() + 60_000);
  }
  res.json({ ok: true, cron: words.cron, tz, label: scheduleLabel(words.cron, tz), next });
}

export async function customAgentsSetStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id ?? "")) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }
  const parsed = StatusBody.safeParse(req.body ?? {});
  if (!parsed.success) return bad(res, "status must be active, paused or archived");
  const { data, error } = await serverClientFromBearer(auth.access_token).rpc("set_custom_agent_status", {
    p_tenant_id: auth.tenant_id,
    p_agent_id: id,
    p_status: parsed.data.status,
  });
  if (error) return sendRpcError(res, error);
  const row = data as CustomAgentRow;
  res.json({ agent: shapeCustomAgent(row, await loadTriggers(auth.tenant_id, [row.id]), await pauseView(auth, [row])) });
}

export async function customAgentsUnarchive(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id ?? "")) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }
  const { data, error } = await serverClientFromBearer(auth.access_token).rpc("unarchive_custom_agent", {
    p_tenant_id: auth.tenant_id,
    p_agent_id: id,
    p_reserved_names: customAgentReservedNames(listGlobalAgentSlugs()),
  });
  if (error) {
    if (String(error.message ?? "").includes("custom_agent_name_reserved")) {
      res.status(409).json({
        error: { code: "name_reserved", message: "That name now belongs to a built-in agent, so this agent can't come back." },
      });
      return;
    }
    if (String(error.message ?? "").includes("custom_agent_name_taken")) {
      const { data: archived } = await tenantClient(auth.tenant_id)
        .from("custom_agents")
        .select("name")
        .eq("id", id)
        .maybeSingle<{ name: string }>();
      const name = archived?.name ?? "this agent";
      res.status(409).json({
        error: { code: "name_taken", message: `Another agent is already called ${name}. Rename that one first.` },
      });
      return;
    }
    return sendRpcError(res, error);
  }
  const row = data as CustomAgentRow;
  res.json({ agent: shapeCustomAgent(row, await loadTriggers(auth.tenant_id, [row.id])) });
}

async function inFlightTestRun(tenant_id: Parameters<typeof tenantClient>[0], slug: string): Promise<string | null> {
  const { data, error } = await tenantClient(tenant_id)
    .from("agent_runs")
    .select("id")
    .eq("agent_slug", slug)
    .in("status", ["queued", "running"])
    .eq("payload->>custom_agent_test", "true")
    .order("enqueued_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`agent_runs read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

export async function customAgentsTest(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id ?? "")) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }
  let row: CustomAgentRow | null;
  try {
    row = await loadRow(auth.tenant_id, id);
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
    return;
  }
  if (!row || (row.status !== "draft" && row.status !== "active")) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }

  let inFlight: string | null;
  try {
    inFlight = await inFlightTestRun(auth.tenant_id, row.slug);
  } catch {
    res.status(503).json({ error: { code: "unavailable", message: "Couldn't check for a test already running. Try again." } });
    return;
  }
  if (inFlight) {
    res.status(202).json({ run_id: inFlight, slug: row.slug, already_running: true });
    return;
  }

  const { data: token, error: tokErr } = await serverClientFromBearer(auth.access_token).rpc(
    "set_custom_agent_test_token",
    { p_tenant_id: auth.tenant_id, p_agent_id: row.id },
  );
  if (tokErr) return sendRpcError(res, tokErr);

  try {
    const { run_id } = await enqueueAgentRun({
      agent_slug: row.slug,
      tenant_id: auth.tenant_id,
      trigger: "manual",
      payload: {
        task_description: "Test run: do your job once now, exactly as your instructions say, and report the result.",
        custom_agent_test: true,
      },
      cron_dedupe_key: customTestDedupeKey(String(token)),
      user_access_token: auth.access_token,
    });
    res.status(202).json({ run_id, slug: row.slug });
  } catch (e) {
    const plan = asPlanUpgradeRequired(e);
    if (plan) {
      res.status(403).json({ error: { ...refusalFor({ kind: "custom_agents_plan" }), required_tier: "starter" } });
      return;
    }
    if (e instanceof InsufficientCreditsError) {
      res.status(402).json({ error: refusalFor({ kind: "credits" }) });
      return;
    }
    if (e instanceof BudgetExceededError) {
      res.status(429).json({ error: refusalFor({ kind: "budget_exceeded" }) });
      return;
    }
    if (e instanceof AgentNotFoundError) {
      res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
      return;
    }
    if (e instanceof FleetHaltedError) {
      res.status(503).json({ error: { code: "fleet_halted", message: e.message } });
      return;
    }
    if (e instanceof SafetyGateError) {
      res.status(403).json({ error: { code: "safety_gate", message: e.message } });
      return;
    }
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

const RECEIPT_COLUMNS = "id, run_id, tool_name, decision_class, outcome, error, created_at";
const RECEIPTS_LIMIT_DEFAULT = 100;
const RECEIPTS_LIMIT_MAX = 200;

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function parseReceiptCursor(raw: unknown): { created_at: string; id: string } | null | "invalid" {
  if (raw === undefined) return null;
  if (typeof raw !== "string") return "invalid";
  const i = raw.lastIndexOf(",");
  if (i < 0) return "invalid";
  const created_at = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!UUID_RE.test(id) || !ISO_TS_RE.test(created_at) || Number.isNaN(Date.parse(created_at))) return "invalid";
  return { created_at, id };
}

export async function customAgentsReceipts(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  const runId = typeof req.query.run_id === "string" ? req.query.run_id : undefined;
  if (!UUID_RE.test(id ?? "") || (runId !== undefined && !UUID_RE.test(runId))) {
    res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
    return;
  }
  const cursor = parseReceiptCursor(req.query.before);
  const limitRaw = req.query.limit === undefined ? RECEIPTS_LIMIT_DEFAULT : Number(req.query.limit);
  if (cursor === "invalid" || !Number.isInteger(limitRaw) || limitRaw < 1) {
    res.status(400).json({ error: { code: "validation", message: "Invalid page cursor or limit." } });
    return;
  }
  const limit = Math.min(limitRaw, RECEIPTS_LIMIT_MAX);
  try {
    const { data: agent, error: agentErr } = await tenantClient(auth.tenant_id)
      .from("custom_agents")
      .select("id")
      .eq("id", id)
      .maybeSingle<{ id: string }>();
    if (agentErr) throw new Error(`custom_agents read failed: ${agentErr.message}`);
    if (!agent) {
      res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
      return;
    }
    let q = tenantClient(auth.tenant_id)
      .from("custom_agent_write_receipts")
      .select(RECEIPT_COLUMNS)
      .eq("agent_id", agent.id);
    if (runId) q = q.eq("run_id", runId);
    if (cursor) {
      q = q.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
    }
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (error) throw new Error(`custom_agent_write_receipts read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; created_at: string }>;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    res.json({
      receipts: page,
      next_cursor: rows.length > limit && last ? `${last.created_at},${last.id}` : null,
    });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

const RUN_COLUMNS = "id, status, trigger, enqueued_at, started_at, finished_at, output_text, error, custom_agent_test:payload->custom_agent_test";
const RUNS_LIMIT = 30;
const SUMMARY_MAX = 200;

type RunRow = {
  id: string;
  status: string;
  trigger: string | null;
  enqueued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  output_text: string | null;
  error?: string | null;
  custom_agent_test?: unknown;
};

export function runSummary(output: string | null): string | null {
  for (const raw of (output ?? "").split("\n")) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (line) return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : line;
  }
  return null;
}

export function runRowSummary(output: string | null): string | null {
  for (const raw of (output ?? "").split("\n")) {
    if (/^\s*#{1,6}\s/.test(raw)) continue;
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) continue;
    const label = raw.match(/^\s*(?:\*\*|__)([^*_]+)(?:\*\*|__)\s*(:?)\s*$/);
    if (label) {
      const text = label[1].trim();
      if (label[2] === ":" || text.endsWith(":") || (text.length <= 40 && !/[.!?]$/.test(text))) continue;
    }
    const line = raw
      .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (!line) continue;
    const sentence = line.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? line;
    return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : sentence;
  }
  return null;
}

const FAILED_RUN_STATUSES = new Set(["failed", "error", "dispatch_error", "parse_failed", "cancelled"]);

export function runFailure(status: string, error: string | null | undefined): string | null {
  if (!FAILED_RUN_STATUSES.has(status)) return null;
  if (error && /is not active/.test(error)) return "Stopped: the agent was paused before it ran.";
  if (error && /not found in src\/agents/.test(error)) return "Stopped: the agent was archived or couldn't be loaded.";
  if (isUsageLimitError(error ?? null)) return "Stopped: the AI service hit a usage limit. It clears on its own shortly.";
  return "The run stopped before it finished.";
}

function shapeRun(r: RunRow) {
  return {
    id: r.id,
    status: r.status,
    test: r.custom_agent_test === true,
    enqueued_at: r.enqueued_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    summary: runRowSummary(r.output_text),
    failure: runFailure(r.status, r.error),
  };
}

async function loadLastRuns(
  tenant_id: Parameters<typeof tenantClient>[0],
  slugs: string[],
): Promise<Map<string, ReturnType<typeof shapeRun>>> {
  const out = new Map<string, ReturnType<typeof shapeRun>>();
  await Promise.all(
    slugs.map(async (slug) => {
      const { data, error } = await tenantClient(tenant_id)
        .from("agent_runs")
        .select(RUN_COLUMNS)
        .eq("agent_slug", slug)
        .order("enqueued_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`agent_runs read failed: ${error.message}`);
      const row = (data ?? [])[0] as RunRow | undefined;
      if (row) out.set(slug, shapeRun(row));
    }),
  );
  return out;
}

async function loadAnyRow(
  tenant_id: Parameters<typeof tenantClient>[0],
  id: string,
): Promise<{ id: string; slug: string } | null> {
  const { data, error } = await tenantClient(tenant_id)
    .from("custom_agents")
    .select("id, slug")
    .eq("id", id)
    .maybeSingle<{ id: string; slug: string }>();
  if (error) throw new Error(`custom_agents read failed: ${error.message}`);
  return data ?? null;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "Agent not found." } });
}

export async function customAgentsRuns(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id ?? "")) return notFound(res);
  try {
    const agent = await loadAnyRow(auth.tenant_id, id);
    if (!agent) return notFound(res);
    const { data, error } = await tenantClient(auth.tenant_id)
      .from("agent_runs")
      .select(RUN_COLUMNS)
      .eq("agent_slug", agent.slug)
      .order("enqueued_at", { ascending: false })
      .limit(RUNS_LIMIT);
    if (error) throw new Error(`agent_runs read failed: ${error.message}`);
    res.json({ runs: ((data ?? []) as RunRow[]).map(shapeRun) });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

const NOTES_LIMIT = 50;
const NOTE_TEXT_MAX = 400;

export async function customAgentsNotes(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id ?? "")) return notFound(res);
  try {
    const agent = await loadAnyRow(auth.tenant_id, id);
    if (!agent) return notFound(res);
    const { data, error } = await tenantClient(auth.tenant_id)
      .from("memory_note")
      .select("id, title, body_markdown, run_id, created_at")
      .eq("custom_agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(NOTES_LIMIT);
    if (error) throw new Error(`memory_note read failed: ${error.message}`);
    const notes = ((data ?? []) as Array<{
      id: string;
      title: string | null;
      body_markdown: string | null;
      run_id: string | null;
      created_at: string;
    }>).map((n) => {
      const text = (n.title?.trim() || runSummary(n.body_markdown) || "").slice(0, NOTE_TEXT_MAX);
      return { id: n.id, text, run_id: n.run_id, created_at: n.created_at };
    });
    res.json({ notes });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}

export async function customAgentsNoteDelete(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  const noteId = req.params.noteId;
  const noteNotFound = () => res.status(404).json({ error: { code: "not_found", message: "Note not found." } });
  if (!UUID_RE.test(id ?? "") || !UUID_RE.test(noteId ?? "")) {
    noteNotFound();
    return;
  }
  const { data, error } = await serverClientFromBearer(auth.access_token).rpc("delete_custom_agent_note", {
    p_tenant_id: auth.tenant_id,
    p_agent_id: id,
    p_note_id: noteId,
  });
  if (error) {
    if (error.code === "23503") {
      res.status(409).json({ error: { code: "in_use", message: "This note is in use, so it can't be deleted." } });
      return;
    }
    return sendRpcError(res, error);
  }
  if (data !== true) {
    noteNotFound();
    return;
  }
  res.json({ deleted: true });
}
