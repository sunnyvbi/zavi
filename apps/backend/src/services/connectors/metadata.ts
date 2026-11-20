
import { serviceClient } from "@/services/supabase";

export type SlackConnectorMeta = {
  kind: "slack";
  team_id: string;
  team_name: string;
  scopes: string[];
  connected_at: string;
};

export type GithubConnectorMeta = {
  kind: "github";
  installation_id: number;
  account_login: string;
  account_type: string;
  repo_ids: number[];
  repo_full_names: string[];
  scopes: string[];
  connected_at: string;
};

export type MetaAdsConnectorMeta = {
  kind: "meta_ads";
  ad_account_id: string;
  scopes: string[];
  connected_at: string;
  token_expires_at: string;
};

export type GoogleAdsConnectorMeta = {
  kind: "google_ads";
  customer_id: string;
  scopes: string[];
  connected_at: string;
};

export type ConnectorMeta =
  | SlackConnectorMeta
  | GithubConnectorMeta
  | MetaAdsConnectorMeta
  | GoogleAdsConnectorMeta;

export type ConnectorsRow = {
  slug: "slack" | "github" | "meta_ads" | "google_ads";
  team_id: string | null;
  team_name: string | null;
  installation_id: number | null;
  account_login: string | null;
  account_type: string | null;
  repo_ids: number[] | null;
  repo_full_names: string[] | null;
  scopes: string[] | null;
  connected_at: string | null;
  token_expires_at?: string | null;
};

export type ConnectorsView = {
  slack?: SlackConnectorMeta;
  github?: GithubConnectorMeta;
  meta_ads?: MetaAdsConnectorMeta;
  google_ads?: GoogleAdsConnectorMeta;
};

export type ConnectorListEntry = {
  slug: string;
  connected: true;
  team_name: string | null;
  account_login: string | null;
  connected_at: string | null;
  repo_count?: number;
  workspace_count?: number;
  token_expires_at?: string | null;
  scopes?: unknown;
};

export async function readConnectorList(
  tenant_id: string,
): Promise<ConnectorListEntry[]> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("slug, team_name, account_login, repo_full_names, connected_at, token_expires_at, scopes")
    .eq("tenant_id", tenant_id);
  if (error) {
    throw new Error(
      `connector_metadata list read failed for ${tenant_id}: ${error.message}`,
    );
  }
  const rows = (data ?? []) as Array<{
    slug: string;
    team_name: string | null;
    account_login: string | null;
    repo_full_names: string[] | null;
    connected_at: string | null;
    token_expires_at: string | null;
    scopes?: unknown;
  }>;

  let slackWorkspaceCount = 0;
  if (rows.some((r) => r.slug === "slack")) {
    const { count } = await serviceClient()
      .from("slack_workspaces")
      .select("team_id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id);
    slackWorkspaceCount = count ?? 0;
  }

  return rows.map((row) => ({
    slug: row.slug,
    connected: true as const,
    team_name: row.team_name,
    account_login: row.account_login,
    connected_at: row.connected_at,
    ...(row.token_expires_at ? { token_expires_at: row.token_expires_at } : {}),
    ...(row.slug === "github"
      ? { repo_count: row.repo_full_names?.length ?? 0 }
      : {}),
    ...(row.slug === "slack"
      ? { workspace_count: Math.max(slackWorkspaceCount, 1) }
      : {}),
    ...(row.slug === "email" ? { scopes: row.scopes ?? null } : {}),
  }));
}

export async function readConnectors(tenant_id: string): Promise<ConnectorsView> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select(
      "slug, team_id, team_name, installation_id, account_login, account_type, repo_ids, repo_full_names, scopes, connected_at, token_expires_at",
    )
    .eq("tenant_id", tenant_id);
  if (error) {
    throw new Error(`connector_metadata read failed for ${tenant_id}: ${error.message}`);
  }
  const out: ConnectorsView = {};
  for (const row of (data ?? []) as ConnectorsRow[]) {
    if (row.slug === "slack") {
      out.slack = {
        kind: "slack",
        team_id: row.team_id ?? "",
        team_name: row.team_name ?? "",
        scopes: row.scopes ?? [],
        connected_at: row.connected_at ?? new Date(0).toISOString(),
      };
    } else if (row.slug === "github") {
      out.github = {
        kind: "github",
        installation_id: row.installation_id ?? 0,
        account_login: row.account_login ?? "",
        account_type: row.account_type ?? "User",
        repo_ids: row.repo_ids ?? [],
        repo_full_names: row.repo_full_names ?? [],
        scopes: row.scopes ?? [],
        connected_at: row.connected_at ?? new Date(0).toISOString(),
      };
    } else if (row.slug === "meta_ads") {
      const connectedAt = row.connected_at ?? new Date(0).toISOString();
      const fallbackMs = Date.parse(connectedAt) + 60 * 86400 * 1000;
      out.meta_ads = {
        kind: "meta_ads",
        ad_account_id: row.team_id ?? "",
        scopes: row.scopes ?? [],
        connected_at: connectedAt,
        token_expires_at: row.token_expires_at ?? new Date(fallbackMs).toISOString(),
      };
    } else if (row.slug === "google_ads") {
      out.google_ads = {
        kind: "google_ads",
        customer_id: row.team_id ?? "",
        scopes: row.scopes ?? [],
        connected_at: row.connected_at ?? new Date(0).toISOString(),
      };
    }
  }
  return out;
}

