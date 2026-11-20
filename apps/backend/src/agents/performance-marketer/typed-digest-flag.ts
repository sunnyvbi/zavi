
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export async function isPerfmktTypedDigestEnabled(
  tenant_id: string,
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
    const raw = blob.perfmkt_typed_digest_enabled;

    if (raw === true) return true;

    if (typeof raw === "string") {
      const allowed = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return allowed.includes(tenant_id);
    }

    return false;
  } catch {
    return false;
  }
}
