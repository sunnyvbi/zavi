import { z } from "zod";
import { canonicalTargeting, listLinkedInSavedAudiences, msToIso, readLinkedInCampaignTargeting, type LiCampaignTargeting, type LiTargetTemplate } from "@/services/connectors/linkedin-ads/account-reads";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { linkedinAccountAccess } from "./_wallet";

const USAGE_STATUSES = ["ACTIVE", "PAUSED", "DRAFT", "COMPLETED"] as const;

export type LinkedInSavedAudience = {
  id: string;
  name: string;
  approximate_member_count: number | null;
  created_at: string | null;
  last_modified_at: string | null;
  days_since_modified: number | null;
  in_use: boolean | null;
  used_by_campaigns: Array<{ campaign_id: string; campaign_name: string; status: string | null }> | null;
  targeting_criteria: unknown;
};

const daysSince = (ms: number | undefined, now: Date): number | null => (typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000)) : null);

export function mapSavedAudiences(templates: LiTargetTemplate[], campaigns: LiCampaignTargeting[] | null, now = new Date()): LinkedInSavedAudience[] {
  const byShape = new Map<string, Array<{ campaign_id: string; campaign_name: string; status: string | null }>>();
  for (const c of campaigns ?? []) {
    if (c.targetingCriteria === undefined || c.id === undefined) continue;
    const key = canonicalTargeting(c.targetingCriteria);
    byShape.set(key, [...(byShape.get(key) ?? []), { campaign_id: String(c.id), campaign_name: c.name ?? String(c.id), status: c.status ?? null }]);
  }
  return templates.map((t) => {
    const used = campaigns === null ? null : (byShape.get(canonicalTargeting(t.targetingCriteria)) ?? []);
    return {
      id: String(t.id ?? ""),
      name: t.name ?? "(unnamed)",
      approximate_member_count: typeof t.approximateMemberCount === "number" ? t.approximateMemberCount : null,
      created_at: msToIso(t.created),
      last_modified_at: msToIso(t.lastModified),
      days_since_modified: daysSince(t.lastModified, now),
      in_use: used === null ? null : used.length > 0,
      used_by_campaigns: used,
      targeting_criteria: t.targetingCriteria ?? null,
    };
  });
}

const inputSchema = z
  .object({
    account_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
      .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
  })
  .strict();

export const LINKEDIN_SAVED_AUDIENCES_METHOD =
  "LinkedIn saves an audience as a targeting template and records nothing about where it is used. in_use is Zavi's own cross-reference: a template is in use when a campaign in the account (active, paused, draft or completed) carries exactly the same targeting criteria, so a campaign that started from a template and was then edited no longer counts as using it. When the campaign read failed, in_use is null and usage_available is false; say unknown, never unused.";

export const linkedinAdsListSavedAudiencesTool: ToolSpec = {
  name: "linkedin_ads_list_saved_audiences",
  effect: "read",
  description:
    "List the saved audiences (targeting templates) on one LinkedIn Ads account with their estimated size, when they were built and last changed, and which campaigns use each one (in_use, used_by_campaigns). Use it for the account-structure check: an audience built but never used is a free lever or dead weight, and summary.unused_ids names them. in_use is matched on identical targeting criteria; when usage_available is false the campaign read failed, in_use is null and nothing may be called unused. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id } = inputSchema.parse(input);
    const access = await linkedinAccountAccess(ctx.tenant_id, account_id);
    if (access.kind === "wallet")
      throw new ExpectedToolError("linkedin_ads_shared_account", "Saved audiences live on Zavi's shared LinkedIn ad account and are not this workspace's to read. Pick an audience when you launch a campaign instead.");
    const [templates, campaigns] = await Promise.all([
      listLinkedInSavedAudiences(ctx.tenant_id, account_id),
      readLinkedInCampaignTargeting(ctx.tenant_id, account_id, USAGE_STATUSES).then((c) => c as LiCampaignTargeting[] | null, () => null),
    ]);
    const audiences = mapSavedAudiences(templates, campaigns);
    return {
      account_id,
      usage_available: campaigns !== null,
      audiences,
      summary: {
        total: audiences.length,
        in_use: campaigns === null ? null : audiences.filter((a) => a.in_use === true).length,
        unused_ids: campaigns === null ? null : audiences.filter((a) => a.in_use === false).map((a) => a.id),
        campaigns_checked: campaigns?.length ?? null,
      },
      method: LINKEDIN_SAVED_AUDIENCES_METHOD,
    };
  },
};
