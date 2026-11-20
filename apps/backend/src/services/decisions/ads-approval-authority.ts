
export const ADS_CAP_BYPASS_CLASSES: ReadonlySet<string> = new Set([
  "meta_ads.update_ad_set_budget",
  "meta_ads.update_ad_set_budget_review",
  "meta_ads.update_campaign_budget",
  "meta_ads.update_campaign_budget_review",
  "meta_ads.set_status",
  "meta_ads.set_status_review",
  "meta_ads.create_ad_set",
  "meta_ads.create_campaign",
  "meta_ads.duplicate_ad_set",
  "meta_ads.duplicate_campaign",
  "meta_ads.launch_campaign",
  "google_ads.update_campaign_budget",
  "google_ads.update_campaign_budget_review",
  "google_ads.set_status",
  "google_ads.set_status_review",
  "google_ads.create_campaign",
]);

export const NON_TENANT_APPROVAL_SOURCES: ReadonlySet<string> = new Set(["staff", "cgo"]);

export const TENANT_HUMAN_APPROVAL_SOURCES: ReadonlySet<string | null> = new Set([null, "email"]);

export function isTenantHumanApproval(d: { approved_by?: string | null; approved_by_source?: string | null }): boolean {
  return (
    typeof d.approved_by === "string" &&
    d.approved_by !== "" &&
    d.approved_by_source !== undefined &&
    TENANT_HUMAN_APPROVAL_SOURCES.has(d.approved_by_source)
  );
}

export function capGovernsDispatch(d: {
  decision_class: string;
  approved_by?: string | null;
  approved_by_source?: string | null;
}): boolean {
  const tenantHumanApproved = isTenantHumanApproval(d);
  const isAdsClass = ADS_CAP_BYPASS_CLASSES.has(d.decision_class);
  return !(tenantHumanApproved && isAdsClass);
}
