export const DIGEST_CHANNEL_NAMES = ["zavi-updates", "zavi"] as const;

import { callMcpTool } from "@/services/mcp/execute";

export async function resolveZaviChannel(
  tenant_id: string,
  agent_run_id: string,
): Promise<string | null> {
  try {
    const r = await callMcpTool(
      { tenant_id, run_id: agent_run_id },
      "slack",
      "list_channels",
      {},
    );
    if (r.is_error) return null;
    const parsed = JSON.parse(r.content) as {
      channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
    };
    const live = (parsed.channels ?? []).filter(
      (c) => !c.is_archived && !!c.id && !!c.name,
    );
    for (const name of DIGEST_CHANNEL_NAMES) {
      const hit = live.find((c) => c.name === name);
      if (hit?.id) return hit.id;
    }
    return null;
  } catch (e) {
    console.warn(
      `[resolve-zavi-channel] channel resolve failed for tenant ${tenant_id}: ${(e as Error).message}`,
    );
    return null;
  }
}
