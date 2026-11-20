"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";

export type PriorityKind =
  | "conflict"
  | "pending_decision"
  | "agent_feedback"
  | "stale_anchor"
  | "untyped_pile";

export type PriorityItem = {
  rank: number;
  kind: PriorityKind;
  refId: string;
  anchorSlug: string | null;
  graphNodeId: string | null;
  title: string;
  reason: string;
  actionLabel: string;
  score: number;
};

const STALE_DAYS = 14;

type DecisionRow = {
  id: string;
  decision_class: string;
  body: Record<string, unknown> | null;
  emitted_at: string;
};

type NoteRow = {
  id: string;
  title: string;
  body_markdown: string;
  note_type: string;
  tags: string[];
  slug: string | null;
  superseded_by: string | null;
  updated_at: string;
};

export function useBrainPriority(anchorSlugByNoteId: Map<string, string>): {
  items: PriorityItem[];
  loading: boolean;
  refresh: () => void;
} {
  const [items, setItems] = useState<PriorityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const slugByIdJson = useMemo(
    () => JSON.stringify(Array.from(anchorSlugByNoteId.entries())),
    [anchorSlugByNoteId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const sb = createBrowserSupabase();
    const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const sinceStale = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();

    void getActiveTenantId(sb).then((tenantId) => {
      if (cancelled) return;
      if (!tenantId) {
        setLoading(false);
        return;
      }
      return Promise.all([
      sb
        .from("memory_note")
        .select("id, title, body_markdown, note_type, tags, slug, superseded_by, updated_at")
        .eq("tenant_id", tenantId)
        .not("superseded_by", "is", null)
        .gte("updated_at", since30d)
        .order("updated_at", { ascending: false })
        .limit(10),
      sb
        .from("decisions")
        .select("id, decision_class, body, emitted_at")
        .eq("tenant_id", tenantId)
        .eq("status", "proposed")
        .order("emitted_at", { ascending: false })
        .limit(10),
      sb
        .from("memory_note")
        .select("id, title, body_markdown, note_type, tags, slug, superseded_by, updated_at")
        .eq("tenant_id", tenantId)
        .eq("note_type", "agent_feedback")
        .gte("updated_at", since7d)
        .order("updated_at", { ascending: false })
        .limit(10),
      sb
        .from("memory_note")
        .select("id, title, body_markdown, note_type, tags, slug, superseded_by, updated_at")
        .eq("tenant_id", tenantId)
        .eq("note_type", "anchor")
        .lt("updated_at", sinceStale)
        .not("slug", "is", null)
        .order("updated_at", { ascending: true })
        .limit(10),
      sb
        .from("memory_note")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("note_type", "untyped"),
    ]).then(([conflictsRes, decisionsRes, feedbackRes, staleRes, untypedRes]) => {
      if (cancelled) return;
      const slugByNoteId = new Map<string, string>(
        JSON.parse(slugByIdJson) as [string, string][],
      );

      const candidates: PriorityItem[] = [];

      const conflictByEntity = new Map<string, PriorityItem>();
      for (const row of (conflictsRes.data ?? []) as NoteRow[]) {
        const ageDays = daysSince(row.updated_at);
        const recencyBonus = Math.max(0, 10 - ageDays);
        const anchorSlug = slugByNoteId.get(row.id) ?? null;
        const item: PriorityItem = {
          rank: 0,
          kind: "conflict",
          refId: row.id,
          anchorSlug,
          graphNodeId: `n:${row.id}`,
          title: row.title || "(untitled conflict)",
          reason: "Newer note contradicts this one. Pick which stays.",
          actionLabel: "Resolve",
          score: 100 + recencyBonus,
        };
        const entityKey = anchorSlug ?? (row.title || row.id).trim().toLowerCase();
        const existing = conflictByEntity.get(entityKey);
        if (!existing || item.score > existing.score) {
          conflictByEntity.set(entityKey, item);
        }
      }
      for (const item of conflictByEntity.values()) candidates.push(item);

      for (const row of (decisionsRes.data ?? []) as DecisionRow[]) {
        const bodyAgent =
          (row.body?.target_agent_slug as string | undefined) ?? row.decision_class;
        const isRule =
          row.decision_class === "proposed_rule" ||
          row.decision_class === "proposed_global_rule";
        candidates.push({
          rank: 0,
          kind: "pending_decision",
          refId: row.id,
          anchorSlug: null,
          graphNodeId: null,
          title: `${bodyAgent} proposes ${row.decision_class.replace(/_/g, " ")}`,
          reason:
            (row.body?.rule_body_markdown as string | undefined)?.slice(0, 110) ??
            "Awaiting your approval in the inbox.",
          actionLabel: "Approve / reject",
          score: 90 + (isRule ? 10 : 0),
        });
      }

      for (const row of (feedbackRes.data ?? []) as NoteRow[]) {
        const ageDays = daysSince(row.updated_at);
        const recencyBonus = Math.max(0, 10 - ageDays);
        candidates.push({
          rank: 0,
          kind: "agent_feedback",
          refId: row.id,
          anchorSlug: slugByNoteId.get(row.id) ?? null,
          graphNodeId: `n:${row.id}`,
          title: row.title || row.body_markdown.slice(0, 60),
          reason: "Agent pushed back on a recent run. Read + act.",
          actionLabel: "Read",
          score: 70 + recencyBonus,
        });
      }

      for (const row of (staleRes.data ?? []) as NoteRow[]) {
        const ageDays = daysSince(row.updated_at);
        const stalenessBonus = Math.min(20, Math.max(0, ageDays - STALE_DAYS));
        candidates.push({
          rank: 0,
          kind: "stale_anchor",
          refId: row.id,
          anchorSlug: row.slug,
          graphNodeId: `a:${row.id}`,
          title: `${row.slug}.md stale ${ageDays}d`,
          reason: "Anchors get read on every run. Refresh while context is fresh.",
          actionLabel: "Edit",
          score: 50 + stalenessBonus,
        });
      }

      const untypedCount = untypedRes.count ?? 0;
      if (untypedCount > 10) {
        candidates.push({
          rank: 0,
          kind: "untyped_pile",
          refId: "untyped",
          anchorSlug: null,
          graphNodeId: null,
          title: `${untypedCount} untyped notes pile up`,
          reason: "Agents skip untyped. Categorize so they get used.",
          actionLabel: "Categorize",
          score: 30 + Math.min(20, untypedCount - 10),
        });
      }

      setItems(rankWithDepartmentSpread(candidates));
      setLoading(false);
      });
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [reloadKey, slugByIdJson]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  return { items, loading, refresh };
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

function rankWithDepartmentSpread(candidates: PriorityItem[]): PriorityItem[] {
  const remaining = [...candidates].sort((a, b) => b.score - a.score);
  const chosen: PriorityItem[] = [];
  const seenSlugs = new Set<string>();
  while (chosen.length < 5 && remaining.length > 0) {
    let bestIdx = 0;
    let bestAdj = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const c = remaining[i];
      const penalty =
        c.anchorSlug && seenSlugs.has(c.anchorSlug) ? c.score * 0.12 : 0;
      const adj = c.score - penalty;
      if (adj > bestAdj) {
        bestAdj = adj;
        bestIdx = i;
      }
    }
    const pick = remaining.splice(bestIdx, 1)[0];
    chosen.push({ ...pick, rank: chosen.length + 1 });
    if (pick.anchorSlug) seenSlugs.add(pick.anchorSlug);
  }
  return chosen;
}
