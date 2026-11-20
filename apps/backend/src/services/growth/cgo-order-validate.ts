
import type { z } from "zod";

type Check = (body: unknown) => string | null;

const zodCheck =
  (schema: z.ZodTypeAny): Check =>
  (body) => {
    const r = schema.safeParse(body);
    return r.success
      ? null
      : r.error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ");
  };

async function checkFor(exec_class: string): Promise<Check | null> {
  if (exec_class.startsWith("meta_ads.")) {
    const m = await import("@/services/tools/meta-ads/write/_decision-bodies");
    const by: Record<string, z.ZodTypeAny> = {
      "meta_ads.update_ad_set_budget": m.updateAdSetBudgetBodySchema,
      "meta_ads.update_campaign_budget": m.updateCampaignBudgetBodySchema,
      "meta_ads.set_status": m.setStatusBodySchema,
      "meta_ads.create_ad_set": m.createAdSetBodySchema,
      "meta_ads.duplicate_ad_set": m.duplicateAdSetBodySchema,
      "meta_ads.duplicate_campaign": m.duplicateCampaignBodySchema,
      "meta_ads.create_custom_audience": m.createCustomAudienceBodySchema,
      "meta_ads.create_ad": m.createAdBodySchema,
    };
    return by[exec_class] ? zodCheck(by[exec_class]!) : null;
  }
  if (exec_class.startsWith("google_ads.")) {
    const g =
      await import("@/services/tools/google-ads/write/_decision-bodies");
    const by: Record<string, z.ZodTypeAny> = {
      "google_ads.update_campaign_budget": g.updateCampaignBudgetBodySchema,
      "google_ads.set_status": g.googleSetStatusBodySchema,
    };
    return by[exec_class] ? zodCheck(by[exec_class]!) : null;
  }
  if (exec_class === "linkedin_ads.launch_campaign")
    return zodCheck(
      (await import("@/services/ads-wallet/linkedin-growth"))
        .linkedinLaunchBody,
    );
  if (exec_class.startsWith("chatgpt_ads.")) {
    const { parseGrowthAction, CHATGPT_GROWTH_CLASSES } =
      await import("@/services/connectors/chatgpt-ads/growth-actions");
    if (!CHATGPT_GROWTH_CLASSES.has(exec_class)) return null;
    return (body) => {
      try {
        parseGrowthAction(exec_class, body);
        return null;
      } catch (e) {
        return (e as Error).message.slice(0, 300);
      }
    };
  }
  return null;
}

export async function orderBodyProblem(
  exec_class: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  try {
    const check = await checkFor(exec_class);
    if (!check) return `no body check for ${exec_class}`;
    return check(body);
  } catch (e) {
    return `body check failed: ${(e as Error).message.slice(0, 200)}`;
  }
}
