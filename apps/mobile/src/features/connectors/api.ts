import { Linking } from "react-native";
import { apiJson } from "../../lib/api";
import type { ConnectorListRow } from "./connectPlan";

type OAuthStart = { oauth_url?: string };

function requireUrl(body: OAuthStart | undefined): string {
  if (!body?.oauth_url) throw new Error("Couldn't open the connection. Please try again.");
  return body.oauth_url;
}

export async function startOAuth(path: string): Promise<string> {
  return requireUrl(await apiJson<OAuthStart>(path, { method: "GET", headers: { Accept: "application/json" } }));
}

export async function openConnectInBrowser(oauthUrl: string): Promise<void> {
  let target = oauthUrl;
  try {
    const body = await apiJson<{ open_url?: string }>("/api/connectors/mobile/handoff", {
      method: "POST",
      body: JSON.stringify({ url: oauthUrl }),
    });
    if (body?.open_url) target = body.open_url;
  } catch {
  }
  await Linking.openURL(target);
}

export function completeConnect(slug: string, code: string, state: string): Promise<{ ok?: boolean }> {
  return apiJson(`/api/connectors/${encodeURIComponent(slug)}/complete`, {
    method: "POST",
    body: JSON.stringify({ code, state }),
  });
}

export async function startComposio(toolkit: string): Promise<string> {
  return requireUrl(
    await apiJson<OAuthStart>(`/api/connectors/composio/${encodeURIComponent(toolkit)}/connect`, { method: "POST" }),
  );
}

export async function fetchConnectorRows(): Promise<ConnectorListRow[]> {
  const body = await apiJson<{ connectors?: ConnectorListRow[] }>("/api/connectors");
  return body?.connectors ?? [];
}

export function continueConnectorRequest(runId: string): Promise<{ run_id?: string }> {
  return apiJson(`/api/chat/connector-requests/${encodeURIComponent(runId)}/continue`, { method: "POST" });
}

type Err = { error?: { message?: string } | string };

const post = <T>(path: string, body: Record<string, unknown>) =>
  apiJson<T & Err>(path, { method: "POST", body: JSON.stringify(body) });

function okOrThrow<T extends Err>(body: T): T {
  const e = body?.error;
  if (e) throw new Error(typeof e === "string" ? e : e.message ?? "Couldn't connect. Please try again.");
  return body;
}

export async function connectStripe(apiKey: string) {
  return okOrThrow(await post<{ ok?: boolean; account_id?: string }>("/api/connectors/stripe", { api_key: apiKey }));
}

export type DbType = "postgres" | "mongodb" | "mysql" | "dynamodb";
export type OperatorDbResult = {
  ok?: boolean;
  write_capable?: "true" | "false" | "unknown";
  discovery_error?: string;
  error?: { code?: string; message?: string };
};

export async function connectOperatorDb(type: DbType, connectionString: string): Promise<OperatorDbResult> {
  const body = await post<OperatorDbResult>("/api/connectors/operator-db", {
    type,
    connection_string: connectionString,
  });
  if (body?.error && !body.discovery_error) okOrThrow(body);
  return body ?? {};
}

export type PosthogProject = { id: string; name: string };
export type PosthogConnectResult = { ok?: boolean };

export async function posthogProjects(apiKey: string, region: "us" | "eu"): Promise<PosthogProject[]> {
  const body = okOrThrow(await post<{ projects?: PosthogProject[] }>("/api/connectors/posthog/projects", { api_key: apiKey, region }));
  return body.projects ?? [];
}

export async function posthogConnect(apiKey: string, region: "us" | "eu", projectId: string): Promise<PosthogConnectResult> {
  return okOrThrow(
    await post<PosthogConnectResult>("/api/connectors/posthog/connect", { api_key: apiKey, region, project_id: projectId }),
  );
}

export type SentryProject = { id: string; slug: string; name: string };
export type SentryConnectResult = { ok?: boolean; org_slug?: string; projects?: SentryProject[] };

export async function connectSentry(authToken: string, orgSlug: string): Promise<SentryConnectResult> {
  return okOrThrow(
    await post<SentryConnectResult>("/api/connectors/sentry", { auth_token: authToken, org_slug: orgSlug.trim() }),
  );
}

export type FigmaConnectResult = { ok?: boolean; handle?: string | null };

export async function connectFigma(apiKey: string): Promise<FigmaConnectResult> {
  return okOrThrow(await post<FigmaConnectResult>("/api/connectors/figma", { api_key: apiKey }));
}

export type SupabaseProject = { ref: string; name: string; region: string; status: string };
export type SupabaseConnectResult = { ok?: boolean; project_name?: string };

export async function supabaseProjects(accessToken: string): Promise<SupabaseProject[]> {
  const body = okOrThrow(await post<{ projects?: SupabaseProject[] }>("/api/connectors/supabase/projects", { access_token: accessToken }));
  return body.projects ?? [];
}

export async function supabaseConnect(accessToken: string, projectRef: string): Promise<SupabaseConnectResult> {
  return okOrThrow(
    await post<SupabaseConnectResult>("/api/connectors/supabase/connect", { access_token: accessToken, project_ref: projectRef }),
  );
}

export function disconnectConnector(path: string): Promise<{ ok?: boolean }> {
  return apiJson(path, { method: "POST" });
}
