"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Mail, MousePointerClick, Rocket, Send, Users } from "lucide-react";
import { DeltaTile as Tile } from "../metrics/DeltaTile";
import { cn } from "@/lib/cn";
import { getSentEmailsPage, type ResultCell, type SentEmail } from "@/lib/workspace/emailResultsApi";
import { onEmailCardChanged } from "@/lib/workspace/emailCardEvents";
import { DEFAULT_RANGES } from "../agent/google-ads/types";
import { ChannelDashboardControls } from "../actions/ChannelDashboardControls";
import { useRangePick } from "../actions/useRangePick";
import { cardButton } from "../actions/card/styles";

const DAY = 86_400_000;
const SENDS = 200;

type Totals = { sent: number; opens: number; delivered: number; clicks: number; allClicks: boolean; visitors: number; allVisitors: boolean };
type Row = { id: string; link: string; subject: string; clicks: number | null; openRate: number | null };

const cell = (c: ResultCell | undefined) => (typeof c?.value === "number" ? c.value : null);

const at = (e: SentEmail) => Date.parse(e.started_at ?? e.finished_at ?? "");

export function emailTotals(emails: readonly SentEmail[]): Totals {
  return emails.reduce<Totals>((t, e) => {
    const sent = e.people.sent ?? 0;
    const delivered = cell(e.delivered) ?? sent;
    const visitors = cell(e.visitors);
    const clicks = cell(e.clicks);
    return {
      sent: t.sent + sent,
      opens: t.opens + (cell(e.opens) ?? 0),
      delivered: t.delivered + (cell(e.opens) === null ? 0 : delivered),
      clicks: t.clicks + (clicks ?? 0),
      allClicks: t.allClicks && clicks !== null,
      visitors: t.visitors + (visitors ?? 0),
      allVisitors: t.allVisitors && visitors !== null,
    };
  }, { sent: 0, opens: 0, delivered: 0, clicks: 0, allClicks: emails.length > 0, visitors: 0, allVisitors: emails.length > 0 });
}

export function inWindow(emails: readonly SentEmail[], days: number, now: number, back = 0): SentEmail[] {
  const to = now - back * days * DAY;
  const from = to - days * DAY;
  return emails.filter((e) => {
    const t = at(e);
    return Number.isFinite(t) && t > from && t <= to;
  });
}

export function loadedSince(emails: readonly SentEmail[], more: boolean): number {
  if (!more) return -Infinity;
  const done = emails.map((e) => Date.parse(e.finished_at ?? "")).filter(Number.isFinite);
  return done.length ? Math.min(...done) : Infinity;
}

export function emailRows(emails: readonly SentEmail[]): Row[] {
  return emails
    .map((e) => {
      const opens = cell(e.opens);
      const base = cell(e.delivered) ?? e.people.sent ?? null;
      return { id: e.card.id, link: `/workspace/email-cards/${e.card.rail}/${encodeURIComponent(e.card.id)}`, subject: e.subject, clicks: cell(e.clicks), openRate: opens !== null && base ? opens / base : null };
    })
    .sort((a, b) => (b.openRate ?? -1) - (a.openRate ?? -1) || (b.clicks ?? -1) - (a.clicks ?? -1));
}

