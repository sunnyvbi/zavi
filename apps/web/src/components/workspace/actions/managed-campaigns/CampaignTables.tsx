"use client";

import { Pilcrow, Plus, Rocket, SquarePen } from "lucide-react";
import { AdsRowsSkeleton } from "./AdsLoading";
import type { ManagedAdEntity, ManagedCampaign } from "@zavi/shared";
import { cn } from "@/lib/cn";
import { CreateMenu } from "../topActions/CreateMenu";
import { CampaignScheduleStatus } from "./CampaignScheduleStatus";
import { count, money, percent, wholeMoney } from "./format";
import { LevelTabs, OnToggle, StatusPill, tableCell as cell, tableEditButton as editButton, tableHead as head, tableLeft as left, tablePrimaryButton } from "./tableParts";
import type { CampaignWorkspaceSpec } from "./types";

export type Level = "campaign" | "ad_group" | "ad";

const LEVELS = [["campaign", "Campaigns"], ["ad_group", "Ad groups"], ["ad", "Ads"]] as const;
const CREATE: Record<Level, string> = { campaign: "Create campaign", ad_group: "Create ad group", ad: "Create ad" };
const clickRate = (impressions: number | undefined, ctr: number | undefined) => (impressions === 0 ? "–" : percent(ctr));
const untilDay = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function dailyBudget(campaign: ManagedCampaign): number | null {
  const micros = campaign.budget?.daily_spend_limit_micros;
  return typeof micros === "number" ? micros / 1e6 : null;
}

function budgetWords(campaign: ManagedCampaign, currency: string | null): string {
  const daily = dailyBudget(campaign);
  if (daily !== null) return `${wholeMoney(daily, currency)} a day`;
  const lifetime = campaign.budget?.lifetime_spend_limit_micros;
  return typeof lifetime === "number" ? `${wholeMoney(lifetime / 1e6, currency)} total` : "-";
}

