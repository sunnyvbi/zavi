
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import { SUPABASE_VAULT_KEYS, SUPABASE_MANAGEMENT_API_BASE } from "./keys";

const REQUEST_TIMEOUT_MS = 30_000;

export type SupabaseCreds = {
  access_token: string;
  project_ref: string;
};

export async function supabaseCreds(tenant_id: string): Promise<SupabaseCreds> {
  const [accessToken, projectRef] = await Promise.all([
    getSecret(tenant_id, SUPABASE_VAULT_KEYS.access_token),
    getSecret(tenant_id, SUPABASE_VAULT_KEYS.project_ref),
  ]);

  if (!accessToken || !projectRef) {
    throw new ExpectedToolError(
      "supabase_not_connected",
      "Supabase is not connected for this workspace. The operator connects it at Settings → Connectors → Supabase by pasting a personal access token and picking a project. Until then, Supabase project/config/logs questions cannot be answered.",
      {
        next_step: "operator_action",
        unblockers: ["Connect Supabase at Settings → Connectors"],
      },
    );
  }

  return { access_token: accessToken, project_ref: projectRef };
}

function sanitizedFetchFailure(): never {
  throw new ExpectedToolError(
    "supabase_unreachable",
    "The Supabase Management API did not respond within 30s. Retry, or check status.supabase.com.",
    { next_step: "retry" },
  );
}

export async function supabaseManagementGet(
  tenant_id: string,
  pathAfterRef: string,
  query?: Record<string, string>,
): Promise<unknown> {
  const creds = await supabaseCreds(tenant_id);
  const url = new URL(
    `${SUPABASE_MANAGEMENT_API_BASE}/projects/${encodeURIComponent(creds.project_ref)}${pathAfterRef}`,
  );
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.access_token}` },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    sanitizedFetchFailure();
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error("supabase_management_api_failed", { tenant_id, status: res.status, path: pathAfterRef });
    if (res.status === 401 || res.status === 403) {
      throw new ExpectedToolError(
        "supabase_token_rejected",
        "Supabase rejected the stored personal access token (401/403). It was revoked or expired. Reconnect Supabase at Settings → Connectors.",
        { next_step: "operator_action", unblockers: ["Reconnect Supabase with a valid personal access token"] },
      );
    }
    if (res.status === 404) {
      throw new ExpectedToolError(
        "supabase_project_not_found",
        "The connected Supabase project was not found (it may have been deleted or transferred). Reconnect Supabase at Settings → Connectors.",
        { next_step: "operator_action", unblockers: ["Reconnect Supabase and re-pick the project"] },
      );
    }
    if (res.status === 429) {
      throw new ExpectedToolError(
        "supabase_rate_limited",
        "The Supabase Management API rate-limited this request. Retry shortly.",
        { next_step: "retry" },
      );
    }
    throw new ExpectedToolError(
      "supabase_query_failed",
      `The Supabase Management API returned HTTP ${res.status}.`,
      { next_step: "revise_input" },
    );
  }

  return res.json();
}
