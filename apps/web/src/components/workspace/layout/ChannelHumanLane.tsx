"use client";

import { useEffect, useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, CircleCheck, Clapperboard, FileText, Users } from "lucide-react";
import type { Channel } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { cx, FOCUS_RING } from "./shared";
import type { HumanBriefsResponse, HumanBrief } from "@/components/humans/humanTypes";
import { isNeverPaidJob, type CreatorJobsResponse, type CreatorJobSummary } from "@/components/humans/creatorJobTypes";
import { dayTimeUtc, firstName, shortDay, UGC_BRIEFS_CHANGED_EVENT, useUgcDrawer, type DrawerName, type DrawerParams } from "../ugc/hub";

export type Tone = "open" | "action" | "quiet";
export type Row = {
  id: string;
  kind: "Brief" | "Job";
  title: string;
  status: string;
  tone: Tone;
  line: string;
  drawer: DrawerName;
  params: DrawerParams;
  done?: boolean;
};

export const TONE: Record<Tone, string> = {
  open: "bg-successBg text-success",
  action: "bg-warnBg text-warn",
  quiet: "bg-bone text-inkMuted",
};

const TILE: Record<Tone, string> = {
  open: "bg-emerald-500/15 text-emerald-600",
  action: "bg-amber-500/15 text-amber-600",
  quiet: "bg-bone text-inkMuted",
};

const DOT: Record<Tone, string> = {
  open: "bg-emerald-500",
  action: "bg-amber-500",
  quiet: "bg-inkMuted",
};

function chipIcon(part: string) {
  if (/applied$/.test(part)) return Users;
  if (/^answer by/.test(part)) return CalendarClock;
  if (/^closed/.test(part)) return CircleCheck;
  return null;
}

type LoadState = { kind: "loading" } | { kind: "ready"; rows: Row[]; jobsFailed: boolean } | { kind: "error" };

export const LANE_TOP = 5;

export function briefRow(b: HumanBrief): Row | null {
  if (!b.posted_at) return null;
  const n = b.application_count ?? 0;
  const base = { id: `brief-${b.id}`, kind: "Brief" as const, title: b.title || "Untitled brief", drawer: "applicants" as const, params: { brief: b.id } };
  if (b.closed_at || b.status === "filled" || b.status === "cancelled") {
    const closed = shortDay(b.closed_at);
    return {
      ...base,
      status: b.status === "filled" ? "Hired" : "Closed",
      tone: "quiet",
      line: `${n} applied${closed ? ` · closed ${closed}` : ""}`,
      done: true,
    };
  }
  const by = shortDay(b.answer_by);
  return { ...base, status: "Open", tone: "open", line: `${n} applied${by ? ` · answer by ${by}` : ""}` };
}

const CLOSED_WORD: Record<string, string> = {
  approved: "Approved",
  auto_accepted: "Accepted automatically",
  mediation_pay_full: "Zavi decided",
  mediation_pay_part: "Zavi decided",
  mediation_refund: "Zavi decided: refund",
  declined: "Declined",
  expired: "No answer",
  withdrawn: "You cancelled",
  no_show: "Not delivered, refunded",
  cancel_agreed: "Cancelled, refunded",
  cancel_no_response: "Cancelled, refunded",
  payment_failed: "Payment failed",
  creator_removed: "Creator removed",
};

const DEADLINE_WORD: Record<string, string> = {
  review: "Review by",
  accept: "Answer by",
  due: "Due",
  no_show_grace: "Last day",
  cancel_response: "Answer by",
  offer_expiry: "Answer by",
};

