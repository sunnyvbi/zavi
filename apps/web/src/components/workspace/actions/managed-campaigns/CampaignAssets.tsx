"use client";
import { useEffect, useRef, useState } from "react";
import { AdsRowsSkeleton } from "./AdsLoading";
import { isAdImagePath, type ManagedAdEntity, type ManagedCampaign } from "@zavi/shared";
import { campaignFetch, requestKey } from "./api";
import type { CampaignWorkspaceSpec } from "./types";
import type { CampaignDraft } from "@zavi/shared";
import { ActivateConfirm, type ActivateTarget } from "./ActivateConfirm";
import { AdImageSlot } from "./AdImageSlot";
import { sheetLabel as label } from "./AdsSheet";
const field = "mt-1.5 block min-h-11 w-full rounded-[10px] border border-rule bg-cream px-2.5 py-2 text-base font-medium leading-[22px] text-ink outline-none focus:border-ink disabled:opacity-60";
const button = "rounded-full border border-ca-strong bg-ca-bg px-4 py-1.5 text-[13px] font-semibold leading-5 text-ca-primary hover:bg-ca-hover disabled:opacity-40";
function trackingFor(fallback: string, url?: string) {
  if (!url) return fallback;
  try { return new URLSearchParams(Array.from(new URL(url).searchParams).filter(([k]) => k.startsWith("utm_"))).toString(); }
  catch { return ""; }
}
export function CampaignAssets({ spec, draft, campaignId, campaign, currency }: { spec: CampaignWorkspaceSpec; draft?: CampaignDraft; campaignId: string; campaign?: ManagedCampaign; currency: string | null }) {
  const [groups, setGroups] = useState<ManagedAdEntity[]>([]);
  const [ads, setAds] = useState<ManagedAdEntity[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingCreates, setPendingCreates] = useState<Array<{ id: string; kind: "group" | "ad" }>>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"group" | "ad" | null>(null);
  const [editing, setEditing] = useState<ManagedAdEntity | null>(null);
  const [confirm, setConfirm] = useState<{ target: ActivateTarget; run: () => void } | null>(null);
  const latch = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const objective = spec.objectives.find(o => o.value === campaign?.bidding_type);
  const bidMicros = objective?.bidMicros ?? 1e6;
  const [strategy, setStrategy] = useState("fixed_bid");
  const product = campaign?.mode === "product_feed";
  const [draftIndex, setDraftIndex] = useState(0);
  const draftAd = !editing ? draft?.ads[draftIndex] : undefined;
  const base = `${spec.apiBase}/campaigns/${encodeURIComponent(campaignId)}`;
  const [adImage, setAdImage] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  useEffect(() => { setAdImage(draftAd?.image_url ?? null); }, [mode, editing, draftAd?.image_url]);
  const imageField = (v: string | null) => !v ? {} : isAdImagePath(v) ? { image_path: v } : { image_url: v };
  useEffect(() => {
    let stale = false; setLoading(true);
    void Promise.all([campaignFetch<{ rows: ManagedAdEntity[] }>(`${base}/entities?level=ad_group&days=30`), campaignFetch<{ rows: ManagedAdEntity[] }>(`${base}/entities?level=ad&days=30`)]).then(([g, a]) => { if (!stale) { setGroups(g.rows); setAds(a.rows); setPendingCreates(pending => pending.filter(p => !(p.kind === "group" ? g.rows : a.rows).some(row => row.id === p.id))); setError(null); } }).catch(e => { if (!stale) setError(e.message); }).finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [base, version]);
  async function write(path: string, body: unknown, message = "Saved. New or edited creatives stay paused until you activate them.", createdKind?: "group" | "ad") {
    if (latch.current) return; latch.current = true; setBusy(true); setError(null); setNotice(null);
    request.current = requestKey(request.current, path, body);
    try { const result = await campaignFetch<{ id?: string }>(path, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": request.current.id } }); if (createdKind && typeof result?.id === "string") setPendingCreates(pending => [...pending, { id: result.id!, kind: createdKind }]); request.current = null; setVersion(v => v + 1); setMode(null); setEditing(null); setNotice(message); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save. Refresh before retrying."); }
    finally { latch.current = false; setBusy(false); }
  }
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const value = (k: string) => String(f.get(k) ?? "");
    if (mode === "group") void write(`${base}/ad-groups${editing ? `/${editing.id}/edit` : ""}`, { name: value("name"), context_hints: value("hints").split("\n").map(s => s.trim()).filter(Boolean), strategy, ...(strategy === "fixed_bid" ? { max_bid_micros: Math.round(Number(value("bid")) * bidMicros) } : {}) }, editing ? "Ad group saved and paused." : "Ad group created and paused.", editing ? undefined : "group");
    else {
      if (!product && !editing && !adImage) { setError("Choose an image for the ad."); return; }
      void write(`${base}/creatives${editing ? `/${editing.id}` : ""}`, { ad_group_id: editing?.ad_group_id ?? value("group"), name: value("name"), title: value("title"), body: value("body"), ...(!product ? { target_url: value("url"), ...imageField(adImage) } : { creative_type: "product_ad_template" }), tracking: "", landing_page_configuration: { query_string_template: value("tracking") } }, editing ? "Ad saved and paused." : "Ad created and paused.", editing ? undefined : "ad");
    }
  }
  return <section className="space-y-4 border-t border-rule pt-5">
    {confirm && <ActivateConfirm spec={spec} target={confirm.target} campaign={campaign} currency={currency} groups={groups} ads={ads} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => { const { run } = confirm; setConfirm(null); run(); }} />}<div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-[16px] font-semibold leading-6 text-ca-xdark">Ad groups and ads</h3><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => { setMode("group"); setEditing(null); setStrategy("fixed_bid"); }}>Add ad group</button><button className={button} disabled={busy || !groups.length} onClick={() => { setMode("ad"); setEditing(null); }}>Add ad</button></div></div>
    {error && <p role="alert" className="text-[13px] text-danger">{error} <button className="underline" onClick={() => setVersion(v => v + 1)}>Refresh</button></p>}{notice && <p role="status" className="text-[13px] text-success">{notice}</p>}
    {pendingCreates.length > 0 && <div role="status" className="space-y-2 rounded-xl border border-rule bg-bone p-3 text-[13px] text-inkSoft">{pendingCreates.map(p => <p key={`${p.kind}:${p.id}`}>ChatGPT has not listed the saved {p.kind === "group" ? "ad group" : "ad"} yet (reference: {p.id}). Do not create it again. Refresh to check when it is available.</p>)}<button type="button" className={button} disabled={loading || busy} onClick={() => setVersion(v => v + 1)}>Refresh saved items</button></div>}
    {[...groups, ...ads].some(r => r.metrics_unavailable) && <p className="text-xs text-inkMuted">Performance reporting is unavailable. These groups and ads can still be edited or paused.</p>}
    {mode === "ad" && !editing && draft?.ads.length && <div className="flex flex-wrap gap-2">{draft.ads.map((a, i) => <button key={i} className={button} disabled={busy} onClick={() => setDraftIndex(i)} aria-pressed={i === draftIndex}>Use draft {i + 1}: {a.name}</button>)}{draftAd?.image_spec && !draftAd.image_url && <p className="w-full text-xs text-inkMuted">Image idea from Zavi: {draftAd.image_spec}</p>}</div>}
    {mode && <form key={`${editing?.id ?? mode}:${draftIndex}`} onSubmit={submit} className="space-y-5 rounded-2xl border border-ca-border bg-ca-bg p-5"><h4 className="text-[16px] font-semibold leading-6 text-ca-xdark">{mode === "group" ? editing ? "Edit ad group" : "New ad group" : editing ? "Edit ad" : `New ${spec.creative.label}`}</h4><label className={label}>Name<input className={field} name="name" defaultValue={editing?.name ?? (mode === "group" ? draft?.group.name : draftAd?.name) ?? ""} minLength={3} maxLength={1000} required disabled={busy} /></label>
      {mode === "group" ? <><label className={label}>{spec.creative.contextLabel}<textarea name="hints" defaultValue={editing?.context_hints?.join("\n") ?? draft?.group.context_hints.join("\n")} className={field} rows={3} placeholder="One situation or question per line" disabled={busy} /></label><label className={label}>Bid strategy<select className={field} value={strategy} onChange={e => setStrategy(e.target.value)} disabled={busy}><option value="fixed_bid">Fixed bid</option>{objective?.automaticStrategy && campaign?.budget?.daily_spend_limit_micros != null && <option value={objective.automaticStrategy}>Maximize {campaign.bidding_type}</option>}</select></label>{strategy === "fixed_bid" && <label className={label}>{objective?.bidLabel ?? "Maximum bid"} ({currency ?? "account currency"})<input className={field} name="bid" defaultValue={editing?.bidding_config?.max_bid_micros != null ? editing.bidding_config.max_bid_micros / bidMicros : undefined} type="number" min={1 / bidMicros} max={1e9 / bidMicros} step={1 / bidMicros} required disabled={busy} /></label>}{objective?.requiresEvent && <p className="text-xs text-inkMuted">This bid guides conversion optimization. Billing is per valid click; it is not a guaranteed cost per conversion.</p>}</> : <><label className={label}>Ad group<select name="group" className={field} defaultValue={editing?.ad_group_id ?? groups[0]?.id} disabled={busy || !!editing}>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label className={label}>Title (3–{spec.creative.titleLimit} characters)<input name="title" className={field} defaultValue={editing?.creative?.title ?? draftAd?.title} minLength={3} maxLength={spec.creative.titleLimit} required disabled={busy} /></label><label className={label}>Ad copy (up to {spec.creative.bodyLimit} characters)<textarea name="body" className={field} defaultValue={editing?.creative?.body ?? draftAd?.body} maxLength={spec.creative.bodyLimit} required disabled={busy} /></label>{!product && <><label className={label}>Sending visitors to<input name="url" className={field} type="url" defaultValue={editing?.creative?.target_url ?? draftAd?.target_url} placeholder="https://example.com/offer" required disabled={busy} /></label><AdImageSlot label={editing ? "Replacement image (optional)" : "Ad image"} value={adImage} onChange={setAdImage} defaultPrompt={draftAd?.image_spec ?? ""} ai={null} disabled={busy} onBusy={setImageBusy} /></>}{product && <p className="text-xs text-inkMuted">Images and destinations come from the selected product catalog.</p>}<label className={label}>Tracking<input name="tracking" className={`${field} font-mono text-[12px]`} defaultValue={editing?.landing_page_configuration?.query_string_template ?? trackingFor(draftAd?.tracking ?? spec.creative.tracking, editing?.creative?.target_url)} disabled={busy} /></label><p className="text-[12px] text-inkMuted">Tracking replaces UTM and click_id parameters in the destination URL. Supports click_id={"{oppref}"}. Saving an edited ad pauses it for your review.</p></>}
      <div className="flex justify-end gap-3"><button type="button" className={button} disabled={busy} onClick={() => setMode(null)}>Cancel</button><button className="rounded-full bg-ca-action px-5 py-1.5 text-[13px] font-semibold leading-5 text-ca-on-action hover:bg-ca-action-hover disabled:opacity-40" disabled={busy || imageBusy}>{busy ? "Saving…" : "Save paused"}</button></div>
    </form>}
    {spec.controls?.previewUnavailableReason && <p className="text-xs text-inkMuted">{spec.controls.previewUnavailableReason}</p>}
    {loading ? <AdsRowsSkeleton label="Reading campaign creatives…" rows={2} /> : groups.length === 0 && !error && !pendingCreates.some(p => p.kind === "group") ? <p className="text-[13px] text-inkMuted">Add an ad group with buyer context, then add the chat cards from your launch kit.</p> : groups.map(g => <div key={g.id} className="rounded-xl border border-rule p-4"><div className="flex items-center justify-between gap-3"><div><h4 className="text-[14px] font-medium">{g.name}</h4><p className="text-[12px] text-inkMuted">{g.context_hints?.join(" · ")}</p>{!!g.serving_issues?.length && <p className="text-xs text-inkMuted">Delivery: {g.serving_issues.join("; ")}</p>}</div><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || g.status === "archived"} onClick={() => { setMode("group"); setEditing(g); setStrategy(g.bidding_config?.strategy ?? "fixed_bid"); }}>Edit group</button><button disabled={busy || !["active", "paused"].includes(g.status ?? "")} className={button} onClick={() => {
          const run = () => void write(`${base}/ad-groups/${g.id}`, g.status === "active" ? { status: "paused" } : { status: "active", expected_campaign_updated_at: campaign?.updated_at }, "Ad group status updated.");
          if (g.status === "active") run(); else setConfirm({ target: { kind: "ad_group", id: g.id, name: g.name }, run });
        }}>{g.status === "active" ? "Pause group" : "Activate group"}</button></div></div><div className="mt-3 space-y-3">{ads.filter(a => a.ad_group_id === g.id).map(a => <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-bone p-3"><div className="min-w-0"><p className="text-[14px] font-medium">{a.creative?.title ?? a.name}</p><p className="text-[13px] text-inkMuted">{a.creative?.body}</p><p className="mt-1 text-[11px] text-inkMuted">{a.status} · Review: {a.review_status ?? "unknown"}</p>{!!a.serving_issues?.length && <p className="mt-1 text-xs text-inkMuted">Delivery: {a.serving_issues.join("; ")}</p>}</div><div className="flex flex-wrap gap-2"><button className={button} disabled={busy || ![spec.creative.type, "product_ad_template"].includes(a.creative?.type ?? "")} onClick={() => { setEditing(a); setMode("ad"); }}>Edit ad</button><button className={button} disabled={busy || !["active", "paused"].includes(a.status ?? "")} onClick={() => {
          const run = () => void write(`${base}/ads/${a.id}`, a.status === "active" ? { ad_group_id: g.id, status: "paused" } : { ad_group_id: g.id, status: "active", expected_campaign_updated_at: campaign?.updated_at }, "Ad status updated.");
          if (a.status === "active") run(); else setConfirm({ target: { kind: "ad", id: a.id, name: a.creative?.title ?? a.name }, run });
        }}>{a.status === "active" ? "Pause ad" : "Activate ad"}</button></div></div>)}</div></div>)}
  </section>;
}
