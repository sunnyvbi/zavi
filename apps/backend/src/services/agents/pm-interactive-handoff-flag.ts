
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export async function isPmInteractiveHandoffEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.pm_interactive_handoff === true;
  } catch {
    return false;
  }
}
