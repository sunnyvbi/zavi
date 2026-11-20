"use client";

import { useCallback, useRef, useState } from "react";
import { Target, TriangleAlert } from "lucide-react";
import { getChannel } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import type { GrowthStrategy } from "@/lib/workspace/useGrowthStrategy";

function channelLabel(slug: string): string {
  const registered = getChannel(slug)?.name;
  if (registered) return registered;
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bSeo\b/i, "SEO")
    .replace(/\bUgc\b/i, "UGC")
    .replace(/\bSms\b/i, "SMS");
}

const CONFIDENCE_COPY: Record<GrowthStrategy["constraint"]["confidence"], string> = {
  high: "Confident",
  medium: "Fairly confident",
  low: "Best guess, worth correcting",
};

export function GrowthStrategyPanel({
  strategy,
  accepted,
  onChanged,
}: {
  strategy: GrowthStrategy;
  accepted: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);

  const accept = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch("/api/workspace/growth-strategy/accept", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { accepted?: boolean; problems?: string[]; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.accepted) {
        setNote(
          body?.problems?.join("; ") ??
            body?.error?.message ??
            `Couldn't accept the strategy (HTTP ${res.status}).`,
        );
        return;
      }
      if (body.problems?.length) setNote(body.problems.join("; "));
      await onChanged();
    } catch (e) {
      setNote((e as Error).message || "Couldn't accept the strategy.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [onChanged]);

  return (
    <section aria-label="Growth strategy">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-[16px] font-semibold text-[#1f1f1f]">
          Growth strategy
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            accepted ? "bg-[#eef6ee] text-[#2f6b34]" : "bg-[#fdf3e3] text-[#8a5a12]"
          }`}
        >
          {accepted ? "Accepted" : "Draft, not applied yet"}
        </span>
      </div>

      <div className="rounded-xl border border-[#e5e5e5] bg-white">
        <div className="border-b border-[#f0f0f0] p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
            North Star
          </p>
          <p className="mt-1 font-display text-[20px] font-semibold leading-[27px] text-[#1f1f1f]">
            {strategy.north_star.metric}
          </p>
          {strategy.north_star.why && (
            <p className="mt-1 text-[13px] leading-[20px] text-[#595959]">
              {strategy.north_star.why}
            </p>
          )}
          {strategy.north_star.provenance && (
            <p className="mt-2 text-[11px] text-[#8a8a8a]">
              Basis: {strategy.north_star.provenance}
            </p>
          )}
        </div>

        <div className="border-b border-[#f0f0f0] p-4">
          <div className="flex items-center gap-2">
            <TriangleAlert className="h-3.5 w-3.5 text-[#cb2029]" aria-hidden />
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
              What&rsquo;s holding growth back
            </p>
          </div>
          <p className="mt-1 text-[14px] font-medium leading-[22px] text-[#1f1f1f]">
            {strategy.constraint.statement}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#8a8a8a]">
            <span>{CONFIDENCE_COPY[strategy.constraint.confidence]}</span>
            {strategy.constraint.lever_family && <span>· {strategy.constraint.lever_family}</span>}
            {strategy.constraint.evidence && <span>· {strategy.constraint.evidence}</span>}
          </div>
        </div>

        {strategy.channel_bets.length > 0 && (
          <div className="border-b border-[#f0f0f0] p-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
              Where we&rsquo;re betting
            </p>
            <ul className="mt-2 space-y-2">
              {strategy.channel_bets.map((bet) => (
                <li key={bet.channel_slug} className="text-[13px] leading-[20px]">
                  <span className="font-medium text-[#1f1f1f]">
                    {channelLabel(bet.channel_slug)}
                  </span>
                  {bet.rationale && <span className="text-[#595959]">: {bet.rationale}</span>}
                  {bet.expected_effect && (
                    <span className="block text-[11px] text-[#8a8a8a]">
                      Expected: {bet.expected_effect}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="p-4">
          <div className="flex items-center gap-2">
            <Target className="h-3.5 w-3.5 text-[#8a8a8a]" aria-hidden />
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
              Primary goal
            </p>
          </div>
          {strategy.goal ? (
            <p className="mt-1 text-[13px] leading-[20px] text-[#1f1f1f]">
              {strategy.goal.objective}:{" "}
              <span className="tabular-nums">
                {strategy.goal.target_metric} to {strategy.goal.target_value}
              </span>{" "}
              by {strategy.goal.due_date}
            </p>
          ) : (
            <p className="mt-1 text-[13px] leading-[20px] text-[#595959]">
              Not measurable yet. Answer the questions in the chat and your CGO will
              propose one.
            </p>
          )}
        </div>
      </div>

      {!accepted && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void accept()}
            disabled={busy}
            className="rounded-cta bg-[#1f1f1f] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-60"
          >
            {busy ? "Applying…" : "Accept this strategy"}
          </button>
          <p className="mt-2 text-[12px] text-[#8a8a8a]">
            Sets your goal and tells the rest of your team what to work toward.
          </p>
        </div>
      )}
      {note && <p className="mt-2 text-[12px] text-[#8a5a12]">{note}</p>}

      {strategy.gaps.length > 0 && (
        <div className="mt-6 rounded-xl border border-[#e5e5e5] bg-[#fafafa] p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
            What I still need from you
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[13px] leading-[20px] text-[#595959]">
            {strategy.gaps.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-[#8a8a8a]">Answer these in the chat →</p>
        </div>
      )}

      {strategy.unmeasured.length > 0 && (
        <div className="mt-4 rounded-xl border border-[#e5e5e5] bg-white p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[#8a8a8a]">
            Named but not measured
          </p>
          <ul className="mt-2 space-y-1 text-[13px] leading-[20px] text-[#595959]">
            {strategy.unmeasured.map((u) => (
              <li key={u.lever}>
                <span className="font-medium text-[#1f1f1f]">{u.lever}</span>: size it
                with: {u.the_one_read_that_would_size_it}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
