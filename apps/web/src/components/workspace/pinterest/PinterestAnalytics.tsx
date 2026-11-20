"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Eye, Heart, MousePointerClick, Rocket, UserPlus } from "lucide-react";
import { DeltaTile as Tile } from "../metrics/DeltaTile";
import { cn } from "@/lib/cn";
import { useAgentDashboard } from "../agent/dashboard-ui";
import { DEFAULT_RANGES, type GadsRange } from "../agent/google-ads/types";
import { ChannelDashboardControls } from "../actions/ChannelDashboardControls";
import { useRangePick } from "../actions/useRangePick";
import { PinterestReadinessLine } from "../actions/PinterestReadinessLine";
import { cardButton } from "../actions/card/styles";

export type PinFormat = "image" | "video";

export type PinRow = {
  id: string;
  title: string;
  format: PinFormat | null;
  image: string | null;
  url: string;
  impressions: number;
  engagements: number;
  clicks: number;
  saves: number;
};

type Totals = { views: number; engagements: number | null; clicks: number; new_followers: number | null };

export type PinterestWindow = Totals & {
  days: number;
  prev: Totals | null;
  formats: Array<{ format: PinFormat; impressions: number; engagements: number }>;
  top: PinRow[];
  pins_failed?: boolean;
};

export type PinterestPayload = {
  connected?: boolean;
  account?: { username: string | null; followers: number | null } | null;
  analytics?: { as_of: string | null; windows: Record<string, PinterestWindow | null> };
  problem?: string | null;
};

const FORMAT_WORD: Record<PinFormat, string> = { image: "Image", video: "Video" };

const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const pct = (n: number) => `${(n * 100).toFixed(1).replace(/\.0$/, "")}%`;

export const engagementRate = (t: { views: number; engagements: number | null }): number | null =>
  t.engagements === null || t.views <= 0 ? null : t.engagements / t.views;

const pinRate = (p: { impressions: number; engagements: number }) => (p.impressions > 0 ? p.engagements / p.impressions : 0);

function lastWord(days: number): string {
  if (days === 7) return "on last week";
  if (days === 30) return "on last month";
  return `on the ${days} days before`;
}

function change(now: number | null, before: number | null): { pct: number; up: boolean } | null {
  if (now === null || before === null || !before) return null;
  const d = (now - before) / Math.abs(before);
  return { pct: Math.abs(Math.round(d * 100)), up: d >= 0 };
}

export function pinterestHeadline(w: PinterestWindow, label: string): ReactNode {
  const best = w.formats[0];
  if (best && w.formats.length > 1) {
    return <span><span className="font-semibold">{FORMAT_WORD[best.format]} performs best</span>, with {pct(pinRate(best))} engagement in the {label}.</span>;
  }
  const top = w.top[0];
  if (top) return <span><span className="font-semibold">{top.title}</span> leads your most-viewed pins in the {label}, with {pct(pinRate(top))} engagement.</span>;
  if (w.pins_failed) return <span>Pinterest did not return your top pins for the {label}.</span>;
  return <span>No pin numbers in the {label} yet. Pins you post show up here with their results.</span>;
}

const TH = "border-b border-ca-border px-4 py-3 text-left text-ca-facts font-semibold text-ca-xdark";
const TD = "border-b border-ca-border px-4 py-3 text-ca-facts text-ca-secondary";

function Thumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span aria-hidden className="block size-10 shrink-0 overflow-hidden rounded-lg bg-ca-subtle">
      {src && !failed && <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-cover" />}
    </span>
  );
}

