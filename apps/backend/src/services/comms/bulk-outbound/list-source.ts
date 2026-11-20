
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { BULK_COHORT_HARD_CAP, type CohortRecord, type CohortSource } from "./cohort";

export function makeListCohortSource(list: { listId: string; versionId: string }): CohortSource {
  return {
    async fetchCandidates(tenant_id: string): Promise<CohortRecord[]> {
      const tid = asTenantId(tenant_id);
      const { data: version, error: versionErr } = await tenantClient(tid)
        .from("email_list_versions")
        .select("id, consent_confirmed_at")
        .eq("id", list.versionId)
        .eq("list_id", list.listId)
        .maybeSingle();
      if (versionErr) throw new Error("bulk list version read failed");
      if (!version) return [];
      const consented = !!(version as { consent_confirmed_at: string | null }).consent_confirmed_at;

      const { data, error } = await tenantRpc(tid, "email_list_version_emails", {
        p_list_id: list.listId,
        p_version_id: list.versionId,
        p_limit: BULK_COHORT_HARD_CAP + 1,
      });
      if (error) throw new Error("bulk list read failed");
      const emails = Array.isArray(data) ? (data as unknown[]) : [];
      return emails
        .filter((e): e is string => typeof e === "string")
        .map((email) => (consented ? { email, opt_in_marketing: true } : { email }));
    },
  };
}
