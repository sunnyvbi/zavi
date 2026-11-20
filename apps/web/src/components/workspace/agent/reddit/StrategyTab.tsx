"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowBigUp, Check, ChevronDown, Clock, Copy, ExternalLink, MessageSquare, Search, ShieldAlert, X as XIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { RedditPostCard, type RedditPostSuggestion } from "@/components/agents/RedditPostCard";
import { RedditDraftActions, RedditReplyCard, type RedditReplyOpportunity } from "@/components/agents/RedditReplyCard";
import { send, type RedditPayload } from "./shared";
import { AttentionList, AttentionRow, LoadError, normSub, subLabel, useTransientError } from "./ui";
import type { RedditInsights } from "./types";

import { OpportunityCard } from "./OpportunityCard";
import { StepDeliverable } from "./StepDeliverable";
import { useArrivalGlow } from "./useArrivalGlow";
import { pageOneRank, redditPostId, strategyDefaultSubs, strategyVisibleOpportunities } from "./opportunitySelectors";
export { OpportunityCard } from "./OpportunityCard";
export { redditPostId, strategyDefaultSubs, strategyVisibleOpportunities, type Opportunity } from "./opportunitySelectors";

const PRIMARY_BTN = "inline-flex h-8 items-center gap-2 rounded-full bg-ink px-3.5 text-base font-semibold text-cream hover:opacity-90 disabled:opacity-60";

function effortLabel(effort: string | null): string | null {
  const v = effort?.trim().toLowerCase();
  if (v === "minutes") return "Takes minutes";
  if (v === "hours") return "Takes hours";
  if (v === "days") return "Takes days";
  return effort?.trim() || null;
}

