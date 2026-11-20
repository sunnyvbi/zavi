
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import { POSTHOG_VAULT_KEYS, POSTHOG_HOSTS, isPosthogRegion } from "./keys";

const REQUEST_TIMEOUT_MS = 30_000;

export type PosthogCreds = {
  api_key: string;
  project_id: string;
  host: string;
};

export async function posthogCreds(tenant_id: string): Promise<PosthogCreds> {
  const [apiKey, projectId, region] = await Promise.all([
    getSecret(tenant_id, POSTHOG_VAULT_KEYS.api_key),
    getSecret(tenant_id, POSTHOG_VAULT_KEYS.project_id),
    getSecret(tenant_id, POSTHOG_VAULT_KEYS.region),
  ]);

  if (!apiKey || !projectId || !region) {
    throw new ExpectedToolError(
      "posthog_not_connected",
      "PostHog is not connected for this workspace. The operator connects it at Settings → Connectors → PostHog by pasting a personal API key. Until then, product-analytics questions cannot be answered from PostHog.",
      {
        next_step: "operator_action",
        unblockers: ["Connect PostHog at Settings → Connectors"],
      },
    );
  }

  if (!isPosthogRegion(region)) {
    throw new ExpectedToolError(
      "posthog_not_connected",
      "The stored PostHog region is not recognized. Reconnect PostHog at Settings → Connectors.",
      { next_step: "operator_action", unblockers: ["Reconnect PostHog"] },
    );
  }

  return {
    api_key: apiKey,
    project_id: projectId.replace(/\D/g, ""),
    host: POSTHOG_HOSTS[region],
  };
}

export async function runHogqlQuery(
  tenant_id: string,
  query: string,
): Promise<{ columns: string[]; results: unknown[][] }> {
  const creds = await posthogCreds(tenant_id);
  const url = `${creds.host}/api/projects/${encodeURIComponent(creds.project_id)}/query/`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.api_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    throw new ExpectedToolError(
      "posthog_unreachable",
      "PostHog did not respond within 30s. Retry, or check status.posthog.com.",
      { next_step: "retry" },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error("posthog_query_failed", { tenant_id, status: res.status });
    if (res.status === 401 || res.status === 403) {
      throw new ExpectedToolError(
        "posthog_key_rejected",
        "PostHog rejected the stored API key (401/403). It was revoked, or it lacks the Query Read scope. Reconnect PostHog at Settings → Connectors.",
        { next_step: "operator_action", unblockers: ["Reconnect PostHog with a key that has Query Read scope"] },
      );
    }
    throw new ExpectedToolError(
      "posthog_query_failed",
      `PostHog returned HTTP ${res.status} for this query. Check the HogQL syntax and the table/column names.`,
      { next_step: "revise_input" },
    );
  }

  const json = (await res.json()) as { columns?: unknown; results?: unknown };
  const columns = Array.isArray(json.columns) ? json.columns.map((c) => String(c)) : [];
  const results = Array.isArray(json.results) ? (json.results as unknown[][]) : [];
  return { columns, results };
}
