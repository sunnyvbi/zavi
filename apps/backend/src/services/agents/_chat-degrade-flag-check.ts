
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export async function isConnectorWallChatDegradeEnabled(
  sb?: Sb,
): Promise<boolean> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.connector_wall_chat_degrade_enabled !== false;
  } catch {
    return false;
  }
}

export async function isConnectorRequestEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return true;
    return (data?.blob ?? {}).connector_request_enabled !== false;
  } catch {
    return true;
  }
}