export function jobRow(j: CreatorJobSummary): Row | null {
  if (isNeverPaidJob(j)) return null;
  const who = j.creator_display_name || "Creator";
  const n = firstName(who);
  const at = j.deadline ? (j.deadline.kind === "due" ? shortDay(j.deadline.deadline_at) : dayTimeUtc(j.deadline.deadline_at)) : "";
  const when = j.deadline ? `${DEADLINE_WORD[j.deadline.kind] ?? "By"} ${at}` : "";
  const changes = j.revisions_used !== undefined ? ` · ${j.revisions_used} of 2 changes used` : "";
  const base = { id: `job-${j.id}`, kind: "Job" as const, title: `${who}: ${j.title}`, params: { job: j.id } };
  switch (j.status) {
    case "completed":
    case "cancelled": {
      const closed = shortDay(j.closed_at);
      return {
        ...base,
        status: CLOSED_WORD[j.closed_reason ?? ""] ?? (j.status === "completed" ? "Done" : "Cancelled"),
        tone: "quiet",
        line: closed ? `Closed ${closed}` : "",
        drawer: j.status === "completed" ? "review" : "job",
        done: true,
      };
    }
    case "awaiting_acceptance":
      return { ...base, status: `Waiting for ${n}`, tone: "action", line: when, drawer: "job" };
    case "in_progress":
      if (j.product_needed && !j.product_received_at) {
        return {
          ...base,
          status: "Waiting for your product",
          tone: "action",
          line: `Send ${n} the product. The due date starts when ${n} marks it received.`,
          drawer: "job",
        };
      }
      if (j.extension_state === "requested") {
        const asked = shortDay(j.extension_requested_due_at);
        return {
          ...base,
          status: `${n} asked for more time`,
          tone: "action",
          line: `${when}${asked ? ` · wants ${asked}` : ""} · approve or decline in the job`,
          drawer: "job",
        };
      }
      return { ...base, status: "In progress", tone: "open", line: when, drawer: "job" };
    case "submitted":
      return { ...base, status: "Delivered, review it", tone: "action", line: `${when}${changes}`, drawer: "review" };
    case "revision_requested":
      return { ...base, status: "Changes requested", tone: "open", line: when, drawer: "job" };
    case "cancel_requested":
      return { ...base, status: "You asked to cancel", tone: "quiet", line: when, drawer: "job" };
    case "in_dispute":
      return { ...base, status: "Zavi is stepping in", tone: "quiet", line: "Zavi staff are looking at this job.", drawer: "job" };
    default:
      return { ...base, status: j.status, tone: "quiet", line: when, drawer: "job" };
  }
}

