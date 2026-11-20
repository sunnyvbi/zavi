"use client";

import { useEffect, useMemo, useState } from "react";
import { SquarePen } from "lucide-react";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { isLinkedinAdsPayload, linkedinAdsAdsTable, linkedinAdsCampaignTable } from "../../agent/linkedinAdsTables";
import type { ExtraCell, ExtraRow, ExtraRowAction, ExtraTableData } from "../extraTableTypes";
import { CellText } from "../ExtraTableCells";
import { cardButton } from "../card/styles";
import { NewCampaignButton } from "./NewCampaignButton";
import { campaignFetch } from "../managed-campaigns/api";
import { formatCurrency } from "../../metrics/currency";

type Level = "campaign" | "ad";
type AdStat = { id: string; impressions: number; clicks: number; spend: number; leads: number; currency?: string | null };
const AD_METRICS = ["Impressions", "Clicks", "Click-through rate", "Spend", "Leads", "Cost per lead"];

function adMetricCells(stat: AdStat | undefined, fallback: string | null): ExtraCell[] {
  if (!stat) return AD_METRICS.map(() => ({ text: "-" }));
  const currency = stat.currency ?? fallback;
  return [
    { text: stat.impressions.toLocaleString("en-US") },
    { text: stat.clicks.toLocaleString("en-US") },
    { text: stat.impressions > 0 ? `${((stat.clicks / stat.impressions) * 100).toFixed(2)}%` : "-" },
    { text: formatCurrency(stat.spend, currency) },
    { text: stat.leads.toLocaleString("en-US") },
    { text: stat.leads > 0 ? formatCurrency(stat.spend / stat.leads, currency, true) : "-" },
  ];
}
type LevelData = Pick<ExtraTableData, "columns" | "rows" | "footer" | "empty"> & { caption?: string };

const LEVELS: ReadonlyArray<[Level, string]> = [["campaign", "Campaigns"], ["ad", "Ads"]];
const CAMPAIGN_COLUMNS = ["Status", "Daily budget", "Impressions", "Clicks", "Click-through rate", "Spend", "Leads", "Cost per lead"];
const SWITCH = /^(Pause|Restart|Turn off|Turn on)$/;
const ON = /^(Pause|Turn off)$/;
const HEAD = "whitespace-nowrap px-4 py-3 text-right text-ca-label font-normal text-ca-secondary first:pl-5 last:pr-5";
const CELL = "whitespace-nowrap border-t border-ca-border px-4 py-4 text-right text-ca-facts tabular-nums text-ca-xdark first:pl-5 last:pr-5";
const LEFT = "!text-left";
const EDIT = cn(cardButton.base, cardButton.secondary);
const PILL: Record<string, string> = { good: "bg-ca-success-bg text-ca-success", warn: "bg-warnBg text-warn", bad: "bg-dangerBg text-danger", muted: "bg-ca-subtle text-ca-dark" };

function pick(data: LevelData, labels: readonly string[], rename: Record<string, string> = {}): LevelData {
  const at = [0, ...labels.map((label) => data.columns.findIndex((c) => c.label === label))].filter((i) => i >= 0);
  const cells = <T,>(list: T[]) => at.map((i) => list[i]);
  return {
    ...data,
    columns: cells(data.columns).map((c) => ({ ...c, label: rename[c.label] ?? c.label })),
    rows: data.rows.map((row) => ({ ...row, cells: cells(row.cells) })),
    footer: data.footer ? cells(data.footer) : undefined,
  };
}

function LevelTabs({ tab, levels, onTab }: { tab: Level; levels: ReadonlyArray<[Level, string]>; onTab: (key: Level) => void }) {
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(tab);
  return (
    <div ref={listRef} role="tablist" aria-label="LinkedIn Ads levels" className="relative inline-flex rounded-full bg-ca-surface p-1">
      <SlidingIndicator box={box} className="rounded-full bg-ca-bg shadow-ca-sm" />
      {levels.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={tab === key} type="button" onClick={() => onTab(key)} className={cn("relative rounded-full px-4 py-1.5 text-ca-label font-semibold transition-colors", tab === key ? "text-ca-xdark" : "text-ca-secondary hover:text-ca-xdark")}>
          {label}
        </button>
      ))}
    </div>
  );
}

function useFiled(action: ExtraRowAction | undefined, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const run = () => {
    if (!action?.onClick) return;
    setError(false);
    const r = action.onClick();
    if (!(r instanceof Promise)) return;
    setBusy(true);
    void r.then(
      (value: unknown) => {
        setBusy(false);
        onDone?.();
        if (typeof value === "string" && value.trim()) toast.add({ type: "success", title: value });
      },
      (e: unknown) => {
        setBusy(false);
        setError(true);
        toast.add({ type: "error", title: e instanceof Error && e.message ? e.message : "Couldn't do that. Try again in a moment." });
      },
    );
  };
  return { busy, error, run };
}

