import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";

const IP_SALT = process.env.MCP_IP_HASH_SALT ?? "praxis-mcp-ip";

export type McpCallCode =
  | "ok"
  | "error"
  | "rate_limited"
  | "unauthorized"
  | "scope_denied"
  | "anomaly";

export type McpAuditActor = {
  user_id: string;
  tenant_id: string;
  credential_kind: "pat" | "oauth";
  pat_id: string | null;
  oauth_access_token_id: string | null;
};

export async function recordMcpCall(
  actor: McpAuditActor,
  tool: string,
  args: unknown,
  ms: number,
  code: McpCallCode,
  ip?: string,
): Promise<void> {
  const args_hash =
    args === undefined
      ? null
      : createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex");
  const ip_hash = ip
    ? createHash("sha256").update(IP_SALT).update(ip).digest("hex")
    : null;
  const { error } = await serviceClient()
    .from("mcp_tool_calls")
    .insert({
      pat_id: actor.pat_id,
      oauth_access_token_id: actor.oauth_access_token_id,
      credential_kind: actor.credential_kind,
      user_id: actor.user_id,
      tenant_id: actor.tenant_id,
      tool,
      args_hash,
      ip_hash,
      ms,
      code,
    });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`[mcp-audit] insert failed (${tool}/${code}): ${error.message}`);
  }
}
