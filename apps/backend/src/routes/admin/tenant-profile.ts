
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { parseSignupAttribution, SIGNUP_ATTRIBUTION_KEY } from "@/services/tenants/signup-attribution";
import { resolveSignupSource } from "@/services/tenants/signup-source";
import { getAgentEffectiveStates } from "@/services/agents/visibility";

export type SignupInput = {
  hasSlackDraft: boolean;
  slackConnectedAt: string | null;
  tenantCreatedAt: string;
  onboardedAt: string | null;
};
export type SignupPath = "slack-first" | "web-wizard" | "unknown";
export type SignupEvidence =
  | "slack_draft"
  | "slack_connected_near_created"
  | "profile_onboarded"
  | null;

export function inferSignupPath(
  input: SignupInput,
): { path: SignupPath; evidence: SignupEvidence } {
  if (input.hasSlackDraft) return { path: "slack-first", evidence: "slack_draft" };
  if (input.slackConnectedAt) {
    const dt = Math.abs(
      new Date(input.slackConnectedAt).getTime() - new Date(input.tenantCreatedAt).getTime(),
    );
    if (Number.isFinite(dt) && dt <= 10 * 60 * 1000) {
      return { path: "slack-first", evidence: "slack_connected_near_created" };
    }
  }
  if (input.onboardedAt) return { path: "web-wizard", evidence: "profile_onboarded" };
  return { path: "unknown", evidence: null };
}

export type ConnectorSummary = {
  key: string;
  label: string;
  connected: boolean;
  connected_at: string | null;
  detail: string | null;
};

export type ConnectorMetaRow = {
  slug: string;
  team_name: string | null;
  connected_at: string | null;
};
export type McpRow = { server_id: string; enabled: boolean | null };
export type ResourceRow = {
  resource_kind: string;
  provider: string | null;
  status: string;
};

const CONNECTOR_LABELS: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  stripe: "Stripe",
  gmail: "Gmail",
  sentry: "Sentry",
  mongo: "Your database (Mongo)",
};

export function summarizeConnectors(
  connectorRows: ConnectorMetaRow[],
  mcpRows: McpRow[],
  resourceRows: ResourceRow[],
): ConnectorSummary[] {
  const out = new Map<string, ConnectorSummary>();

  for (const c of connectorRows) {
    out.set(c.slug, {
      key: c.slug,
      label: CONNECTOR_LABELS[c.slug] ?? c.slug,
      connected: !!c.connected_at,
      connected_at: c.connected_at,
      detail: c.team_name,
    });
  }
  for (const m of mcpRows) {
    const key = `mcp:${m.server_id}`;
    if (out.has(m.server_id)) continue;
    if (out.has(key)) continue;
    out.set(key, {
      key,
      label: `${CONNECTOR_LABELS[m.server_id] ?? m.server_id} (MCP)`,
      connected: m.enabled === true,
      connected_at: null,
      detail: null,
    });
  }
  for (const r of resourceRows) {
    const key = `resource:${r.provider ?? "unknown"}:${r.resource_kind}`;
    if (out.has(key)) continue;
    out.set(key, {
      key,
      label: `${r.provider ?? "resource"} · ${r.resource_kind}`,
      connected: r.status === "ready",
      connected_at: null,
      detail: r.status,
    });
  }

  return [...out.values()].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label),
  );
}

export type UsageRunRow = {
  trigger: string | null;
  enqueued_at: string | null;
  finished_at: string | null;
};
export type SurfaceRow = { surface: string; runs: number; last_at: string | null };

const SURFACE_LABELS: Record<string, string> = {
  slack: "Slack",
  chat: "Web chat",
  manual: "Manual",
  cron: "Scheduled",
  email: "Email",
  teams: "Teams",
};