function FormatBars({ formats }: { formats: PinterestWindow["formats"] }) {
  const max = Math.max(...formats.map(pinRate), 0);
  return (
    <section aria-labelledby="pinterest-by-format">
      <h2 id="pinterest-by-format" className="text-ca-title font-semibold text-ca-xdark">Engagement by format</h2>
      <ul className="mt-3 flex flex-col gap-3">
        {formats.map((f) => {
          const r = pinRate(f);
          return (
            <li key={f.format} data-testid={`pinterest-format-${f.format}`} className="grid grid-cols-[minmax(4.5rem,13.5rem)_1fr_auto] items-center gap-4 text-ca-facts">
              <span className="text-ca-xdark">{FORMAT_WORD[f.format]}</span>
              <span className="h-2 min-w-0" aria-hidden>
                <span className="block h-full rounded-full bg-ca-focus" style={{ width: `${max > 0 ? Math.max(2, (r / max) * 100) : 0}%` }} />
              </span>
              <span className="w-14 text-right tabular-nums text-ca-secondary">{pct(r)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TopPins({ pins }: { pins: PinRow[] }) {
  return (
    <section aria-labelledby="pinterest-top-posts">
      <h2 id="pinterest-top-posts" className="text-ca-title font-semibold text-ca-xdark">Top posts</h2>
      <div className="mt-3 overflow-x-auto rounded-2xl border border-ca-border">
        <table className="w-full border-collapse">
          <thead className="bg-ca-subtle">
            <tr>
              <th scope="col" className={TH}>Post</th>
              <th scope="col" className={TH}>Format</th>
              <th scope="col" className={cn(TH, "text-right")}>Views</th>
              <th scope="col" className={cn(TH, "text-right")}>Engagement</th>
            </tr>
          </thead>
          <tbody className="[&>tr:last-child>*]:border-b-0">
            {pins.map((p, i) => (
              <tr key={p.id} data-testid="pinterest-top-post">
                <th scope="row" className="border-b border-ca-border px-4 py-3 text-left text-ca-facts font-normal text-ca-xdark">
                  <span className="flex min-w-[14rem] items-center gap-3">
                    <Thumb src={p.image} />
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words hover:underline focus-visible:underline focus-visible:outline-none">{p.title}</a>
                    {i === 0 && <span className="whitespace-nowrap rounded-full bg-ca-success-bg px-2 py-0.5 text-[13px] font-medium text-ca-success">Top</span>}
                  </span>
                </th>
                <td className={TD}>{p.format ? FORMAT_WORD[p.format] : "–"}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{p.impressions.toLocaleString("en-US")}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{pct(pinRate(p))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Body({ data, range, phrase, windowKey, connected, onRetry, retrying }: { data: PinterestPayload; range: GadsRange; phrase: string; windowKey: string; connected: boolean; onRetry: () => void; retrying: boolean }) {
  const w = data.analytics?.windows?.[windowKey] ?? null;
  const label = phrase;
  const since = lastWord(range.days);
  const note = data.problem ?? (data.connected === false ? "Connect Pinterest in Settings and Zavi reads your account's views, clicks and saves." : null);
  const rate = w ? engagementRate(w) : null;
  return (
    <div className="mt-3 flex flex-col gap-8 pb-6">
      {w && (
        <p data-testid="pinterest-analytics-headline" className="flex items-center gap-2.5 rounded-2xl bg-ca-subtle px-4 py-3 text-ca-facts text-ca-xdark">
          <Rocket className="size-5 shrink-0 text-ca-secondary" aria-hidden />
          {pinterestHeadline(w, label)}
        </p>
      )}
      {note && <p role="status" className="text-ca-action text-ca-secondary">{note}</p>}
      {connected && <PinterestReadinessLine />}
      <section aria-label={range.label} className="-mt-2">
        <ul className="grid grid-cols-1 gap-3 [@container(min-width:32rem)]:grid-cols-2 [@container(min-width:56rem)]:grid-cols-4">
          <Tile icon={Eye} label="Views" value={w ? compact(w.views) : "–"} delta={w?.prev ? change(w.views, w.prev.views) : null} since={since} />
          <Tile icon={Heart} label="Engagement" value={rate === null ? "–" : pct(rate)} delta={w?.prev && rate !== null ? change(rate, engagementRate(w.prev)) : null} since={since} />
          <Tile icon={MousePointerClick} label="Link clicks" value={w ? compact(w.clicks) : "–"} delta={w?.prev ? change(w.clicks, w.prev.clicks) : null} since={since} />
          <Tile icon={UserPlus} label="New followers" value={w && w.new_followers !== null ? compact(w.new_followers) : "–"} delta={w?.prev ? change(w.new_followers, w.prev.new_followers) : null} since={since} />
        </ul>
      </section>
      {w && w.formats.length > 0 && <FormatBars formats={w.formats} />}
      {w?.pins_failed && (
        <p role="alert" data-testid="pinterest-pins-failed" className="flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
          Zavi could not read your top pins just now.
          <button type="button" disabled={retrying} onClick={onRetry} className={cn(cardButton.base, cardButton.secondary)}>Try again</button>
        </p>
      )}
      {w && w.top.length > 0 && <TopPins pins={w.top} />}
    </div>
  );
}

function Loaded({ connected, foot }: { connected: boolean; foot?: ReactNode }) {
  const { range, custom, phrase, windowKey, onPick } = useRangePick();
  const dashboard = useAgentDashboard<PinterestPayload>("pinterest_organic", { params: useMemo((): Record<string, string> => (custom ? { since: custom.since, until: custom.until } : {}), [custom]) });
  return (
    <>
      <ChannelDashboardControls
        ranges={DEFAULT_RANGES}
        range={range}
        pickedId={range.id}
        onPick={onPick}
        allowCustom
        custom={custom}
        onRefresh={dashboard.refresh}
        refreshing={dashboard.refreshing}
        scan={false}
      />
      <div data-testid="pinterest-analytics" className="mx-auto flex w-full max-w-ca-content flex-col">
        <section aria-labelledby="pinterest-analytics-title" className="mt-3 [container-type:inline-size]">
          <h2 id="pinterest-analytics-title" className="text-ca-heading font-semibold tracking-tight text-ca-xdark">How the account is doing</h2>
          {dashboard.data ? (
            <Body data={dashboard.data} range={range} phrase={phrase} windowKey={windowKey} connected={connected} onRetry={dashboard.refresh} retrying={!!dashboard.refreshing} />
          ) : dashboard.error ? (
            <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
              Zavi could not load your Pinterest numbers just now.
              <button type="button" onClick={dashboard.refreshSilent ?? dashboard.refresh} className={cn(cardButton.base, cardButton.secondary)}>Try again</button>
            </p>
          ) : (
            <div aria-busy className="mt-3 h-[360px] animate-pulse rounded-2xl bg-ca-subtle motion-reduce:animate-none" />
          )}
        </section>
        {foot}
      </div>
    </>
  );
}

export function PinterestAnalytics({ active, connected, foot }: { active: boolean; connected: boolean; foot?: ReactNode }) {
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  return opened ? <Loaded connected={connected} foot={foot} /> : null;
}
