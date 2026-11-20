
import type { Document } from "mongodb";
import type { VerifiedOrderMap } from "./types";

const CAMPAIGN_LEAF = /^utm[_-]?campaign$/i;
const SOURCE_LEAF = /^utm[_-]?source$/i;
const TAG_HOLDER = /(attribution|touch|utm|acquisition|source|referr|campaign|marketing)/i;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

const leaf = (path: string) => path.split(".").pop() ?? path;

function rank(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const la = /last/i.test(a) ? 0 : 1;
    const lb = /last/i.test(b) ? 0 : 1;
    return la - lb || a.length - b.length || a.localeCompare(b);
  });
}

export function siblingSource(campaignPath: string, known: string[]): string | null {
  const parent = campaignPath.includes(".") ? campaignPath.slice(0, campaignPath.lastIndexOf(".") + 1) : "";
  const hit = known.find((p) => p.startsWith(parent) && p.slice(parent.length).indexOf(".") === -1 && SOURCE_LEAF.test(leaf(p)));
  return hit ?? null;
}

export function catalogUtmCampaignPaths(columns: Array<{ name: string }>): string[] {
  return rank(columns.map((c) => c.name).filter((n) => FIELD_RE.test(n) && CAMPAIGN_LEAF.test(leaf(n))));
}

export function utmProbePaths(columns: Array<{ name: string; type: string }>): Array<{ campaign: string; source: string }> {
  const holders = columns.filter((c) => /document|object/i.test(c.type) && TAG_HOLDER.test(c.name) && FIELD_RE.test(c.name)).map((c) => c.name);
  const out: Array<{ campaign: string; source: string }> = [];
  for (const h of rank(holders).slice(0, 8)) {
    out.push({ campaign: `${h}.utmCampaign`, source: `${h}.utmSource` }, { campaign: `${h}.utm_campaign`, source: `${h}.utm_source` });
  }
  return out;
}

export const VERIFIED_ROW_LIMIT = 50;

export function buildVerifiedPipeline(
  map: VerifiedOrderMap,
  users: { table: string; id_field: string },
  utm: { campaign: string; source: string | null },
  windowStart: Date,
): Document[] {
  const comp = map.completed_at_field;
  const refund =
    map.refund_field && map.refund_basis === "booking_created_net" ? { $ifNull: [`$${map.refund_field}`, 0] } : { $literal: 0 };
  const scale = map.amount_unit === "cents" ? 100 : 1;
  return [
    { $match: { [map.status_field]: { $in: map.terminal_statuses }, [comp]: { $ne: null }, [map.customer_ref_field]: { $ne: null } } },
    {
      $project: {
        _id: 0,
        c: `$${map.customer_ref_field}`,
        at: { $convert: { input: `$${comp}`, to: "date", onError: null, onNull: null } },
        rev: map.revenue_field ? `$${map.revenue_field}` : { $literal: null },
        ref: refund,
      },
    },
    { $match: { at: { $gte: windowStart } } },
    { $addFields: { ok: { $and: [{ $isNumber: "$rev" }, { $isNumber: "$ref" }] } } },
    {
      $group: {
        _id: "$c",
        net: { $sum: { $cond: ["$ok", { $subtract: ["$rev", "$ref"] }, 0] } },
        unreadable: { $sum: { $cond: ["$ok", 0, 1] } },
      },
    },
    { $lookup: { from: users.table, localField: "_id", foreignField: users.id_field, as: "_u" } },
    {
      $project: {
        net: { $divide: ["$net", scale] },
        unreadable: 1,
        utm_campaign: { $ifNull: [{ $arrayElemAt: [`$_u.${utm.campaign}`, 0] }, null] },
        utm_source: utm.source ? { $ifNull: [{ $arrayElemAt: [`$_u.${utm.source}`, 0] }, null] } : { $literal: null },
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total_verified: { $sum: 1 },
              matched_verified: { $sum: { $cond: [{ $ne: ["$utm_campaign", null] }, 1, 0] } },
              unreadable: { $sum: "$unreadable" },
            },
          },
        ],
        byCampaign: [
          { $match: { utm_campaign: { $ne: null } } },
          { $group: { _id: { c: "$utm_campaign", s: "$utm_source" }, verified_bookings: { $sum: 1 }, net_gmv: { $sum: "$net" } } },
          { $sort: { verified_bookings: -1 } },
          { $limit: VERIFIED_ROW_LIMIT + 1 },
        ],
      },
    },
  ];
}
