"use client";

import { CreditRefusalNotice } from "@/components/workspace/CreditRefusalNotice";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/lib/api";
import { recallRunId, runCostLabel, useChannelRunPress } from "./useChannelRunPress";
import { cx, FOCUS_RING } from "./shared";
import { CookingCard, EmptyBody, EmptyCard } from "./ChannelEmptyCard";
import { cardButton } from "../actions/card/styles";
import { Markdown } from "../Markdown";
import { useChannelChatOpener, type ChannelChatOpener } from "../actions/channelChat";
import { useChannelPlanLock } from "../actions/channelPlanLock";
import { readTopActionRun } from "../actions/topActions/api";
import { platformFor } from "../actions/platforms";
import { useEmailRunSlot } from "../email/emailRunSlot";
import type { ChannelDetail } from "./channelDetail";

type ChannelRunFacts = { reserveCredits: number | null; lastRunId: string | null; costLoaded: boolean };

function pickRunId(
  pinned: { id: string; at: number } | null,
  getId: unknown,
  getAt: unknown,
): string | null {
  const fromGet = typeof getId === "string" ? getId : null;
  if (!pinned) return fromGet;
  if (!fromGet) return pinned.id;
  const getMs = typeof getAt === "string" ? Date.parse(getAt) : NaN;
  if (!Number.isFinite(getMs)) return pinned.id;
  return getMs > pinned.at ? fromGet : pinned.id;
}

