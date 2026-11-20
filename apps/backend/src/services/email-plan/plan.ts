
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import type { EmailTool } from "@/services/connectors/email-campaign/providers";
import { isKnownZone, wallLabel, wallToInstant } from "./time";

export const PLAN_ROUTES = ["sendgrid", "mailchimp", "klaviyo", "zavi_list"] as const;
export type PlanRoute = (typeof PLAN_ROUTES)[number];

export type PlanInput = {
  route: PlanRoute;
  list_id: string;
  date: string;
  time: string;
  angle: string;
  why: string | null;
  source: "email_agent" | "growth_agent" | "founder";
  actor: string | null;
  request_key: string;
};

export type PlanResult =
  | { ok: true; id: string; replayed: boolean; planned_at: string; label: string; timezone: string; list_name: string }
  | { ok: false; code: string; last_send_at?: string; sentence?: string };

export type PlanDeps = {
  zone: (tenantId: string) => Promise<string>;
  list: (tenantId: string, route: PlanRoute, listId: string) => Promise<{ ok: true; name: string } | { ok: false; code: string; sentence?: string }>;
  rpc: <T>(tenantId: string, name: string, args: Record<string, unknown>) => Promise<T>;
  prior: (tenantId: string, requestKey: string) => Promise<{ planned_at: string; timezone: string; list_name: string } | null>;
};

async function liveRpc<T>(tenantId: string, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), name, args);
  if (error) throw new Error(`${name} failed`);
  return data as T;
}

export async function livePlanList(
  tenantId: string,
  route: PlanRoute,
  listId: string,
): Promise<{ ok: true; name: string } | { ok: false; code: string; sentence?: string }> {
  if (route === "zavi_list") {
    const { listSummaries } = await import("@/services/comms/bulk-outbound/lists");
    const list = (await listSummaries(tenantId)).find((l) => l.id === listId);
    if (!list) return { ok: false, code: "list_not_found" };
    if (!list.active) return { ok: false, code: "list_not_consented" };
    const { emailRunPreflight } = await import("./preflight");
    const pre = await emailRunPreflight(tenantId, { route });
    if (pre.verdict === "block") return { ok: false, code: pre.code, ...(pre.sentence ? { sentence: pre.sentence } : {}) };
    return { ok: true, name: list.name };
  }
  const { resolveEmailTool, accountCall } = await import("@/services/connectors/email-campaign/account");
  const { EMAIL_PROVIDERS, EmailToolError } = await import("@/services/connectors/email-campaign/providers");
  try {
    const resolved = await resolveEmailTool(tenantId, route as EmailTool);
    const audience = await EMAIL_PROVIDERS[route as EmailTool].getAudience(accountCall(resolved), listId);
    return audience ? { ok: true, name: audience.name } : { ok: false, code: "list_not_found" };
  } catch (e) {
    if (e instanceof ExpectedToolError) return { ok: false, code: e.code };
    if (e instanceof EmailToolError) return { ok: false, code: "email_tool_read_failed" };
    throw e;
  }
}

async function scheduleZone(tenantId: string): Promise<string | null> {
  const { data, error } = (await tenantClient(asTenantId(tenantId)).from("email_plan_schedule").select("timezone").maybeSingle()) as {
    data: { timezone?: string | null } | null;
    error: { message?: string } | null;
  };
  if (error) {
    console.warn(`[email-plan] email_plan_schedule timezone read failed for tenant ${tenantId}: ${error.message ?? "unknown error"}`);
    return null;
  }
  return data?.timezone ?? null;
}

const WORKSPACE_ZONE = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/;

export async function liveTenantZone(tenantId: string): Promise<string | null> {
  const { data, error } = (await tenantClient(asTenantId(tenantId)).from("tenants").select("timezone").maybeSingle()) as {
    data: { timezone?: string | null } | null;
    error: { message?: string } | null;
  };
  if (error) throw new Error(`tenants timezone read failed for tenant ${tenantId}: ${error.message ?? "unknown error"}`);
  const tz = data?.timezone;
  return typeof tz === "string" && WORKSPACE_ZONE.test(tz) && isKnownZone(tz) ? tz : null;
}

