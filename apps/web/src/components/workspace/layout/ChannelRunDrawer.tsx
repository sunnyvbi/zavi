"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Clock } from "lucide-react";
import {
  useChannelHistoryRead,
  type ChannelClosedRow,
  type ChannelHistoryState,
  type ChannelRunRow,
  type PreSwitchRow,
} from "../actions/useChannelHistory";
import { relative } from "./channelDetail";
import { isChannelSlug } from "@zavi/shared";
import { platformFor } from "../actions/platforms";
import { ChannelRefreshLine, useChannelReadFailure } from "./ChannelRefresh";
import { CountPill } from "../CountPill";
import { useChannelSurface } from "../actions/ChannelSurface";
import { isAdsChannel } from "../actions/ads/AdsPresentation";
import { ChannelHistory } from "../actions/history/ChannelHistory";

type RunOutcome = "ok" | "running" | "failed";

function outcomeOf(status: string): RunOutcome {
  if (status === "success") return "ok";
  if (status === "queued" || status === "running" || status === "blocked") return "running";
  return "failed";
}

const RUN_STATUS: Record<string, string> = {
  success: "Finished",
  queued: "Waiting to start",
  running: "Running",
  blocked: "Waiting on you",
  failed: "Failed",
  cancelled: "Cancelled",
  parse_failed: "Failed",
  dispatch_error: "Failed to start",
};
const RUN_TRIGGER: Record<string, string> = {
  channel_recipe: "channel run",
  manual: "you ran it",
  chat: "from chat",
  cron: "on schedule",
  scheduled: "on schedule",
  schedule: "on schedule",
  handoff: "handed over by another agent",
  slack: "from Slack",
  email: "from email",
  webhook: "from a webhook",
  playbook: "from a playbook",
};
const words = (map: Record<string, string>, v: string) => map[v] ?? v.replace(/_/g, " ");

const CLOSED_LABEL: Record<ChannelClosedRow["status"], string> = {
  acted: "Done",
  rejected: "Rejected",
  redone: "Redone",
  stale: "Went stale",
  displaced: "Outranked",
};

function when(...candidates: Array<string | null>): string | null {
  const first = candidates.find((c) => c);
  return first ? relative(first) : null;
}

function RunRow({ run }: { run: ChannelRunRow }) {
  const outcome = outcomeOf(run.status);
  const stamp = when(run.finished_at, run.started_at, run.enqueued_at);
  return (
    <li
      className={
        outcome === "failed"
          ? "flex items-start gap-2.5 rounded-xl border border-danger/25 bg-dangerBg px-3.5 py-2.5"
          : "flex items-start gap-2.5 rounded-xl border border-rule bg-cream px-3.5 py-2.5"
      }
    >
      <span aria-hidden className="flex h-5 w-1.5 shrink-0 items-center">
        <span
          data-testid="run-dot"
          className={
            outcome === "ok"
              ? "h-1.5 w-1.5 rounded-full bg-success"
              : outcome === "failed"
                ? "h-1.5 w-1.5 rounded-full bg-danger"
                : "h-1.5 w-1.5 rounded-full bg-inkMuted"
          }
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-ink">
            {isChannelSlug(run.executor) ? platformFor(run.executor).name : run.executor}
            {run.redo_of_action_id ? (
              <span className="ml-1.5 font-normal text-inkMuted">· redo</span>
            ) : null}
          </span>
          {stamp ? <DayLabel text={stamp} /> : null}
        </span>
        {}
        <span className="mt-0.5 block text-[13px] leading-5 text-inkMuted">
          <span className={outcome === "failed" ? "font-medium text-danger" : undefined}>
            {words(RUN_STATUS, run.status)}
          </span>
          {` · ${words(RUN_TRIGGER, run.trigger)}`}
        </span>
      </span>
    </li>
  );
}

function ClosedRow({ row }: { row: ChannelClosedRow }) {
  const stamp = when(row.status_at, row.proposed_at);
  return (
    <li className="rounded-xl border border-rule bg-cream px-3.5 py-2.5">
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-ink">{row.title}</span>
        {stamp ? <DayLabel text={stamp} /> : null}
      </span>
      <span className="mt-0.5 block text-[13px] leading-5 text-inkMuted">
        {CLOSED_LABEL[row.status]}
      </span>
      {}
      {row.note ? (
        <span className="mt-1 block text-[13px] leading-5 text-inkMuted">{row.note}</span>
      ) : null}
    </li>
  );
}

function PreSwitchItem({ row }: { row: PreSwitchRow }) {
  const stamp = when(row.archived_at, row.emitted_at);
  const step = row.position && row.of ? `Step ${row.position} of ${row.of}` : null;
  return (
    <li className="rounded-xl border border-rule bg-creamDeep px-3.5 py-2.5">
      {}
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-inkMuted">
          {row.title ?? "Untitled item"}
        </span>
        {stamp ? <DayLabel text={stamp} /> : null}
      </span>
      {step ? <span className="mt-0.5 block text-[13px] leading-5 text-inkMuted">{step}</span> : null}
    </li>
  );
}

