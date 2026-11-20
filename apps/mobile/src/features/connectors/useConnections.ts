import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { SUGGESTED_CONNECTORS, connectorLabel, connectorUses, tenantRows } from "./catalog";
import { buildConnections, isBroken, type ConnectorRow } from "./health";

export type SlackWorkspace = {
  team_id: string;
  team_name: string;
  label: string;
  purpose: string;
  suggested_purpose?: string;
  default_agent_slug: string | null;
  missing: string[];
  is_primary: boolean;
  connected_at: string | null;
  team_icon_url?: string | null;
};

export type WhatsAppHandset = { id: string; name: string | null; number: string };

export function whatsappHandsetsLabel(handsets: readonly WhatsAppHandset[]): string {
  if (handsets.length === 0) return "";
  const labels = handsets.map((h) => h.name ?? h.number);
  if (labels.length <= 2) return labels.join(" · ");
  return `${labels[0]} +${labels.length - 1} more`;
}

export type ConnectionsData = {
  rows: ConnectorRow[];
  whatsappHandsets: WhatsAppHandset[];
  slackMissing: string[];
  slackWorkspaces: SlackWorkspace[];
  lastSync: Record<string, string>;
  recommended: string[];
};

export const connectionsKey = (tenant: string) => ["connections", tenant] as const;

const FULL_COLS =
  "slug, team_id, team_name, account_login, account_type, repo_full_names, repo_ids, repo_private, selected_repo_ids, default_repo_full_name, repo_default_branches, connected_at, token_expires_at, managed_by";
const BASE_COLS =
  "slug, team_id, team_name, account_login, repo_full_names, repo_ids, selected_repo_ids, default_repo_full_name, connected_at, token_expires_at";

type Recommendation = {
  slug: string;
  connected: boolean;
  recommended: boolean;
  agents_unlocked?: string[];
  new_agents_unlocked?: string[];
};

function rankRecommendations(recs: Recommendation[]): string[] {
  const score = (r: Recommendation) =>
    (r.recommended ? 2 : 0) + ((r.new_agents_unlocked ?? r.agents_unlocked ?? []).length > 0 ? 1 : 0);
  return recs
    .filter((r) => !r.connected)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => score(b.r) - score(a.r) || a.i - b.i)
    .map(({ r }) => r.slug);
}

async function readRows(tenant: string): Promise<ConnectorRow[]> {
  const full = await supabase.from("connector_metadata").select(FULL_COLS).eq("tenant_id", tenant);
  const res = full.error
    ? await supabase.from("connector_metadata").select(BASE_COLS).eq("tenant_id", tenant)
    : full;
  if (res.error) throw new Error(res.error.message);
  return tenantRows((res.data ?? []) as ConnectorRow[]);
}

async function fetchConnections(tenant: string): Promise<ConnectionsData> {
  const rows = await readRows(tenant);
  const [slack, lastSync, recommended, whatsappHandsets] = await Promise.all([
    rows.some((r) => r.slug === "slack")
      ? apiJson<{ missing?: string[]; workspaces?: SlackWorkspace[] }>("/api/connectors/slack/scope-status")
          .then((b) => ({ missing: b?.missing ?? [], workspaces: b?.workspaces ?? [] }))
          .catch(() => ({ missing: [] as string[], workspaces: [] as SlackWorkspace[] }))
      : Promise.resolve({ missing: [] as string[], workspaces: [] as SlackWorkspace[] }),
    apiJson<{ sources?: Record<string, { last_synced_at?: string }> }>("/api/connectors/sync-status")
      .then((b) => {
        const out: Record<string, string> = {};
        for (const [slug, v] of Object.entries(b?.sources ?? {})) if (v?.last_synced_at) out[slug] = v.last_synced_at;
        return out;
      })
      .catch(() => ({})),
    apiJson<{ recommendations?: Recommendation[] }>("/api/connectors/recommendations")
      .then((b) => (Array.isArray(b?.recommendations) ? rankRecommendations(b.recommendations) : []))
      .catch(() => []),
    rows.some((r) => r.slug === "whatsapp")
      ? apiJson<{ handsets?: WhatsAppHandset[] }>("/api/connectors/whatsapp/status")
          .then((b) =>
            (b?.handsets ?? []).filter((h) => typeof h?.id === "string" && typeof h?.number === "string"),
          )
          .catch(() => [] as WhatsAppHandset[])
      : Promise.resolve([] as WhatsAppHandset[]),
  ]);
  return {
    rows,
    whatsappHandsets,
    slackMissing: slack.missing,
    slackWorkspaces: slack.workspaces,
    lastSync,
    recommended,
  };
}

export function useConnections() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: connectionsKey(tenant),
    queryFn: () => fetchConnections(tenant),
    enabled: tenant !== "none",
    staleTime: 0,
  });
}

export function useRefreshConnections() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return () => qc.invalidateQueries({ queryKey: connectionsKey(tenant) });
}

export function useBrokenConnectorCount(): number {
  const { data } = useConnections();
  if (!data) return 0;
  return buildConnections({
    rows: data.rows,
    suggested: SUGGESTED_CONNECTORS,
    labelFor: connectorLabel,
    usedByFor: connectorUses,
    slackMissing: data.slackMissing,
    now: Date.now(),
  }).filter(isBroken).length;
}
