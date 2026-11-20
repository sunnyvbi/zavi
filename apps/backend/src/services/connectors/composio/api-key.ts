
export function getComposioApiKey(): string {
  const k = process.env.COMPOSIO_API_KEY?.trim();
  if (!k) {
    throw new Error(
      "COMPOSIO_API_KEY missing. Set it in AWS Secrets Manager " +
        "praxis-envprod-1 (per apps/backend/CLAUDE.md) and restart the container.",
    );
  }
  return k;
}

export function getComposioMcpServerId(): string {
  const v = process.env.COMPOSIO_MCP_SERVER_ID?.trim();
  if (!v) {
    throw new Error(
      "COMPOSIO_MCP_SERVER_ID missing. Set it in AWS Secrets Manager " +
        "praxis-envprod-1 and restart.",
    );
  }
  return v;
}

export function getComposioAuthConfigId(toolkit: string): string | null {
  const raw = process.env.COMPOSIO_AUTH_CONFIGS?.trim();
  if (!raw) return null;
  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim().toLowerCase();
    const v = pair.slice(eq + 1).trim();
    if (k && v) map.set(k, v);
  }
  return map.get(toolkit.toLowerCase()) ?? null;
}

export function listComposioToolkits(): string[] {
  const raw = process.env.COMPOSIO_AUTH_CONFIGS?.trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim().toLowerCase();
    if (k) out.push(k);
  }
  return out;
}

export function buildComposioMcpUrl(tenant_id: string): string {
  const serverId = getComposioMcpServerId();
  return `https://backend.composio.dev/v3/mcp/${encodeURIComponent(serverId)}?user_id=${encodeURIComponent(tenant_id)}`;
}
