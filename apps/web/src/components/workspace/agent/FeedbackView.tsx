"use client";

import { useCallback, useEffect, useState } from "react";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { createBrowserSupabase } from "@/lib/supabase";
import { Textarea } from "@/components/Input";
import { useOpenStatic } from "../layout/shared";

type FeedbackRow = {
  id: string;
  kind: "rule" | "note" | string;
  state: string;
  rating: number | null;
  comment: string | null;
  target_type: string | null;
  target_id: string | null;
  created_by: string;
  created_at: string;
};

type SubTab = "feedback" | "rules" | "ratings";

export function FeedbackView({ slug }: { slug: string }) {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<SubTab>("feedback");
  const [draftBody, setDraftBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const openStatic = useOpenStatic();

  const reload = useCallback(async () => {
    setLoading(true);
    const sb = createBrowserSupabase();
    const { data, error } = await sb.rpc("list_agent_feedback", {
      p_agent_slug: slug,
    });
    if (error) {
      setErrorMsg(error.message);
    } else {
      setRows((data ?? []) as FeedbackRow[]);
      setErrorMsg(null);
    }
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async () => {
    if (!draftBody.trim()) return;
    setSubmitting(true);
    const sb = createBrowserSupabase();
    const { error } = await sb.rpc("add_agent_note", {
      p_agent_slug: slug,
      p_body: draftBody.trim(),
      p_scope: null,
    });
    setSubmitting(false);
    if (error) {
      setErrorMsg(error.message);
      return;
    }
    setDraftBody("");
    await reload();
  };

  const counts = {
    feedback: rows.filter((r) => r.kind === "note").length,
    ratings: rows.filter((r) => r.target_type !== null).length,
  };

  const filtered = rows.filter((r) => {
    if (tab === "feedback") return r.kind === "note";
    if (tab === "rules") return r.kind === "rule";
    return r.target_type !== null;
  });
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(tab);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-[16px] font-semibold text-ink">
          Feedback
        </h2>
        <p className="mt-1 text-[13px] leading-[1.55] text-inkMuted">
          Teach this agent how you want it to work. Write a sentence of
          feedback after a run that nailed it or missed something. Tomorrow&apos;s run will read it and adjust.
        </p>
      </div>

      <div
        ref={listRef}
        role="tablist"
        aria-label="Feedback kind"
        className="relative flex gap-1 text-[12px]"
      >
        <SlidingIndicator box={box} className="rounded-md bg-bone/70" />
        <SubTabChip
          active={tab === "feedback"}
          onClick={() => setTab("feedback")}
        >
          Feedback · {counts.feedback}
        </SubTabChip>
        <SubTabChip active={tab === "rules"} onClick={() => setTab("rules")}>
          Rules
        </SubTabChip>
        <SubTabChip
          active={tab === "ratings"}
          onClick={() => setTab("ratings")}
        >
          Ratings · {counts.ratings}
        </SubTabChip>
      </div>

      {}
      <p className="-mt-1 text-[12px] leading-[1.5] text-inkMuted">
        {tab === "feedback" ? (
          <>
            Coaching notes for this agent. Each note is stored in the
            agent&apos;s memory and read on its next run. Applied corrections
            are named in the run output under &ldquo;Learnings.&rdquo;
          </>
        ) : tab === "rules" ? (
          <>Rules live on one page for your whole company.</>
        ) : (
          <>The 👍 / 👎 you&apos;ve left on this agent&apos;s runs and decisions.</>
        )}
      </p>

      {tab === "rules" && (
        <div className="rounded-lg border border-ink/10 bg-white p-4">
          <p className="text-[13px] leading-[1.55] text-ink">
            Rules you save are followed by every agent they apply to, from its
            next run. Add one for this agent in Settings → Rules, or type{" "}
            <span className="font-mono">/feedback</span> in this agent&apos;s chat.
          </p>
          <button
            type="button"
            onClick={() => openStatic("settings", { section: "rules" })}
            className="mt-3 rounded-cta bg-ink px-3 py-1.5 text-[12px] font-medium text-white hover:bg-inkSoft"
          >
            Open Rules
          </button>
        </div>
      )}

      {tab === "feedback" && (
        <div className="rounded-lg border border-ink/10 bg-white p-4">
          <label className="mb-1.5 block text-[14px] font-medium text-ink">
            Give the agent feedback
          </label>
          <p className="mb-2 text-[12px] leading-[1.5] text-inkMuted">
              <>
                One or two sentences after a run: what went well, what was
                off, what the agent should do differently next time. Stored in
                the agent&apos;s memory and prepended to the next-run prompt.
                Think of it like coaching a teammate.
              </>
          </p>
          <Textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            placeholder={
              "e.g. yesterday's digest buried the chargeback under \"FYI\". Chargebacks are P0 always, put them in Decide Today."
            }
            maxLength={4000}
            rows={4}
            className="resize-none leading-[1.5]"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="font-mono text-[11px] text-inkMuted">
              {draftBody.length}/4000
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || !draftBody.trim()}
              className="rounded-cta bg-ink px-3 py-1.5 text-[12px] font-medium text-white hover:bg-inkSoft disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Saving…" : "Send feedback"}
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900">
          {errorMsg}
        </div>
      )}

      {tab === "rules" ? null : loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-md bg-bone"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink/10 px-4 py-6 text-center text-[13px] leading-[1.55] text-inkMuted">
          {tab === "feedback" ? (
            <>
              No feedback yet. After the agent&apos;s next run, drop a sentence
              above on what worked and what didn&apos;t. The agent reads it on
              the run after that.
            </>
          ) : (
            <>
              No ratings yet. Use 👍 / 👎 on any decision or run reply to rate
              the agent&apos;s output.
            </>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <li
              key={r.id}
              className="rounded-md border border-ink/10 bg-white p-3 text-[13px]"
            >
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                  {labelForKind(r.kind)}
                  <StateBadge state={r.state} />
                </span>
                <span className="text-[11px] text-inkMuted">
                  {new Date(r.created_at).toLocaleString()}
                </span>
              </div>
              {r.target_type && (
                <div className="font-mono text-[11px] text-inkMuted">
                  {r.target_type}:{r.target_id?.slice(0, 8)}
                  {r.rating != null && (
                    <span className="ml-2">
                      {r.rating === 1 ? "👍" : "👎"}
                    </span>
                  )}
                </div>
              )}
              {r.comment && (
                <div className="mt-1 whitespace-pre-wrap leading-[1.55] text-ink">
                  {r.comment}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {tab === "feedback" && (
        <p className="text-[11px] leading-[1.5] text-inkMuted">
          A note&apos;s status (
          <span className="font-medium">Pending → Acknowledged → Applied</span>
          ) shows whether the agent has absorbed it. Per-note &ldquo;applied in
          run X&rdquo; linkage isn&apos;t tracked here yet. For now, look for
          the &ldquo;Learnings&rdquo; footer in a recent run on the agent&apos;s
          dashboard, where the agent names the corrections it applied.
        </p>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    open: { label: "Pending", cls: "bg-bone text-inkMuted" },
    acknowledged: { label: "Acknowledged", cls: "bg-amber-100 text-amber-800" },
    applied: { label: "Applied", cls: "bg-emerald-100 text-emerald-800" },
  };
  const { label, cls } = cfg[state] ?? {
    label: state,
    cls: "bg-bone text-inkMuted",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[9.5px] font-medium normal-case tracking-normal ${cls}`}
    >
      {label}
    </span>
  );
}

function labelForKind(kind: string): string {
  if (kind === "note") return "feedback";
  return kind;
}

function SubTabChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`
        relative rounded-md px-2.5 py-1 transition-colors duration-300
        ${
          active
            ? "font-medium text-ink"
            : "text-inkMuted hover:bg-bone"
        }
      `}
    >
      {children}
    </button>
  );
}
