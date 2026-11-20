import type { staffCrossTenantClient } from "@/services/tenant-client";
import {
  parseSignupAttribution,
  SIGNUP_ATTRIBUTION_KEY,
} from "./signup-attribution";
import { resolveSignupSource, type SignupSource } from "./signup-source";

type SourceDetails = { source: SignupSource; source_detail: string | null };

export async function readSignupSources(
  db: ReturnType<typeof staffCrossTenantClient>,
  tenantIds: string[],
): Promise<Map<string, SourceDetails>> {
  const result = new Map<string, SourceDetails>();
  const ids = [...new Set(tenantIds)];
  for (let at = 0; at < ids.length; at += 100) {
    const batch = ids.slice(at, at + 100);
    const [settings, referrals] = await Promise.all([
      db
        .from("tenant_app_setting")
        .select("tenant_id, value")
        .eq("key", SIGNUP_ATTRIBUTION_KEY)
        .in("tenant_id", batch)
        .limit(100),
      db
        .from("affiliate_referrals")
        .select("tenant_id, member_id")
        .in("tenant_id", batch)
        .limit(100),
    ]);
    if (settings.error || referrals.error)
      throw new Error("Signup source read failed");
    const creatorIds = [
      ...new Set((referrals.data ?? []).map((r) => r.member_id as string)),
    ];
    const names = new Map<string, string | null>();
    if (creatorIds.length) {
      const members = await db
        .from("human_members")
        .select("id, display_name")
        .in("id", creatorIds)
        .limit(100);
      if (members.error) throw new Error("Signup creator read failed");
      for (const member of members.data ?? [])
        names.set(member.id, member.display_name);
    }
    const byTenant = new Map(
      (settings.data ?? []).map((r) => [r.tenant_id, r.value]),
    );
    const byReferral = new Map(
      (referrals.data ?? []).map((r) => [
        r.tenant_id,
        { member_id: r.member_id, display_name: names.get(r.member_id) },
      ]),
    );
    for (const id of batch) {
      const raw = byTenant.get(id);
      const source = resolveSignupSource(raw, byReferral.get(id));
      const a = parseSignupAttribution(raw);
      let detail: string | null = null;
      if (source.kind === "unknown") {
        if (a?.capture_status === "analytics_disabled")
          detail = "Browser reported analytics disabled";
        else if (a?.capture_status === "storage_unavailable")
          detail = "Browser attribution storage unavailable";
        else if (a?.capture_status === "not_captured")
          detail = "Browser did not capture a source";
        else if (
          a?.landing_path &&
          /^\/(login|auth)(\/|$)/.test(a.landing_path)
        )
          detail = "Only a sign-in page was captured";
        else
          detail = a
            ? "Captured details do not identify a source"
            : raw == null
              ? "No recorded source"
              : "Stored source details are invalid";
      }
      result.set(id, { source, source_detail: detail });
    }
  }
  return result;
}
