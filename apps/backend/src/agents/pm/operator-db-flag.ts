
import { serviceClient } from "@/services/supabase";

export function shouldDenyPmOperatorDb(args: {
  agentSlug: string;
  toolName: string;
  flagEnabled: boolean | undefined;
}): boolean {
  if (args.agentSlug !== "pm") return false;
  const isOperatorDbTool =
    args.toolName.startsWith("operator_db__") ||
    args.toolName.includes("__operator_db__");
  if (!isOperatorDbTool) return false;
  return args.flagEnabled !== true;
}

export async function isPmOperatorDbEnabled(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.pm_operator_db_enabled !== false;
  } catch {
    return false;
  }
}