const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits).replace(/\.0$/, "")}%`;

function lastWord(days: number): string {
  if (days === 7) return "on last week";
  if (days === 30) return "on last month";
  return `on the ${days} days before`;
}

function change(now: number, before: number): { pct: number; up: boolean } | null {
  if (!before) return null;
  const d = (now - before) / before;
  return { pct: Math.abs(Math.round(d * 100)), up: d >= 0 };
}

const TH = "border-b border-ca-border px-3 py-2.5 text-left text-ca-facts font-semibold";
const TD = "border-b border-ca-border px-3 py-2.5 text-ca-facts text-ca-secondary";

export function EmailAnalytics({ active, foot }: { active: boolean; foot?: ReactNode }) {
  const [emails, setEmails] = useState<SentEmail[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { range, custom, phrase, endMs, onPick } = useRangePick();
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getSentEmailsPage(SENDS)
      .then((r) => {
        setEmails(r.emails);
        setMore(r.more);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (opened) load();
  }, [opened, load]);
  useEffect(() => (opened ? onEmailCardChanged(() => load()) : undefined), [opened, load]);

  const now = endMs ?? Date.now();
  const current = emails ? inWindow(emails, range.days, now) : [];
  const t = emailTotals(current);
  const p = emailTotals(emails ? inWindow(emails, range.days, now, 1) : []);
  const rows = emailRows(current);
  const best = rows.find((r) => r.openRate !== null) ?? null;
  const since = lastWord(range.days);
  const cut = emails !== null && loadedSince(emails, more) > now - 2 * range.days * DAY;
  const delta = (d: ReturnType<typeof change>) => (cut ? null : d);
  const rate = t.delivered ? t.opens / t.delivered : null;
  const prevRate = p.delivered ? p.opens / p.delivered : null;

  return (
    <>
      <ChannelDashboardControls
        ranges={DEFAULT_RANGES}
        range={range}
        pickedId={range.id}
        onPick={onPick}
        allowCustom
        custom={custom}
        onRefresh={load}
        refreshing={loading}
        scan={false}
      />
      <div data-testid="email-analytics" className="mx-auto flex w-full max-w-ca-content flex-col">
        <section aria-labelledby="email-analytics-title" className="mt-3">
          <h2 id="email-analytics-title" className="text-ca-heading font-semibold tracking-tight text-ca-xdark">How the account is doing</h2>
          {error ? (
            <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-ca-action text-ca-danger">
              {error}
              <button type="button" onClick={load} className={cn(cardButton.base, cardButton.secondary)}>Try again</button>
            </p>
          ) : emails === null ? (
            <div aria-busy className="mt-3 h-[360px] animate-pulse rounded-2xl bg-ca-subtle motion-reduce:animate-none" />
          ) : (
            <div className="mt-3 flex flex-col gap-6 pb-6">
              <p data-testid="email-analytics-headline" className="flex items-center gap-2.5 rounded-2xl bg-ca-subtle px-4 py-3 text-ca-facts text-ca-xdark">
                <Rocket className="size-5 shrink-0 text-ca-secondary" aria-hidden />
                {best ? (
                  <span><span className="font-semibold">“{best.subject}”</span> is your best campaign in the {phrase}.</span>
                ) : rows.length > 0 ? (
                  <span>Open-rate results are not in yet. Sent emails are listed below.</span>
                ) : (
                  <span>Nothing sent in the {phrase}. Emails you approve show up here with their results.</span>
                )}
              </p>
              <section aria-label={range.label}>
                <ul className="grid grid-cols-1 gap-3 [@container(min-width:32rem)]:grid-cols-2 [@container(min-width:56rem)]:grid-cols-4">
                  <Tile icon={Send} label="Sent" value={compact(t.sent)} delta={delta(change(t.sent, p.sent))} since={since} />
                  <Tile icon={Mail} label="Open rate" value={rate === null ? "–" : pct(rate)} delta={rate !== null && prevRate ? delta(change(rate, prevRate)) : null} since={since} />
                  <Tile icon={MousePointerClick} label="Clicks" value={t.allClicks ? compact(t.clicks) : "–"} delta={t.allClicks && p.allClicks ? delta(change(t.clicks, p.clicks)) : null} since={since} />
                  <Tile icon={Users} label="Visitors" value={t.allVisitors ? compact(t.visitors) : "–"} delta={t.allVisitors && p.allVisitors ? delta(change(t.visitors, p.visitors)) : null} since={since} />
                </ul>
                {cut && <p data-testid="email-analytics-cut" className="mt-2 text-ca-facts text-ca-secondary">Based on your latest {SENDS} sends. Older sends are not loaded, so no change {since} is shown.</p>}
              </section>
              {rows.length > 0 && (
                <section aria-labelledby="email-top-campaigns">
                  <h2 id="email-top-campaigns" className="text-ca-title font-semibold text-ca-xdark">Top campaigns</h2>
                  <div className="mt-3 overflow-x-auto rounded-2xl border border-ca-border">
                    <table className="w-full border-collapse">
                      <thead className="bg-ca-subtle">
                        <tr>
                          <th scope="col" className={TH}>Campaign</th>
                          <th scope="col" className={TH}>Format</th>
                          <th scope="col" className={cn(TH, "text-right")}>Clicks</th>
                          <th scope="col" className={cn(TH, "text-right")}>Open rate</th>
                        </tr>
                      </thead>
                      <tbody className="[&>tr:last-child>*]:border-b-0">
                        {rows.slice(0, 10).map((r) => (
                          <tr key={r.id}>
                            <th scope="row" className="border-b border-ca-border px-3 py-2.5 text-left text-ca-facts font-medium text-ca-xdark">
                              <span className="flex items-center gap-2.5">
                                <Link href={r.link} className="min-w-0 break-words hover:underline focus-visible:underline focus-visible:outline-none">{r.subject}</Link>
                                {best?.id === r.id && <span className="whitespace-nowrap rounded-full bg-ca-success-bg px-2 py-0.5 text-[13px] font-medium text-ca-success">Best</span>}
                              </span>
                            </th>
                            <td className={TD}>Email</td>
                            <td className={cn(TD, "text-right tabular-nums")}>{r.clicks === null ? "–" : r.clicks.toLocaleString("en-US")}</td>
                            <td className={cn(TD, "text-right tabular-nums")}>{r.openRate === null ? "–" : pct(r.openRate, 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </div>
          )}
        </section>
        {foot && <div className="mt-12">{foot}</div>}
      </div>
    </>
  );
}
