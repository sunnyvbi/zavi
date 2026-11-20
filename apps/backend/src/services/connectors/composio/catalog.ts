import { composioFetch } from "./api";
import { getComposioAuthConfigId, getComposioMcpServerId } from "./api-key";
import { composioToolIsRead } from "./write-classify";

export type CatalogToolkit = {
  slug: string; name: string; logo: string; category: string | null;
  managed: string[]; schemes: string[]; no_auth: boolean;
};
const TTL_MS = 60 * 60 * 1000;
export const SHOPIFY_TOOLKIT_VERSION = "20261018_00";
export const API_KEY_CONNECT = true;
export const NO_AUTH_CONNECT = true;
const USER_SUPPLIED_SCHEMES = new Set(["API_KEY", "BEARER_TOKEN", "BASIC", "BASIC_WITH_JWT"]);
let memo: { at: number; items: CatalogToolkit[] } | null = null;
const authMemo = new Map<string, string>();
const mcpSynced = new Set<string>();
const toolsMemo = new Map<string, { at: number; slugs: ReadonlySet<string> }>();

export function _resetCatalogForTests(): void { memo = null; authMemo.clear(); mcpSynced.clear(); toolsMemo.clear(); }

export async function listComposioCatalog(): Promise<CatalogToolkit[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.items;
  const items: CatalogToolkit[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({ limit: "1000", ...(cursor ? { cursor } : {}) });
    const res = await composioFetch("GET", `/api/v3/toolkits?${qs}`);
    if (!res.ok) throw new Error(`composio toolkits HTTP ${res.status}`);
    const j = (await res.json()) as { items?: any[]; next_cursor?: string | null };
    for (const t of j.items ?? []) {
      if (typeof t?.slug !== "string" || t.deprecated === true) continue;
      items.push({
        slug: t.slug.toLowerCase(), name: String(t.name ?? t.slug),
        logo: String(t.meta?.logo ?? `https://logos.composio.dev/api/${t.slug}`),
        category: t.meta?.categories?.[0]?.name ?? null,
        managed: Array.isArray(t.composio_managed_auth_schemes) ? t.composio_managed_auth_schemes : [],
        schemes: Array.isArray(t.auth_schemes) ? t.auth_schemes : [],
        no_auth: t.no_auth === true,
      });
    }
    cursor = j.next_cursor ?? null;
    if (!cursor) break;
  }
  if (cursor) throw new Error("composio toolkits listing truncated (page cap hit)");
  memo = { at: Date.now(), items };
  return items;
}

export function isConnectable(t: Pick<CatalogToolkit, "slug" | "managed" | "schemes" | "no_auth">): boolean {
  if (t.no_auth) return NO_AUTH_CONNECT;
  if (getComposioAuthConfigId(t.slug)) return true;
  if (t.managed.length > 0) return true;
  return API_KEY_CONNECT && t.schemes.some((s) => USER_SUPPLIED_SCHEMES.has(s));
}

export async function lookupAuthConfigId(slug: string): Promise<string | null> {
  const s = slug.toLowerCase();
  const env = getComposioAuthConfigId(s);
  if (env && s !== "shopify") return env;
  const hit = authMemo.get(s);
  if (hit) return hit;
  const list = await composioFetch("GET", `/api/v3/auth_configs?${new URLSearchParams({ toolkit_slug: s })}`);
  if (!list.ok) throw new Error(`composio auth_configs HTTP ${list.status}`);
  const enabled = (((await list.json()) as { items?: Array<{ id?: string; status?: string; is_composio_managed?: boolean; auth_scheme?: string }> }).items ?? [])
    .filter((c) => c.id && (c.status ?? "ENABLED") === "ENABLED")
    .filter((c) => s !== "shopify" || (c.is_composio_managed !== true && c.auth_scheme === "BEARER_TOKEN"))
    .map((c) => c.id as string);
  let existing = enabled[0];
  if (enabled.length > 1) {
    const mcp = await composioFetch("GET", `/api/v3.1/mcp/${encodeURIComponent(getComposioMcpServerId())}`);
    if (!mcp.ok) throw new Error(`composio mcp get HTTP ${mcp.status}`);
    const onServer = ((await mcp.json()) as { auth_config_ids?: string[] }).auth_config_ids ?? [];
    existing = enabled.find((id) => onServer.includes(id)) ?? existing;
  }
  if (existing) authMemo.set(s, existing);
  return existing ?? null;
}

export async function ensureAuthConfigForConnect(t: Pick<CatalogToolkit, "slug" | "managed" | "schemes" | "no_auth">): Promise<string | null> {
  const found = await lookupAuthConfigId(t.slug);
  if (found) return found;
  if (t.slug === "shopify") return null;
  if (!isConnectable(t)) return null;
  const auth_config = t.managed.length > 0
    ? { type: "use_composio_managed_auth" }
    : t.no_auth
      ? { type: "use_custom_auth", authScheme: "NO_AUTH", credentials: {} }
      : { type: "use_custom_auth", authScheme: t.schemes.find((s) => USER_SUPPLIED_SCHEMES.has(s)), credentials: {} };
  const created = await composioFetch("POST", "/api/v3/auth_configs", { toolkit: { slug: t.slug }, auth_config });
  if (!created.ok) throw new Error(`composio auth_config create HTTP ${created.status}`);
  const id = ((await created.json()) as { auth_config?: { id?: string } }).auth_config?.id;
  if (!id) throw new Error("composio auth_config create: no id");
  authMemo.set(t.slug, id);
  return id;
}