function useChannelRunFacts(slug: string, refreshKey: string | null): ChannelRunFacts {
  const [facts, setFacts] = useState<ChannelRunFacts>({ reserveCredits: null, lastRunId: null, costLoaded: false });

  useEffect(() => {
    if (!slug) return;
    const pinned = recallRunId(slug);
    setFacts((f) =>
      f.lastRunId === (pinned?.id ?? null) ? f : { ...f, lastRunId: pinned?.id ?? null },
    );
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/channels");
        if (!res.ok) return;
        const body = (await res.json()) as {
          channels?: Array<{
            channel_slug?: string;
            run_reserve_credits?: unknown;
            last_run_id?: unknown;
            last_run_at?: unknown;
          }>;
        };
        const row = (body.channels ?? []).find((c) => c.channel_slug === slug);
        if (cancelled || !row) return;
        setFacts({
          reserveCredits:
            typeof row.run_reserve_credits === "number" && Number.isFinite(row.run_reserve_credits) && row.run_reserve_credits > 0
              ? row.run_reserve_credits
              : null,
          lastRunId: pickRunId(pinned, row.last_run_id, row.last_run_at),
          costLoaded: true,
        });
      } catch {
      } finally {
        if (!cancelled) setFacts((f) => (f.costLoaded ? f : { ...f, costLoaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, refreshKey]);

  return facts;
}

type LastRunWords =
  | { state: "pending" }
  | { state: "said"; text: string; full?: string }
  | { state: "silent" }
  | { state: "unreadable" };

function useLastRunWords(slug: string, runId: string | null, enabled: boolean): LastRunWords {
  const [words, setWords] = useState<{ key: string; value: LastRunWords } | null>(null);
  const key = enabled && slug && runId ? `${slug}|${runId}` : "";

  useEffect(() => {
    if (!key || !runId) return;
    let cancelled = false;
    readTopActionRun(slug, runId)
      .then((r) => {
        if (cancelled) return;
        const note = typeof r.note === "string" ? r.note.trim() : "";
        const text = (typeof r.summary === "string" ? r.summary.trim() : "") || note;
        const filed = Array.isArray(r.actions) && r.actions.length > 0;
        const full = note && note !== text ? note : undefined;
        setWords({ key, value: !filed && text ? { state: "said", text, ...(full ? { full } : {}) } : { state: "silent" } });
      })
      .catch(() => {
        if (!cancelled) setWords({ key, value: { state: "unreadable" } });
      });
    return () => {
      cancelled = true;
    };
  }, [key, slug, runId]);

  if (!key) return { state: "silent" };
  return words?.key === key ? words.value : { state: "pending" };
}

export type ChannelRunInfo = {
  slug: string;
  name: string;
  switched: boolean | "unknown";
  priorCount: number;
  foldBelow: boolean;
  onRan: () => void;
  onPress?: () => void;
  onPressEnd?: () => void;
};

function RunChannelButton({
  run,
  label,
  tone = "primary",
  running = false,
  costLabel,
  showCost = true,
  after,
  emailRow = false,
  center = false,
}: {
  run: ChannelRunInfo;
  label: string;
  tone?: "primary" | "quiet";
  running?: boolean;
  costLabel: string;
  showCost?: boolean;
  after?: ReactNode;
  emailRow?: boolean;
  center?: boolean;
}) {
  const planLock = useChannelPlanLock();
  const { press, busy, fired, blocked, error, credit } = useChannelRunPress({
    slug: run.slug,
    running,
    onRan: run.onRan,
    onStart: run.onPress,
    onSettle: run.onPressEnd,
    planLock,
  });
  const emailSlot = useEmailRunSlot();
  const slot = emailRow && run.slug === "email_marketing" ? emailSlot : null;

  const button = (
    <button
      type="button"
      onClick={press}
      disabled={blocked}
      aria-disabled={blocked || undefined}
      data-testid="run-channel"
      className={center && !slot ? cx(cardButton.base, tone === "primary" ? cardButton.primary : cardButton.secondary) : cx(
        "inline-flex items-center gap-2 rounded-cta border px-3.5 font-semibold transition-opacity",
        slot ? "h-9 cursor-pointer whitespace-nowrap text-[13px]" : "h-9 text-[14px]",
        tone === "primary"
          ? "border-ca-action bg-ca-action text-ca-on-action hover:opacity-90"
          : "border border-ca-border bg-ca-bg font-medium text-ca-xdark hover:bg-ca-subtle",
        blocked && "cursor-not-allowed opacity-50 hover:opacity-50",
        FOCUS_RING,
      )}
    >
      {busy ? "Starting…" : running ? "Running…" : label}
    </button>
  );
  const cost = showCost && !fired && !running && <span className="text-[13px] text-ca-secondary">{costLabel}</span>;
  const notes = (
    <>
      {fired && (
        <p role="status" className="mt-2 text-[13px] leading-5 text-ca-secondary">
          Started. This takes a few minutes; the actions land here when it
          finishes.
        </p>
      )}
      {error && credit && error === credit.headline && (
        <CreditRefusalNotice refusal={credit} className="mt-2" />
      )}
      {error && !(credit && error === credit.headline) && (
        <p role="alert" className="mt-2 text-[13px] leading-5 text-danger">
          {error}
        </p>
      )}
    </>
  );

  if (slot) {
    return (
      <>
        {createPortal(
          <>
            {button}
            {cost}
            {(fired || error) && <div data-testid="run-channel-notes" className="w-full text-right">{notes}</div>}
          </>,
          slot,
        )}
        {after && <div className={cx("flex flex-wrap items-center gap-2", center ? "mt-5 justify-center" : "mt-3")}>{after}</div>}
      </>
    );
  }

  return (
    <>
      <div className={cx("flex flex-wrap items-center gap-2", center ? "mt-5 justify-center" : "mt-3")}>
        {button}
        {cost}
        {after}
      </div>
      {notes}
    </>
  );
}

export function StaleSignupBanner({
  run,
  weeks,
  running = false,
}: {
  run: ChannelRunInfo;
  weeks: number;
  running?: boolean;
}) {
  const facts = useChannelRunFacts(run.slug, null);
  return (
    <div
      data-testid="stale-signup-banner"
      className="mt-5 rounded-xl border border-ca-border bg-ca-subtle px-4 py-3 text-[13px] leading-5 text-ca-xdark"
    >
      <p>
        Found <span className="font-semibold">{`${weeks} ${weeks === 1 ? "week" : "weeks"} ago`}</span>, when you signed up.
      </p>
      <RunChannelButton
        run={run}
        label="Refresh"
        tone="quiet"
        running={running}
        costLabel={runCostLabel(facts.reserveCredits)}
        showCost={platformFor(run.slug).hideRunCost !== true}
      />
    </div>
  );
}

function AskAboutChannelButton({ open, label = "Ask Zavi about this channel", center = false }: { open: ChannelChatOpener; label?: string; center?: boolean }) {
  const openChat = open;
  return (
    <button
      type="button"
      onClick={() => openChat({ target: "channel" })}
      data-testid="ask-about-channel"
      className={center ? cx(cardButton.base, cardButton.secondary) : cx(
        "inline-flex h-9 items-center rounded-cta border border-ca-border bg-ca-bg px-3.5 text-[14px] font-medium text-ca-xdark hover:bg-ca-subtle",
        FOCUS_RING,
      )}
    >
      {label}
    </button>
  );
}

function RunSlot({
  run,
  label,
  tone,
  running,
  costLabel,
  showCost = true,
  askLabel,
  center = false,
}: {
  run: ChannelRunInfo | null;
  label: string;
  tone?: "primary" | "quiet";
  running?: boolean;
  costLabel: string;
  showCost?: boolean;
  askLabel?: string;
  center?: boolean;
}) {
  const openChat = useChannelChatOpener();
  const ask = openChat ? <AskAboutChannelButton open={openChat} label={askLabel} center={center} /> : null;
  if (!run) {
    if (!ask) return null;
    return <div className={cx("flex flex-wrap items-center gap-2", center ? "mt-5 justify-center" : "mt-3")}>{ask}</div>;
  }
  return (
    <RunChannelButton
      run={run}
      label={label}
      tone={tone}
      running={running ?? false}
      costLabel={costLabel}
      showCost={showCost}
      after={ask}
      emailRow
      center={center}
    />
  );
}

function priorPhrase(n: number): string {
  return n === 1 ? "Your earlier item is" : `Your ${n} earlier items are`;
}

function RunSaidText({ text, full }: { text: string; full?: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 220 || Boolean(full);
  return (
    <>
      <div
        data-testid="empty-run-said-text"
        className={cx("mt-2 max-w-[60ch] text-ca-body text-ca-secondary", long && !all && "line-clamp-3")}
      >
        {all || !long ? (
          <Markdown source={full ?? text} compact breaks disableActionLinks />
        ) : (
          text.replace(/^[ \t]*[-*][ \t]+/gm, "").replace(/\s*\n+\s*/g, " ")
        )}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className={cx("mt-1.5 text-[13px] font-medium text-ca-xdark underline underline-offset-2", FOCUS_RING)}
        >
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

function whyLine(text: string): string {
  const body = text
    .trim()
    .replace(/^(?:(?:why\s*:|because\b)[\s,;:\-–—]*)+/iu, "")
    .replace(/[\s,;:]+$/u, "");
  if (!body) return "";
  const [first = "", second = ""] = Array.from(body);
  const capped =
    /^\p{Ll}$/u.test(first) && !/^\p{Lu}$/u.test(second)
      ? first.toUpperCase() + body.slice(first.length)
      : body;
  return /[.!?…]["'”’)\]]*$/u.test(capped) ? capped : `${capped}.`;
}

export function HeldCardsQueued({
  count,
  name,
  onRelease,
}: {
  count: number;
  name: string;
  onRelease: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const steps = count === 1 ? `1 more ${name} step is queued.` : `${count} more ${name} steps are queued.`;
  return (
    <div data-testid="held-cards-queued" className="rounded-xl border border-ca-border bg-ca-subtle px-4 py-3 text-[14px] leading-5 text-ca-xdark">
      <p>{`${steps} I'll bring a few out each day so you're not buried.`}</p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          const ok = await onRelease();
          setBusy(false);
          if (!ok) setFailed(true);
        }}
        className={cx("mt-2 inline-flex h-9 items-center rounded-cta bg-ca-action px-3.5 text-[14px] font-semibold text-ca-on-action hover:opacity-90 disabled:opacity-60", FOCUS_RING)}
      >
        Show them now
      </button>
      {failed && <p role="status" className="mt-2 text-[13px] text-ca-secondary">Could not show them just now. Try again.</p>}
    </div>
  );
}

export function ChannelRunWhileCardsWait({ run, running }: { run: ChannelRunInfo; running: boolean }) {
  const facts = useChannelRunFacts(run.slug, null);
  return (
    <RunChannelButton
      run={run}
      label={`Run ${run.name} now`}
      tone="quiet"
      running={running}
      costLabel={runCostLabel(facts.reserveCredits)}
      showCost={platformFor(run.slug).hideRunCost !== true}
      emailRow
    />
  );
}

export function ActionsEmpty({
  workState,
  lastRunAt,
  run = null,
  planIntent = null,
  planRationale = null,
  filteredReason = null,
  quietRun = false,
  hideCost = false,
}: {
  workState: ChannelDetail["workState"];
  quietRun?: boolean;
  hideCost?: boolean;
  lastRunAt: string | null;
  run?: ChannelRunInfo | null;
  planIntent?: string | null;
  planRationale?: string | null;
  filteredReason?: string | null;
}) {
  const name = run?.name ?? "this channel";
  const facts = useChannelRunFacts(run?.slug ?? "", `${workState}|${lastRunAt ?? ""}`);
  const costLabel = runCostLabel(facts.reserveCredits);
  const showCost = !!run && !hideCost && platformFor(run.slug).hideRunCost !== true && run.slug !== "ugc" && run.slug !== "pinterest_organic";
  const planLock = useChannelPlanLock();
  const emailSlot = useEmailRunSlot();
  const lastWords = useLastRunWords(
    run?.slug ?? "",
    facts.lastRunId,
    workState === "delivered" && !filteredReason && run?.switched !== true && run?.switched !== "unknown",
  );
  const actions = (askLabel?: string) => (
    <>
      <RunSlot run={run} label="Get suggestions" tone={quietRun ? "quiet" : "primary"} costLabel={costLabel} showCost={false} askLabel={askLabel} center />
      {showCost && (
        <div data-testid="run-cost" aria-busy={!facts.costLoaded || undefined} title={facts.costLoaded && facts.reserveCredits != null ? "Held when you press Get suggestions. You're charged what the run actually uses, and the rest comes back." : undefined} className="mt-3 min-h-5 text-ca-action text-ca-secondary">
          {facts.costLoaded ? costLabel : <span className="sr-only">Loading what a run costs</span>}
        </div>
      )}
    </>
  );

  if (workState === "running") {
    return (
      <CookingCard slug={run?.slug} name={run?.name} startedAt={lastRunAt}>
        {emailSlot && run?.slug === "email_marketing" && <RunSlot run={run} label="Get suggestions" tone="quiet" running costLabel={costLabel} showCost={false} />}
      </CookingCard>
    );
  }

  if (workState === "needs_review") {
    return (
      <EmptyCard title="The last run didn't finish">
        <EmptyBody>So there are no new suggestions yet. Try again when you&apos;re ready.</EmptyBody>
        {actions()}
      </EmptyCard>
    );
  }

  if (run?.switched === "unknown") {
    return (
      <p role="status" aria-busy="true" data-testid="empty-pending" className="text-ca-action text-ca-secondary">
        Checking what this channel already has…
      </p>
    );
  }

  if (run?.switched === true) {
    return (
      <EmptyCard testId="empty-switched" title="Nothing here yet">
        <EmptyBody>
          Zavi changed where it keeps {name} work, so this page starts out empty.{" "}
          {run.foldBelow
            ? `${priorPhrase(run.priorCount)} further down, read-only.`
            : `${priorPhrase(run.priorCount)} kept, read-only, because the numbers behind ${run.priorCount === 1 ? "it" : "them"} are out of date.`}
        </EmptyBody>
        {actions()}
      </EmptyCard>
    );
  }

  if (planLock?.tierName && !filteredReason) {
    return (
      <EmptyCard testId="empty-first-round-done" title="That was your first round">
        <EmptyBody>{`On ${planLock.tierName}, Zavi finds new steps every week.`}</EmptyBody>
        <button type="button" onClick={() => planLock.upgrade(null, { clicked: true })} className={cx(cardButton.base, cardButton.primary, "mt-5")}>
          {`Upgrade to ${planLock.tierName}`}
        </button>
      </EmptyCard>
    );
  }

  if (workState === "delivered" && filteredReason) {
    return (
      <EmptyCard title={`No open steps on ${name}`}>
        <EmptyBody>{filteredReason}</EmptyBody>
        {actions()}
      </EmptyCard>
    );
  }

  if (workState === "delivered") {
    const reading = !!run && (!facts.costLoaded || lastWords.state === "pending");
    const said = !reading && lastWords.state === "said";
    return (
      <EmptyCard testId={reading ? "empty-reading-run" : said ? "empty-run-said" : "empty-delivered"} title={reading ? `Checking ${name}` : said ? `No new suggestions for ${name}` : `You're all caught up on ${name}`}>
        {lastWords.state === "said" && said ? (
          <RunSaidText text={lastWords.text} full={lastWords.full} />
        ) : (
          <EmptyBody testId={reading ? undefined : "empty-run-said-text"}>{reading ? "Reading what the last run said…" : "Zavi can take another look and suggest what to do next."}</EmptyBody>
        )}
        {actions("Answer Zavi in chat")}
      </EmptyCard>
    );
  }

  if (planIntent) {
    const why = planRationale ? whyLine(planRationale) : "";
    return (
      <EmptyCard title={`Zavi's plan for ${name}`}>
        <EmptyBody>
          <p className="font-medium text-ca-xdark">{planIntent}</p>
          {why ? <p className="mt-1">{`Why: ${why}`}</p> : null}
        </EmptyBody>
        {actions()}
      </EmptyCard>
    );
  }

  return (
    <EmptyCard title={`No suggestions for ${name} yet`}>
      <EmptyBody>Zavi can look at {name} and suggest what to do next.</EmptyBody>
      {actions()}
    </EmptyCard>
  );
}