export function StrategyTab({
  data,
  onChanged,
  selectedSubs,
  onSelectSubs,
  arrival = 0,
}: {
  data: RedditPayload;
  onChanged?: () => void | Promise<void>;
  selectedSubs: string[] | null;
  onSelectSubs: (subs: string[] | null) => void;
  arrival?: number;
}) {
  const { on: glow, target: glowTarget } = useArrivalGlow(arrival);
  const [googleOnly, setGoogleOnly] = useState(false);
  const insights = data.insights && data.insights.has_data ? data.insights : null;
  const connected = data.account?.connected === true;
  const supportingSteps = data.supporting_steps ?? [];
  const opportunities = useMemo(() => insights?.opportunities ?? [], [insights]);
  const refresh = () => void onChanged?.();

  const defaultSubs = useMemo(() => strategyDefaultSubs(data), [data]);
  const effective: string[] | null = selectedSubs ?? defaultSubs;

  const options = useMemo(() => {
    const map = new Map<string, string>();
    const add = (name: string | null | undefined) => {
      const key = normSub(name);
      if (key && !map.has(key)) map.set(key, (name ?? "").trim().replace(/^\/?r\//i, "").replace(/\/+$/, ""));
    };
    for (const c of data.workspace?.communities ?? []) add(c.name);
    for (const c of insights?.communities ?? []) add(c.name);
    for (const o of opportunities) add(o.subreddit);
    for (const s of data.suggestions) add(s.subreddit);
    for (const k of effective ?? []) add(k);
    return [...map.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data.workspace, insights, opportunities, data.suggestions, effective]);

  const selectedSet = new Set(effective ?? options.map((o) => o.key));
  const inSelection = (sub: string | null | undefined) => effective === null || selectedSet.has(normSub(sub));

  const top = strategyVisibleOpportunities(data, selectedSubs)
    .filter((o) => !googleOnly || pageOneRank(o) !== null)
    .slice(0, 5);

  const posts = data.suggestions.filter(
    (s): s is RedditPostSuggestion => s.type === "reddit_post" && inSelection(s.subreddit),
  );
  const oppPostIds = new Set(top.map((o) => redditPostId(o.url)).filter(Boolean));
  const runReplies = data.suggestions.filter(
    (s): s is RedditReplyOpportunity =>
      s.type === "reddit_reply" &&
      inSelection(s.subreddit) &&
      !(redditPostId(s.thread_url) && oppPostIds.has(redditPostId(s.thread_url))),
  );

  const labelFor = (key: string) => options.find((o) => o.key === key)?.label ?? key;

  const toggle = (key: string) => {
    const next = selectedSet.has(key) ? [...selectedSet].filter((k) => k !== key) : [...selectedSet, key];
    onSelectSubs(next);
  };
  const selectAll = () => {
    if (defaultSubs === null) onSelectSubs(null);
    else onSelectSubs(options.map((o) => o.key));
  };

  const addSubreddit = async (raw: string): Promise<string | null> => {
    const name = normSub(raw);
    if (!name) return "Type a subreddit name.";
    const err = await send("/api/reddit/workspace/communities", "POST", { name });
    if (err) return err;
    if (effective !== null) {
      if (!effective.includes(name)) onSelectSubs([...effective, name]);
    } else {
      const communities = [
        ...(data.workspace?.communities ?? []),
        { id: "new", name, selected: true, rules_verdict: null, rules_verdict_at: null },
      ];
      const nextDefault = strategyDefaultSubs({ ...data, workspace: { keywords: [], competitors: [], ...data.workspace, communities } });
      if (nextDefault !== null) onSelectSubs([...new Set([...options.map((o) => o.key), name])]);
    }
    refresh();
    return null;
  };

  const subCopy =
    effective === null
      ? "Threads from the last 7 days across every tracked subreddit, ranked by post and comment relevance."
      : effective.length === 1
        ? `Threads from the last 7 days in ${subLabel(labelFor(effective[0]))}, ranked by post and comment relevance.`
        : `Threads from the last 7 days across ${effective.length} selected subreddits, ranked by post and comment relevance.`;

  if (data.insights_error) {
    return <LoadError what="Reddit insights" onRetry={() => void onChanged?.()} />;
  }

  if (!insights && data.suggestions.length === 0 && supportingSteps.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-rule bg-cream px-4 py-8 text-center">
        <p className="text-[14px] font-semibold text-ink">No opportunities yet</p>
        <p className="mx-auto mt-1 max-w-sm text-[16px] leading-5 text-inkMuted">
          Scan Reddit from Overview, or run the channel, and Zavi will find buyer questions worth answering,
          then add one researched new-post idea.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-[26px]">
      <div className="flex flex-wrap items-center gap-2">
        <SubredditPicker
          options={options}
          selected={selectedSet}
          countLabel={effective === null ? null : String(effective.length)}
          onToggle={toggle}
          onAll={selectAll}
          onClear={() => onSelectSubs([])}
          onAdd={addSubreddit}
        />
        {effective !== null && effective.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Selected subreddits">
            {effective.map((key) => (
              <li key={key}>
                <span className="inline-flex items-center gap-1 rounded-full border border-rule bg-cream py-0.5 pl-2.5 pr-1 text-[16px] font-medium text-ink">
                  {subLabel(labelFor(key))}
                  <button
                    type="button"
                    aria-label={`Remove ${subLabel(labelFor(key))}`}
                    onClick={() => toggle(key)}
                    className="rounded-full p-0.5 text-inkMuted hover:bg-bone hover:text-ink"
                  >
                    <XIcon className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {insights && opportunities.some((o) => o.google.checked) && (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[16px] font-medium text-ink">
            <input
              type="checkbox"
              checked={googleOnly}
              onChange={(e) => setGoogleOnly(e.target.checked)}
              className="h-4 w-4 accent-ink"
            />
            Ranking on Google only
          </label>
        )}
      </div>

      {insights && (
        <section ref={glowTarget} aria-labelledby="reddit-top-opportunities" className="space-y-[18px]">
          <div>
            <h3 id="reddit-top-opportunities" className="text-[16px] font-semibold tracking-tight text-ink">
              {top.length >= 5 ? "Top 5 comment opportunities" : "Comment opportunities"} · last 7 days
            </h3>
            <p className="text-[16px] text-inkMuted">{subCopy}</p>
          </div>
          {top.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-rule bg-cream px-4 py-6 text-center text-[16px] text-inkMuted">
              {effective !== null && effective.length === 0
                ? "Pick at least one subreddit to see its opportunities."
                : googleOnly
                  ? "None of these threads rank on Google page 1 yet."
                  : "No comment opportunities in these subreddits yet."}
            </p>
          ) : (
            <div className={`grid grid-cols-1 gap-[18px] ${top.length > 1 ? "md:grid-cols-2" : ""}`}>
              {top.map((o, i) => (
                <OpportunityCard
                  key={o.thread_id}
                  opportunity={o}
                  rank={i + 1}
                  onChanged={onChanged}
                  glow={glow}
                  halfWidth={top.length > 1}
                  connected={connected}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {runReplies.length > 0 && (
        <section aria-labelledby="reddit-replies" className="space-y-[18px]">
          <div>
            {}
            <h3 id="reddit-replies" className="text-[16px] font-semibold tracking-tight text-ink">
              Replies Zavi drafted for you
            </h3>
            <p className="text-[16px] text-inkMuted">
              Answers for threads Zavi picked. They stay here until you handle them, so some may be from an
              earlier run. Approve &amp; post publishes the reply from your connected Reddit account.
            </p>
          </div>
          {runReplies.map((r) => (
            <RedditReplyCard key={r.id} opportunity={r} onChanged={onChanged} connected={connected} />
          ))}
        </section>
      )}

      {posts.length > 0 && (
        <section aria-labelledby="reddit-new-posts" className="space-y-[18px]">
          <div>
            <h3 id="reddit-new-posts" className="text-[16px] font-semibold tracking-tight text-ink">
              Start a conversation
            </h3>
            <p className="text-[16px] text-inkMuted">A new post for a researched community</p>
          </div>
          {posts.map((p) => (
            <RedditPostCard key={p.id} suggestion={p} onChanged={onChanged} connected={connected} />
          ))}
        </section>
      )}

      {data.research_summary && (
        <details className="rounded-xl border border-rule bg-cream px-4 py-3">
          <summary className="cursor-pointer text-[16px] font-semibold text-ink">Research behind the suggestions</summary>
          <p className="mt-2 whitespace-pre-wrap text-[16px] leading-5 text-inkMuted">{data.research_summary}</p>
        </details>
      )}

      {supportingSteps.length > 0 && (
        <section aria-labelledby="reddit-supporting-actions" className="space-y-[18px]">
          <div>
            <h3 id="reddit-supporting-actions" className="text-[16px] font-semibold tracking-tight text-ink">
              Checks only you can do
            </h3>
            <p className="text-[16px] text-inkMuted">Rules, account standing and follow-ups from your runs</p>
          </div>
          <AttentionList label="Checks only you can do">
            {supportingSteps.map((step) => (
              <AttentionRow
                key={step.id}
                icon={step.blocking ? ShieldAlert : Clock}
                tone={step.blocking ? "blocker" : "approval"}
                title={step.title}
                detail={step.body}
                chip={[step.blocking ? "Blocker" : null, effortLabel(step.effort)].filter(Boolean).join(" · ") || null}
              >
                {step.deliverable?.content && (
                  <StepDeliverable label={step.deliverable.label} content={step.deliverable.content} />
                )}
              </AttentionRow>
            ))}
          </AttentionList>
        </section>
      )}
    </div>
  );
}

function SubredditPicker({
  options,
  selected,
  countLabel,
  onToggle,
  onAll,
  onClear,
  onAdd,
}: {
  options: Array<{ key: string; label: string }>;
  selected: Set<string>;
  countLabel: string | null;
  onToggle: (key: string) => void;
  onAll: () => void;
  onClear: () => void;
  onAdd: (name: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useTransientError();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const submit = async () => {
    if (adding) return;
    setAdding(true);
    setAddError(null);
    const err = await onAdd(draft);
    setAdding(false);
    if (err) setAddError(err);
    else setDraft("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="reddit-subreddit-picker"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 items-center gap-2 rounded-cta border border-rule bg-cream px-3.5 text-[16px] font-semibold text-ink hover:border-ink"
      >
        Subreddits
        {}
        {countLabel !== null && (
          <span className="rounded-full bg-ink px-1.5 text-[13px] font-semibold tabular-nums text-cream">{countLabel}</span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-inkMuted" aria-hidden />
      </button>
      {open && (
        <div
          id="reddit-subreddit-picker"
          role="group"
          aria-label="Choose subreddits"
          className="absolute left-0 z-20 mt-1.5 w-64 rounded-xl border border-rule bg-cream p-2 shadow-lg"
        >
          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <button type="button" onClick={onAll} className="text-[16px] font-medium text-ink underline underline-offset-2">
              Select all
            </button>
            <button type="button" onClick={onClear} className="text-[16px] font-medium text-inkMuted underline underline-offset-2">
              Clear
            </button>
          </div>
          {options.length > 0 && (
            <ul className="max-h-64 overflow-y-auto">
              {options.map((o) => (
                <li key={o.key}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-[16px] text-ink hover:bg-bone">
                    <input
                      type="checkbox"
                      checked={selected.has(o.key)}
                      onChange={() => onToggle(o.key)}
                      className="h-4 w-4 accent-ink"
                    />
                    {subLabel(o.label)}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-1.5 flex items-center gap-2 border-t border-rule px-1 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a subreddit"
              aria-label="Add a subreddit"
              className="h-8 min-w-0 flex-1 rounded-lg border border-rule bg-cream px-2 text-[16px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
            />
            <button type="submit" disabled={adding || !draft.trim()} className={PRIMARY_BTN}>
              {adding ? "Adding…" : "Add"}
            </button>
          </form>
          {addError && (
            <p role="alert" className="px-1.5 pt-1 text-[16px] text-[#c0392b]">
              {addError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