export function summarizeUsageSurfaces(runRows: UsageRunRow[]): SurfaceRow[] {
  const by = new Map<string, { runs: number; last_at: string | null }>();
  for (const r of runRows) {
    const label = SURFACE_LABELS[r.trigger ?? ""] ?? "Other";
    const cur = by.get(label) ?? { runs: 0, last_at: null };
    cur.runs += 1;
    const at = r.finished_at ?? r.enqueued_at;
    if (at && (!cur.last_at || at > cur.last_at)) cur.last_at = at;
    by.set(label, cur);
  }
  return [...by.entries()]
    .map(([surface, s]) => ({ surface, runs: s.runs, last_at: s.last_at }))
    .sort((a, b) => b.runs - a.runs);
}

export type SubRow = {
  plan: string | null;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  stripe_customer_id: string | null;
} | null;
export type BalRow = {
  included_allowance: number | null;
  included_used: number | null;
  purchased_balance: number | null;
  reserved: number | null;
  period_end: string | null;
} | null;
export type CapRow = { daily_cap_usd: number | null } | null;

export type BillingSummary = {
  plan: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  grandfathered: boolean;
  stripe_customer_id: string | null;
  credits: {
    included_allowance: number;
    included_used: number;
    included_remaining: number;
    purchased_balance: number;
    reserved: number;
    period_end: string | null;
  } | null;
  daily_cap_usd: number | null;
};

export function summarizeBilling(sub: SubRow, bal: BalRow, cap: CapRow): BillingSummary {
  const credits = bal
    ? {
        included_allowance: bal.included_allowance ?? 0,
        included_used: bal.included_used ?? 0,
        included_remaining: (bal.included_allowance ?? 0) - (bal.included_used ?? 0),
        purchased_balance: bal.purchased_balance ?? 0,
        reserved: bal.reserved ?? 0,
        period_end: bal.period_end,
      }
    : null;
  return {
    plan: sub?.plan ?? "free",
    status: sub?.status ?? "unknown",
    current_period_end: sub?.current_period_end ?? null,
    cancel_at_period_end: sub?.cancel_at_period_end ?? false,
    grandfathered: false,
    stripe_customer_id: sub?.stripe_customer_id ?? null,
    credits,
    daily_cap_usd: cap?.daily_cap_usd ?? null,
  };
}

export function computeLastActive(
  runRows: UsageRunRow[],
  lastThreadMsgAt: string | null,
): { at: string | null; source: "run" | "chat" | null } {
  let runMax: string | null = null;
  for (const r of runRows) {
    const at = r.finished_at ?? r.enqueued_at;
    if (at && (!runMax || at > runMax)) runMax = at;
  }
  if (!runMax && !lastThreadMsgAt) return { at: null, source: null };
  if (runMax && (!lastThreadMsgAt || runMax >= lastThreadMsgAt)) {
    return { at: runMax, source: "run" };
  }
  return { at: lastThreadMsgAt, source: "chat" };
}

export function normalizeProductUrl(raw: unknown): { href: string; label: string } | null {
  let candidate: string | null = null;
  if (typeof raw === "string") candidate = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.href === "string") candidate = o.href;
    else if (typeof o.url === "string") candidate = o.url;
  }
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { href: u.toString(), label: u.host + (u.pathname === "/" ? "" : u.pathname) };
  } catch {
    return null;
  }
}

const WINDOW_DAYS = 30;