function DayLabel({ text }: { text: string }) {
  return (
    <span data-testid="row-day" className="shrink-0 whitespace-nowrap text-[12px] leading-5 text-inkMuted [font-variant-numeric:tabular-nums]">
      {text}
    </span>
  );
}

export const RUN_PAGE = 5;

function Section<T>({
  title,
  rows,
  render,
  collapsible = false,
}: {
  title: string;
  rows: T[];
  render: (row: T) => ReactNode;
  collapsible?: boolean;
}) {
  const [shown, setShown] = useState(RUN_PAGE);
  const left = rows.length - shown;
  const heading = (
    <>
      {title}
      {rows.length > RUN_PAGE ? (
        <span className="font-medium normal-case tracking-normal [font-variant-numeric:tabular-nums]">
          {`${Math.min(shown, rows.length)} of ${rows.length}`}
        </span>
      ) : null}
    </>
  );
  const body = (
    <>
      <ul className="mt-2 flex flex-col gap-2">{rows.slice(0, shown).map(render)}</ul>
      {left > 0 ? (
        <button
          type="button"
          onClick={() => setShown((n) => n + RUN_PAGE)}
          className="mt-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-inkSoft transition-colors hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          Show more
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </>
  );
  if (collapsible) {
    return (
      <details data-testid={`section-${title.toLowerCase()}`} className="group/section mt-4 first:mt-3">
        <summary className="flex w-fit cursor-pointer list-none items-baseline gap-1 rounded-md text-[12px] font-semibold uppercase tracking-wide text-inkMuted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 [&::-webkit-details-marker]:hidden">
          {heading}
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 self-center transition-transform duration-150 group-open/section:rotate-180 motion-reduce:transition-none"
            aria-hidden
          />
        </summary>
        {body}
      </details>
    );
  }
  return (
    <section className="mt-4 first:mt-3">
      <h4 className="flex items-baseline gap-2 text-[12px] font-semibold uppercase tracking-wide text-inkMuted">
        {heading}
      </h4>
      {body}
    </section>
  );
}

export function ChannelRunDrawerView({ history, slug, logsOnly = false }: { history: ChannelHistoryState; slug?: string; logsOnly?: boolean }) {
  const surface = useChannelSurface();
  if (slug && (surface || isAdsChannel(slug))) return <ChannelHistory key={slug} slug={slug} history={history} doneHistory={platformFor(slug).doneHistory === true} logsOnly={logsOnly} />;
  if (history.state === "idle" || history.state === "loading") return null;

  if (history.state === "error") return null;

  const { runs, closed, pre_switch: preSwitch } = history.history;
  const total = runs.length + closed.length + preSwitch.length;
  if (total === 0) return null;

  return (
    <details
      data-testid="run-drawer"
      className="group mt-3 overflow-hidden rounded-2xl border border-rule bg-white px-4 [&[open]]:pb-4"
    >
      <summary data-testid="run-drawer-summary" className="-mx-4 flex cursor-pointer list-none items-center gap-2.5 px-4 py-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30 motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
        <Clock className="h-3.5 w-3.5 shrink-0 text-inkMuted" aria-hidden />
        <span className="min-w-0 flex-1">Runs and past items</span>
        <CountPill count={total} quiet testId="run-drawer-count" />
        <ChevronDown
          data-testid="run-drawer-chevron"
          className="h-4 w-4 shrink-0 text-inkLight transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>

      {}
      {closed.length > 0 && (
        <Section title="Finished here" rows={closed} render={(r) => <ClosedRow key={r.id} row={r} />} />
      )}

      {runs.length > 0 && (
        <Section
          title="Runs"
          rows={runs}
          collapsible
          render={(r) => <RunRow key={r.run_id} run={r} />}
        />
      )}

      {preSwitch.length > 0 && (
        <section className="mt-4" data-testid="pre-switch">
          <h4 className="text-[12px] font-semibold uppercase tracking-wide text-inkMuted">
            Before the switch
          </h4>
          {}
          <p className="mt-1.5 text-[13px] leading-5 text-inkMuted">
            {preSwitch.length} older {preSwitch.length === 1 ? "item" : "items"}{" "}
            from before this channel moved store, kept read-only. They were
            priced against an account that has moved on, so they cannot be
            approved from here.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {preSwitch.map((r, i) => (
              <PreSwitchItem key={`${r.run_id ?? "no-run"}-${i}`} row={r} />
            ))}
          </ul>
        </section>
      )}
    </details>
  );
}

export function ChannelRunDrawer({ slug }: { slug: string }) {
  const { history, failed, reload } = useChannelHistoryRead(slug);
  const inline = useChannelReadFailure(failed, reload);
  return (
    <>
      {inline && <ChannelRefreshLine onRetry={reload} />}
      <ChannelRunDrawerView history={history} slug={slug} />
    </>
  );
}