function StatusSwitch({ action, on: shown, name }: { action: ExtraRowAction | undefined; on: boolean; name: string }) {
  const [flipped, setFlipped] = useState<{ from: boolean } | null>(null);
  const { busy, error, run } = useFiled(action, () => setFlipped({ from: shown }));
  const on = flipped && flipped.from === shown ? !shown : shown;
  const settled = !!flipped && flipped.from === shown;
  const label = settled ? `"${name}" is ${on ? "turning on" : "pausing"} in LinkedIn.` : (action?.title ?? (on ? `"${name}" is on. Only an owner or admin can pause it.` : `"${name}" is off. Only an owner or admin can turn it on.`));
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy || undefined}
      data-retry={error || undefined}
      title={busy ? (action?.busyLabel ?? label) : error ? `${label} Try again.` : label}
      disabled={!action || busy || settled}
      onClick={run}
      className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors focus-visible:shadow-ca-focus focus-visible:outline-none", action ? "disabled:opacity-40" : "cursor-default", on ? "bg-ca-action" : "bg-ca-strong")}
    >
      <span className={cn("absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform", on && "translate-x-4")} />
    </button>
  );
}

function rowState(row: ExtraRow, statusIndex: number): { switchAction?: ExtraRowAction; on: boolean; canSwitch: boolean } {
  const switchAction = (row.actions ?? []).find((a) => SWITCH.test(a.label));
  const status = (row.cells[statusIndex]?.text ?? "").toLowerCase();
  const on = switchAction ? ON.test(switchAction.label) : /^(active|live|on\b|ads )/.test(status);
  const canSwitch = !!switchAction || /^(active|live|on\b|paused|off|draft|ads )/.test(status);
  return { switchAction, on, canSwitch };
}

function StatusCell({ cell }: { cell: ExtraCell }) {
  return <span title={cell.title} className={cn("inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-ca-action", PILL[cell.chip ?? "muted"])}>{cell.text}</span>;
}

function NameCell({ cell }: { cell: ExtraCell }) {
  if (cell.media) return <CellText cell={cell} />;
  return (
    <>
      <span className="block max-w-[280px] truncate" title={cell.text}>{cell.text}</span>
      {cell.sub && <span className="block text-ca-action text-ca-secondary">{cell.sub}</span>}
    </>
  );
}

