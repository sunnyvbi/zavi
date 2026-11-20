
import { createHash } from "node:crypto";
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { gadsMutateOperations, gadsSearch, type GadsOperation } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";

export const MAX_GEO_PLACES = 50;

export const GEO_LEVEL_BY_CHANNEL_TYPE: Readonly<Record<string, "campaign" | "ad_group">> = {
  SEARCH: "campaign",
  DISPLAY: "campaign",
  PERFORMANCE_MAX: "campaign",
  DEMAND_GEN: "ad_group",
};

export const replaceGeoTargetsBodySchema = z.object({
  campaign_id: z.string().regex(/^[0-9]+$/),
  level: z.enum(["campaign", "ad_group"]),
  scope: z.enum(["campaign", "all_ad_groups"]),
  location_ids: z.array(z.number().int().positive()).min(1).max(MAX_GEO_PLACES),
  before_names: z.array(z.string().max(200)).max(200),
  place_names: z.array(z.string().max(200)).min(1).max(MAX_GEO_PLACES),
  expected_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().max(255).optional(),
  about: z.string().max(300).optional(),
  rationale: rationaleInput(),
  over_cap: z.literal(true).optional(),
  origin: z.literal("user_initiated_ledger"),
});
export type ReplaceGeoTargetsBody = z.infer<typeof replaceGeoTargetsBodySchema>;

export type GoogleGeoTargets = {
  level: "campaign" | "ad_group";
  owners: Array<{ resource: string; criteria: Array<{ resource_name: string; geo_id: number }> }>;
};

const geoIdOf = (s: string | undefined) => {
  const m = /geoTargetConstants\/(\d+)$/.exec(s ?? "");
  return m ? Number(m[1]) : null;
};

export async function readGoogleGeoTargets(
  tenant_id: string,
  campaign: { campaign_id: string; campaign_resource: string },
  level: "campaign" | "ad_group",
): Promise<GoogleGeoTargets> {
  const id = campaign.campaign_id;
  if (!/^[0-9]+$/.test(id)) throw new ExpectedToolError("google_ads_invalid_campaign_id", `invalid campaign_id: ${id}`);
  if (level === "campaign") {
    const rows = (await gadsSearch(
      tenant_id,
      "SELECT campaign_criterion.resource_name, campaign_criterion.location.geo_target_constant, campaign_criterion.negative " +
        `FROM campaign_criterion WHERE campaign.id = ${id} AND campaign_criterion.type = 'LOCATION'`,
      { complete: true },
    )) as Array<{ campaignCriterion?: { resourceName?: string; negative?: boolean; location?: { geoTargetConstant?: string } } }>;
    const criteria: Array<{ resource_name: string; geo_id: number }> = [];
    for (const r of rows) {
      const c = r.campaignCriterion;
      const geo = geoIdOf(c?.location?.geoTargetConstant);
      if (!c?.resourceName || c.negative === true || geo === null) continue;
      criteria.push({ resource_name: c.resourceName, geo_id: geo });
    }
    return { level, owners: [{ resource: campaign.campaign_resource, criteria }] };
  }
  const [groups, rows] = await Promise.all([
    gadsSearch(tenant_id, `SELECT ad_group.resource_name FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED'`, {
      complete: true,
    }) as Promise<Array<{ adGroup?: { resourceName?: string } }>>,
    gadsSearch(
      tenant_id,
      "SELECT ad_group.resource_name, ad_group_criterion.resource_name, ad_group_criterion.location.geo_target_constant, ad_group_criterion.negative " +
        `FROM ad_group_criterion WHERE campaign.id = ${id} AND ad_group_criterion.type = 'LOCATION' AND ad_group.status != 'REMOVED'`,
      { complete: true },
    ) as Promise<
      Array<{ adGroup?: { resourceName?: string }; adGroupCriterion?: { resourceName?: string; negative?: boolean; location?: { geoTargetConstant?: string } } }>
    >,
  ]);
  const owners = new Map<string, Array<{ resource_name: string; geo_id: number }>>();
  for (const g of groups) if (g.adGroup?.resourceName) owners.set(g.adGroup.resourceName, []);
  for (const r of rows) {
    const owner = r.adGroup?.resourceName;
    const c = r.adGroupCriterion;
    const geo = geoIdOf(c?.location?.geoTargetConstant);
    if (!owner || !owners.has(owner) || !c?.resourceName || c.negative === true || geo === null) continue;
    owners.get(owner)!.push({ resource_name: c.resourceName, geo_id: geo });
  }
  return { level, owners: [...owners.entries()].map(([resource, criteria]) => ({ resource, criteria })) };
}

