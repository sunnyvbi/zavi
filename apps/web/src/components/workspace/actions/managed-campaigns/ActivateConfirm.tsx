"use client";

import { useEffect, useState } from "react";
import type { ManagedAdEntity, ManagedCampaign } from "@zavi/shared";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { campaignFetch } from "./api";
import { campaignLocationsLine, money } from "./format";
import type { CampaignWorkspaceSpec } from "./types";

const button = "rounded-cta border border-rule px-3 py-2 text-[13px] text-ink disabled:opacity-40";
const MAX_PREVIEWS = 10;

export type ActivateTarget = { kind: "campaign" | "ad_group" | "ad"; id: string; name: string };

type Props = {
  spec: CampaignWorkspaceSpec;
  target: ActivateTarget;
  campaign: ManagedCampaign | undefined;
  currency: string | null;
  groups?: ManagedAdEntity[];
  ads?: ManagedAdEntity[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function budgetLine(campaign: ManagedCampaign | undefined, currency: string | null): string {
  const b = campaign?.budget;
  if (b?.daily_spend_limit_micros != null) return `${money(b.daily_spend_limit_micros / 1e6, currency)} per day`;
  if (b?.lifetime_spend_limit_micros != null) return `${money(b.lifetime_spend_limit_micros / 1e6, currency)} total`;
  return "Could not be read";
}

const NOT_SERVABLE_REVIEW = /reject|disapprov|denied/i;

export function ActivateConfirm({ spec, target, campaign, currency, groups: givenGroups, ads: givenAds, busy, onConfirm, onCancel }: Props) {
  const campaignId = campaign?.id ?? (target.kind === "campaign" ? target.id : "");
  const [read, setRead] = useState<{ groups: ManagedAdEntity[]; ads: ManagedAdEntity[] } | null>(
    givenGroups && givenAds ? { groups: givenGroups, ads: givenAds } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (read || !campaignId) return;
    let stale = false;
    const base = `${spec.apiBase}/campaigns/${encodeURIComponent(campaignId)}`;
    void Promise.all([
      campaignFetch<{ rows: ManagedAdEntity[] }>(`${base}/entities?level=ad_group&days=30`),
      campaignFetch<{ rows: ManagedAdEntity[] }>(`${base}/entities?level=ad&days=30`),
    ])
      .then(([g, a]) => { if (!stale) setRead({ groups: g?.rows ?? [], ads: a?.rows ?? [] }); })
      .catch(e => { if (!stale) setError(e instanceof Error ? e.message : "Could not read the ads. Try again."); });
    return () => { stale = true; };
  }, [read, campaignId, spec.apiBase, attempt]);

  const objective = spec.objectives.find(o => o.value === campaign?.bidding_type);
  const bidMicros = objective?.bidMicros ?? 1e6;
  const inScope = (e: ManagedAdEntity) => e.status !== "archived";
  const groupId = target.kind === "ad_group" ? target.id : target.kind === "ad" ? read?.ads.find(a => a.id === target.id)?.ad_group_id : undefined;
  const groups = (read?.groups ?? []).filter(g => inScope(g) && (!groupId || g.id === groupId));
  const scopedAds = (read?.ads ?? []).filter(a => inScope(a) && (target.kind === "ad" ? a.id === target.id : !groupId || a.ad_group_id === groupId));
  const activeAfter = (kind: ActivateTarget["kind"], e: { id: string; status?: string | null } | undefined) =>
    !!e && (e.status === "active" || (target.kind === kind && target.id === e.id));
  const campaignServes = activeAfter("campaign", campaign ?? (target.kind === "campaign" ? { id: target.id } : undefined));
  const servingGroups = groups.filter(g => activeAfter("ad_group", g));
  const ads = campaignServes ? scopedAds.filter(a =>
    activeAfter("ad", a) && !NOT_SERVABLE_REVIEW.test(a.review_status ?? "") && servingGroups.some(g => g.id === a.ad_group_id)) : [];
  const missing = [
    !campaignServes && "the campaign",
    !servingGroups.length && "an ad group",
    !scopedAds.some(a => activeAfter("ad", a)) && "an ad",
  ].filter(Boolean) as string[];
  const nothingServes = missing.length
    ? `No ad will serve yet: activate ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : missing[0]} too.`
    : "No ad will serve yet: none of these ads passed review.";
  const what = target.kind === "campaign" ? "campaign" : target.kind === "ad_group" ? "ad group" : "ad";

  return (
    <AdsDialog size="md" labelledBy="activate-confirm-title" busy={busy} onClose={onCancel}>
      <div className="space-y-4 p-4">
        <h3 id="activate-confirm-title" className="text-[16px] font-medium">Activate {what} “{target.name}”?</h3>
        <p className="text-[14px] font-medium">Activating starts spend from your balance.</p>
        <dl className="space-y-2 text-[14px]">
          <div><dt className="text-inkMuted">Budget</dt><dd data-testid="activate-budget">{budgetLine(campaign, currency)}</dd></div>
          <div>
            <dt className="text-inkMuted">{objective?.bidLabel ?? "Maximum bid"}</dt>
            <dd data-testid="activate-bids">
              {!read ? (error ? "Could not be read" : "Reading…") : groups.length === 0 ? "No ad group" : (
                <ul>{groups.map(g => (
                  <li key={g.id}>
                    {g.name}: {g.bidding_config?.max_bid_micros != null
                      ? money(g.bidding_config.max_bid_micros / bidMicros, currency)
                      : "Automatic: the platform sets each bid within the budget"}
                  </li>
                ))}</ul>
              )}
            </dd>
          </div>
          <div><dt className="text-inkMuted">Locations</dt><dd data-testid="activate-countries">{campaign ? campaignLocationsLine(campaign.targeting) : "Could not be read"}</dd></div>
        </dl>
        <div className="space-y-2">
          <p className="text-[13px] text-inkMuted">Ads that will serve</p>
          {!read ? <p role="status" className="text-[13px] text-inkMuted">{error ?? "Reading ads…"}</p> : ads.length === 0 ? <p data-testid="activate-no-serving" className="text-[13px] text-inkMuted">{scopedAds.length ? nothingServes : `No ads in this ${what} yet.`}</p> : (
            <ul className="space-y-2">{ads.slice(0, MAX_PREVIEWS).map(a => (
              <li key={a.id} data-testid="activate-preview" className="flex gap-3 rounded-lg bg-bone p-3">
                {/^https:\/\//i.test(a.creative?.image_url ?? "") && <img src={a.creative!.image_url} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />}
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">{a.creative?.title ?? a.name}</p>
                  {a.creative?.body && <p className="text-[13px] text-inkMuted">{a.creative.body}</p>}
                  {a.creative?.target_url && <p className="truncate text-[12px] text-inkMuted">{a.creative.target_url}</p>}
                </div>
              </li>
            ))}</ul>
          )}
          {ads.length > MAX_PREVIEWS && <p className="text-[12px] text-inkMuted">And {ads.length - MAX_PREVIEWS} more.</p>}
        </div>
        {error && <p role="alert" className="text-[13px] text-danger">{error} <button className="underline" onClick={() => { setError(null); setAttempt(n => n + 1); }}>Try reading again</button></p>}
        <div className="flex justify-end gap-3">
          <button type="button" className={button} disabled={busy} onClick={onCancel}>Cancel</button>
          {}
          <button type="button" className="rounded-cta bg-ink px-4 py-2 text-[13px] text-cream disabled:opacity-40" disabled={busy || !read} onClick={onConfirm}>Activate</button>
        </div>
      </div>
    </AdsDialog>
  );
}