export async function livePlanPrior(tenantId: string, requestKey: string): Promise<{ planned_at: string; timezone: string; list_name: string } | null> {
  const { data, error } = (await tenantClient(asTenantId(tenantId))
    .from("email_planned_sends")
    .select("planned_at, planned_tz, list_name")
    .eq("request_key", requestKey)
    .maybeSingle()) as { data: { planned_at: string; planned_tz: string; list_name: string } | null; error: { message?: string } | null };
  if (error) {
    console.warn(`[email-plan] prior plan read failed for tenant ${tenantId}: ${error.message ?? "unknown error"}`);
    return null;
  }
  return data ? { planned_at: data.planned_at, timezone: data.planned_tz, list_name: data.list_name } : null;
}

export async function livePlanZone(tenantId: string): Promise<string> {
  const { resolveReportingTimezone } = await import("@/services/analytics/tenant-timezone");
  const resolved = await resolveReportingTimezone(tenantId).catch(() => null);
  if (resolved && resolved.source !== "default") return resolved.tz;
  const scheduled = await scheduleZone(tenantId).catch(() => null);
  if (scheduled) return scheduled;
  const workspace = await liveTenantZone(tenantId).catch((e: Error) => {
    console.warn(`[email-plan] ${e.message}`);
    return null;
  });
  return workspace ?? resolved?.tz ?? "UTC";
}

export const LIVE_PLAN_DEPS: PlanDeps = {
  zone: livePlanZone,
  list: livePlanList,
  rpc: liveRpc,
  prior: livePlanPrior,
};

export async function planEmail(tenantId: string, a: PlanInput, depsIn: Partial<PlanDeps> = {}): Promise<PlanResult> {
  const deps = { ...LIVE_PLAN_DEPS, ...depsIn };
  const key = a.request_key.trim().slice(0, 200);
  const prior = key ? await deps.prior(tenantId, key).catch(() => null) : null;
  const tz = prior ? prior.timezone : await deps.zone(tenantId);
  const at = prior ? ({ ok: true, at: new Date(prior.planned_at) } as const) : wallToInstant({ date: a.date, time: a.time }, tz);
  if (!at.ok) return { ok: false, code: at.code };
  const list = prior ? ({ ok: true, name: prior.list_name } as const) : await deps.list(tenantId, a.route, a.list_id);
  if (!list.ok) return list;
  const out = await deps.rpc<{ ok: boolean; id?: string; replayed?: boolean; code?: string; last_send_at?: string }>(tenantId, "plan_email_send", {
    p_actor: a.actor,
    p_source: a.source,
    p_route: a.route,
    p_list_id: a.list_id,
    p_list_name: list.name.slice(0, 300),
    p_planned_at: at.at.toISOString(),
    p_tz: tz,
    p_angle: a.angle,
    p_why: a.why,
    p_request_key: a.request_key,
  });
  if (!out.ok || !out.id) return { ok: false, code: out.code ?? "bad_request", ...(out.last_send_at ? { last_send_at: out.last_send_at } : {}) };
  if (out.replayed) {
    const row = await deps.rpc<{ planned_at: string; timezone: string; list_name: string } | null>(tenantId, "email_planned_send_row", { p_id: out.id });
    if (!row) return { ok: false, code: "plan_unreadable" };
    return { ok: true, id: out.id, replayed: true, planned_at: row.planned_at, label: wallLabel(row.planned_at, row.timezone), timezone: row.timezone, list_name: row.list_name };
  }
  return { ok: true, id: out.id, replayed: false, planned_at: at.at.toISOString(), label: wallLabel(at.at, tz), timezone: tz, list_name: list.name };
}
