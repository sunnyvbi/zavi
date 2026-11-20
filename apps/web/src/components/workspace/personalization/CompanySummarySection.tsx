"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";
import { BTN_TEXT, errorMessageOf, Section, SourceTag, Updated } from "./shared";

type SummaryItem = { text: string; source: "confirmed" | "inferred"; updated_at: string | null; label?: string };
type SummarySection = {
  id: "facts" | "goals" | "decisions" | "recent_work" | "agent_conclusions";
  items: SummaryItem[];
};
type Summary = { updated_at: string | null; version: number; sections: SummarySection[] };

const SECTION_TITLE: Record<SummarySection["id"], string> = {
  facts: "Facts on file",
  goals: "Active goals",
  decisions: "Recent decisions",
  recent_work: "Recent work",
  agent_conclusions: "What your agents have concluded",
};

export function CompanySummarySection({ refreshKey }: { refreshKey: number }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/personalization/summary");
      const body = (await res.json().catch(() => null)) as Summary | null;
      if (!res.ok || !body) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setSummary(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the summary.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const nonEmpty = summary?.sections.filter((s) => s.items.length > 0) ?? [];

  return (
    <Section
      id="company-summary"
      title="Company summary"
      description="What your agents currently know, assembled from your confirmed facts, goals and their own recent work."
      updatedAt={summary?.updated_at}
      aside={
        <button type="button" onClick={() => void load()} disabled={loading} className={BTN_TEXT}>
          Refresh
        </button>
      }
    >
      {loading && !summary ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : error ? (
        <p role="alert" className="text-[13px] text-ink">
          {error}
        </p>
      ) : nonEmpty.length === 0 ? (
        <p className="text-[13px] text-inkMuted">
          Nothing on file yet. Fill in the company fields above and the summary builds itself.
        </p>
      ) : (
        <div className="space-y-5">
          {nonEmpty.map((section) => (
            <div key={section.id}>
              <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-inkMuted">
                {SECTION_TITLE[section.id]}
              </h3>
              <ul className="mt-2 divide-y divide-rule">
                {section.items.map((item, i) => (
                  <li key={`${section.id}-${i}`} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2">
                    <p className="min-w-0 flex-1 text-[16px] leading-5 text-ink">
                      {item.label ? <span className="text-inkMuted">{item.label}: </span> : null}
                      {item.text}
                    </p>
                    <span className="flex shrink-0 items-center gap-2">
                      <SourceTag source={item.source} />
                      {item.updated_at ? <Updated at={item.updated_at} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
