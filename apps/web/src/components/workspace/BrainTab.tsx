"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { useActiveTenant } from "./brain/useActiveTenant";
import { scopeToTenant } from "./brain/tenantScope";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "./WorkspaceShell";
import { useBrainPulse } from "./brain/useBrainPulse";
import { useBrainPriority, type PriorityItem } from "./brain/useBrainPriority";
import { BrainPriorityPanel } from "./brain/BrainPriorityPanel";
import { BrainRecallProbe } from "./brain/BrainRecallProbe";
import { assignNotesToAnchors } from "./brain/affinity";
import { TimelineSegment } from "./brain/TimelineSegment";
import { CompanyFactsPanel } from "./CompanyFactsPanel";
import { isMember } from "@/lib/members";
import {
  BrainListSkeleton,
  EntitiesListSkeleton,
  ConflictsSkeleton,
  BrainGraphSkeleton,
} from "./brain/BrainSkeletons";
import type {
  AnchorInput,
  NoteInput,
  EntityInput,
  PriorityHighlight,
} from "./brain/BrainGraph";
import { Input } from "@/components/Input";
import { NextChevron } from "@/components/ui/NextChevron";

const ANCHOR_AGENT: Record<string, string> = {
  company: "chief-of-staff",
  ops: "support-lead",
  policies: "support-lead",
  disputes: "support-lead",
  support: "support-lead",
};
const FALLBACK_AGENT = "chief-of-staff";

const BrainGraph = dynamic(
  () => import("./brain/BrainGraph").then((m) => m.BrainGraph),
  { ssr: false, loading: () => <BrainGraphSkeleton /> },
);

type ViewMode = "graph" | "list";
const VIEW_STORAGE_KEY = "praxis.brain.view";
const SYSTEM_CORE_COLLAPSED_KEY = "brainTab_systemCore_collapsed";

type NoteRow = {
  id: string;
  title: string;
  body_markdown: string;
  source: string;
  source_ref: string | null;
  tags: string[];
  note_type: string;
  created_at: string;
  updated_at: string;
};

type AnchorRow = {
  id: string;
  slug: string;
  title: string;
  body_markdown: string;
  updated_at: string;
  metadata: { tier?: string; source?: string; candidate_id?: string } | null;
};

const ANCHOR_SLUGS: ReadonlyArray<{ slug: string; label: string; hint: string }> = [
  { slug: "company", label: "Company brief", hint: "What the company is. Read by every agent." },
  { slug: "ops", label: "Operating priorities", hint: "Surface ranking, escalation chain, $-cap." },
  { slug: "policies", label: "Policies", hint: "Refund / KYC / dispute / fraud rules in your voice." },
  { slug: "disputes", label: "Disputes anchor", hint: "When to refund, chargeback, ban. Concrete examples." },
  { slug: "support", label: "Support anchor", hint: "Escalation tiers, response-time targets." },
];

type Entity = {
  id: string;
  entity_type: string;
  canonical_name: string;
  attrs: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
};

type Segment = "timeline" | "company" | "map" | "entities" | "skills" | "conflicts";

const KNOWN_ENTITY_TYPES = [
  "person",
  "company",
  "deal",
  "metric",
  "email",
  "url",
  "amount",
  "tool",
  "host",
  "customer",
  "product",
  "domain",
  "handle",
  "phone",
];

const NOTE_TYPES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "operator_preference", label: "preference" },
  { key: "agent_feedback", label: "feedback" },
  { key: "tenant_project", label: "project" },
  { key: "tenant_reference", label: "reference" },
  { key: "untyped", label: "untyped" },
];

const SHOW_PROBE = false;
const SHOW_PARKED_SEGMENTS = false;

