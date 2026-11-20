import { getEmailChannelSettings, getEmailTemplate } from "@/lib/workspace/emailCampaignSettingsApi";

export type PostalProblem = "missing" | "placeholder" | null;

const PLACEHOLDER: readonly RegExp[] = [
  /\b(test|fake|example|dummy|placeholder)\s+(street|st|road|rd|avenue|ave|lane|ln|way|drive|dr|boulevard|blvd|place|pl)\b/i,
  /\b(lorem|ipsum|placeholder|tbd|tba|todo)\b/i,
  /\banytown\b/i,
  /\byour\s+(\w+\s+)?address\b/i,
  /\bcity\b[\s\S]*\b(state|zip)\b/i,
  /x{3,}/i,
  /^[^\p{L}]*$/u,
];

export function postalAddressProblem(value: string | null | undefined): PostalProblem {
  const text = (value ?? "").trim();
  if (!text) return "missing";
  return PLACEHOLDER.some((re) => re.test(text)) ? "placeholder" : null;
}

export function footerPostal(template: { postal_address: string | null } | null | undefined, setting: readonly string[] | null | undefined): string {
  if (template) return (template.postal_address ?? "").trim();
  for (const v of setting ?? []) {
    const text = typeof v === "string" ? v.trim() : "";
    if (text) return text;
  }
  return "";
}

export async function loadFooterPostal(): Promise<string | null> {
  const t = await getEmailTemplate().catch(() => null);
  if (!t) return null;
  if (t.template) return footerPostal(t.template, null);
  const settings = await getEmailChannelSettings().catch(() => null);
  if (!settings) return null;
  return footerPostal(null, settings.postal_address);
}