function EditLink({ href, name }: { href: string | null | undefined; name: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Edit "${name}" in LinkedIn Campaign Manager`} className={EDIT}>
      <SquarePen className="size-4" aria-hidden />
      Edit
    </a>
  );
}

function LevelTable({ data, label, links }: { data: LevelData; label: string; links?: Map<string, string> }) {
  const statusIndex = data.columns.findIndex((c) => c.label === "Status");
  const hrefOf = (row: ExtraRow) => row.cells[0]?.href ?? links?.get(row.id);
  const hasActions = data.rows.some((r) => !!hrefOf(r));
  const left = (i: number) => i === 0 || i === statusIndex || data.columns[i]?.align === "left";
  if (data.rows.length === 0) return <p role="status" className="border-t border-ca-border p-5 text-ca-action text-ca-secondary">{data.empty}</p>;
  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">{label}</caption>
      <thead className="bg-ca-subtle">
        <tr>
          <th scope="col" className={cn(HEAD, LEFT, "w-px")}>On</th>
          {data.columns.map((c, i) => (
            <th key={c.label} scope="col" className={cn(HEAD, left(i) && LEFT)}>{c.label}</th>
          ))}
          {hasActions && <th scope="col" className={HEAD}><span className="sr-only">Actions</span></th>}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => {
          const s = rowState(row, Math.max(0, statusIndex));
          const [name, ...others] = row.cells;
          return (
            <tr key={row.id}>
              <td data-testid="linkedin-row-switch" className={cn(CELL, LEFT, "w-px")}>{s.canSwitch ? <StatusSwitch action={s.switchAction} on={s.on} name={name?.text ?? ""} /> : null}</td>
              <td className={cn(CELL, LEFT)}>{name ? <NameCell cell={name} /> : null}</td>
              {others.map((c, i) => (
                <td key={i} className={cn(CELL, left(i + 1) && LEFT)}>
                  {i + 1 === statusIndex ? <StatusCell cell={c} /> : <CellText cell={{ ...c, strong: false, text: c.text.replace(" / day", " a day") }} />}
                </td>
              ))}
              {hasActions && (
                <td className={CELL} data-testid="linkedin-row-actions">
                  <span className="flex justify-end">
                    <EditLink href={hrefOf(row)} name={name?.text ?? ""} />
                  </span>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
      {data.footer && data.footer.length > 0 && (
        <tfoot className="bg-ca-subtle font-semibold">
          <tr>
            <td className={CELL} />
            {data.footer.map((c, i) => (
              <td key={i} className={cn(CELL, left(i) && LEFT)}>{c.text.replace(" / day", " a day")}</td>
            ))}
            {hasActions && <td className={CELL} />}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

export function LinkedInCampaignWorkspace({ payload, role, onFiled }: {
  payload: unknown;
  role: string | null;
  onFiled?: () => void;
  onChanged: () => void;
  channelName: string;
}) {
  const [tab, setTab] = useState<Level>("campaign");
  const canAct = role === "owner" || role === "admin";
  const ctx = useMemo(() => ({ canPause: canAct, onFiled }), [canAct, onFiled]);
  const campaigns = useMemo(() => linkedinAdsCampaignTable(payload, ctx)[0] ?? null, [payload, ctx]);
  const ads = useMemo(() => linkedinAdsAdsTable(payload, ctx)[0] ?? null, [payload, ctx]);
  const [adStats, setAdStats] = useState<Map<string, AdStat> | null>(null);
  const period = isLinkedinAdsPayload(payload) ? payload.period : undefined;
  const since = period?.from;
  const until = period?.to;
  useEffect(() => {
    if (tab !== "ad" || !since || !until) return;
    let stale = false;
    setAdStats(null);
    void campaignFetch<{ rows: AdStat[] }>(`/api/channels/linkedin_ads/analytics/ads?${new URLSearchParams({ since, until })}`).then(
      (r) => { if (!stale) setAdStats(new Map(r.rows.map((row) => [row.id, row]))); },
      () => { if (!stale) setAdStats(new Map()); },
    );
    return () => { stale = true; };
  }, [tab, since, until]);
  if (!isLinkedinAdsPayload(payload) || !campaigns) return null;
  const currency = payload.account?.currency ?? null;
  const plain = (rows: ExtraRow[]): ExtraRow[] => rows.map((row) => ({ ...row, cells: [{ ...row.cells[0], media: undefined }, ...row.cells.slice(1)] }));
  const campaignLevel = pick({ columns: campaigns.columns, rows: plain(campaigns.rows), footer: campaigns.footer, empty: campaigns.empty, caption: campaigns.caption }, CAMPAIGN_COLUMNS, { "Ad set": "Campaign" });
  const campaignWords = (text: string) => text.replace(/\bad set(s?)\b/g, "campaign$1");
  const adLevel = ads ? pick({ columns: ads.columns, rows: ads.rows, footer: ads.footer, empty: campaignWords(ads.empty), caption: ads.caption ? campaignWords(ads.caption) : undefined }, ["Ad set", "Status"], { "Ad set": "Campaign" }) : null;
  const adTable = adLevel && { ...adLevel, columns: [...adLevel.columns, ...AD_METRICS.map((label) => ({ label }))], rows: adLevel.rows.map((row) => ({ ...row, cells: [...row.cells, ...adMetricCells(adStats?.get(row.id), currency)] })) };
  const levels = LEVELS.filter(([key]) => key === "campaign" || !!adLevel);
  const shownTab: Level = levels.some(([key]) => key === tab) ? tab : "campaign";
  const current = shownTab === "ad" && adTable ? adTable : campaignLevel;
  const campaignUrls = new Map((payload.campaigns ?? []).flatMap((c) => (c.url ? [[c.id, c.url] as const] : [])));
  const adLinks = new Map((payload.ads ?? []).flatMap((a) => { const url = campaignUrls.get(a.campaign_id); return url ? [[a.id, url] as const] : []; }));
  const label = levels.find(([key]) => key === shownTab)?.[1] ?? "Campaigns";
  return (
    <div>
      <section id="campaigns" aria-label="LinkedIn Ads campaigns" className="scroll-mt-4 overflow-hidden rounded-2xl border border-ca-border bg-ca-bg shadow-ca-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <LevelTabs tab={shownTab} levels={levels} onTab={(key) => setTab(key)} />
          <NewCampaignButton label={shownTab === "ad" ? "Create ad" : "Create campaign"} />
        </div>
        {canAct && shownTab === "ad" && <p role="note" className="px-5 pb-3 text-ca-action text-ca-secondary">On LinkedIn Ads, a new ad is created together with a new campaign.</p>}
        <div role="tabpanel" aria-label={label} className="overflow-x-auto">
          <LevelTable data={current} label={label} links={adLinks} />
        </div>
      </section>
      <p className="mt-2 text-ca-action text-ca-secondary">{[current.caption, "Numbers as reported by LinkedIn Campaign Manager."].filter(Boolean).join(" ")}</p>
    </div>
  );
}
