
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export async function staffTenants(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = serviceClient();
  const { data, error } = await sb
    .from("tenants")
    .select("id, slug, display_name, rar_weekly_threshold, created_at, kind")
    .order("created_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: { code: "tenants_query_failed", message: error.message } });
    return;
  }
  if (req.query.include_member_emails !== "1") {
    res.json({ tenants: data ?? [] });
    return;
  }
  const { emails, complete } = await memberEmailsByTenant(sb);
  const tenants = ((data ?? []) as Array<{ id: string }>).map((t) => ({
    ...t,
    member_emails: emails.get(t.id) ?? [],
  }));
  res.json({ tenants, member_emails_complete: complete });
}

export async function memberEmailsByTenant(
  sb: ReturnType<typeof serviceClient>,
): Promise<{ emails: Map<string, string[]>; complete: boolean }> {
  const out = new Map<string, Set<string>>();
  let complete = true;
  const add = (tenantId: string, email: string | null | undefined) => {
    const e = (email ?? "").trim().toLowerCase();
    if (!e) return;
    let set = out.get(tenantId);
    if (!set) out.set(tenantId, (set = new Set()));
    set.add(e);
  };
  try {
    const pageAll = async <T>(
      fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
    ): Promise<T[]> => {
      const rows: T[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await fetchPage(from, from + 999);
        if (error) {
          complete = false;
          break;
        }
        const page = (data ?? []) as T[];
        rows.push(...page);
        if (page.length < 1000) break;
      }
      return rows;
    };
    const [members, invites] = await Promise.all([
      pageAll<{ tenant_id: string; user_id: string }>((from, to) =>
        sb.from("tenant_users").select("tenant_id, user_id").order("user_id").order("tenant_id").range(from, to),
      ),
      pageAll<{ tenant_id: string; email: string | null }>((from, to) =>
        sb
          .from("tenant_member_invites")
          .select("tenant_id, email")
          .is("accepted_at", null)
          .is("revoked_at", null)
          .order("id")
          .range(from, to),
      ),
    ]);
    const emailById = new Map<string, string>();
    for (let page = 1; ; page++) {
      if (page > 20) {
        complete = false;
        break;
      }
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) {
        complete = false;
        break;
      }
      const users = data?.users ?? [];
      for (const u of users) if (u.email) emailById.set(u.id, u.email);
      if (users.length < 1000) break;
    }
    for (const r of members) {
      add(r.tenant_id, emailById.get(r.user_id));
    }
    for (const r of invites) {
      add(r.tenant_id, r.email);
    }
  } catch {
    complete = false;
  }
  return { emails: new Map([...out].map(([k, v]) => [k, [...v].sort()])), complete };
}

export async function staffTenantsUsage(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const raw = Number.parseInt(String(req.query.window ?? "7"), 10);
  const windowDays = Number.isFinite(raw) ? Math.min(90, Math.max(1, raw)) : 7;

  const sb = serviceClient();
  const { data, error } = await sb.rpc("admin_tenant_usage", { p_window_days: windowDays });
  if (error) {
    res.status(500).json({ error: { code: "tenants_usage_failed", message: error.message } });
    return;
  }

  type UsageRow = {
    tenant_id: string;
    runs: number | string;
    errors: number | string;
    ok_runs: number | string;
    cost_usd: number | string;
    active_agents: number | string;
    user_messages: number | string;
    last_active_at: string | null;
    connectors: number | string;
    pending_decisions: number | string;
  };
  const usage = ((data ?? []) as UsageRow[]).map((u) => {
    const runs = Number(u.runs) || 0;
    const okRuns = Number(u.ok_runs) || 0;
    return {
      tenant_id: u.tenant_id,
      runs,
      errors: Number(u.errors) || 0,
      ok_runs: okRuns,
      ok_rate: runs > 0 ? Math.round((okRuns / runs) * 100) / 100 : null,
      cost_usd: Math.round((Number(u.cost_usd) || 0) * 1000) / 1000,
      active_agents: Number(u.active_agents) || 0,
      user_messages: Number(u.user_messages) || 0,
      last_active_at: u.last_active_at,
      connectors: Number(u.connectors) || 0,
      pending_decisions: Number(u.pending_decisions) || 0,
    };
  });
  res.json({ window_days: windowDays, usage });
}