export async function listToolkitToolSlugs(slug: string): Promise<ReadonlySet<string>> {
  const hit = toolsMemo.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.slugs;
  const out = new Set<string>();
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const isShopify = slug === "shopify";
    const qs = new URLSearchParams({
      toolkit_slug: slug,
      limit: "1000",
      ...(isShopify ? { toolkit_versions: SHOPIFY_TOOLKIT_VERSION } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const res = await composioFetch("GET", `${isShopify ? "/api/v3.1" : "/api/v3"}/tools?${qs}`);
    if (!res.ok) throw new Error(`composio tools HTTP ${res.status}`);
    const j = (await res.json()) as { items?: Array<{ slug?: string }>; next_cursor?: string | null };
    for (const t of j.items ?? []) if (typeof t.slug === "string") out.add(t.slug);
    cursor = j.next_cursor ?? null;
    if (!cursor) break;
  }
  if (cursor) throw new Error(`composio tools listing for ${slug} truncated (page cap hit)`);
  toolsMemo.set(slug, { at: Date.now(), slugs: out });
  return out;
}

export function parseInvalidMcpTools(body: string): Set<string> {
  let message = "";
  try { message = String((JSON.parse(body) as { error?: { message?: unknown } }).error?.message ?? ""); } catch { return new Set(); }
  const m = message.match(/^Invalid tools provided for MCP server[^:]*:\s*(.+)$/s);
  if (!m) return new Set();
  return new Set(m[1].split(".")[0].split(",").map((t) => t.trim()).filter((t) => /^[A-Z0-9_]+$/.test(t)));
}

const MCP_READS_ONLY: ReadonlySet<string> = new Set(["reddit", "pinterest"]);
const SHOPIFY_GRAPHQL_MCP_TOOLS: ReadonlySet<string> = new Set([
  "SHOPIFY_GRAPH_QL_SHOP",
  "SHOPIFY_GRAPH_QL_PRODUCTS",
  "SHOPIFY_GRAPH_QL_ORDERS",
  "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS",
]);

export function composioToolAllowedForMcp(slug: string, tool: string): boolean {
  const prefix = `${slug.toUpperCase()}_`;
  if (!tool.startsWith(prefix)) return true;
  if (slug === "shopify") return SHOPIFY_GRAPHQL_MCP_TOOLS.has(tool);
  return !MCP_READS_ONLY.has(slug) || composioToolIsRead(tool, slug, undefined);
}

async function authConfigIdsForToolkit(slug: string): Promise<ReadonlySet<string>> {
  const res = await composioFetch("GET", `/api/v3/auth_configs?${new URLSearchParams({ toolkit_slug: slug })}`);
  if (!res.ok) throw new Error(`composio auth configs HTTP ${res.status}`);
  const j = (await res.json()) as { items?: Array<{ id?: unknown }> };
  return new Set((j.items ?? []).flatMap((item) => typeof item.id === "string" ? [item.id] : []));
}

export async function ensureToolkitOnMcpServer(
  slug: string,
  authConfigId: string,
): Promise<{ toolsNotAdded: string | null }> {
  if (mcpSynced.has(slug)) return { toolsNotAdded: null };
  const sid = encodeURIComponent(getComposioMcpServerId());
  const cur = await composioFetch("GET", `/api/v3.1/mcp/${sid}`);
  if (!cur.ok) throw new Error(`composio mcp get HTTP ${cur.status}`);
  const j = (await cur.json()) as { auth_config_ids?: string[]; allowed_tools?: string[]; toolkits?: string[] };
  const ids = j.auth_config_ids ?? [];
  const current = j.allowed_tools ?? [];
  const kits = j.toolkits ?? [];
  if (current.length === 0) throw new Error("composio mcp allowed_tools empty/missing: refusing to PATCH (semantics unverified)");
  const allowed = (t: string) => composioToolAllowedForMcp(slug, t);
  const tools = current.filter(allowed);
  const want = [...(await listToolkitToolSlugs(slug))].filter(allowed);
  const missingTools = want.filter((t) => !tools.includes(t));
  const existingToolkitIds = slug === "shopify" ? await authConfigIdsForToolkit(slug) : null;
  const keptIds = existingToolkitIds
    ? ids.filter((id) => id === authConfigId || !existingToolkitIds.has(id))
    : ids;
  const desiredIds = keptIds.includes(authConfigId) ? keptIds : [...keptIds, authConfigId];
  const authConfigsChanged = desiredIds.length !== ids.length || desiredIds.some((id, index) => id !== ids[index]);
  if (authConfigsChanged || !kits.includes(slug) || missingTools.length > 0 || tools.length < current.length) {
    const body = {
      auth_config_ids: desiredIds,
      toolkits: kits.includes(slug) ? kits : [...kits, slug],
      allowed_tools: [...tools, ...missingTools],
    };
    let res = await composioFetch("PATCH", `/api/v3.1/mcp/${sid}`, body);
    let resText: string | null = null;
    if (res.status === 400) {
      resText = await res.text();
      const invalid = parseInvalidMcpTools(resText);
      if (invalid.size > 0) {
        res = await composioFetch("PATCH", `/api/v3.1/mcp/${sid}`, {
          ...body,
          allowed_tools: body.allowed_tools.filter((t) => !invalid.has(t)),
        });
        resText = null;
      }
    }
    if (!res.ok) {
      if (resText === null) resText = await res.text().catch(() => "");
      const detail = `composio mcp patch HTTP ${res.status}: ${resText.slice(0, 300)}`;
      const onlyToolsMissing =
        ids.includes(authConfigId) && kits.includes(slug) && tools.length === current.length &&
        want.some((t) => tools.includes(t));
      if (onlyToolsMissing) return { toolsNotAdded: detail };
      throw new Error(detail);
    }
  }
  mcpSynced.add(slug);
  return { toolsNotAdded: null };
}