export async function staffTenantProfile(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const sb = serviceClient();

  const { data: tenant, error: tErr } = await sb
    .from("tenants")
    .select(
      "id, slug, display_name, tier, kind, created_at, product_url, show_in_public_feed, rar_weekly_threshold, disabled_at, disabled_reason",
    )
    .eq("id", tenantId)
    .maybeSingle();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_query_failed", message: tErr.message } });
    return;
  }
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const degraded: string[] = [];

  const ownerSection = (async () => {
    const { data: members, error } = await sb
      .from("tenant_users")
      .select("user_id, role, created_at")
      .eq("tenant_id", tenantId);
    if (error) throw error;
    const rows = members ?? [];
    const owners = rows
      .filter((r) => r.role === "owner")
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const primary = owners[0] ?? null;
    let owner: {
      user_id: string;
      email: string | null;
      name: string | null;
      joined_at: string | null;
    } | null = null;
    if (primary) {
      let email: string | null = null;
      let name: string | null = null;
      try {
        const { data: u } = await sb.auth.admin.getUserById(primary.user_id);
        email = u?.user?.email ?? null;
        const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
        name = (meta.full_name as string) ?? (meta.name as string) ?? null;
      } catch {
      }
      owner = { user_id: primary.user_id, email, name, joined_at: primary.created_at };
    }
    return { primary_owner: owner, owner_count: owners.length, members_total: rows.length };
  })();

  const signupSection = (async () => {
    const ownerRow = await sb
      .from("tenant_users")
      .select("user_id, created_at")
      .eq("tenant_id", tenantId)
      .eq("role", "owner")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const ownerUserId = ownerRow.data?.user_id ?? null;

    if (ownerRow.error) throw ownerRow.error;
    const [prof, draft, slackConn, enrich] = await Promise.all([
      ownerUserId
        ? sb.from("profiles").select("onboarded_at").eq("user_id", ownerUserId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      sb
        .from("slack_onboarding_drafts")
        .select("company_domain")
        .eq("tenant_id", tenantId)
        .limit(1)
        .maybeSingle(),
      sb
        .from("connector_metadata")
        .select("connected_at")
        .eq("tenant_id", tenantId)
        .eq("slug", "slack")
        .maybeSingle(),
      ownerUserId
        ? sb
            .from("enrichment_audit")
            .select("outcome, resolved_domain, created_at")
            .eq("user_id", ownerUserId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    for (const r of [prof, draft, slackConn, enrich]) {
      if ((r as { error?: { message: string } | null }).error) {
        throw (r as { error: { message: string } }).error;
      }
    }

    const draftRow = draft.data as { company_domain: string | null } | null;
    const enrichRow = enrich.data as
      | { outcome: string | null; resolved_domain: string | null; created_at: string | null }
      | null;
    const { path, evidence } = inferSignupPath({
      hasSlackDraft: !!draftRow,
      slackConnectedAt: (slackConn.data as { connected_at: string | null } | null)?.connected_at ?? null,
      tenantCreatedAt: tenant.created_at,
      onboardedAt: (prof.data as { onboarded_at: string | null } | null)?.onboarded_at ?? null,
    });
    return {
      path,
      evidence,
      onboarded_at: (prof.data as { onboarded_at: string | null } | null)?.onboarded_at ?? null,
      company_domain: draftRow?.company_domain ?? enrichRow?.resolved_domain ?? null,
      enrichment_outcome: enrichRow?.outcome ?? null,
      enrichment_at: enrichRow?.created_at ?? null,
    };
  })();

  const attributionSection = (async () => {
    const [setting, referral] = await Promise.all([
      sb.from("tenant_app_setting").select("value").eq("tenant_id", tenantId)
        .eq("key", SIGNUP_ATTRIBUTION_KEY).maybeSingle(),
      sb.from("affiliate_referrals").select("member_id, code, clicked_at")
        .eq("tenant_id", tenantId).maybeSingle(),
    ]);
    if (setting.error) throw setting.error;
    if (referral.error) throw referral.error;
    let displayName: string | null = null;
    if (referral.data) {
      const member = await sb.from("human_members").select("display_name")
        .eq("id", referral.data.member_id).maybeSingle();
      if (member.error) throw member.error;
      displayName = member.data?.display_name ?? null;
    }
    return {
      ...resolveSignupSource(setting.data?.value, referral.data
        ? { member_id: referral.data.member_id, display_name: displayName } : null),
      referral_code: referral.data?.code ?? null,
      clicked_at: referral.data?.clicked_at ?? null,
      source_tag: parseSignupAttribution(setting.data?.value)?.from ?? null,
    };
  })();

  const connectorsSection = (async () => {
    const [cm, mcp, resources] = await Promise.all([
      sb.from("connector_metadata").select("slug, team_name, connected_at").eq("tenant_id", tenantId),
      sb.from("tenant_mcp_servers").select("server_id, enabled").eq("tenant_id", tenantId),
      sb.from("tenant_resources").select("resource_kind, provider, status").eq("tenant_id", tenantId),
    ]);
    if (cm.error) throw cm.error;
    if (mcp.error) throw mcp.error;
    if (resources.error) throw resources.error;
    return summarizeConnectors(
      (cm.data ?? []) as ConnectorMetaRow[],
      (mcp.data ?? []) as McpRow[],
      (resources.data ?? []) as ResourceRow[],
    );
  })();

  const billingSection = (async () => {
    const [sub, bal, cap] = await Promise.all([
      sb
        .from("tenant_subscriptions")
        .select("plan, status, current_period_end, cancel_at_period_end, stripe_customer_id")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      sb
        .from("tenant_credit_balances")
        .select("included_allowance, included_used, purchased_balance, reserved, period_end")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      sb.from("tenant_budget_override").select("daily_cap_usd").eq("tenant_id", tenantId).maybeSingle(),
    ]);
    if (sub.error) throw sub.error;
    if (bal.error) throw bal.error;
    if (cap.error) throw cap.error;
    return summarizeBilling(sub.data as SubRow, bal.data as BalRow, cap.data as CapRow);
  })();

  const usageSection = (async () => {
    const [runs, lastMsg, states] = await Promise.all([
      sb
        .from("agent_runs")
        .select("trigger, enqueued_at, finished_at")
        .eq("tenant_id", tenantId)
        .gte("enqueued_at", since)
        .limit(20000),
      sb
        .from("agent_thread_messages")
        .select("created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      getAgentEffectiveStates(tenantId).catch(() => []),
    ]);
    if (runs.error) throw runs.error;
    if (lastMsg.error) throw lastMsg.error;
    const runRows = (runs.data ?? []) as UsageRunRow[];
    const lastThreadAt = (lastMsg.data as { created_at: string | null } | null)?.created_at ?? null;
    const lastActive = computeLastActive(runRows, lastThreadAt);
    return {
      last_active_at: lastActive.at,
      last_active_source: lastActive.source,
      surfaces: summarizeUsageSurfaces(runRows),
      runs_30d: runRows.length,
      agents_enabled: states.filter((s) => s.effective_state === "visible").length,
    };
  })();

  const [owner, signup, connectors, billing, usage, attribution] = await Promise.allSettled([
    ownerSection,
    signupSection,
    connectorsSection,
    billingSection,
    usageSection,
    attributionSection,
  ]);

  const pick = <T>(key: string, r: PromiseSettledResult<T>, fallback: T): T => {
    if (r.status === "fulfilled") return r.value;
    degraded.push(key);
    // eslint-disable-next-line no-console
    console.warn(`[tenant-profile] section '${key}' failed: ${(r.reason as Error)?.message ?? "unknown"}`);
    return fallback;
  };

  const ownerVal = pick("owner", owner, {
    primary_owner: null,
    owner_count: 0,
    members_total: 0,
  });

  res.json({
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      display_name: tenant.display_name,
      tier: tenant.tier,
      kind: tenant.kind,
      created_at: tenant.created_at,
      product_url: normalizeProductUrl(tenant.product_url),
      show_in_public_feed: tenant.show_in_public_feed,
      rar_weekly_threshold: tenant.rar_weekly_threshold,
      disabled_at: (tenant as { disabled_at?: string | null }).disabled_at ?? null,
      disabled_reason: (tenant as { disabled_reason?: string | null }).disabled_reason ?? null,
    },
    primary_owner: ownerVal.primary_owner,
    owner_count: ownerVal.owner_count,
    members: { total: ownerVal.members_total },
    signup: pick("signup", signup, null),
    attribution: pick("attribution", attribution, null),
    connectors: pick("connectors", connectors, []),
    billing: pick("billing", billing, null),
    usage: pick("usage", usage, {
      last_active_at: null,
      last_active_source: null,
      surfaces: [],
      runs_30d: 0,
      agents_enabled: 0,
    }),
    degraded,
  });
}
