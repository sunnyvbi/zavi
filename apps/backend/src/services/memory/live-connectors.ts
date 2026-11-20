
import { logEvent } from "@/services/logging/logEvent";

type Sb = { from: (t: string) => any };

export async function liveConnectorsForTenant(sb: Sb, tenant_id: string): Promise<string[]> {
  try {
    const { data, error } = await sb
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", tenant_id);
    if (error) {
      void logEvent({
        level: "warn",
        source: "memory.live_connectors",
        code: "live_connectors_read_failed",
        meta: { tenant_id, stage: "query" },
      }).catch(() => {});
      return [];
    }
    if (!data) return [];
    return [
      ...new Set(
        (data as { slug?: unknown }[])
          .map((r) => (typeof r.slug === "string" ? r.slug.split(".").pop()! : ""))
          .filter(Boolean),
      ),
    ];
  } catch {
    void logEvent({
      level: "warn",
      source: "memory.live_connectors",
      code: "live_connectors_read_failed",
      meta: { tenant_id, stage: "exception" },
    }).catch(() => {});
    return [];
  }
}
