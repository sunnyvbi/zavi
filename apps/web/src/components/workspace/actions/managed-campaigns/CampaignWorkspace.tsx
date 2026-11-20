"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import type { ManagedAdEntity, ManagedCampaign } from "@zavi/shared";
import { campaignFetch } from "./api";
import { count, money, wholeMoney } from "./format";
import { cardButton } from "../card/styles";
import { cn } from "@/lib/cn";
import { CampaignMetricTile } from "./CampaignMetricTile";
import { CampaignTables, dailyBudget, type Level } from "./CampaignTables";
import type { CampaignWorkspaceSpec } from "./types";
import type { CampaignDraft } from "@zavi/shared";
import { CampaignEditor } from "./CampaignEditor";
import { EditorLayer } from "./EditorLayer";
import { ActivateConfirm, type ActivateTarget } from "./ActivateConfirm";
import { LaunchSheet } from "./LaunchSheet";
import { registerNewCampaignOpener } from "./newCampaignRequest";

function periodWords(days: number, timezone: string | undefined) {
  let zone = timezone ?? "";
  try { zone = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longGeneric" }).formatToParts().find((p) => p.type === "timeZoneName")?.value.replace(/ Time$/, " time") ?? zone; }
  catch { void 0; }
  return `In the last ${days} days, ${zone ? `${zone}, ` : ""}complete days only`;
}

const TRACKING_WORDS: Record<string, string> = {
  configured: "Conversions and return on ad spend are provider-reported and do not prove bookings or sales.",
  not_configured: "Conversion tracking is not set up yet, so conversions and return on ad spend do not count bookings.",
  unavailable: "Conversion tracking could not be checked, so do not treat conversions or return on ad spend as bookings.",
};

export function CampaignWorkspace({ spec, payload, days, loading, onRefresh }: { spec: CampaignWorkspaceSpec; payload: unknown; days: number; loading: boolean; onRefresh: () => void }) {
  const data = spec.readDashboard(payload);
  const [tab, setTab] = useState<Level>("campaign");
  const [rows, setRows] = useState<ManagedAdEntity[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<CampaignDraft | undefined>();
  const [edit, setEdit] = useState<ManagedCampaign | "new" | null>(null);
  const [opening, setOpening] = useState(0);
  const [focusSetup, setFocusSetup] = useState(false);
  const open = (target: ManagedCampaign | "new", draft?: CampaignDraft, assets = false) => { setSelectedDraft(draft); setEdit(target); setFocusSetup(assets); setOpening(n => n + 1); };
  const [busy, setBusy] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ target: ActivateTarget; campaign: ManagedCampaign | undefined; run: () => Promise<void> } | null>(null);
  const writing = useRef(false);
  const [version, setVersion] = useState(0);
  const campaigns = useMemo(() => data?.campaigns ?? [], [data?.campaigns]);
  const ids = campaigns.map((campaign) => campaign.id).join(",");
  const campaignName = (name: string) => data?.campaign_name_prefix && name.startsWith(data.campaign_name_prefix) ? name.slice(data.campaign_name_prefix.length) : name;
  useEffect(() => {
    if (tab === "campaign") return;
    let stopped = false;
    setRows([]); setError(null); setReading(true);
    const selected = campaigns;
    void (async () => {
      const next: ManagedAdEntity[] = [];
      for (let i = 0; i < selected.length; i += 4) {
        const batch = await Promise.all(selected.slice(i, i + 4).map(c => campaignFetch<{ rows: ManagedAdEntity[] }>(`${spec.apiBase}/campaigns/${encodeURIComponent(c.id)}/entities?level=${tab}&days=${days}`)));
        if (stopped) return;
        next.push(...batch.flatMap(b => b.rows));
      }
      if (!stopped) setRows(next);
    })().catch(e => { if (!stopped) setError(e instanceof Error ? e.message : "Could not read ads. Try again."); }).finally(() => { if (!stopped) setReading(false); });
    return () => { stopped = true; };
  }, [campaigns, tab, days, spec.apiBase, version, payload]);

  async function change(path: string, body: unknown, label: string) {
    if (writing.current) return;
    writing.current = true; setBusy(path); setError(null); setNotice(null);
    try {
      await campaignFetch(path, { method: "POST", body: JSON.stringify(body) });
      setNotice(label); setVersion(v => v + 1); onRefresh();
    } catch (e) { setError(e instanceof Error ? e.message : "The change could not be confirmed. Refresh before trying again."); }
    finally { writing.current = false; setBusy(null); }
  }

  const totals = data?.totals_across_your_campaigns_only ?? {};
  const cards = spec.metrics.map(metric => {
    const value = metric.field === "roas" ? data?.purchase_return?.roas : totals[metric.field];
    return { ...metric, shown: metric.format === "money" ? money(value, data?.currency ?? null) : metric.format === "ratio" ? value != null ? `${value.toFixed(2)}×` : "-" : count(value ?? undefined) };
  });
  const activeDaily = campaigns.filter(c => c.status === "active" && dailyBudget(c) !== null);
  const dailyTotal = activeDaily.reduce((sum, c) => sum + (dailyBudget(c) ?? 0), 0);
  const changeDaily = () => { if (activeDaily.length === 1) open(activeDaily[0]); else document.getElementById("campaigns")?.scrollIntoView({ block: "start" }); };
  const toggleCampaign = (c: ManagedCampaign) => {
    const run = () => change(`${spec.apiBase}/campaigns/${c.id}`, { status: c.status === "active" ? "paused" : "active", expected_updated_at: c.updated_at }, "Campaign status updated. Delivery and reported spend may take time to settle.");
    if (c.status === "active") void run(); else setConfirm({ target: { kind: "campaign", id: c.id, name: campaignName(c.name) }, campaign: c, run });
  };
  const firstUse = !loading && data?.no_campaigns_for_tenant === true;
  const canCreate = firstUse ? !!data?.currency : !loading && !!data?.campaign_name_prefix && !data?.error_code;
  const createNew = useRef(() => {});
  createNew.current = () => open("new", firstUse ? data?.draft : undefined);
  useEffect(() => {
    if (!canCreate) return;
    return registerNewCampaignOpener(() => createNew.current());
  }, [canCreate]);
  return <div className="space-y-6">
    {edit && <EditorLayer><CampaignEditor key={opening} focusSetup={focusSetup} spec={spec} draft={selectedDraft} campaign={edit} prefix={data?.campaign_name_prefix ?? ""} currency={data?.currency ?? null} onBack={() => setEdit(null)} onSaved={saved => { setEdit(saved); onRefresh(); }} /></EditorLayer>}
    {launching && <LaunchSheet campaignId={launching} spec={spec} onClose={() => { setLaunching(null); setVersion(v => v + 1); onRefresh(); }} />}
    {confirm && <ActivateConfirm spec={spec} target={confirm.target} campaign={confirm.campaign} currency={data?.currency ?? null} busy={!!busy} onCancel={() => setConfirm(null)} onConfirm={() => { const { run } = confirm; setConfirm(null); void run(); }} />}
    {data?.setup_notice && <p role="status" className="rounded-xl border border-rule bg-bone p-4 text-[13px] text-inkMuted">{data.setup_notice}</p>}
    {data?.period && <p className="-mt-3.5 text-ca-action text-ca-secondary">{periodWords(days, data.period.timezone)}</p>}
    <section aria-label={`${spec.title} metrics`} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((metric) => <CampaignMetricTile key={metric.field} metricKey={metric.field} icon={metric.icon} label={metric.label} value={loading ? "…" : metric.shown} help={metric.help} />)}
      <CampaignMetricTile metricKey="daily_budget" icon={CalendarDays} label="Daily budget" value={loading ? "…" : activeDaily.length ? wholeMoney(dailyTotal, data?.currency ?? null) : "-"} suffix={!loading && activeDaily.length ? "a day" : undefined} help={activeDaily.length === 1 ? "Across 1 active campaign" : activeDaily.length ? `Across ${activeDaily.length} active campaigns` : "No active daily budget"} action={activeDaily.length > 0 ? <button type="button" className={cn(cardButton.base, cardButton.secondary, "shrink-0")} onClick={changeDaily}>Change</button> : undefined} />
    </section>
    {data?.conversion_tracking && TRACKING_WORDS[data.conversion_tracking] && <p role="status" className="text-ca-action text-ca-secondary">{TRACKING_WORDS[data.conversion_tracking]}</p>}
    <CampaignTables firstUse={firstUse} spec={spec} tab={tab} onTab={(key) => { setTab(key); setError(null); }} campaigns={campaigns} rows={rows} currency={data?.currency ?? null} totals={totals} name={campaignName} loading={loading} reading={reading} busy={!!busy} error={error} notice={notice} unavailable={!data || !!data.error_code} canCreate={canCreate} onCreate={() => createNew.current()} onCreateIn={(c) => open(c, undefined, true)} onToggle={toggleCampaign} onLaunch={setLaunching} onEdit={(c) => open(c)} onEditAssets={(c) => open(c, undefined, true)} onRetry={() => { setVersion(v => v + 1); onRefresh(); }} />
  </div>;
}
