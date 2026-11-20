
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const LIST_CAP = 100;

export type ConnectionRow = {
  source: "connector" | "mcp" | "resource" | "operator_db";
  key: string;
  label: string;
  status: string;
  connected_at: string | null;
  detail: string | null;
};

export type ConnectorMetaFull = {
  slug: string;
  team_name: string | null;
  scopes: string[] | null;
  connected_at: string | null;
};
export type McpFull = { server_id: string; transport: string | null; enabled: boolean | null; created_at: string | null };
export type ResourceFull = {
  resource_kind: string;
  provider: string | null;
  status: string;
  mode: string | null;
  created_at: string | null;
};
export type OperatorDbRow = { type: string | null; created_at: string | null } | null;

const CONNECTOR_LABELS: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  stripe: "Stripe",
  gmail: "Gmail",
  sentry: "Sentry",
  meta_ads: "Meta Ads",
  jira: "Jira",
  operator_db: "Your database",
};

export function buildConnectionList(
  connectors: ConnectorMetaFull[],
  mcp: McpFull[],
  resources: ResourceFull[],
  operatorDb: OperatorDbRow,
): ConnectionRow[] {
  const rows: ConnectionRow[] = [];

  for (const c of connectors) {
    rows.push({
      source: "connector",
      key: `connector:${c.slug}`,
      label: CONNECTOR_LABELS[c.slug] ?? c.slug,
      status: c.connected_at ? "connected" : "pending",
      connected_at: c.connected_at,
      detail: [c.team_name, c.scopes?.length ? `${c.scopes.length} scopes` : null]
        .filter(Boolean)
        .join(" · ") || null,
    });
  }
  for (const m of mcp) {
    rows.push({
      source: "mcp",
      key: `mcp:${m.server_id}`,
      label: `${CONNECTOR_LABELS[m.server_id] ?? m.server_id} (MCP)`,
      status: m.enabled ? "enabled" : "disabled",
      connected_at: m.created_at,
      detail: m.transport,
    });
  }
  for (const r of resources) {
    rows.push({
      source: "resource",
      key: `resource:${r.provider ?? "unknown"}:${r.resource_kind}`,
      label: `${r.provider ?? "resource"} · ${r.resource_kind}`,
      status: r.status,
      connected_at: r.created_at,
      detail: r.mode,
    });
  }
  if (operatorDb) {
    rows.push({
      source: "operator_db",
      key: "operator_db",
      label: "Your database (query)",
      status: "connected",
      connected_at: operatorDb.created_at,
      detail: operatorDb.type,
    });
  }

  const rank = (s: string) =>
    s === "connected" || s === "enabled" || s === "ready" ? 0 : s === "pending" || s === "provisioning" ? 1 : 2;
  return rows.sort((a, b) => rank(a.status) - rank(b.status) || a.label.localeCompare(b.label));
}

export type ThreadRow = {
  id: string;
  agent_slug: string;
  title: string | null;
  created_at: string;
  last_message_at: string;
};
export type ChatItem = ThreadRow & { messages: number };

export function buildChatList(threads: ThreadRow[], countByThread: Map<string, number>): ChatItem[] {
  return threads.map((t) => ({ ...t, messages: countByThread.get(t.id) ?? 0 }));
}

export type ChatErrorRunRow = {
  id: string;
  agent_slug: string;
  status: string;
  error: string | null;
  enqueued_at: string | null;
  finished_at: string | null;
};
export type ChatErrorItem = {
  run_id: string;
  agent_slug: string;
  status: string;
  error: string;
  at: string | null;
};

export function buildChatErrors(runs: ChatErrorRunRow[]): ChatErrorItem[] {
  const ERR_STATUS = new Set(["dispatch_error", "parse_failed", "blocked"]);
  return runs
    .filter((r) => ERR_STATUS.has(r.status) || (r.error != null && r.error !== ""))
    .map((r) => ({
      run_id: r.id,
      agent_slug: r.agent_slug,
      status: r.status,
      error: r.error && r.error !== "" ? r.error : r.status,
      at: r.finished_at ?? r.enqueued_at,
    }));
}