export async function staffSetTenantKind(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const kind = (req.body?.kind ?? "").toString();
  if (kind !== "real" && kind !== "test") {
    res.status(400).json({ error: { code: "bad_kind", message: "kind must be 'real' or 'test'" } });
    return;
  }
  const sb = serviceClient();
  const { data, error } = await sb.rpc("set_tenant_kind", {
    p_tenant_id: tenantId,
    p_kind: kind,
  });
  if (error) {
    res.status(500).json({ error: { code: "set_kind_failed", message: error.message } });
    return;
  }
  res.json({ tenant_id: tenantId, kind: data ?? kind });
}

export async function staffTenantSummary(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const sb = serviceClient();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const tenantQ = sb
    .from("tenants")
    .select("id, slug, display_name, created_at")
    .eq("id", tenantId)
    .maybeSingle();
  const runsQ = sb
    .from("agent_runs")
    .select("agent_slug, status", { count: "exact", head: false })
    .eq("tenant_id", tenantId)
    .gte("started_at", since);
  const fbQ = sb.rpc("agent_feedback_summary", {
    p_tenant_id: tenantId,
    p_window_days: 7,
  });

  const [tenant, runs, fb] = await Promise.all([tenantQ, runsQ, fbQ]);

  if (tenant.error) {
    res.status(500).json({ error: { code: "tenant_query_failed", message: tenant.error.message } });
    return;
  }
  if (!tenant.data) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  type RunRow = { agent_slug: string; status: string };
  const runRows: RunRow[] = (runs.data ?? []) as RunRow[];
  const total = runRows.length;
  const errors = runRows.filter((r) => r.status === "dispatch_error" || r.status === "parse_failed").length;

  res.json({
    tenant: tenant.data,
    runs_7d: { total, errors },
    feedback_7d: fb.data ?? [],
  });
}

export async function staffTenantAgents(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const sb = serviceClient();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from("agent_runs")
    .select("agent_slug, status, parse_ok, cost_usd, finished_at")
    .eq("tenant_id", tenantId)
    .gte("started_at", since)
    .order("finished_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: { code: "agents_query_failed", message: error.message } });
    return;
  }

  type RunRow = {
    agent_slug: string;
    status: string;
    parse_ok: boolean | null;
    cost_usd: number | null;
    finished_at: string | null;
  };
  const rows = (data ?? []) as RunRow[];
  const bySlug = new Map<string, { runs: number; ok: number; errors: number; cost: number; latest: string | null }>();
  for (const r of rows) {
    const cur = bySlug.get(r.agent_slug) ?? { runs: 0, ok: 0, errors: 0, cost: 0, latest: null };
    cur.runs += 1;
    if (r.status === "success" && r.parse_ok) cur.ok += 1;
    if (r.status === "dispatch_error" || r.status === "parse_failed") cur.errors += 1;
    cur.cost += Number(r.cost_usd ?? 0);
    if (!cur.latest || (r.finished_at && r.finished_at > cur.latest)) cur.latest = r.finished_at;
    bySlug.set(r.agent_slug, cur);
  }
  const agents = [...bySlug.entries()].map(([agent_slug, s]) => ({
    agent_slug,
    runs: s.runs,
    ok_rate: s.runs > 0 ? Math.round((s.ok / s.runs) * 100) / 100 : 0,
    errors: s.errors,
    cost_usd: Math.round(s.cost * 1000) / 1000,
    latest_run: s.latest,
  }));
  res.json({ agents });
}
