import { formatCurrency } from "../../metrics/currency";
import { words, type TiktokCampaignObject, type TiktokSettings } from "./types";

const fields: Array<[keyof TiktokSettings, string]> = [
  ["budget_optimize_on", "Campaign budget optimization"], ["special_industries", "Special ad categories"],
  ["campaign_automation_type", "Campaign automation"], ["is_smart_performance_campaign", "Smart performance campaign"],
  ["placement_type", "Placement mode"], ["billing_event", "Billing event"], ["creative_material_mode", "Creative mode"],
  ["is_aco", "Automated creative"], ["dynamic_format", "Dynamic format"], ["dynamic_destination", "Dynamic destination"],
  ["tiktok_item_id", "Source post ID"], ["identity_authorized_bc_id", "Identity Business Center ID"], ["image_ids", "Cover image IDs"],
  ["placements", "Placements"], ["optimization_goal", "Optimization goal"],
  ["promotion_type", "Destination type"], ["schedule_type", "Schedule mode"],
  ["auto_targeting_enabled", "Automatic targeting"], ["smart_audience_enabled", "Smart audience"],
  ["smart_interest_behavior_enabled", "Smart interest and behavior"],
  ["video_download_disabled", "Video downloads disabled"], ["bid_type", "Bid strategy"],
  ["aigc_disclosure_type", "AI-generated content disclosure"], ["ad_format", "Ad format"], ["identity_type", "Identity type"], ["identity_id", "Identity ID"],
];

export function CurrentSettings({ object, currency }: { object: TiktokCampaignObject; currency: string | null }) {
  const rows = fields.filter(([key]) => object.settings[key] != null).map(([key, label]) => {
    const value = object.settings[key];
    return [label, typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : Array.isArray(value) ? (value.map(v => key.endsWith("_ids") ? v : words(v)).join(", ") || "None reported") : key.endsWith("_id") ? String(value) : words(String(value))];
  });
  if (object.budget_mode) rows.push(["Budget mode", words(object.budget_mode.replace(/^BUDGET_MODE_/, ""))]);
  if (object.budget != null) rows.push(["Current budget", formatCurrency(object.budget, currency, true)]);
  if (!rows.length) return null;
  return <details className="rounded-xl border border-rule p-3 text-sm">
    <summary className="cursor-pointer font-medium">Current configuration</summary>
    <dl className="mt-3 space-y-2">{rows.map(([name, value]) => <div key={name} className="grid gap-1 sm:grid-cols-2"><dt className="text-inkMuted">{name}</dt><dd className="break-words">{value}</dd></div>)}</dl>
    <p className="mt-3 text-inkMuted">These are the values TikTok reported. Use the available controls below to propose changes.</p>
  </details>;
}
