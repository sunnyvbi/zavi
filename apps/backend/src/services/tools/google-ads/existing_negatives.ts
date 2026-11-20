
import { z } from "zod";
import { gadsSearch } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

type CriterionRow = {
  campaign?: { id?: string; name?: string; status?: string };
  adGroup?: { id?: string; name?: string; status?: string };
  campaignCriterion?: { status?: string; keyword?: { text?: string; matchType?: string } };
  adGroupCriterion?: { status?: string; keyword?: { text?: string; matchType?: string } };
  sharedSet?: { id?: string; name?: string; status?: string; referenceCount?: string };
  sharedCriterion?: { keyword?: { text?: string; matchType?: string } };
};

type Negative = {
  keyword: string;
  match_type: string;
  level: "campaign" | "ad_group" | "shared_list";
  scope: string;
  blocking: boolean;
};

export const existingNegativesTool: ToolSpec = {
  name: "google_ads_existing_negatives",
  effect: "read",
  description:
    "List the negative keywords already blocking on the Google Ads account — campaign level, ad-group level, and shared negative keyword lists — with match type and scope. Removed criteria are excluded, and criteria belonging to a shared list attached to no campaign are returned but marked non-blocking and kept out of the dedupe index. Use before proposing any negative so the deliverable never re-proposes a term the account already blocks. Reports which levels were read; a level that failed to read is NOT a level with no negatives. Throws google_ads_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx) {
    const negatives: Negative[] = [];
    const levels_read: string[] = [];
    const levels_failed: Array<{ level: string; error: string }> = [];
    const unattached_lists = new Set<string>();

    const attempt = async (
      level: Negative["level"],
      query: string,
      map: (r: CriterionRow) => Negative | null,
    ) => {
      try {
        const rows = (await gadsSearch(ctx.tenant_id, query)) as CriterionRow[];
        for (const r of rows) {
          const n = map(r);
          if (n && n.keyword) negatives.push(n);
        }
        levels_read.push(level);
      } catch (e) {
        levels_failed.push({ level, error: e instanceof Error ? e.message : String(e) });
      }
    };

    await attempt(
      "campaign",
      `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign_criterion.status,
          campaign_criterion.keyword.text,
          campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign_criterion.negative = TRUE
          AND campaign_criterion.type = 'KEYWORD'
          AND campaign_criterion.status != 'REMOVED'
          AND campaign.status != 'REMOVED'
        LIMIT 2000
      `,
      (r) => ({
        keyword: r.campaignCriterion?.keyword?.text ?? "",
        match_type: r.campaignCriterion?.keyword?.matchType ?? "",
        level: "campaign",
        scope: r.campaign?.name ?? r.campaign?.id ?? "",
        blocking: true,
      }),
    );

    await attempt(
      "ad_group",
      `
        SELECT
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group.status,
          ad_group_criterion.status,
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.negative = TRUE
          AND ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.status != 'REMOVED'
          AND ad_group.status != 'REMOVED'
        LIMIT 2000
      `,
      (r) => ({
        keyword: r.adGroupCriterion?.keyword?.text ?? "",
        match_type: r.adGroupCriterion?.keyword?.matchType ?? "",
        level: "ad_group",
        scope: `${r.campaign?.name ?? ""} / ${r.adGroup?.name ?? r.adGroup?.id ?? ""}`.trim(),
        blocking: true,
      }),
    );

    await attempt(
      "shared_list",
      `
        SELECT
          shared_set.id,
          shared_set.name,
          shared_set.status,
          shared_set.reference_count,
          shared_criterion.keyword.text,
          shared_criterion.keyword.match_type
        FROM shared_criterion
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
          AND shared_set.status != 'REMOVED'
        LIMIT 2000
      `,
      (r) => {
        const attached = Number(r.sharedSet?.referenceCount ?? 0) > 0;
        const name = r.sharedSet?.name ?? r.sharedSet?.id ?? "";
        if (!attached && name) unattached_lists.add(name);
        return {
          keyword: r.sharedCriterion?.keyword?.text ?? "",
          match_type: r.sharedCriterion?.keyword?.matchType ?? "",
          level: "shared_list",
          scope: name,
          blocking: attached,
        };
      },
    );

    const blocked_index = [
      ...new Set(negatives.filter((n) => n.blocking).map((n) => normalise(n.keyword))),
    ].sort();

    return {
      levels_read,
      levels_failed,
      complete: levels_failed.length === 0,
      total: negatives.length,
      blocking_total: negatives.filter((n) => n.blocking).length,
      by_level: {
        campaign: negatives.filter((n) => n.level === "campaign").length,
        ad_group: negatives.filter((n) => n.level === "ad_group").length,
        shared_list: negatives.filter((n) => n.level === "shared_list").length,
      },
      unattached_lists: [...unattached_lists],
      unattached_lists_note: unattached_lists.size
        ? "These shared negative lists are attached to NO campaign, so nothing in them blocks anything. Their terms are excluded from blocked_index and this is a finding worth raising: someone built the list and never applied it."
        : null,
      negatives,
      blocked_index,
      dedupe_note:
        "blocked_index holds only criteria that actually block, and is case- and whitespace-normalised ONLY. It is deliberately not stemmed: Google negative keywords do not match close variants, so 'job' and 'jobs' are two different blocks and an account holding one has NOT blocked the other. Proposing the missing plural is correct, not a duplicate.",
      exclusions_note:
        "REMOVED criteria, removed campaigns and removed ad groups are filtered out at the query, because a removed negative blocks nothing and counting it would suppress a correct recommendation.",
      completeness_note:
        levels_failed.length === 0
          ? null
          : `Only ${levels_read.join(", ") || "no"} level(s) were read. Treat the dedupe set as INCOMPLETE and say so when proposing negatives — a term missing from blocked_index may still be blocked at a level that failed to read.`,
    };
  },
};

function normalise(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, " ");
}