export async function staffTenantActivity(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const sb = serviceClient();

  const { data: tenant, error: tErr } = await sb
    .from("tenants")
    .select("id")
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

  const degraded: string[] = [];

  const connectionsSection = (async () => {
    const [cm, mcp, resources, opdb] = await Promise.all([
      sb.from("connector_metadata").select("slug, team_name, scopes, connected_at").eq("tenant_id", tenantId),
      sb.from("tenant_mcp_servers").select("server_id, transport, enabled, created_at").eq("tenant_id", tenantId),
      sb.from("tenant_resources").select("resource_kind, provider, status, mode, created_at").eq("tenant_id", tenantId),
      sb.from("tenant_db_config").select("type, created_at").eq("tenant_id", tenantId).maybeSingle(),
    ]);
    if (cm.error) throw cm.error;
    if (mcp.error) throw mcp.error;
    if (resources.error) throw resources.error;
    if (opdb.error) throw opdb.error;
    return buildConnectionList(
      (cm.data ?? []) as ConnectorMetaFull[],
      (mcp.data ?? []) as McpFull[],
      (resources.data ?? []) as ResourceFull[],
      (opdb.data ?? null) as OperatorDbRow,
    );
  })();

  const chatsSection = (async () => {
    const totalQ = sb
      .from("agent_threads")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .is("deleted_at", null);
    const pageQ = sb
      .from("agent_threads")
      .select("id, agent_slug, title, created_at, last_message_at")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .order("last_message_at", { ascending: false })
      .limit(LIST_CAP);
    const [total, page] = await Promise.all([totalQ, pageQ]);
    if (page.error) throw page.error;
    if (total.error) throw total.error;
    const threads = (page.data ?? []) as ThreadRow[];

    const countByThread = new Map<string, number>();
    if (threads.length > 0) {
      const ids = threads.map((t) => t.id);
      const { data: msgs, error: mErr } = await sb
        .from("agent_thread_messages")
        .select("thread_id")
        .in("thread_id", ids)
        .limit(50000);
      if (mErr) throw mErr;
      for (const m of (msgs ?? []) as Array<{ thread_id: string }>) {
        countByThread.set(m.thread_id, (countByThread.get(m.thread_id) ?? 0) + 1);
      }
    }
    return { total: total.count ?? threads.length, items: buildChatList(threads, countByThread) };
  })();

  const chatErrorsSection = (async () => {
    const ERR_FILTER = "status.in.(dispatch_error,parse_failed,blocked),error.not.is.null";
    const pageQ = sb
      .from("agent_runs")
      .select("id, agent_slug, status, error, enqueued_at, finished_at")
      .eq("tenant_id", tenantId)
      .eq("trigger", "chat")
      .or(ERR_FILTER)
      .order("enqueued_at", { ascending: false })
      .limit(LIST_CAP);
    const countQ = sb
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("trigger", "chat")
      .or(ERR_FILTER);
    const [page, cnt] = await Promise.all([pageQ, countQ]);
    if (page.error) throw page.error;
    if (cnt.error) throw cnt.error;
    const items = buildChatErrors((page.data ?? []) as ChatErrorRunRow[]);
    return { total: cnt.count ?? items.length, items };
  })();

  const [connections, chats, chatErrors] = await Promise.allSettled([
    connectionsSection,
    chatsSection,
    chatErrorsSection,
  ]);

  const pick = <T>(key: string, r: PromiseSettledResult<T>, fallback: T): T => {
    if (r.status === "fulfilled") return r.value;
    degraded.push(key);
    // eslint-disable-next-line no-console
    console.warn(`[tenant-activity] section '${key}' failed: ${(r.reason as Error)?.message ?? "unknown"}`);
    return fallback;
  };

  res.json({
    connections: pick("connections", connections, [] as ConnectionRow[]),
    chats: pick("chats", chats, { total: 0, items: [] as ChatItem[] }),
    chat_errors: pick("chat_errors", chatErrors, { total: 0, items: [] as ChatErrorItem[] }),
    list_cap: LIST_CAP,
    degraded,
  });
}
