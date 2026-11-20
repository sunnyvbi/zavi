
export const META_CONVERSION_OBJECTIVES = new Set([
  "OUTCOME_SALES", "OUTCOME_LEADS", "CONVERSIONS", "LEAD_GENERATION",
  "PRODUCT_CATALOG_SALES", "OUTCOME_APP_PROMOTION", "APP_INSTALLS",
]);
export const META_CONVERSION_GOALS = new Set([
  "OFFSITE_CONVERSIONS", "LEAD_GENERATION", "QUALITY_LEAD", "VALUE",
  "APP_INSTALLS", "CONVERSATIONS", "IN_APP_VALUE",
]);

const META_REACH_OBJECTIVES = new Set([
  "OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "BRAND_AWARENESS",
  "REACH", "LINK_CLICKS", "POST_ENGAGEMENT", "PAGE_LIKES", "VIDEO_VIEWS",
  "LOCAL_AWARENESS", "EVENT_RESPONSES",
]);
const META_REACH_GOALS = new Set([
  "REACH", "IMPRESSIONS", "AD_RECALL_LIFT", "LINK_CLICKS", "LANDING_PAGE_VIEWS",
  "THRUPLAY", "POST_ENGAGEMENT", "PAGE_LIKES", "EVENT_RESPONSES", "PROFILE_VISIT",
  "VISIT_INSTAGRAM_PROFILE",
]);

export type MetaJudgedOn = "conversions" | "reach_and_clicks" | "unknown";

export function metaJudgedOn(objective: string | null | undefined, goal?: string | null): MetaJudgedOn {
  if (goal) {
    if (META_CONVERSION_GOALS.has(goal)) return "conversions";
    if (META_REACH_GOALS.has(goal)) return "reach_and_clicks";
  }
  if (objective) {
    if (META_CONVERSION_OBJECTIVES.has(objective)) return "conversions";
    if (META_REACH_OBJECTIVES.has(objective)) return "reach_and_clicks";
  }
  return "unknown";
}
