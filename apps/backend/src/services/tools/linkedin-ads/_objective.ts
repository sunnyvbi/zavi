import type { MetaJudgedOn } from "@/services/tools/meta-ads/_objective";

const LINKEDIN_CONVERSION_OBJECTIVES = new Set(["WEBSITE_CONVERSIONS", "LEAD_GENERATION", "TALENT_LEADS", "JOB_APPLICANT"]);
const LINKEDIN_REACH_OBJECTIVES = new Set(["BRAND_AWARENESS", "WEBSITE_VISIT", "ENGAGEMENT", "VIDEO_VIEW"]);

export function linkedinJudgedOn(objective: string | null | undefined): MetaJudgedOn {
  if (!objective) return "unknown";
  if (LINKEDIN_CONVERSION_OBJECTIVES.has(objective)) return "conversions";
  if (LINKEDIN_REACH_OBJECTIVES.has(objective)) return "reach_and_clicks";
  return "unknown";
}

export function linkedinGroupJudgedOn(objectives: Array<string | null | undefined>): { objective: string | null; judged_on: MetaJudgedOn } {
  const known = [...new Set(objectives.filter((o): o is string => typeof o === "string" && o.length > 0))];
  if (known.length !== 1) return { objective: null, judged_on: "unknown" };
  return { objective: known[0], judged_on: linkedinJudgedOn(known[0]) };
}
