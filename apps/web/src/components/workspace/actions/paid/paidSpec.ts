import type { ActionItem } from "../types";
import type { SecondaryKey } from "../card/ActionCardFrame";
import type { PrimarySpec } from "../card/cardPrimary";
import { eyebrowKind, isBrief } from "../card/cardKind";
import { exactChangeRows } from "../types";
import { adReviewModel } from "../ads/adReviewModel";
import { platformFor } from "../platforms";
import type { Fact } from "./blocks/InlineFacts";

const BUDGET = /budget|spend|a day|\/day/i;

export function usdText(value: string): string {
  return value.trim().replace(/\s*\/\s*day$/i, " a day").replace(/^([0-9][0-9,]*(?:\.[0-9]+)?) USD\b/, (_, n: string) => {
    const amount = Number(n.replace(/,/g, ""));
    return `$${amount.toLocaleString("en-US", Number.isInteger(amount) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  });
}

export function simpleCard(a: ActionItem): boolean {
  return a.channel_slug === "linkedin_ads";
}

export type SponsoredPost = { readPath: string | null; text: string | null; facts: Fact[] };

export function sponsoredPost(a: ActionItem): SponsoredPost | null {
  const base = platformFor(a.channel_slug).sponsoredPostReview?.actionReviewPath;
  const creative = a.body?.ad_review?.creatives?.[0];
  if (!base || !creative?.source) return null;
  const cost = a.body?.ad_review?.cost?.trim() ?? exactChangeRows(a).find((r) => BUDGET.test(r.item) && !r.item.startsWith("Original proposal"))?.after;
  return {
    readPath: a.executable ? `${base}/${encodeURIComponent(a.id)}/post-preview` : null,
    text: creative.body?.trim() || null,
    facts: [...(cost ? [{ label: "Daily budget", value: usdText(cost) }] : []), { label: "Comes from", value: creative.source }],
  };
}

function usesAdsBalance(a: ActionItem): boolean {
  if (a.body?.funding_source === "wallet") return true;
  return exactChangeRows(a).some((row) =>
    (row.item === "Funding" && /shared.*ads balance/i.test(row.after))
    || row.item === "Available wallet balance"
    || row.item === "Required wallet coverage",
  );
}

export function paidKind(a: ActionItem): string {
  const intent = a.body?.intent ?? a.body?.step?.intent;
  const adCard = a.action_type === "create_ad" || a.card_kind === "ad_manual";
  if (simpleCard(a) && adCard && intent === "create" && !a.body?.kind_label) return "Ad";
  if (typeof intent === "string" && intent.trim()) return eyebrowKind(a);
  const serverKind = a.body?.kind_label;
  if (typeof serverKind === "string" && serverKind.trim()) return serverKind.trim();
  if (a.action_type === "create_ad" || a.card_kind === "ad_manual") {
    return simpleCard(a) ? "Ad" : adReviewModel(a).kind;
  }
  return eyebrowKind(a);
}

export function paidMeta(a: ActionItem): string[] {
  const cost = a.body?.ad_review?.cost?.trim();
  if (cost) return [usdText(cost)];
  const budget = exactChangeRows(a).find((r) => BUDGET.test(r.item));
  if (budget && a.action_type === "create_ad") return [`Up to ${budget.after}`];
  return a.executable && a.action_type !== "pause_ad" && usesAdsBalance(a) ? ["From your ads balance"] : [];
}

export function paidSecondary(a: ActionItem, primary: PrimarySpec | null): SecondaryKey[] {
  if (isBrief(a)) return ["notNow", "ask"];
  if (primary?.mode === "approve" || primary?.mode === "review") return ["reject"];
  if (primary?.mode === "copy") return ["reject"];
  if (a.blocking) return ["ask", "notNow"];
  return ["ask"];
}

const REMOVED = /^(removed for good|deleted)/i;
const ARCHIVED = /^archived/i;

export function executedWords(a: ActionItem, network: string): string {
  if (a.action_type === "pause_ad") {
    const rows = exactChangeRows(a);
    if (rows.some((r) => REMOVED.test(r.after))) return `Removed from ${network}`;
    if (rows.some((r) => ARCHIVED.test(r.after))) return `Archived in ${network}`;
    return `Paused in ${network}`;
  }
  if (a.action_type === "update_ad") return `Updated in ${network}`;
  return `Live in ${network}`;
}
