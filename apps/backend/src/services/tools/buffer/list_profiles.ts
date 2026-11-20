
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { serviceClient } from "@/services/supabase";

const inputSchema = z.object({});

type BufferConnectionRow = {
  workspace_id: string;
  profile_ids: string[];
  scopes: string[];
  refresh_token: string;
  last_revoked_at: string | null;
};

async function loadBufferConnection(
  tenant_id: string,
): Promise<BufferConnectionRow | null> {
  const svc = serviceClient();
  const { data, error } = await svc.rpc("get_buffer_connection", {
    p_tenant_id: tenant_id,
  });
  if (error) {
    return null;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as BufferConnectionRow;
}

export const listProfilesTool: ToolSpec = {
  name: "buffer_list_profiles",
  effect: "read",
  description:
    "List the tenant's connected Buffer social profiles (channel + handle + status). Read-only. Throws buffer_not_connected if the tenant has not yet completed the Buffer OAuth flow — the agent should fall back to the not-connected digest path in that case.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const conn = await loadBufferConnection(ctx.tenant_id);
    if (!conn || conn.last_revoked_at) {
      throw new ExpectedToolError(
        "buffer_not_connected",
        "Buffer is not connected for this tenant — no scheduling or publishing through Buffer. " +
          "This does NOT block drafting: fall back to the not-connected path and write the posts " +
          "from the public profile read, which is the intended basis for them. Only mention " +
          "connecting Buffer in /settings if the operator specifically asks to SCHEDULE or PUBLISH.",
      );
    }
    return {
      workspace_id: conn.workspace_id,
      profiles: conn.profile_ids.map((id) => ({
        id,
        channel: "unknown",
        display_name: id,
      })),
      scopes: conn.scopes,
    };
  },
};
