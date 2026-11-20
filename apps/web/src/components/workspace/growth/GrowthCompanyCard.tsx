"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { faviconUrlFromDomain } from "@/lib/favicon";
import { Skeleton } from "@/components/ui/Skeleton";
import { errorMessageOf } from "../personalization/shared";
import type { GrowthPlanDetail } from "@/lib/workspace/useGrowthPlan";
import { CompanyFactsList, PlanSummary } from "./GrowthPlanDetail";
import { FactRow, SectionAction } from "./GrowthSection";
import { SettledSection } from "@/components/ui/SettledSection";
import { CompanyBars } from "./GrowthMemoSkeleton";

type Facts = {
  company_name: string;
  what_we_sell: string;
  competitors: string;
  domain: string;
};
const EMPTY: Facts = {
  company_name: "",
  what_we_sell: "",
  competitors: "",
  domain: "",
};

export { faviconUrlFromDomain };

const MAX_FACT = 500;
const MAX_COMPETITORS_FACT = 1300;
const maxCharsFor = (key: keyof Facts): number =>
  key === "competitors" ? MAX_COMPETITORS_FACT : MAX_FACT;
const MAX_COMPETITORS = 20;
const MAX_COMPETITOR_CHARS = 60;

export function sentenceCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const ends = t.match(/[.!?](?=\s|$)/g)?.length ?? 0;
  return /[.!?]$/.test(t) ? ends : ends + 1;
}