const sortedIds = (criteria: ReadonlyArray<{ geo_id: number }>) => [...new Set(criteria.map((c) => c.geo_id))].sort((a, b) => a - b);

export function liveGeoIds(t: GoogleGeoTargets): number[] {
  return sortedIds(t.owners.flatMap((o) => o.criteria));
}

export function geoShape(t: GoogleGeoTargets): "single" | "mixed" | "none" {
  if (t.owners.length === 0) return "none";
  const first = sortedIds(t.owners[0].criteria).join(",");
  return t.owners.every((o) => sortedIds(o.criteria).join(",") === first) ? "single" : "mixed";
}

export function geoFingerprint(t: GoogleGeoTargets): string {
  const canon = t.owners
    .map((o) => `${o.resource}=${sortedIds(o.criteria).join(",")}`)
    .sort()
    .join("|");
  return createHash("sha256").update(`google:${t.level}:${canon}`).digest("hex");
}

export function shapeReplaceGeoOperations(live: GoogleGeoTargets, location_ids: readonly number[]): GadsOperation[] {
  const ids = [...new Set(location_ids)];
  const service = live.level === "campaign" ? "campaignCriteria" : "adGroupCriteria";
  const removes: GadsOperation[] = live.owners.flatMap((o) => o.criteria.map<GadsOperation>((c) => ({ service, remove: c.resource_name })));
  const creates: GadsOperation[] = live.owners.flatMap((o) =>
    ids.map<GadsOperation>((id) => ({
      service,
      create:
        live.level === "campaign"
          ? { campaign: o.resource, location: { geoTargetConstant: `geoTargetConstants/${id}` } }
          : { adGroup: o.resource, location: { geoTargetConstant: `geoTargetConstants/${id}` } },
    })),
  );
  return [...removes, ...creates];
}

export async function googleReplaceGeoTargets(
  tenant_id: string,
  campaign: { campaign_id: string; campaign_resource: string; channel_type: string },
  body: ReplaceGeoTargetsBody,
): Promise<{ location_ids: number[]; verified: boolean }> {
  const level = GEO_LEVEL_BY_CHANNEL_TYPE[campaign.channel_type];
  if (!level) {
    throw new ExpectedToolError(
      "google_ads_geo_unsupported_campaign",
      "Zavi can't change where this kind of Google Ads campaign shows. Change it in Google Ads.",
    );
  }
  if (level !== body.level) {
    throw new ExpectedToolError("google_ads_geo_level_mismatch", "This campaign keeps its places somewhere else now, so nothing was changed.");
  }
  const live = await readGoogleGeoTargets(tenant_id, campaign, level);
  if (geoFingerprint(live) !== body.expected_fingerprint) {
    throw new ExpectedToolError(
      "google_ads_geo_stale",
      "Where this campaign shows changed after the places were picked, so nothing was changed. Open the card again to pick from what it shows now.",
    );
  }
  const shape = geoShape(live);
  if (shape === "none") throw new ExpectedToolError("google_ads_geo_no_owner", "This campaign has no ad group to hold its places, so nothing was changed.");
  if (shape === "mixed" && body.scope !== "all_ad_groups") {
    throw new ExpectedToolError("google_ads_geo_mixed", "This campaign's ad groups show in different places. Choose to apply the places to every ad group first.");
  }
  await gadsMutateOperations(tenant_id, shapeReplaceGeoOperations(live, body.location_ids));
  const want = [...new Set(body.location_ids)].sort((a, b) => a - b);
  let verified = false;
  try {
    const after = await readGoogleGeoTargets(tenant_id, campaign, level);
    verified = after.owners.every((o) => sortedIds(o.criteria).join(",") === want.join(","));
  } catch {
    verified = false;
  }
  return { location_ids: want, verified };
}