export function ChannelHumanLane({ channel }: { channel: Channel }) {
  const human = channel.human;
  const drawer = useUgcDrawer();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(true);
  const reloadKey = drawer.name;
  const [changed, setChanged] = useState(0);

  useEffect(() => {
    const bump = () => setChanged((n) => n + 1);
    const back = () => {
      if (document.visibilityState === "visible") bump();
    };
    window.addEventListener(UGC_BRIEFS_CHANGED_EVENT, bump);
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener(UGC_BRIEFS_CHANGED_EVENT, bump);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);

  useEffect(() => {
    if (!human?.available) return;
    let alive = true;
    void (async () => {
      try {
        const [bRes, jRes] = await Promise.all([apiFetch("/api/humans/briefs"), apiFetch("/api/humans/orders")]);
        if (!bRes.ok) throw new Error(String(bRes.status));
        const briefs = ((await bRes.json()) as HumanBriefsResponse).briefs ?? [];
        const jobsFailed = !jRes.ok;
        const jobs = jRes.ok ? (((await jRes.json()) as CreatorJobsResponse).jobs ?? []) : [];
        const all = [
          ...briefs.map(briefRow).filter((r): r is Row => r !== null),
          ...jobs.map(jobRow).filter((r): r is Row => r !== null),
        ];
        const rank = (r: Row) => (!r.done ? 0 : r.kind === "Job" ? 1 : 2);
        const rows = [0, 1, 2].flatMap((k) => all.filter((r) => rank(r) === k));
        if (alive) setState({ kind: "ready", rows, jobsFailed });
      } catch {
        if (alive) setState({ kind: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [human?.available, reloadKey, changed]);

  if (!human?.available) return null;

  return (
    <section aria-labelledby="channel-human-lane" className="mt-8">
      <h3 id="channel-human-lane" className="text-[22px] font-semibold tracking-tight text-ink">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="channel-human-lane-body"
          onClick={() => setOpen((v) => !v)}
          className={cx("group flex w-full cursor-pointer items-center gap-2.5 text-left", FOCUS_RING)}
        >
          <span>Your creators</span>
          {state.kind === "ready" && state.rows.length > 0 && (
            <span aria-label={`${state.rows.length} in total`} className="rounded-full bg-creamDeep px-2.5 py-0.5 text-[13px] font-semibold tracking-normal text-inkMuted">
              {state.rows.length}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cx(
              "ml-auto h-5 w-5 shrink-0 text-inkMuted transition-transform group-hover:text-ink motion-reduce:transition-none",
              open ? "rotate-180" : "",
            )}
          />
        </button>
      </h3>
      {open && (
      <div id="channel-human-lane-body">
      <p className="mt-1.5 text-[14px] leading-5 text-inkMuted">
        Briefs you posted and the jobs running from them. Open one to see applicants, messages and the work.
      </p>

      {}
      {state.kind === "loading" && (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading your creators.</span>
          <ul aria-hidden="true" className="mt-2 flex flex-col gap-2">
            {["w-1/2", "w-2/5", "w-3/5"].map((w) => (
              <li key={w} className="rounded-2xl border border-rule bg-white p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <span className={cx("h-5 animate-pulse rounded-md bg-bone motion-reduce:animate-none", w)} />
                  <span className="h-5 w-16 shrink-0 animate-pulse rounded-md bg-bone motion-reduce:animate-none" />
                </div>
                <span className="mt-2 block h-3.5 w-1/3 animate-pulse rounded-md bg-bone motion-reduce:animate-none" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.kind === "error" && (
        <p className="mt-2 text-[13px] leading-5 text-inkMuted">Couldn&apos;t load your briefs and jobs just now.</p>
      )}

      {state.kind === "ready" && state.jobsFailed && (
        <p role="alert" className="mt-2 text-[13px] leading-5 text-inkMuted">
          Couldn&apos;t load your jobs just now. Reopen the channel to try again.
        </p>
      )}

      {state.kind === "ready" && !state.jobsFailed && state.rows.length === 0 && (
        <p className="mt-2 text-[13px] leading-5 text-inkMuted">
          No briefs or jobs yet. Run UGC Videos and Zavi drafts one for you, or write your own brief.
        </p>
      )}

      {state.kind === "ready" && state.rows.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {(showAll ? state.rows : state.rows.slice(0, LANE_TOP)).map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => drawer.open(b.drawer, b.params)}
                className={cx(
                  "group flex w-full cursor-pointer items-center gap-4 rounded-2xl border border-rule bg-white px-5 py-4 text-left shadow-elev transition-colors duration-150 hover:border-inkMuted/40 hover:bg-bone motion-reduce:transition-none",
                  b.done && "opacity-75 hover:opacity-100",
                  FOCUS_RING,
                )}
              >
                <span aria-hidden="true" className={cx("grid h-12 w-12 shrink-0 place-items-center rounded-xl", TILE[b.tone])}>
                  {b.kind === "Brief" ? <FileText className="h-[22px] w-[22px]" /> : <Clapperboard className="h-[22px] w-[22px]" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="sr-only">{b.kind}: </span>
                    <span
                      className={cx(
                        "truncate text-[17px] font-semibold",
                        b.done ? "text-inkSoft" : "text-ink",
                      )}
                    >
                      {b.title}
                    </span>
                  </span>
                  {b.line && b.kind === "Brief" ? (
                    <span className="mt-2 flex flex-wrap items-center gap-1.5" aria-label={b.line}>
                      {b.line.split(" · ").map((part) => {
                        const Icon = chipIcon(part);
                        return (
                          <span key={part} className="inline-flex items-center gap-1.5 rounded-full bg-creamDeep px-2.5 py-1 text-[13px] text-inkSoft">
                            {Icon && <Icon aria-hidden="true" className="h-3.5 w-3.5 text-inkMuted" />}
                            {part}
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    b.line && <span className="mt-1 block truncate text-[14px] text-inkMuted">{b.line}</span>
                  )}
                </span>
                <span className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold", TONE[b.tone])}>
                  <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", DOT[b.tone])} />
                  {b.status}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 text-inkMuted transition-colors group-hover:text-ink motion-reduce:transition-none"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.kind === "ready" && state.rows.length > LANE_TOP && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className={cx("mt-2 block cursor-pointer text-[13px] font-medium text-inkMuted underline hover:text-ink", FOCUS_RING)}
        >
          {showAll ? "Show less" : "Show more"}
        </button>
      )}
      </div>
      )}
    </section>
  );
}