export function splitCompetitors(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function GrowthCompanyCard({
  fallbackName,
  canEdit,
  sourcedFacts,
  summary,
  footer,
  onFacts,
  addRivalRequest = 0,
}: {
  fallbackName: string | null;
  canEdit: boolean;
  sourcedFacts?: GrowthPlanDetail["company_facts"];
  summary?: string;
  footer?: ReactNode;
  onFacts?: (facts: { name: string; rivals: number } | null) => void;
  addRivalRequest?: number;
}) {
  const [facts, setFacts] = useState<Facts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Facts>(EMPTY);
  const [competitorInput, setCompetitorInput] = useState("");
  const [addingCompetitor, setAddingCompetitor] = useState(false);
  const [foundOpen, setFoundOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/connectors/company-facts");
      const body = (await res.json().catch(() => null)) as {
        facts?: { key: string; value_text: string | null }[];
      } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      const next = { ...EMPTY };
      for (const f of body?.facts ?? []) {
        if (f.key in next) next[f.key as keyof Facts] = f.value_text ?? "";
      }
      setFacts(next);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message || "Could not load company details.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const [suggestion, setSuggestion] = useState<{ value: string; from: string } | null>(null);
  const [suggestionDone, setSuggestionDone] = useState(false);
  const needsSuggestion = facts !== null && !facts.what_we_sell.trim();
  useEffect(() => {
    if (!needsSuggestion) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/company-facts/suggestions");
        if (!res.ok) return;
        const body = (await res.json()) as {
          suggestions?: { what_we_sell?: { value: string; from: string } };
        };
        if (!cancelled && body.suggestions?.what_we_sell) {
          setSuggestion(body.suggestions.what_we_sell);
        }
      } catch {
      } finally {
        if (!cancelled) setSuggestionDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsSuggestion]);

  const [aiDraft, setAiDraft] = useState<{ value: string; from: string } | null>(null);
  const [aiDrafting, setAiDrafting] = useState(false);
  const [aiDraftDone, setAiDraftDone] = useState(false);
  const wantsAiDraft =
    facts !== null && canEdit && sentenceCount(facts.what_we_sell) < 2;
  useEffect(() => {
    if (!wantsAiDraft) {
      setAiDraft(null);
      return;
    }
    let cancelled = false;
    setAiDrafting(true);
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/company-facts/description-draft", {
          method: "POST",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { draft?: { value: string; from: string } | null };
        if (!cancelled) setAiDraft(body.draft ?? null);
      } catch {
      } finally {
        if (!cancelled) {
          setAiDrafting(false);
          setAiDraftDone(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsAiDraft]);

  const dismissAiDraft = async () => {
    try {
      const res = await apiFetch("/api/connectors/company-facts/description-draft/dismiss", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAiDraft(null);
      setError(null);
    } catch {
      setError("Could not dismiss that. Try again.");
    }
  };

  const proposal = aiDraft
    ? { ...aiDraft, from: `Zavi drafted this from ${aiDraft.from}`, ai: true }
    : !facts?.what_we_sell.trim() && suggestion
      ? { ...suggestion, from: `From ${suggestion.from}`, ai: false }
      : null;

  const save = async (changes: Partial<Facts>): Promise<boolean> => {
    const entries = Object.entries(changes) as [keyof Facts, string][];
    if (entries.length === 0) return true;
    const tooLong = entries.find(([k, v]) => v.trim().length > maxCharsFor(k));
    if (tooLong) {
      setError(`Keep each field under ${maxCharsFor(tooLong[0])} characters.`);
      return false;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch("/api/connectors/company-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facts: entries.map(([key, value]) => ({ key, value: value.trim() })),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        rejected?: { key: string; dropped: string[] }[];
      } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      const dropped = (body?.rejected ?? []).flatMap((r) => r.dropped);
      if (dropped.length > 0) {
        const shown = dropped.map((d) => (d.length > 40 ? `${d.slice(0, 40)}…` : d));
        setNotice(`Not saved: "${shown.join('", "')}". Rivals are names only, up to ${MAX_COMPETITOR_CHARS} characters.`);
      }
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message || "Could not save.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const competitors = splitCompetitors(facts?.competitors ?? "");

  const onFactsRef = useRef(onFacts);
  onFactsRef.current = onFacts;
  useEffect(() => {
    if (loadError) onFactsRef.current?.(null);
    else if (facts)
      onFactsRef.current?.({
        name: facts.company_name.trim(),
        rivals: splitCompetitors(facts.competitors).length,
      });
  }, [facts, loadError]);

  const rivalsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (addRivalRequest === 0) return;
    setAddingCompetitor(true);
    rivalsRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [addRivalRequest]);

  const addCompetitor = async () => {
    const name = competitorInput.trim().replace(/,/g, " ");
    if (!name) return;
    if (name.length > MAX_COMPETITOR_CHARS) {
      setError(`Keep a rival to a name, up to ${MAX_COMPETITOR_CHARS} characters.`);
      return;
    }
    if (competitors.length >= MAX_COMPETITORS) {
      setError(`Zavi plans around up to ${MAX_COMPETITORS} rivals. Remove one to add another.`);
      return;
    }
    if (competitors.some((c) => c.toLowerCase() === name.toLowerCase())) {
      setCompetitorInput("");
      return;
    }
    const ok = await save({ competitors: [...competitors, name].join(", ") });
    if (ok) {
      setCompetitorInput("");
      setAddingCompetitor(false);
    }
  };

  const removeCompetitor = (name: string) =>
    void save({
      competitors: competitors.filter((c) => c !== name).join(", "),
    });

  const startEdit = () => {
    setDraft(facts ?? EMPTY);
    setError(null);
    setEditing(true);
  };

  const commitEdit = async () => {
    if (!facts) return;
    const name = draft.company_name.trim();
    if (name.length === 1) {
      setError("Use at least 2 characters for the name.");
      return;
    }
    const changes: Partial<Facts> = {};
    if (name !== facts.company_name.trim()) changes.company_name = name;
    if (draft.what_we_sell.trim() !== facts.what_we_sell.trim())
      changes.what_we_sell = draft.what_we_sell;
    if (await save(changes)) setEditing(false);
  };

  const name = facts?.company_name.trim() || fallbackName?.trim() || "Your company";
  const initial = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? Array.from(name)[0] ?? "•").toUpperCase();
  const faviconUrl = faviconUrlFromDomain(facts?.domain ?? "");
  useEffect(() => {
    setLogoFailed(false);
  }, [faviconUrl]);

  const logo = (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#1A73FF] text-sm font-semibold text-white"
    >
      {}
      {faviconUrl && !logoFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={faviconUrl}
          alt=""
          width={24}
          height={24}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setLogoFailed(true)}
          className="h-5 w-5 object-contain"
        />
      ) : (
        initial
      )}
    </span>
  );

  const foundCount = sourcedFacts?.length ?? 0;
  const hasFound = foundCount > 0 || Boolean(summary?.trim());

  const editButton =
    canEdit && facts && !editing && !loadError ? (
      <SectionAction onClick={startEdit} label="Edit company details">
        Edit
      </SectionAction>
    ) : undefined;

  const messages = (
    <>
      {error && (
        <p role="alert" className="mt-2 text-[14px] text-warn dark:text-marigold">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 break-words text-[14px] text-inkMuted">
          {notice}
        </p>
      )}
    </>
  );

  const settled =
    loadError !== null ||
    (facts !== null && (!needsSuggestion || suggestionDone) && (!wantsAiDraft || aiDraftDone));

  return (
    <SettledSection
      ready={settled}
      holdOnRefresh={false}
      className="divide-y divide-rule"
      skeleton={<CompanyBars ariaLabel="Loading your company" />}
    >
      <FactRow label="Company" action={editButton}>
        {loadError ? (
          <p role="alert" className="text-sm text-warn dark:text-marigold">
            Company details could not be loaded.{" "}
            <button type="button" className="underline" onClick={() => void load()}>
              Retry
            </button>
          </p>
        ) : !facts ? (
          <div role="status" aria-label="Loading company details" className="flex items-center gap-3">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : editing ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {logo}
              <input
                aria-label="Company name"
                value={draft.company_name}
                onChange={(e) => setDraft({ ...draft, company_name: e.target.value })}
                placeholder={fallbackName ?? "Company name"}
                className="min-w-0 flex-1 rounded-lg border border-rule bg-creamDeep px-3 py-1.5 text-base font-medium text-ink focus:border-inkMuted focus:outline-none focus:ring-2 focus:ring-inkMuted"
              />
            </div>
            <textarea
              aria-label="What the company does"
              value={draft.what_we_sell}
              onChange={(e) => setDraft({ ...draft, what_we_sell: e.target.value })}
              placeholder="One line on what the company does, e.g. scheduling software for dental clinics."
              rows={2}
              className="w-full resize-none rounded-lg border border-rule bg-creamDeep px-3 py-2 text-[14px] text-ink placeholder:text-inkMuted focus:border-inkMuted focus:outline-none focus:ring-2 focus:ring-inkMuted"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void commitEdit()}
                disabled={saving}
                className="rounded-cta bg-ink px-3.5 py-1.5 text-[14px] font-medium text-cream disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
                className="text-[14px] text-inkMuted hover:text-ink"
              >
                Cancel
              </button>
            </div>
            {messages}
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3">
              {logo}
              <p className="min-w-0 flex-1 break-words pt-1">
                <span className="font-semibold text-ink">{name}</span>
                {facts.what_we_sell.trim() ? (
                  <span className="text-inkSoft">{` ${facts.what_we_sell.trim()}`}</span>
                ) : proposal && canEdit ? null : (
                  <span className="text-inkMuted">
                    {canEdit
                      ? " Add a line on what the company does, so Zavi stops guessing."
                      : " No description yet."}
                  </span>
                )}
              </p>
            </div>

            {aiDrafting && !proposal && canEdit && (
              <p role="status" className="mt-2 text-[13px] text-inkMuted">
                Zavi is reading your site to suggest a fuller description…
              </p>
            )}
            {proposal && canEdit && (
              <div className="mt-3 rounded-xl border border-dashed border-rule px-3.5 py-3">
                <p className="text-[13px] text-inkMuted">{proposal.from}:</p>
                <p className="mt-1 break-words text-[14px] leading-snug text-ink">
                  {proposal.value}
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save({ what_we_sell: proposal.value })}
                    className="rounded-cta bg-ink px-3 py-1.5 text-[14px] font-medium text-cream disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Use this"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft({ ...(facts ?? EMPTY), what_we_sell: proposal.value });
                      setEditing(true);
                    }}
                    className="text-[14px] text-inkMuted underline underline-offset-2 hover:text-ink"
                  >
                    Edit first
                  </button>
                  {proposal.ai && (
                    <button
                      type="button"
                      onClick={() => void dismissAiDraft()}
                      className="ml-auto text-[14px] text-inkMuted hover:text-ink"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            )}

            {hasFound && (
              <button
                type="button"
                aria-expanded={foundOpen}
                onClick={() => setFoundOpen((v) => !v)}
                className="mt-1 text-[13px] text-inkMuted underline-offset-2 hover:text-ink hover:underline"
              >
                {foundOpen ? "Hide what Zavi found" : foundCount > 0 ? `What Zavi found (${foundCount})` : "What Zavi found"}
              </button>
            )}
            {foundOpen && (
              <>
                <PlanSummary summary={summary} />
                <CompanyFactsList facts={sourcedFacts} />
              </>
            )}
            {footer}
          </>
        )}
      </FactRow>

      {facts && !loadError && (
        <FactRow
          label="Rivals"
          action={
            canEdit && !addingCompetitor ? (
              <SectionAction onClick={() => setAddingCompetitor(true)} label="Add a rival">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add
              </SectionAction>
            ) : undefined
          }
        >
          {}
          <div ref={rivalsRef} className="flex flex-wrap items-center gap-2">
            {competitors.map((c) => (
              <span
                key={c}
                className="inline-flex max-w-full items-center gap-1 break-all rounded-full bg-creamDeep py-0.5 pl-2.5 pr-1.5 text-[13px] text-ink"
              >
                {c}
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Remove ${c}`}
                    disabled={saving}
                    onClick={() => removeCompetitor(c)}
                    className="rounded-full p-0.5 text-inkMuted hover:bg-rule hover:text-ink disabled:opacity-40"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
            {competitors.length === 0 && !addingCompetitor && (
              <span className="text-inkMuted">None yet. I will not guess them.</span>
            )}
            {canEdit && addingCompetitor && (
              <form
                className="inline-flex items-center gap-1 rounded-full border border-rule py-0.5 pl-2.5 pr-1 focus-within:border-inkMuted"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addCompetitor();
                }}
              >
                <input
                  aria-label="Add a competitor"
                  autoFocus
                  value={competitorInput}
                  onChange={(e) => setCompetitorInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setCompetitorInput("");
                      setAddingCompetitor(false);
                    }
                  }}
                  placeholder="Name"
                  className="w-28 bg-transparent text-[13px] text-ink placeholder:text-inkMuted focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={saving || !competitorInput.trim()}
                  className="rounded-full px-2 py-0.5 text-[13px] font-medium text-ink hover:bg-creamDeep disabled:text-inkMuted"
                >
                  Add
                </button>
              </form>
            )}
          </div>
        </FactRow>
      )}
      {}
      {!editing && messages}
    </SettledSection>
  );
}