function CampaignRows({ spec, campaigns, currency, busy, name, totals, onToggle, onLaunch, onEdit }: {
  spec: CampaignWorkspaceSpec;
  campaigns: readonly ManagedCampaign[];
  currency: string | null;
  busy: boolean;
  name: (raw: string) => string;
  totals: { impressions?: number; clicks?: number; spend?: number };
  onToggle: (campaign: ManagedCampaign) => void;
  onLaunch: (id: string) => void;
  onEdit: (campaign: ManagedCampaign) => void;
}) {
  const activeDaily = campaigns.filter((c) => c.status === "active").flatMap((c) => dailyBudget(c) ?? []);
  const goal = (c: ManagedCampaign) => spec.objectives.find((o) => o.value === c.bidding_type)?.label.split(" (")[0] ?? c.bidding_type ?? "";
  return (
    <table className="w-full border-collapse">
      <thead className="bg-ca-subtle">
        <tr>
          <th className={cn(head, left)}>On</th>
          <th className={cn(head, left)}>Campaign</th>
          <th className={cn(head, left)}>Status</th>
          <th className={head}>Daily budget</th>
          <th className={head}>Impressions</th>
          <th className={head}>Clicks</th>
          <th className={head}>Click-through rate</th>
          <th className={head}>Spend</th>
          <th className={head}><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {campaigns.map((c) => {
          const title = name(c.name);
          const ended = typeof c.end_time === "number" && c.end_time * 1000 <= Date.now();
          return (
            <tr key={c.id}>
              <td className={cn(cell, left)}><OnToggle status={c.status} busy={busy} label={`${c.status === "active" ? "Pause" : "Activate"} ${title}`} onChange={() => onToggle(c)} /></td>
              <td className={cn(cell, left)}>
                <span className="block max-w-[280px] truncate" title={title}>{title}</span>
                <span className="block text-ca-action text-ca-secondary">{goal(c)}</span>
              </td>
              <td className={cn(cell, left)}>
                <StatusPill value={c.status} />
                {c.status === "active" && typeof c.end_time === "number" && !ended && <p className="mt-1 text-ca-action text-ca-secondary">Runs until {untilDay(c.end_time)}</p>}
                {c.status === "paused" && c.impressions === 0 && !ended && <p className="mt-1 text-ca-action text-ca-secondary">Not launched yet</p>}
                <CampaignScheduleStatus key={c.end_time} endTime={c.end_time} />
              </td>
              <td className={cell}>{budgetWords(c, currency)}</td>
              <td className={cell}>{count(c.impressions)}</td>
              <td className={cell}>{count(c.clicks)}</td>
              <td className={cell}>{clickRate(c.impressions, c.ctr)}</td>
              <td className={cell}>{money(c.spend, currency)}</td>
              <td className={cell}>
                <span className="inline-flex items-center justify-end gap-2">
                  {c.status === "paused" && <button type="button" data-testid="launch-campaign" disabled={busy} className={tablePrimaryButton} onClick={() => onLaunch(c.id)}><Rocket className="size-4" aria-hidden />Launch</button>}
                  <button type="button" className={editButton} onClick={() => onEdit(c)}><SquarePen className="size-4" aria-hidden />Edit</button>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
      {campaigns.length > 0 && (
        <tfoot className="bg-ca-subtle font-semibold">
          <tr>
            <td className={cell} />
            <td className={cn(cell, left)}>{campaigns.length === 1 ? "1 campaign" : `${campaigns.length} campaigns`}</td>
            <td className={cell} />
            <td className={cell}>{activeDaily.length ? `${wholeMoney(activeDaily.reduce((a, b) => a + b, 0), currency)} a day` : "-"}</td>
            <td className={cell}>{count(totals.impressions)}</td>
            <td className={cell}>{count(totals.clicks)}</td>
            <td className={cell}>{clickRate(totals.impressions, totals.impressions && totals.clicks !== undefined ? totals.clicks / totals.impressions : undefined)}</td>
            <td className={cell}>{money(totals.spend, currency)}</td>
            <td className={cell} />
          </tr>
        </tfoot>
      )}
    </table>
  );
}

function EntityRows({ level, rows, campaigns, currency, name, onEdit }: {
  level: "ad_group" | "ad";
  rows: readonly ManagedAdEntity[];
  campaigns: readonly ManagedCampaign[];
  currency: string | null;
  name: (raw: string) => string;
  onEdit: (campaign: ManagedCampaign) => void;
}) {
  return (
    <table className="w-full border-collapse">
      <thead className="bg-ca-subtle">
        <tr>
          <th className={cn(head, left)}>{level === "ad" ? "Ad" : "Ad group"}</th>
          <th className={cn(head, left)}>Campaign</th>
          <th className={head}>Impressions</th>
          <th className={head}>Clicks</th>
          <th className={head}>Click-through rate</th>
          <th className={head}>Spend</th>
          <th className={head}><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const parent = campaigns.find((c) => c.id === r.campaign_id);
          return (
            <tr key={r.id}>
              <td className={cn(cell, left)}>
                <span className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ca-subtle"><Pilcrow className="size-5 text-ca-secondary" aria-hidden /></span>
                  <span className="min-w-[240px] max-w-[320px] whitespace-normal">
                    <span className="block">{r.name}</span>
                    {level === "ad" && r.creative?.body && <span className="block text-ca-action text-ca-secondary">{r.creative.body}</span>}
                    {r.serving_issues?.map((issue) => <span key={issue} className="block text-ca-action text-ca-danger">{issue}</span>)}
                  </span>
                </span>
              </td>
              <td className={cn(cell, left, "max-w-[180px] !whitespace-normal")}>{parent ? name(parent.name) : name(r.parent_name)}</td>
              <td className={cell}>{count(r.impressions)}</td>
              <td className={cell}>{count(r.clicks)}</td>
              <td className={cell}>{clickRate(r.impressions, r.ctr)}</td>
              <td className={cell}>{money(r.spend, currency)}</td>
              <td className={cell}>
                <button type="button" className={editButton} disabled={!parent} onClick={() => parent && onEdit(parent)}><SquarePen className="size-4" aria-hidden />Edit</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function CampaignTables({ spec, firstUse, tab, onTab, campaigns, rows, currency, totals, name, loading, reading, busy, error, notice, unavailable, canCreate, onCreate, onCreateIn, onToggle, onLaunch, onEdit, onEditAssets, onRetry }: {
  spec: CampaignWorkspaceSpec;
  tab: Level;
  onTab: (key: Level) => void;
  campaigns: readonly ManagedCampaign[];
  rows: readonly ManagedAdEntity[];
  currency: string | null;
  totals: { impressions?: number; clicks?: number; spend?: number };
  name: (raw: string) => string;
  loading: boolean;
  reading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  unavailable: boolean;
  canCreate: boolean;
  firstUse?: boolean;
  onCreate: () => void;
  onCreateIn: (campaign: ManagedCampaign) => void;
  onToggle: (campaign: ManagedCampaign) => void;
  onLaunch: (id: string) => void;
  onEdit: (campaign: ManagedCampaign) => void;
  onEditAssets: (campaign: ManagedCampaign) => void;
  onRetry: () => void;
}) {
  const noun = tab === "campaign" ? "campaigns" : tab === "ad" ? "ads" : "ad groups";
  const empty = tab === "campaign" ? campaigns.length === 0 : rows.length === 0;
  return (
    <>
      <section id="campaigns" aria-label={`${spec.title} campaigns`} className="scroll-mt-4 overflow-hidden rounded-2xl border border-ca-border bg-ca-bg">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <LevelTabs tab={tab} levels={LEVELS} label="Ad account levels" onTab={onTab} />
          {tab === "campaign" ? (
            <button type="button" className={tablePrimaryButton} onClick={onCreate} disabled={!canCreate}><Plus className="size-4" aria-hidden />{CREATE.campaign}</button>
          ) : campaigns.length > 0 && (
            <CreateMenu direct label={CREATE[tab]} tag={null} actions={campaigns.map((c) => ({ key: c.id, label: name(c.name), modal: "tab" as const }))} onPick={(a) => { const picked = campaigns.find((c) => c.id === a.key); if (picked) onCreateIn(picked); }} />
          )}
        </div>
        {error && <div role="alert" className="px-5 pb-3 text-ca-action text-ca-danger">{error} <button type="button" className="underline" onClick={onRetry}>Refresh</button></div>}
        {rows.some((r) => r.metrics_unavailable) && <p role="status" className="px-5 pb-3 text-ca-action text-ca-secondary">Some performance figures are unavailable. Ad status and controls remain available.</p>}
        {notice && <p role="status" className="px-5 pb-3 text-ca-action text-ca-success">{notice}</p>}
        <div role="tabpanel" aria-label={LEVELS.find(([key]) => key === tab)?.[1]} className="overflow-x-auto">
          {loading || reading ? (
            <AdsRowsSkeleton label={`Reading ${noun}…`} />
          ) : tab === "campaign" ? (
            <CampaignRows spec={spec} campaigns={campaigns} currency={currency} busy={busy} name={name} totals={totals} onToggle={onToggle} onLaunch={onLaunch} onEdit={onEdit} />
          ) : (
            <EntityRows level={tab} rows={rows} campaigns={campaigns} currency={currency} name={name} onEdit={onEditAssets} />
          )}
          {!loading && !reading && !error && empty && (
            <p className="p-8 text-center text-ca-action text-ca-secondary">
              {unavailable ? "Account data is unavailable. Try Refresh." : tab === "campaign" ? firstUse ? "No campaigns yet." : "No campaigns could be verified in this read. Refresh or ask Zavi to check the account." : `No ${noun} found for this selection.`}
            </p>
          )}
        </div>
      </section>
      <p className="!mt-2 text-ca-action text-ca-secondary">Numbers as reported by OpenAI.</p>
    </>
  );
}