export function BrainTab() {
  const [segment, setSegment] = useState<Segment>("timeline");
  const { role } = useWorkspace();
  const col = "mx-auto w-full max-w-[1084px] px-6";

  const parkedTabs = (
    <>
      <SegmentTab active={segment === "map"} onClick={() => setSegment("map")}>
        Brain map
      </SegmentTab>
      <SegmentTab active={segment === "entities"} onClick={() => setSegment("entities")}>
        Entities
      </SegmentTab>
      <SegmentTab active={segment === "skills"} onClick={() => setSegment("skills")}>
        Skills
      </SegmentTab>
      <SegmentTab active={segment === "conflicts"} onClick={() => setSegment("conflicts")}>
        Conflicts
      </SegmentTab>
    </>
  );

  const nonTimeline = (
    <>
      {segment === "map" && <NotesSegment initialView="graph" />}
      {segment === "entities" && (
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          <EntitiesSegment />
        </div>
      )}
      {segment === "skills" && (
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          <SkillsSegment />
        </div>
      )}
      {segment === "conflicts" && (
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          <ConflictsSegment />
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {SHOW_PROBE && (
        <div className={`${col} mt-4`}>
          <BrainRecallProbe />
        </div>
      )}

      {SHOW_PARKED_SEGMENTS && (
        <div className={`${col} mt-6`}>
          <div className="flex flex-wrap items-center gap-1">{parkedTabs}</div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {segment === "timeline" && <TimelineSegment />}
        {segment === "company" && (
          <div className="mx-auto w-full max-w-[1084px] px-6 pb-6 pt-6">
            <div className="w-full max-w-[828px]">
              <CompanyFactsPanel readOnly={isMember(role)} />
            </div>
          </div>
        )}
        {SHOW_PARKED_SEGMENTS && nonTimeline}
      </div>
    </div>
  );
}

function NotesSegment({ initialView }: { initialView?: ViewMode } = {}) {
  const router = useRouter();
  const { openAgentTab, role } = useWorkspace();
  const canEditBrain = role !== "member";
  const [rows, setRows] = useState<NoteRow[]>([]);
  const [anchors, setAnchors] = useState<AnchorRow[]>([]);
  const [graphEntities, setGraphEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<ViewMode>(initialView ?? "list");

  const tid = useActiveTenant();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (initialView) return;
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "list" || stored === "graph") setView(stored);
  }, [initialView]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  useEffect(() => {
    if (tid === undefined) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    if (tid === null) {
      setRows([]);
      setLoading(false);
      return;
    }
    const sb = createBrowserSupabase();
    let q = scopeToTenant(
      sb
        .from("memory_note")
        .select("id, title, body_markdown, source, source_ref, tags, note_type, created_at, updated_at"),
      tid,
    )
      .neq("note_type", "anchor")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (typeFilter) q = q.eq("note_type", typeFilter);
    q.then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setErrorMsg(error.message);
        setLoading(false);
        return;
      }
      setRows((data ?? []) as NoteRow[]);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [typeFilter, reloadKey, tid]);

  useEffect(() => {
    if (tid === undefined) return;
    let cancelled = false;
    if (tid === null) {
      setAnchors([]);
      return;
    }
    const sb = createBrowserSupabase();
    scopeToTenant(
      sb
        .from("memory_note")
        .select("id, slug, title, body_markdown, updated_at, metadata"),
      tid,
    )
      .eq("note_type", "anchor")
      .not("slug", "is", null)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (cancelled) return;
        setAnchors((data ?? []) as AnchorRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, tid]);

  useEffect(() => {
    if (view !== "graph" || tid === undefined) return;
    let cancelled = false;
    if (tid === null) {
      setGraphEntities([]);
      return;
    }
    const sb = createBrowserSupabase();
    scopeToTenant(
      sb
        .from("memory_entity")
        .select("id, entity_type, canonical_name, attrs, first_seen_at, last_seen_at"),
      tid,
    )
      .order("last_seen_at", { ascending: false })
      .limit(120)
      .then(({ data }) => {
        if (cancelled) return;
        setGraphEntities((data ?? []) as Entity[]);
      });
    return () => {
      cancelled = true;
    };
  }, [view, reloadKey, tid]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.body_markdown.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.note_type, (m.get(r.note_type) ?? 0) + 1);
    return m;
  }, [rows]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this note? This can't be undone.")) return;
      try {
        const res = await apiFetch(`/api/memory/notes/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          alert(`Delete failed: ${j?.error?.message ?? res.statusText}`);
          return;
        }
        setReloadKey((k) => k + 1);
      } catch (e) {
        alert(`Delete failed: ${(e as Error).message}`);
      }
    },
    [],
  );

  const primaryAnchors = useMemo(
    () => anchors.filter((a) => a.metadata?.tier === "primary"),
    [anchors],
  );
  const canonicalAnchors = useMemo(
    () => anchors.filter((a) => a.metadata?.tier !== "primary"),
    [anchors],
  );

  const orderedAnchors = useMemo(() => {
    const bySlug = new Map(canonicalAnchors.map((a) => [a.slug, a]));
    return ANCHOR_SLUGS.map((s) => ({
      ...s,
      row: bySlug.get(s.slug),
    }));
  }, [canonicalAnchors]);

  const [systemCoreCollapsed, setSystemCoreCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(SYSTEM_CORE_COLLAPSED_KEY);
    setSystemCoreCollapsed(stored === "1");
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SYSTEM_CORE_COLLAPSED_KEY, systemCoreCollapsed ? "1" : "0");
  }, [systemCoreCollapsed]);

  const orderedPrimaryAnchors = useMemo(() => {
    return [...primaryAnchors].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }, [primaryAnchors]);

  const anchorInputs: AnchorInput[] = useMemo(() => {
    const bySlug = new Map(anchors.map((a) => [a.slug, a]));
    const canonical: AnchorInput[] = ANCHOR_SLUGS.map((s) => {
      const row = bySlug.get(s.slug);
      return {
        id: row?.id ?? `placeholder:${s.slug}`,
        slug: s.slug,
        label: s.label,
        body: row?.body_markdown ?? s.hint,
        written: Boolean(row),
        tier: "canonical" as const,
      };
    });
    const primary: AnchorInput[] = orderedPrimaryAnchors.map((p, idx) => ({
      id: p.id,
      slug: p.slug,
      label: p.title,
      body: p.body_markdown,
      written: true,
      tier: "primary" as const,
      primary_rank: idx + 1,
    }));
    return [...canonical, ...primary];
  }, [anchors, orderedPrimaryAnchors]);
  const noteInputs: NoteInput[] = useMemo(
    () =>
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body_markdown,
        note_type: r.note_type,
        tags: r.tags ?? [],
      })),
    [rows],
  );
  const entityInputs: EntityInput[] = useMemo(
    () =>
      graphEntities.map((e) => ({
        id: e.id,
        canonical_name: e.canonical_name,
        entity_type: e.entity_type,
      })),
    [graphEntities],
  );
  const anchorIds = useMemo(() => anchors.map((a) => a.id), [anchors]);
  const { pulses, reads24h } = useBrainPulse(anchorIds, tid);

  const anchorSlugByNoteId = useMemo(
    () => assignNotesToAnchors(anchorInputs, noteInputs),
    [anchorInputs, noteInputs],
  );
  const { items: priorityItems, loading: priorityLoading } = useBrainPriority(
    anchorSlugByNoteId,
  );
  const [hoveredPriorityRank, setHoveredPriorityRank] = useState<number | null>(
    null,
  );

  const priorityHighlights: PriorityHighlight[] = useMemo(() => {
    const out: PriorityHighlight[] = [];
    for (const it of priorityItems) {
      if (it.graphNodeId) {
        out.push({ rank: it.rank, graphNodeId: it.graphNodeId });
      } else if (it.anchorSlug) {
        const anchorRow = anchors.find((a) => a.slug === it.anchorSlug);
        if (anchorRow) {
          out.push({ rank: it.rank, graphNodeId: `a:${anchorRow.id}` });
        }
      }
    }
    return out;
  }, [priorityItems, anchors]);

  const handlePriorityClick = useCallback(
    (it: PriorityItem) => {
      switch (it.kind) {
        case "conflict":
          window.location.hash = `#conflicts:${it.refId}`;
          router.push(`/memory/${it.refId}`);
          break;
        case "pending_decision":
          router.push(`/inbox?decision=${it.refId}`);
          break;
        case "agent_feedback":
          setView("list");
          setExpanded(it.refId);
          setTimeout(() => {
            document
              .getElementById(`note-${it.refId}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 80);
          break;
        case "stale_anchor":
          router.push(`/memory/${it.refId}`);
          break;
        case "untyped_pile":
          setView("list");
          setTypeFilter("untyped");
          break;
      }
    },
    [router],
  );

  return (
    <div
      className={
        view === "graph"
          ? "flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3"
          : "mx-auto w-full max-w-4xl px-6 pb-6 pt-4"
      }
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="inline-flex items-center gap-0.5 rounded-full bg-[#efe9df] p-0.5 text-[12px]">
          <ViewToggle active={view === "graph"} onClick={() => setView("graph")}>
            Graph
          </ViewToggle>
          <ViewToggle active={view === "list"} onClick={() => setView("list")}>
            List
          </ViewToggle>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-wide text-inkMuted">
          {view === "graph"
            ? "live · click any node"
            : "auto-extracted from chat + agent runs"}
        </span>
      </div>

      {view === "graph" && (
        <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <BrainGraph
            anchors={anchorInputs}
            notes={noteInputs}
            entities={entityInputs}
            pulses={pulses}
            reads24h={reads24h}
            priority={priorityHighlights}
            hoveredPriorityRank={hoveredPriorityRank}
            onHoveredPriorityChange={setHoveredPriorityRank}
            onAnchorClick={(a) => {
              const agentSlug = ANCHOR_AGENT[a.slug] ?? FALLBACK_AGENT;
              void openAgentTab(agentSlug);
            }}
            onNoteClick={(n) => {
              const slug = anchorSlugByNoteId.get(n.id);
              const agentSlug = (slug && ANCHOR_AGENT[slug]) || FALLBACK_AGENT;
              void openAgentTab(agentSlug);
            }}
            onEntityClick={(e) => {
              const needle = e.canonical_name.toLowerCase();
              if (needle.length >= 3) {
                const tally = new Map<string, number>();
                for (const n of noteInputs) {
                  const hay = `${n.title}\n${n.body}`.toLowerCase();
                  if (hay.includes(needle)) {
                    const slug = anchorSlugByNoteId.get(n.id);
                    if (slug) tally.set(slug, (tally.get(slug) ?? 0) + 1);
                  }
                }
                let bestSlug: string | null = null;
                let bestCount = 0;
                for (const [s, c] of tally) {
                  if (c > bestCount) {
                    bestCount = c;
                    bestSlug = s;
                  }
                }
                if (bestSlug) {
                  void openAgentTab(ANCHOR_AGENT[bestSlug] ?? FALLBACK_AGENT);
                  return;
                }
              }
              void openAgentTab(FALLBACK_AGENT);
            }}
          />
          <BrainPriorityPanel
            items={priorityItems}
            loading={priorityLoading}
            hoveredRank={hoveredPriorityRank}
            onHoverRankChange={setHoveredPriorityRank}
            onItemClick={handlePriorityClick}
          />
          {}
          {loading && (
            <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-wide text-inkMuted lg:col-span-2">
              loading brain…
            </p>
          )}
          {errorMsg && (
            <div className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900 lg:col-span-2">
              Couldn&apos;t load notes: {errorMsg}
            </div>
          )}
        </section>
      )}

      {view === "list" && (
        <>
          {}
          {orderedPrimaryAnchors.length > 0 && (
            <section className="mb-6">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
                  Your fleet&apos;s priorities
                </h2>
                <span className="font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                  {orderedPrimaryAnchors.length} operator-chosen
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {orderedPrimaryAnchors.map((a) => {
                  const cardClass =
                    "group rounded-xl border border-ink/[0.08] border-l-[3px] border-l-ink bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]";
                  const inner = (
                    <>
                      <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <span className="inline-flex items-center rounded-[5px] bg-[#eef2ef] px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.04em] text-[#2f6f5e]">
                          operator priority
                        </span>
                        {canEditBrain && (
                          <div className="font-mono text-[11px] text-inkMuted">edit <NextChevron /></div>
                        )}
                      </div>
                      <div className="mb-1 text-[13px] font-medium text-ink">
                        {a.title.replace(/\.md$/, "")}
                      </div>
                      <div className="line-clamp-2 text-[12px] leading-[1.5] text-inkMuted">
                        {a.body_markdown.replace(/^#+\s*/gm, "").trim().slice(0, 140)}
                      </div>
                    </>
                  );
                  return canEditBrain ? (
                    <Link
                      key={a.id}
                      href={`/memory/${a.id}`}
                      className={`${cardClass} transition-colors hover:border-l-ink hover:bg-bone/30`}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={a.id} className={cardClass}>
                      {inner}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {}
          {canonicalAnchors.length > 0 && (
            <section className="mb-6">
              <button
                type="button"
                onClick={() => setSystemCoreCollapsed((v) => !v)}
                aria-expanded={!systemCoreCollapsed}
                className="mb-2 flex w-full items-baseline justify-between text-left"
              >
                <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">
                  <span aria-hidden className="mr-1.5 text-inkMuted">
                    {systemCoreCollapsed ? "▸" : "▾"}
                  </span>
                  System core
                </h2>
                <span className="font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                  {canonicalAnchors.length} anchors agents read by slug
                </span>
              </button>
              {!systemCoreCollapsed && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {orderedAnchors.map((a) =>
                    a.row ? (
                      (() => {
                        const cardClass =
                          "group rounded-xl border border-ink/[0.08] bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(25,25,25,0.04)]";
                        const inner = (
                          <>
                            <div className="mb-1 flex items-baseline justify-between gap-2">
                              <div className="font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                                {a.slug}.md
                              </div>
                              {canEditBrain && (
                                <div className="font-mono text-[11px] text-inkMuted">edit <NextChevron /></div>
                              )}
                            </div>
                            <div className="mb-1 text-[13px] font-medium text-ink">
                              {a.label}
                            </div>
                            <div className="line-clamp-2 text-[12px] leading-[1.5] text-inkMuted">
                              {a.row.body_markdown.replace(/^#+\s*/gm, "").trim().slice(0, 140) || a.hint}
                            </div>
                          </>
                        );
                        return canEditBrain ? (
                          <Link
                            key={a.slug}
                            href={`/memory/${a.row.id}`}
                            className={`${cardClass} hover:border-ink/30 transition-colors`}
                          >
                            {inner}
                          </Link>
                        ) : (
                          <div key={a.slug} className={cardClass}>
                            {inner}
                          </div>
                        );
                      })()
                    ) : (
                      <div
                        key={a.slug}
                        className="rounded-md border border-dashed border-ink/10 bg-bone/40 px-3 py-2.5"
                      >
                        <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                          {a.slug}.md
                        </div>
                        <div className="text-[13px] font-medium text-inkMuted">
                          Not yet written
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </section>
          )}

          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
              Typed notes
            </h2>
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-[11px] uppercase tracking-wide text-inkMuted sm:inline">
                auto-extracted from chat + agent runs
              </span>
              {canEditBrain && (
                <Link
                  href="/memory/new"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-ink/15 bg-white px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:border-ink/40 hover:bg-bone"
                >
                  <span aria-hidden className="text-[13px] leading-none">+</span>
                  New note
                </Link>
              )}
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <FilterChip
              active={typeFilter === null}
              onClick={() => setTypeFilter(null)}
              count={rows.length}
            >
              all
            </FilterChip>
            {NOTE_TYPES.map((t) => (
              <FilterChip
                key={t.key}
                active={typeFilter === t.key}
                onClick={() => setTypeFilter(t.key)}
                count={typeCounts.get(t.key) ?? 0}
              >
                {t.label}
              </FilterChip>
            ))}
            <Input
              unstyled
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title / body / tags…"
              className="ml-auto w-56 rounded-full border border-ink/15 bg-white px-3 py-1 text-[12px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
            />
          </div>

          {loading && <BrainListSkeleton count={5} label="Loading notes…" />}
          {errorMsg && (
            <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900">
              Couldn&apos;t load notes: {errorMsg}
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="rounded-md border border-dashed border-ink/10 px-4 py-10 text-center text-[13px] text-inkMuted">
              {rows.length === 0 ? (
                <>
                  <p>
                    No typed notes yet. They get auto-extracted as you chat with
                    agents + as agents run.
                  </p>
                  {canEditBrain && (
                    <Link
                      href="/memory/new"
                      className="mt-3 inline-flex items-center gap-1 rounded-md border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-ink/40 hover:bg-bone"
                    >
                      <span aria-hidden className="text-[13px] leading-none">+</span>
                      Add a note manually
                    </Link>
                  )}
                </>
              ) : (
                "No notes match this filter."
              )}
            </div>
          )}
          {!loading && filtered.length > 0 && (
            <ul className="space-y-1.5">
              {filtered.map((n) => (
                <li
                  key={n.id}
                  id={`note-${n.id}`}
                  className="rounded-xl border border-ink/[0.08] bg-white shadow-[0_1px_2px_rgba(25,25,25,0.04)]"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === n.id ? null : n.id)}
                    aria-expanded={expanded === n.id}
                    className="flex w-full items-start gap-3 px-3 py-2 text-left"
                  >
                    <NoteTypeChip type={n.note_type} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink">
                        {n.title || "(untitled)"}
                      </span>
                      <span className="block truncate text-[12px] text-inkMuted">
                        {n.body_markdown.slice(0, 160)}
                      </span>
                    </span>
                    <span className="hidden font-mono text-[11px] text-inkMuted tabular-nums sm:inline">
                      {new Date(n.updated_at).toLocaleDateString()}
                    </span>
                    <span aria-hidden className="text-inkMuted">
                      {expanded === n.id ? "▾" : "▸"}
                    </span>
                  </button>
                  {expanded === n.id && (
                    <div className="border-t border-ink/10 bg-bone px-3 py-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-inkMuted">
                        <span className="font-mono uppercase tracking-wide">
                          source: {n.source}
                        </span>
                        {n.source_ref && (
                          <span className="font-mono">
                            ref: <code>{n.source_ref.slice(0, 20)}</code>
                          </span>
                        )}
                        {n.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-bone px-1.5 py-0.5 font-mono text-[11px] text-inkMuted"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                      <pre className="mb-3 whitespace-pre-wrap font-sans text-[13px] leading-[1.5] text-ink">
                        {n.body_markdown}
                      </pre>
                      {canEditBrain && (
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/memory/${n.id}`}
                            className="rounded border border-ink/15 bg-white px-2.5 py-1 text-[12px] text-ink hover:bg-bone"
                          >
                            Edit
                          </Link>
                          <button
                            type="button"
                            onClick={() => handleDelete(n.id)}
                            className="rounded border border-rose-300 bg-white px-2.5 py-1 text-[12px] text-rose-700 hover:bg-rose-50"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-6 text-[11px] text-inkMuted">
            {filtered.length} of {rows.length} shown
            {typeFilter && ` · filtered by type=${typeFilter}`}
            {query && ` · query="${query}"`}
          </p>
        </>
      )}
    </div>
  );
}

type SkillRow = NoteRow;

type SkillDraft = {
  id: string | null;
  title: string;
  body_markdown: string;
  tags: string;
};

function SkillsSegment() {
  const { role } = useWorkspace();
  const canEditBrain = role !== "member";
  const tid = useActiveTenant();
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (tid === undefined) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    if (tid === null) {
      setRows([]);
      setLoading(false);
      return;
    }
    apiFetch("/api/memory/notes?note_type=skill")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) {
          setErrorMsg(j.error.message ?? "load failed");
          setLoading(false);
          return;
        }
        setRows((j.notes ?? []) as SkillRow[]);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setErrorMsg((e as Error).message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tid, reloadKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.body_markdown.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const startCreate = useCallback(() => {
    setSaveErr(null);
    setDraft({ id: null, title: "", body_markdown: "", tags: "" });
  }, []);
  const startEdit = useCallback((r: SkillRow) => {
    setSaveErr(null);
    setDraft({
      id: r.id,
      title: r.title,
      body_markdown: r.body_markdown,
      tags: (r.tags ?? []).join(", "),
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    const body = draft.body_markdown.trim();
    if (body.length === 0) {
      setSaveErr("A skill needs a body. Describe how the company does this.");
      return;
    }
    setSaving(true);
    setSaveErr(null);
    const tags = draft.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 10);
    try {
      const res = await apiFetch("/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          ...(draft.id ? { id: draft.id } : {}),
          note_type: "skill",
          title: draft.title.trim(),
          body_markdown: body,
          tags,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setSaveErr(j?.error?.message ?? res.statusText);
        setSaving(false);
        return;
      }
      setDraft(null);
      setSaving(false);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setSaveErr((e as Error).message);
      setSaving(false);
    }
  }, [draft]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm("Delete this skill? This can't be undone.")) return;
    try {
      const res = await apiFetch(`/api/memory/notes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Delete failed: ${j?.error?.message ?? res.statusText}`);
        return;
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }, []);

  if (draft) {
    return (
      <div className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
        <h2 className="mb-3 font-display text-[14px] font-semibold tracking-tight text-ink">
          {draft.id ? "Edit skill" : "New skill"}
        </h2>
        <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-inkMuted">
          Title
        </label>
        <Input
          unstyled
          type="text"
          value={draft.title}
          onChange={(e) =>
            setDraft((d) => (d ? { ...d, title: e.target.value } : d))
          }
          placeholder="e.g. How we handle a refund request"
          className="mb-3 w-full rounded-md border border-ink/15 bg-white px-2.5 py-1.5 text-[13px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
        />
        <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-inkMuted">
          Skill (how we do this here)
        </label>
        <textarea
          value={draft.body_markdown}
          onChange={(e) =>
            setDraft((d) => (d ? { ...d, body_markdown: e.target.value } : d))
          }
          rows={10}
          placeholder="Describe the procedure in your own words. Every agent reads this when the task comes up."
          className="mb-3 w-full rounded-md border border-ink/15 bg-white px-2.5 py-2 font-sans text-[13px] leading-[1.5] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
        />
        <label className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-inkMuted">
          Tags (comma-separated, optional)
        </label>
        <Input
          unstyled
          type="text"
          value={draft.tags}
          onChange={(e) =>
            setDraft((d) => (d ? { ...d, tags: e.target.value } : d))
          }
          placeholder="refunds, support, policy"
          className="mb-4 w-full rounded-md border border-ink/15 bg-white px-2.5 py-1.5 text-[13px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
        />
        {saveErr && (
          <div className="mb-3 rounded-md border border-rose-300 bg-rose-50 p-2.5 text-[13px] text-rose-900">
            {saveErr}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="rounded-cta border border-ink/15 bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-ink/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : draft.id ? "Save changes" : "Create skill"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => setDraft(null)}
            className="rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-bone disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[14px] font-semibold tracking-tight text-ink">
          Shared skills
        </h2>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-[11px] uppercase tracking-wide text-inkMuted sm:inline">
            read by every agent
          </span>
          {canEditBrain && (
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex shrink-0 items-center gap-1 rounded-cta border border-ink/15 bg-white px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:border-ink/40 hover:bg-bone"
            >
              <span aria-hidden className="text-[13px] leading-none">+</span>
              New skill
            </button>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            unstyled
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title / body / tags…"
            className="ml-auto w-56 rounded-full border border-ink/15 bg-white px-3 py-1 text-[12px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
          />
        </div>
      )}

      {loading && <BrainListSkeleton count={3} label="Loading skills…" />}
      {errorMsg && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900">
          Couldn&apos;t load skills: {errorMsg}
        </div>
      )}
      {!loading && !errorMsg && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-ink/10 px-4 py-10 text-center text-[13px] text-inkMuted">
          {rows.length === 0 ? (
            <>
              <p className="mx-auto max-w-md">
                <span className="font-medium text-ink">Skills</span> are short
                write-ups of how your company does a recurring task: refunds,
                onboarding a host, qualifying a lead. Every agent reads them, so
                writing one teaches the whole fleet at once.
              </p>
              {canEditBrain && (
                <button
                  type="button"
                  onClick={startCreate}
                  className="mt-3 inline-flex items-center gap-1 rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-ink/40 hover:bg-bone"
                >
                  <span aria-hidden className="text-[13px] leading-none">+</span>
                  Write your first skill
                </button>
              )}
            </>
          ) : (
            "No skills match this search."
          )}
        </div>
      )}
      {!loading && !errorMsg && filtered.length > 0 && (
        <ul className="space-y-1.5">
          {filtered.map((n) => (
            <li
              key={n.id}
              className="rounded-xl border border-ink/[0.08] bg-white shadow-[0_1px_2px_rgba(25,25,25,0.04)]"
            >
              <button
                type="button"
                onClick={() => setExpanded(expanded === n.id ? null : n.id)}
                aria-expanded={expanded === n.id}
                className="flex w-full items-start gap-3 px-3 py-2 text-left"
              >
                <span className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide bg-[#eef2ef] text-[#2f6f5e]">
                  skill
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {n.title || "(untitled skill)"}
                  </span>
                  <span className="block truncate text-[12px] text-inkMuted">
                    {n.body_markdown.slice(0, 160)}
                  </span>
                </span>
                <span className="hidden font-mono text-[11px] text-inkMuted tabular-nums sm:inline">
                  {new Date(n.updated_at).toLocaleDateString()}
                </span>
                <span aria-hidden className="text-inkMuted">
                  {expanded === n.id ? "▾" : "▸"}
                </span>
              </button>
              {expanded === n.id && (
                <div className="border-t border-ink/10 bg-bone px-3 py-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-inkMuted">
                    <span className="font-mono uppercase tracking-wide">
                      source: {n.source}
                    </span>
                    <span className="font-mono uppercase tracking-wide">
                      added {new Date(n.created_at).toLocaleDateString()}
                    </span>
                    {n.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-bone px-1.5 py-0.5 font-mono text-[11px] text-inkMuted"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  <pre className="mb-3 whitespace-pre-wrap font-sans text-[13px] leading-[1.5] text-ink">
                    {n.body_markdown}
                  </pre>
                  {canEditBrain && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(n)}
                        className="rounded border border-ink/15 bg-white px-2.5 py-1 text-[12px] text-ink hover:bg-bone"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(n.id)}
                        className="rounded border border-rose-300 bg-white px-2.5 py-1 text-[12px] text-rose-700 hover:bg-rose-50"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && rows.length > 0 && (
        <p className="mt-6 text-[11px] text-inkMuted">
          {filtered.length} of {rows.length} shown
          {query && ` · query="${query}"`}
        </p>
      )}
    </>
  );
}

function ViewToggle({
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
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? "bg-white font-semibold text-ink shadow-[0_1px_2px_rgba(25,25,25,0.08)]"
          : "text-inkMuted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function EntitiesSegment() {
  const { activeTabId, setInspectorForTab } = useWorkspace();
  const [rows, setRows] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const tid = useActiveTenant();

  useEffect(() => {
    if (tid === undefined) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    if (tid === null) {
      setRows([]);
      setLoading(false);
      return;
    }
    const sb = createBrowserSupabase();
    scopeToTenant(
      sb
        .from("memory_entity")
        .select("id, entity_type, canonical_name, attrs, first_seen_at, last_seen_at"),
      tid,
    )
      .order("last_seen_at", { ascending: false })
      .limit(500)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setErrorMsg(error.message);
          setLoading(false);
          return;
        }
        setRows((data ?? []) as Entity[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tid]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter && r.entity_type !== typeFilter) return false;
      if (q && !r.canonical_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, typeFilter, query]);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.entity_type, (m.get(r.entity_type) ?? 0) + 1);
    return m;
  }, [rows]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip
          active={typeFilter === null}
          onClick={() => setTypeFilter(null)}
          count={rows.length}
        >
          all
        </FilterChip>
        {KNOWN_ENTITY_TYPES.filter((t) => typeCounts.get(t)).map((t) => (
          <FilterChip
            key={t}
            active={typeFilter === t}
            onClick={() => setTypeFilter(t)}
            count={typeCounts.get(t) ?? 0}
          >
            {t}
          </FilterChip>
        ))}
        <Input
          unstyled
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name…"
          className="ml-auto w-48 rounded-full border border-ink/15 bg-white px-3 py-1 text-[12px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
        />
      </div>

      {loading && <EntitiesListSkeleton />}
      {errorMsg && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900">
          Couldn&apos;t load entities: {errorMsg}
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-ink/10 px-4 py-10 text-center text-[13px] text-inkMuted">
          {rows.length === 0
            ? "The ledger is empty. Entities get extracted as agents run + write to memory."
            : "No entities match this filter."}
        </div>
      )}
      {!loading && filtered.length > 0 && (
        <ul className="space-y-1">
          {filtered.map((e) => (
            <li key={e.id} className="rounded-xl border border-ink/[0.08] bg-white shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
              <button
                type="button"
                onClick={() => {
                  setExpanded(expanded === e.id ? null : e.id);
                  setInspectorForTab(activeTabId, {
                    kind: "entity",
                    entityId: e.id,
                  });
                }}
                aria-expanded={expanded === e.id}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px]"
              >
                <span className="min-w-[80px] font-mono text-[11px] uppercase tracking-wide text-inkMuted">
                  {e.entity_type}
                </span>
                <span className="flex-1 truncate text-ink">
                  {e.canonical_name}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-inkMuted">
                  {new Date(e.last_seen_at).toLocaleDateString()}
                </span>
                <span aria-hidden className="text-inkMuted">
                  {expanded === e.id ? "▾" : "▸"}
                </span>
              </button>
              {expanded === e.id && e.attrs && (
                <div className="border-t border-ink/10 bg-bone px-3 py-2">
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-ink">
                    {JSON.stringify(e.attrs, null, 2)}
                  </pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

type ConflictPair = {
  active_id: string;
  active_title: string;
  active_body: string;
  superseded_id: string;
  superseded_title: string;
  superseded_body: string;
  supersession_rationale: string | null;
  superseded_at: string;
};

type DreamCycleStatus = {
  last_run_at: string | null;
  next_run_at: string;
  schedule_human: string;
};

function formatPast(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

function formatFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "any minute";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "in less than a minute";
  if (m < 60) return `in ${m} ${m === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} ${h === 1 ? "hour" : "hours"}`;
  const d = Math.floor(h / 24);
  return `in ${d} ${d === 1 ? "day" : "days"}`;
}

function ConflictsSegment() {
  const [pairs, setPairs] = useState<ConflictPair[]>([]);
  const [status, setStatus] = useState<DreamCycleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch("/api/memory/notes/conflicts?limit=50")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) {
          setErrorMsg(j.error.message ?? "load failed");
          setLoading(false);
          return;
        }
        setPairs((j.pairs ?? []) as ConflictPair[]);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setErrorMsg((e as Error).message);
          setLoading(false);
        }
      });
    apiFetch("/api/memory/dream-cycle-status")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j && j.status && typeof j.status.next_run_at === "string") {
          setStatus(j.status as DreamCycleStatus);
        }
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const handleUnsupersede = useCallback(async (id: string) => {
    if (!confirm("Restore the older note as active? The newer note stays.")) return;
    try {
      const res = await apiFetch(`/api/memory/notes/${id}/unsupersede`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Un-supersede failed: ${j?.error?.message ?? res.statusText}`);
        return;
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      alert(`Un-supersede failed: ${(e as Error).message}`);
    }
  }, []);

  if (loading) {
    return <ConflictsSkeleton />;
  }
  if (errorMsg) {
    return (
      <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900">
        Couldn&apos;t load conflicts: {errorMsg}
      </div>
    );
  }
  if (pairs.length === 0) {
    const timingLine = status ? (
      <div className="mb-2 text-[12px] text-inkMuted/90">
        The brain checks {status.schedule_human}.{" "}
        <span className="text-ink/70">
          Last check: {status.last_run_at ? formatPast(status.last_run_at) : "hasn’t run yet"} ·
          Next check: {formatFuture(status.next_run_at)}.
        </span>
      </div>
    ) : null;
    return (
      <div className="rounded-md border border-dashed border-ink/10 px-4 py-10 text-center text-[13px] text-inkMuted">
        {timingLine}
        No conflicts. When the nightly dream-cycle finds a new note that
        contradicts an existing one, the older note gets superseded and shows
        up here for review.
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {pairs.map((p) => (
        <li key={p.superseded_id} className="rounded-xl border border-[#f0dca6] bg-[#fffaf0] p-3 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-[#8a5a10]">
            <span aria-hidden>◆</span>
            superseded {new Date(p.superseded_at).toLocaleString()}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-rose-600">
                superseded
              </div>
              <div className="text-[13px] font-medium text-ink line-through">
                {p.superseded_title}
              </div>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-[12px] text-inkMuted">
                {p.superseded_body}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-emerald-600">
                active
              </div>
              <div className="text-[13px] font-medium text-ink">{p.active_title}</div>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-[12px] text-ink">
                {p.active_body}
              </pre>
            </div>
          </div>
          {p.supersession_rationale && (
            <div className="mt-3 rounded bg-white/70 px-2.5 py-1.5 text-[12px] text-[#8a5a10]">
              <span className="font-mono uppercase tracking-wide">rationale:</span>{" "}
              {p.supersession_rationale}
            </div>
          )}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => handleUnsupersede(p.superseded_id)}
              className="rounded-cta border border-[#e6cf94] bg-white px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-[#fff5e3]"
            >
              Restore superseded
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function FilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`
        inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px]
        ${
          active
            ? "bg-ink text-white"
            : "border border-ink/10 bg-white text-ink hover:border-ink/25"
        }
      `}
    >
      {children}
      <span className={active ? "text-ink/30" : "text-inkMuted"}>{count}</span>
    </button>
  );
}

function SegmentTab({
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
      onClick={onClick}
      aria-pressed={active}
      className={`
        h-8 flex-1 rounded-full px-4 text-[16px] font-semibold leading-5 transition-colors
        ${active ? "bg-white text-[#1f1f1f]" : "text-[#454545] hover:text-[#1f1f1f]"}
      `}
    >
      {children}
    </button>
  );
}

function NoteTypeChip({ type }: { type: string }) {
  const colors: Record<string, string> = {
    operator_preference: "bg-[#eef2ef] text-[#2f6f5e]",
    agent_feedback: "bg-[#fbeccb] text-[#8a5a10]",
    tenant_project: "bg-creamDeep text-ink",
    tenant_reference: "bg-emerald-50 text-emerald-700",
    untyped: "bg-bone text-inkMuted",
  };
  const labels: Record<string, string> = {
    operator_preference: "preference",
    agent_feedback: "feedback",
    tenant_project: "project",
    tenant_reference: "reference",
    untyped: "untyped",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide ${
        colors[type] ?? colors.untyped
      }`}
    >
      {labels[type] ?? type}
    </span>
  );
}
