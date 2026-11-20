"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { useActiveTenant } from "@/components/workspace/brain/useActiveTenant";
import { Markdown } from "@/components/workspace/Markdown";
import type { CompanyMdRef, KeyFact } from "./types";
import { NextChevron } from "@/components/ui/NextChevron";

const PLACEHOLDER_THRESHOLD = 40;
const LABEL_VISIBLE_MAX = 14;
const VALUE_VISIBLE_MAX = 30;

export function CompanyBriefCard({
  companyMd,
  loading: parentLoading = false,
}: {
  companyMd: CompanyMdRef | null;
  loading?: boolean;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [keyFacts, setKeyFacts] = useState<KeyFact[] | undefined>(
    companyMd?.metadata?.key_facts,
  );
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenAttempted, setRegenAttempted] = useState(false);
  const regenFiredRef = useRef(false);
  const tid = useActiveTenant();

  useEffect(() => {
    setKeyFacts(companyMd?.metadata?.key_facts);
    setRegenAttempted(false);
    regenFiredRef.current = false;
  }, [companyMd?.id, companyMd?.updated_at]);

  useEffect(() => {
    if (!companyMd || tid === undefined) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    if (tid === null) {
      setBody("");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const { data, error } = await sb
          .from("memory_note")
          .select("body_markdown")
          .eq("tenant_id", tid)
          .eq("id", companyMd.id)
          .single();
        if (cancelled) return;
        if (error) {
          setErrorMsg(error.message);
          setLoading(false);
          return;
        }
        const text = (data as { body_markdown?: string } | null)?.body_markdown ?? "";
        setBody(text);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setErrorMsg((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyMd, tid]);

  useEffect(() => {
    if (regenFiredRef.current) return;
    if (parentLoading) return;
    const isHuman = companyMd?.source === "human";
    const bodyTooShort = body !== null && body.trim().length < PLACEHOLDER_THRESHOLD;
    const chipsNeverTried = !!companyMd && keyFacts === undefined && !isHuman;
    const shouldRegen = !companyMd || bodyTooShort || chipsNeverTried;
    if (!shouldRegen) return;
    if (companyMd && body === null && !errorMsg) return;
    let cancelled = false;
    regenFiredRef.current = true;
    setRegenAttempted(true);
    setRegenerating(true);
    setErrorMsg(null);
    const failsafe = setTimeout(() => {
      if (!cancelled) setRegenerating(false);
    }, 45000);
    (async () => {
      try {
        const res = await apiFetch("/api/memory/regenerate-anchor", {
          method: "POST",
          body: JSON.stringify({ slug: "company" }),
        });
        if (cancelled || !res.ok) return;
        const json = (await res.json()) as {
          body_markdown?: string;
          key_facts?: KeyFact[];
        };
        if (cancelled) return;
        if (typeof json.body_markdown === "string" && json.body_markdown.length > 0) {
          setBody(json.body_markdown);
        }
        setKeyFacts(json.key_facts);
      } catch {
      } finally {
        clearTimeout(failsafe);
        setRegenerating(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(failsafe);
    };
  }, [companyMd, body, keyFacts, errorMsg, parentLoading]);

  if (parentLoading) {
    return (
      <Card title="Company brief">
        <ChipSkeleton />
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 animate-pulse rounded bg-bone" />
          ))}
        </div>
      </Card>
    );
  }

  if (regenerating || (!companyMd && !regenAttempted)) {
    return (
      <Card title="Company brief">
        <p className="mb-3 text-[13px] text-inkMuted">
          Brain is writing your company brief from what it knows…
        </p>
        <ChipSkeleton />
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 animate-pulse rounded bg-bone" />
          ))}
        </div>
      </Card>
    );
  }

  if (!companyMd) {
    return (
      <Card title="Company brief">
        <p className="text-[16px] leading-[1.55] text-inkMuted">
          The brain couldn&apos;t draft a company brief yet. You can{" "}
          <Link
            href="/start"
            className="text-ink underline-offset-2 hover:underline"
          >
            sharpen it via onboarding
          </Link>{" "}
          or{" "}
          <Link
            href="/memory/new"
            className="text-ink underline-offset-2 hover:underline"
          >
            write one manually
          </Link>
          .
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={companyMd.title}
      right={
        <Link
          href={`/memory/${encodeURIComponent(companyMd.id)}`}
          className="text-[12px] text-inkMuted hover:text-ink"
        >
          edit <NextChevron />
        </Link>
      }
    >
      <ChipStrip
        keyFacts={keyFacts}
        source={companyMd.source}
        updatedAt={companyMd.updated_at}
      />
      {loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 animate-pulse rounded bg-bone" />
          ))}
        </div>
      )}
      {errorMsg && (
        <div className="text-[13px] text-rose-700">{errorMsg}</div>
      )}
      {!loading && !errorMsg && body !== null && (
        body.length > 0 ? (
          <Markdown source={body} />
        ) : (
          <span className="text-[13px] text-inkMuted">
            (Company brief is empty.)
          </span>
        )
      )}
    </Card>
  );
}

function Card({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function ChipStrip({
  keyFacts,
  source,
  updatedAt,
}: {
  keyFacts: KeyFact[] | undefined;
  source: string;
  updatedAt: string;
}) {
  const showFacts = Array.isArray(keyFacts) && keyFacts.length > 0;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {showFacts &&
        keyFacts!.map((f, i) => (
          <FactChip key={`${f.label}-${i}`} label={f.label} value={f.value} />
        ))}
      <SourceChip source={source} />
      <FreshnessChip updatedAt={updatedAt} />
    </div>
  );
}

function FactChip({ label, value }: { label: string; value: string }) {
  const visibleLabel = clip(label, LABEL_VISIBLE_MAX);
  const visibleValue = clip(value, VALUE_VISIBLE_MAX);
  const fullText = `${label}: ${value}`;
  return (
    <span
      title={fullText}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-bone px-2.5 py-0.5 text-[12px] text-ink"
    >
      <span className="font-medium text-ink">{visibleLabel}</span>
      <span className="text-inkMuted">·</span>
      <span className="truncate">{visibleValue}</span>
    </span>
  );
}

function SourceChip({ source }: { source: string }) {
  const isAi = source === "agent_write";
  const label = isAi ? "AI-drafted" : "Operator-edited";
  return (
    <span
      className={
        isAi
          ? "inline-flex items-center rounded-full bg-bone px-2.5 py-0.5 text-[12px] text-ink"
          : "inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-[12px] text-emerald-700"
      }
    >
      {label}
    </span>
  );
}

function FreshnessChip({ updatedAt }: { updatedAt: string }) {
  return (
    <span
      title={updatedAt}
      className="inline-flex items-center rounded-full bg-bone px-2.5 py-0.5 text-[12px] text-inkMuted"
    >
      Updated {relativeTime(updatedAt)}
    </span>
  );
}

function ChipSkeleton() {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-5 w-20 animate-pulse rounded-full bg-bone"
        />
      ))}
    </div>
  );
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "-";
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 300) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 8) return `${wk}w ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
