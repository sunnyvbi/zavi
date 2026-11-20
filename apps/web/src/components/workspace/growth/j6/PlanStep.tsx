"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import type { GoalHypothesis, GrowthBet, GrowthChannel, GrowthPlanPayload } from "@/lib/workspace/useGrowthPlan";
import { agreeConstraint, keepMine, setChannelInPlan, setFounderConstraint, switchConstraint } from "./api";
import { day } from "./format";
import { B, L, Mark, RingMark, Src, Tabs, box, eyebrow } from "./ui";

const NAME = new Map<string, string>(CHANNELS.map((c): [string, string] => [c.slug, c.name]));
export const channelLabel = (slug: string) => NAME.get(slug) ?? slug.replace(/_/g, " ");
export const isPaid = (slug: string) => /(_|-)ads$/.test(slug);

const LIVE_BETS = new Set<GrowthBet["status"]>(["proposed", "accepted"]);

export function zaviGuess(hypotheses: GoalHypothesis[] | undefined, skip?: string): GoalHypothesis | null {
  const rank = { confirmed: 0, testing: 1, listed: 2, ruled_out: 9 } as const;
  return (
    (hypotheses ?? [])
      .filter((h) => h.status !== "ruled_out" && h.id !== skip)
      .sort((a, b) => rank[a.status] - rank[b.status])[0] ?? null
  );
}

type Say = (text: string, undo?: () => void) => void;

export function notUsingWhy(c: GrowthChannel): string | null {
  if (c.plan_selected_set_by === "founder_stopped") return "stopped by you";
  if (c.plan_selected && c.plan_selected_set_by === "founder" && !c.autorun) return "added by you, off";
  if (c.plan_selected || c.fit?.value === "high" || c.fit?.value === "medium") return null;
  if (c.fit?.value === "low") return c.fit.line?.trim() || "a poor fit for you";
  return c.cgo_reason?.trim() || "not in Zavi's plan";
}

export function planChannels(data: Pick<GrowthPlanPayload, "bets" | "channels">) {
  const stopped = new Set(data.channels.filter((c) => c.plan_selected_set_by === "founder_stopped").map((c) => c.slug));
  const bets = data.bets
    .filter((b) => b.channel_slug && LIVE_BETS.has(b.status) && !stopped.has(b.channel_slug))
    .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));
  const betSlugs = new Set(bets.map((b) => b.channel_slug as string));
  const channels = data.channels.filter((c) => NAME.has(c.slug) && !RETIRED_CHANNEL_SLUGS.has(c.slug) && !betSlugs.has(c.slug));
  const helping = channels.filter((c) => notUsingWhy(c) === null);
  const notUsing = channels.filter((c) => notUsingWhy(c) !== null);
  return { bets, betSlugs, channels, helping, notUsing };
}

export function withoutNotUsing<T extends { channel_slug: string | null; tone?: string | null }>(cards: readonly T[], data: Pick<GrowthPlanPayload, "bets" | "channels">): T[] {
  const off = new Set(planChannels(data).notUsing.map((c) => c.slug));
  return cards.filter((c) => !c.channel_slug || c.tone === "danger" || !off.has(c.channel_slug));
}

