
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export async function isUrgentFlagsAsCardsEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.urgent_flags_as_cards_enabled === true;
  } catch {
    return false;
  }
}
