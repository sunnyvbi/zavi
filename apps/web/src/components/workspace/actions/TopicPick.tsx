"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { readTopActionContext } from "./topActions/api";
import { runCostLabel } from "../layout/useChannelRunPress";
import type { ActionItem } from "./types";

export type PickTopic = {
  title: string;
  why: string;
  searches: string[];
  ranks: { site: string; note: string }[];
  your_site: string;
  have: { text: string; src: string }[];
  fill: string[];
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const objs = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

export function topicPickOf(a: Pick<ActionItem, "body">): PickTopic[] | null {
  const p = (a.body as { step?: { deliverable?: { presentation?: { type?: unknown; topics?: unknown } } } } | null)?.step?.deliverable
    ?.presentation;
  if (p?.type !== "topic_pick") return null;
  const topics = objs(p.topics)
    .map((t) => ({
      title: str(t.title),
      why: str(t.why),
      searches: strs(t.searches),
      ranks: objs(t.ranks).map((r) => ({ site: str(r.site), note: str(r.note) })).filter((r) => r.site),
      your_site: str(t.your_site),
      have: objs(t.have).map((h) => ({ text: str(h.text), src: str(h.src) })).filter((h) => h.text),
      fill: strs(t.fill),
    }))
    .filter((t) => t.title);
  return topics.length ? topics : null;
}

export function TopicPickList({ topics, selected, onSelect }: { topics: PickTopic[]; selected: number; onSelect: (i: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Pick your next page" className="mt-5 grid grid-cols-1 gap-2">
      {topics.map((t, i) => (
        <button
          key={`${i}-${t.title}`}
          type="button"
          role="radio"
          aria-checked={selected === i}
          aria-label={t.title}
          onClick={() => onSelect(i)}
          className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left ${selected === i ? "border-ink bg-creamDeep" : "border-rule bg-cream hover:border-inkLight"}`}
        >
          <span className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${selected === i ? "border-ink" : "border-rule"}`}>
            {selected === i && <span className="size-2 rounded-full bg-ink" />}
          </span>
          <span>
            <span className="text-[14px] font-semibold text-ink">
              {t.title}
              {i === 0 && <span className="ml-2 rounded-full bg-successBg px-2 py-0.5 text-xs font-medium text-success">Best bet</span>}
            </span>
            {t.why && <span className="mt-0.5 block text-[12px] text-inkMuted">{t.why}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function TopicPickCost() {
  const [credits, setCredits] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    readTopActionContext("seo", "write_proof_page")
      .then((c) => {
        if (live && typeof c.credits === "number") setCredits(c.credits);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (credits === null) return null;
  return <p data-testid="topic-pick-cost" className="mt-2 text-[12px] text-inkMuted">{runCostLabel(credits)}</p>;
}

const block = "rounded-xl border border-rule bg-cream px-4 py-3";
const label = "text-[11px] font-semibold uppercase tracking-[0.06em] text-inkMuted";

export function TopicResearch({ topic }: { topic: PickTopic }) {
  const blanks = topic.fill.length === 0 ? "No blanks" : `${topic.fill.length} ${topic.fill.length === 1 ? "blank" : "blanks"} to fill`;
  return (
    <div data-testid="topic-research" className="flex flex-col gap-2.5 text-[14px] leading-snug text-ink">
      {topic.searches.length > 0 && (
        <div className={block}>
          <div className={label}>What people search</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {topic.searches.map((q, n) => (
              <span key={`${n}-${q}`} className="rounded-full bg-creamDeep px-2.5 py-1 text-[13px]">{`“${q}”`}</span>
            ))}
          </div>
          <div className="mt-2 text-[12px] text-inkLight">From search suggestions and threads. Exact volumes need Search Console.</div>
        </div>
      )}
      {topic.ranks.length > 0 && (
        <div className={block}>
          <div className={label}>Who shows up today</div>
          <ol className="mt-2 space-y-1.5">
            {topic.ranks.map((r, n) => (
              <li key={`${n}-${r.site}`} className="flex gap-2">
                <span className="text-inkLight">{n + 1}.</span>
                <span>
                  <span className="font-semibold">{r.site}</span> <span className="text-inkMuted">{r.note}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {topic.your_site && (
        <div className={block}>
          <div className={label}>Your site</div>
          <div className="mt-1.5">{topic.your_site}</div>
        </div>
      )}
      {topic.have.length > 0 && (
        <div className={block}>
          <div className={label}>What Zavi already has</div>
          <ul className="mt-1.5 space-y-1">
            {topic.have.map((h, n) => (
              <li key={`${n}-${h.text}`}>
                <Check className="mr-1 inline size-3.5 text-success" aria-hidden />
                {h.text} {h.src && <span className="text-[12px] text-inkLight">· {h.src}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={block}>
        <div className="flex items-center justify-between">
          <span className={label}>You would fill</span>
          <span className="rounded-full bg-bone px-2 py-0.5 text-[11px] text-inkMuted">{blanks}</span>
        </div>
        {topic.fill.length ? (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {topic.fill.map((f, n) => (
              <li key={`${n}-${f}`}>{f}</li>
            ))}
          </ul>
        ) : (
          <div className="mt-1.5 text-inkMuted">Nothing. Zavi has every fact it needs.</div>
        )}
      </div>
    </div>
  );
}