export function PlanStep({
  data,
  counts,
  hasGoal,
  goalId,
  drafting,
  canEdit,
  onDraftStarted,
  jumpToday,
  say,
  onChanged,
}: {
  data: GrowthPlanPayload;
  counts: Record<string, number> | null;
  hasGoal: boolean;
  goalId: string | null;
  drafting: boolean;
  canEdit: boolean;
  onDraftStarted?: (runId?: string) => void;
  jumpToday: () => void;
  say: Say;
  onChanged: () => Promise<void>;
}) {
  const [writing, setWriting] = useState(false);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "paid" | "organic">("paid");
  const [helpingShut, setHelpingShut] = useState(false);

  const plan = data.unreadable.includes("plan") ? null : data.plan;
  const statement = plan?.constraint_statement?.trim() ?? "";
  const founder = plan?.founder_constraint?.trim() ?? "";
  const agreed = !!plan?.constraint_agreed_at;
  const untested = plan?.constraint_confidence !== "high";
  const conflicts = data.constraint_conflicts ?? [];
  const conflict = statement ? (conflicts.find((c) => c.goal_id === goalId) ?? conflicts[0] ?? null) : null;
  const hypotheses = data.goal_work?.[conflict?.goal_id ?? goalId ?? ""]?.hypotheses;
  const guess = zaviGuess(hypotheses, conflict?.hypothesis_id);

  const run = async (fn: () => Promise<{ ok: boolean; message: string | null }>, done: string, undo?: () => Promise<unknown>) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      say(r.message ?? "Could not save that. Try again.");
      return false;
    }
    say(done, undo ? () => void undo().then(() => onChanged()) : undefined);
    await onChanged();
    return true;
  };

  const saveOwn = async () => {
    const text = own.trim().slice(0, 300);
    if (!text) return;
    const prev = founder || null;
    if (await run(() => setFounderConstraint(text), "Saved. Zavi will plan around your view.", () => setFounderConstraint(prev))) {
      setWriting(false);
      setOwn("");
    }
  };

  const switchTo = async (hypothesisId: string) => {
    setBusy(true);
    const r = await switchConstraint(hypothesisId);
    setBusy(false);
    if (!r.ok) {
      say(r.message ?? "Could not switch the plan.");
      return onChanged();
    }
    const runId = typeof r.body?.run_id === "string" ? r.body.run_id : undefined;
    onDraftStarted?.(runId);
    say("Re-planning around Zavi's guess.");
    await onChanged();
  };

  const stop = (slug: string) =>
    run(() => setChannelInPlan(slug, false), `Stopped ${channelLabel(slug)}. Its open jobs leave your list.`, () => setChannelInPlan(slug, true));
  const use = (slug: string) =>
    run(() => setChannelInPlan(slug, true), `Added ${channelLabel(slug)}. First jobs show up after Zavi's next review.`, () => setChannelInPlan(slug, false));

  const writer = (
    <>
      <input
        autoFocus
        value={own}
        maxLength={300}
        aria-label="What do you think it is?"
        onChange={(e) => setOwn(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void saveOwn();
        }}
        placeholder="What do you think it is?"
        className="h-10 min-w-[240px] max-w-full flex-1 rounded-full border border-ink/15 bg-cream px-4 text-[15px] text-ink outline-none placeholder:text-inkMuted focus:border-[#60acff]"
      />
      <B dark disabled={!own.trim() || busy} onClick={() => void saveOwn()}>
        Save
      </B>
      <L onClick={() => setWriting(false)}>Cancel</L>
    </>
  );

  let diagnosis: ReactNode;
  if (!plan) {
    diagnosis = <p className="mt-1.5 text-[15px] leading-6 text-inkMuted">{drafting ? "Zavi is writing your plan…" : data.unreadable.includes("plan") ? "Couldn't load the plan. Try again in a moment." : "No plan yet."}</p>;
  } else if (conflict) {
    const kept = !!conflict.kept_at;
    diagnosis = (
      <div className="mt-1.5 grid gap-2 text-[15px] leading-6 text-inkSoft">
        <p className={kept ? "" : "text-inkMuted"}>
          <b className="font-semibold text-ink">Your plan:</b> {statement} {kept && conflict.kept_at && <span className="text-[14px] text-inkMuted">· You kept yours on {day(conflict.kept_at)}</span>}
        </p>
        <p>
          <b className="font-semibold text-ink">Zavi&apos;s guess:</b>{" "}
          {guess ? (
            <>
              {guess.claim} {guess.status !== "confirmed" && <Src kind="estimate">not tested yet</Src>}
            </>
          ) : (
            <span className="text-inkMuted">not worked out yet</span>
          )}
        </p>
        {canEdit && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {guess && (
              <B disabled={busy || drafting} onClick={() => void switchTo(guess.id)}>
                Switch to Zavi&apos;s
              </B>
            )}
            {!kept && (
              <B disabled={busy} onClick={() => void run(() => keepMine(conflict.hypothesis_id, true), "Kept your plan.", () => keepMine(conflict.hypothesis_id, false))}>
                Keep mine
              </B>
            )}
            {drafting && <span className="text-[14px] text-inkMuted">Re-planning…</span>}
          </div>
        )}
      </div>
    );
  } else {
    diagnosis = (
      <div className="mt-1.5 text-[15px] leading-6 text-inkSoft">
        {founder ? (
          <>
            <p>
              <b className="font-semibold text-ink">Your view:</b> {founder}{" "}
              <span className="text-[14px] text-inkMuted">· Zavi plans around this{plan.founder_constraint_at ? ` since ${day(plan.founder_constraint_at)}` : ""}</span>
            </p>
            {guess && (
              <p className="mt-1 text-inkMuted">
                <b className="font-semibold text-ink">Zavi&apos;s guess:</b> {guess.claim} {guess.status !== "confirmed" && <Src kind="estimate">not tested yet</Src>}
              </p>
            )}
          </>
        ) : statement ? (
          <p>
            <b className="font-semibold text-ink">Zavi&apos;s guess:</b> {statement} {untested && <Src kind="estimate">not tested yet</Src>}
            {agreed && <span className="ml-1 rounded-full bg-creamDeep px-2 py-0.5 align-middle text-[12px] font-semibold leading-4 text-inkSoft">you agreed</span>}
          </p>
        ) : (
          <p className="text-inkMuted">Not worked out yet.</p>
        )}
        {!hasGoal && <p className="mt-0.5 text-[14px] text-inkMuted">A first plan. It gets sharper once you pick a goal.</p>}
        {canEdit && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {writing ? (
              writer
            ) : founder ? (
              <>
                <L
                  onClick={() => {
                    setOwn(founder);
                    setWriting(true);
                  }}
                >
                  Change
                </L>
                {guess ? (
                  <B disabled={busy || drafting} onClick={() => void switchTo(guess.id)}>
                    Switch to Zavi&apos;s
                  </B>
                ) : (
                  <L disabled={busy} onClick={() => void run(() => setFounderConstraint(null), "Your view is cleared.", () => setFounderConstraint(founder))}>
                    Clear my view
                  </L>
                )}
                {drafting && <span className="text-[14px] text-inkMuted">Re-planning…</span>}
              </>
            ) : agreed ? (
              <L onClick={() => void run(() => agreeConstraint(false), "Reopened.")}>Change</L>
            ) : statement ? (
              <>
                <B disabled={busy} onClick={() => void run(() => agreeConstraint(true), "Thanks. The plan below stays.", () => agreeConstraint(false))}>
                  Sounds right
                </B>
                <B onClick={() => setWriting(true)}>Not quite…</B>
              </>
            ) : (
              <B onClick={() => setWriting(true)}>Tell Zavi what you think it is</B>
            )}
          </div>
        )}
      </div>
    );
  }

  const { bets, betSlugs, channels, helping, notUsing } = planChannels(data);
  const listed = new Set([...betSlugs, ...channels.map((c) => c.slug)]);
  const addable = CHANNELS.filter((c) => !RETIRED_CHANNEL_SLUGS.has(c.slug as string) && !listed.has(c.slug as string));
  const toDo = (slug: string) =>
    counts === null ? (
      <span className="text-inkMuted">to-dos not read yet</span>
    ) : counts[slug] ? (
      <L onClick={jumpToday}>{counts[slug]} to do</L>
    ) : (
      <span className="text-inkMuted">0 to do</span>
    );

  const offList = [
    ...notUsing.map((n) => ({ slug: n.slug, why: notUsingWhy(n) })),
    ...addable.map((a) => ({ slug: a.slug as string, why: null as string | null })),
  ].sort((a, b) => channelLabel(a.slug).localeCompare(channelLabel(b.slug)));
  const paid = offList.filter((n) => isPaid(n.slug));
  const organic = offList.filter((n) => !isPaid(n.slug));
  const shownOff = filter === "paid" ? paid : filter === "organic" ? organic : offList;

  return (
    <div className={`${box} divide-y divide-rule`}>
      <div className="p-4">
        <p className={eyebrow}>What&apos;s holding you back</p>
        {diagnosis}
      </div>

      <div className="p-4">
        <p className={eyebrow}>Working on</p>
        {bets.length === 0 && <p className="mt-3 text-[15px] leading-6 text-inkMuted">{drafting ? "Zavi is picking channels…" : "No channels picked yet."}</p>}
        {bets.length > 0 && (
          <ul className="mt-3 flex flex-col gap-4">
            {bets.map((b) => {
              const slug = b.channel_slug as string;
              const r = b.result ?? null;
              return (
                <li key={b.id} className="flex items-start gap-3">
                  <Mark slug={slug} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] leading-6 text-inkSoft">
                      <span className="font-semibold text-ink">{channelLabel(slug)}:</span> {b.rationale ?? b.intent}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[14px] leading-5 text-inkMuted">
                      {r ? (
                        <>
                          <Src kind={r.label}>{r.label === "measured" ? "result" : r.label === "blocked" ? "blocked" : "no number"}</Src> {r.line}
                          {r.source ? ` · ${r.source}` : ""}
                        </>
                      ) : (
                        <Src kind="unmeasured">not measured yet</Src>
                      )}
                    </p>
                    {open === b.id && (
                      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[14px] leading-5 text-inkSoft">
                        {b.falsifier ? `Zavi drops it if: ${b.falsifier.replace(/\.$/, "")}.` : "Zavi hasn't said when it would drop this."}
                        {canEdit && (
                          <L disabled={busy} onClick={() => void stop(slug)}>
                            Stop this channel now
                          </L>
                        )}
                      </p>
                    )}
                  </div>
                  <span className="flex shrink-0 items-center gap-3 text-[14px] leading-5 text-inkMuted">
                    {toDo(slug)}
                    <L onClick={() => setOpen(open === b.id ? null : b.id)}>{open === b.id ? "Less" : "When it stops"}</L>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div data-section="helping" className="mt-4 text-[15px] leading-6 text-inkSoft">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink">Also helping:</span>
            {helping.length === 0 && <span className="text-inkMuted">nothing else yet</span>}
            {helping.length > 0 && helpingShut && <span className="text-[14px] text-inkMuted">{helping.length}</span>}
            {helping.length > 0 && (
              <button
                type="button"
                onClick={() => setHelpingShut(!helpingShut)}
                aria-expanded={!helpingShut}
                aria-label={helpingShut ? "Show Also helping" : "Collapse Also helping"}
                title={helpingShut ? "Show" : "Collapse"}
                className="ml-auto flex size-8 cursor-pointer items-center justify-center rounded-full text-inkMuted hover:bg-creamDeep hover:text-ink"
              >
                {helpingShut ? <ChevronDown className="h-[18px] w-[18px]" strokeWidth={1.75} /> : <ChevronUp className="h-[18px] w-[18px]" strokeWidth={1.75} />}
              </button>
            )}
          </div>
          {helping.length > 0 && !helpingShut && (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Channels also helping">
              {helping.map((h) => {
                const why = h.fit?.line?.trim().replace(/\.$/, "") || h.cgo_reason?.trim() || null;
                return (
                  <li key={h.slug} className="group relative">
                    <span
                      tabIndex={why ? 0 : undefined}
                      className="inline-flex min-h-10 items-center gap-2.5 rounded-full border border-rule py-1 pl-1.5 pr-1.5 text-[15px] text-ink outline-none focus-visible:border-[#60acff]"
                    >
                      <RingMark slug={h.slug} size={28} />
                      {channelLabel(h.slug)}
                      {counts && counts[h.slug] ? <L onClick={jumpToday}>{counts[h.slug]} to do</L> : null}
                      {canEdit ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void stop(h.slug)}
                          aria-label={`Stop ${channelLabel(h.slug)}`}
                          title={`Stop ${channelLabel(h.slug)}`}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-full text-ink hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <X className="h-[18px] w-[18px]" strokeWidth={1.75} />
                        </button>
                      ) : (
                        <span className="w-1.5" />
                      )}
                    </span>
                    {why && (
                      <span
                        role="tooltip"
                        className="pointer-events-none invisible absolute bottom-full left-0 z-20 mb-2 w-max max-w-[300px] rounded-lg bg-ink px-3 py-2 text-[13px] leading-5 text-cream opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
                      >
                        {why}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="p-4">
        <p className="text-[18px] font-semibold leading-7 text-ink">Not using</p>
        {drafting && bets.length === 0 ? (
          <p className="text-[15px] leading-6 text-inkMuted">Zavi is still choosing.</p>
        ) : (
          <>
            {offList.length > 0 && (
              <div className="mt-3">
                <Tabs
                  label="Filter channels"
                  value={filter}
                  onChange={setFilter}
                  items={[
                    { value: "all", label: "All", count: offList.length },
                    { value: "paid", label: "Paid", count: paid.length },
                    { value: "organic", label: "Organic", count: organic.length },
                  ]}
                />
              </div>
            )}
            {shownOff.length === 0 ? (
              <p className="mt-3 text-[15px] leading-6 text-inkMuted">{offList.length === 0 ? "nothing" : "Nothing here."}</p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Channels not in use">
                {shownOff.map((n) => (
                  <li key={n.slug}>
                    <span
                      title={n.why ? `Not used: ${n.why}` : undefined}
                      data-why={n.why ?? undefined}
                      className="inline-flex min-h-10 items-center gap-2.5 rounded-full border border-rule py-1 pl-1.5 pr-1.5 text-[15px] text-ink"
                    >
                      <RingMark slug={n.slug} size={28} />
                      {channelLabel(n.slug)}
                      {canEdit ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void use(n.slug)}
                          aria-label={`Use ${channelLabel(n.slug)}`}
                          title={`Use ${channelLabel(n.slug)}`}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-full text-ink hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Plus className="h-[18px] w-[18px]" strokeWidth={1.75} />
                        </button>
                      ) : (
                        <span className="w-1.5" />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
