
import { getSecret } from "@/services/secrets/vault";
import { serviceClient } from "@/services/supabase";
import { ExpectedToolError } from "@/services/tools/types";

const SLACK_API = "https://slack.com/api";
const SLACK_API_TIMEOUT_MS = 10_000;
const SLACK_DOWNLOAD_TIMEOUT_MS = 15_000;

async function resolveSlackToken(
  tenant_id: string,
  team_id?: string,
  noLegacyFallback = false,
): Promise<string | null> {
  if (noLegacyFallback) {
    if (!team_id) return null;
    return getSecret(tenant_id, `slack.bot_token:${team_id}`);
  }

  let resolvedTeamId = team_id;
  if (!resolvedTeamId) {
    const sc = serviceClient();
    const { data } = await sc
      .from("slack_workspaces")
      .select("team_id, is_primary, connected_at")
      .eq("tenant_id", tenant_id)
      .order("is_primary", { ascending: false })
      .order("connected_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    resolvedTeamId = (data as { team_id?: string } | null)?.team_id;
  }

  if (resolvedTeamId) {
    const keyed = await getSecret(tenant_id, `slack.bot_token:${resolvedTeamId}`);
    if (keyed) return keyed;
  }
  return getSecret(tenant_id, "slack.bot_token");
}

export async function downloadSlackFileBytes(
  tenant_id: string,
  url: string,
  team_id?: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<Buffer | null> {
  try {
    const isSlackHost = (u: string): boolean => {
      try {
        const h = new URL(u).hostname;
        return h === "slack.com" || h.endsWith(".slack.com");
      } catch {
        return false;
      }
    };
    if (!isSlackHost(url)) return null;

    const token = await resolveSlackToken(tenant_id, team_id);
    if (!token) return null;

    let resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(SLACK_DOWNLOAD_TIMEOUT_MS),
    });
    let hops = 0;
    while (
      (resp.status === 301 || resp.status === 302 || resp.status === 303 ||
        resp.status === 307 || resp.status === 308) &&
      hops < 3
    ) {
      const loc = resp.headers.get("location");
      if (!loc) return null;
      const next = new URL(loc, url).toString();
      if (!next.startsWith("https://")) return null;
      resp = await fetch(next, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(SLACK_DOWNLOAD_TIMEOUT_MS),
      });
      hops++;
    }
    if (!resp.ok) return null;

    const declared = Number(resp.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return null;

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
    return buf;
  } catch {
    return null;
  }
}

export async function slackFetch<T = Record<string, unknown>>(
  tenant_id: string,
  method: string,
  body: Record<string, string | number | boolean | undefined> = {},
  team_id?: string,
  opts?: { noLegacyFallback?: boolean },
): Promise<T> {
  const token = await resolveSlackToken(
    tenant_id,
    team_id,
    opts?.noLegacyFallback ?? false,
  );
  if (!token) {
    throw new ExpectedToolError(
      "slack_not_connected",
      "Slack is not connected for this workspace. Visit /connectors to connect.",
    );
  }

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    form.set(k, String(v));
  }

  let resp: Response;
  try {
    resp = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new ExpectedToolError(
        "slack_timeout",
        `Slack API ${method} timed out after ${SLACK_API_TIMEOUT_MS}ms`,
        { slack_method: method },
      );
    }
    throw e;
  }

  if (!resp.ok) {
    throw new ExpectedToolError(
      "slack_http",
      `Slack API ${method} returned HTTP ${resp.status}`,
      { status: resp.status, slack_method: method },
    );
  }

  const json = (await resp.json()) as Record<string, unknown> & {
    ok?: boolean;
    error?: string;
  };
  if (json.ok !== true) {
    throw new ExpectedToolError(
      "slack_api_error",
      `Slack API ${method} not ok: ${String(json.error ?? "unknown")}`,
      { slack_method: method, slack_error: String(json.error ?? "unknown") },
    );
  }

  return json as unknown as T;
}
