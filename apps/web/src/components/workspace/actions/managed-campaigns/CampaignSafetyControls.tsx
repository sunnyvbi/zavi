"use client";
import { useCallback, useEffect, useState } from "react";
import { AdsRowsSkeleton } from "./AdsLoading";
import { campaignFetch } from "./api";
import { ChannelBalance } from "./ChannelBalance";
import { BoundAdsCampaigns } from "./BoundAdsCampaigns";
import type { CampaignWorkspaceSpec } from "./types";

type Campaign = { id: string; name: string; status: string; updated_at?: number };
export const WALLET_READ_WAIT_MS = 4000;
type SafetyWallet = { balance_cents?: number; reserved_cents?: number; auto_refill_enabled?: boolean; pending?: boolean };
export function hasMoneyAtStake(w: SafetyWallet | null | undefined): boolean {
  if (!w || typeof w.balance_cents !== "number" || typeof w.reserved_cents !== "number") return true;
  return !!w.auto_refill_enabled || !!w.pending || w.balance_cents !== 0 || w.reserved_cents !== 0;
}
export function CampaignSafetyControls({ spec }: { spec: CampaignWorkspaceSpec }) {
  const [open, setOpen] = useState(false);
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    let live = true;
    let settled = false;
    const slow = setTimeout(() => { if (live && !settled) setNeeded(true); }, WALLET_READ_WAIT_MS);
    Promise.all([campaignFetch<SafetyWallet>("/api/ads/wallet"), campaignFetch<{ campaigns?: Campaign[]; complete?: boolean }>(spec.safetyPath!)])
      .then(([w, inv]) => { settled = true; if (live) setNeeded(hasMoneyAtStake(w) || inv?.complete !== true || (inv.campaigns ?? []).some(c => !ENDED.has(String(c.status ?? "").trim().toLowerCase()) && c.status !== "paused")); })
      .catch(() => { settled = true; if (live) setNeeded(true); });
    return () => { live = false; clearTimeout(slow); };
  }, [spec.safetyPath]);
  if (!needed) return null;
  return <section className="my-3 rounded-xl border border-rule p-4">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-sm font-medium underline">Manage {spec.title} balance and pauses</button>
    {open && <SafetyBody spec={spec} />}
  </section>;
}
const ENDED = new Set(["ended", "completed", "archived", "canceled", "cancelled"]);
export function BoundCampaignSafetyControls({ platform, name }: { platform: "linkedin"; name: string }) {
  const [open, setOpen] = useState(false);
  const [stoppable, setStoppable] = useState(false);
  return <section hidden={!stoppable} data-testid={`${platform}-safety`} className="my-3 rounded-xl border border-rule p-4">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-sm font-medium underline">Pause {name} campaigns</button>
    <div hidden={!open} className="mt-4 space-y-3">
      <p className="text-sm text-inkMuted">You can pause campaigns even while this channel is locked. Creating and launching campaigns is unavailable.</p>
      <BoundAdsCampaigns platform={platform} pauseOnly onCampaigns={(list) => setStoppable(list.some((c) => !ENDED.has(String(c.status ?? "").trim().toLowerCase())))} />
    </div>
  </section>;
}
function SafetyBody({ spec }: { spec: CampaignWorkspaceSpec }) {
  const [inventory, setInventory] = useState<{ campaigns: Campaign[]; complete: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setInventory(await campaignFetch(spec.safetyPath!)); setError(null); }
    catch { setError("Campaign status is unavailable. Retry before assuming ads have stopped."); }
  }, [spec.safetyPath]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function pause(campaign: Campaign) {
    setBusy(true);
    try {
      await campaignFetch(`${spec.apiBase}/campaigns/${encodeURIComponent(campaign.id)}`, { method: "POST", body: JSON.stringify({ status: "paused", ...(campaign.updated_at !== undefined ? { expected_updated_at: campaign.updated_at } : {}) }) });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not pause this campaign. Retry."); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 space-y-3">
    <p className="text-sm text-inkMuted">You can turn off auto-refill and pause campaigns even while this channel is locked. Campaign creation and activation are unavailable.</p>
    <ChannelBalance spec={spec} cancellationOnly />
    {error && <p role="alert" className="text-sm text-danger">{error} <button type="button" onClick={() => void refresh()} className="underline">Retry</button></p>}
    {!inventory && !error && <AdsRowsSkeleton label="Loading campaigns…" />}
    {inventory && !inventory.complete && <p role="alert">The campaign list is incomplete. Contact Zavi to check the remaining campaigns.</p>}
    {inventory?.complete && inventory.campaigns.length === 0 && <p className="text-sm">No managed campaigns found.</p>}
    {inventory?.campaigns.map(c => <div key={c.id} className="flex items-center justify-between gap-3 text-sm"><span>{c.name} · {c.status}</span>{c.status !== "paused" && <button type="button" disabled={busy} onClick={() => void pause(c)} className="rounded-cta border border-rule px-3 py-2 disabled:opacity-40">Pause {c.name}</button>}</div>)}
  </div>;
}
