import { composioProxy } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { getConnectorToken } from "@/services/connectors/core/token";
import { INSTAGRAM_GRAPH_URL, INSTAGRAM_GRAPH_VERSION, INSTAGRAM_SOCIAL_SLUG, INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY } from "./constants";

type ReadResult = { ok: boolean; status: number; json: Record<string, unknown> };
export type InstagramReader = (path: string, params: Record<string, string>) => Promise<ReadResult>;

export async function resolveInstagramReader(tenantId: string): Promise<InstagramReader | null> {
  const account = await resolveOwnedComposioAccount(tenantId, "instagram");
  const token = account ? null : await getConnectorToken(tenantId, INSTAGRAM_SOCIAL_SLUG, INSTAGRAM_SOCIAL_ACCESS_TOKEN_KEY);
  if (!account && !token) return null;
  return async (path, params) => {
    const url = new URL(`${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_GRAPH_VERSION}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (account) return composioProxy({ account, method: "GET", endpoint: url.toString() });
    const response = await fetch(url.toString(), {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    let json: Record<string, unknown>;
    try { json = await response.json() as Record<string, unknown>; }
    catch { return { ok: false, status: 502, json: { error: { message: "Instagram returned an invalid response." } } }; }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return { ok: false, status: 502, json: { error: { message: "Instagram returned an invalid response." } } };
    }
    return { ok: response.ok && !json.error, status: response.status, json };
  };
}
