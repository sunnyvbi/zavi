
import { z } from "zod";
import { listNotes, PRIVATE_NOTE_TYPE_SET } from "@/services/memory";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import type { ToolSpec } from "@/services/tools/types";

export async function isAgenticReadEnabledForTenant(tenant_id: string): Promise<boolean> {
  return getBoolSetting("memory_agentic_read_enabled", tenant_id);
}

const MAX_NOTES_PER_TOPIC = 25;
const MAX_TOPICS = 60;
const MAX_TOTAL_ENTRIES = 400;
const SALIENCE_TOP = 40;
const OWN_EPISODIC_LIMIT = 25;
const MAX_TITLE_CHARS = 200;
const MAX_TOPIC_CHARS = 120;

const AGENT_EXPERIENCE = "agent_experience";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function episodicVisible(
  note_type: string,
  note_agent_slug: string | null,
  ctx_agent_slug: string | null | undefined,
): boolean {
  if (!PRIVATE_NOTE_TYPE_SET.has(note_type)) return true;
  return ctx_agent_slug != null && note_agent_slug === ctx_agent_slug;
}

type Candidate = {
  id: string;
  title: string;
  created_at: string;
  note_type: string;
  tags: string[];
  agent_slug: string | null;
  pinned: boolean;
};

type RawNoteRow = {
  id: string;
  title: string | null;
  created_at: string | null;
  note_type: string | null;
  tags: string[] | null;
  slug: string | null;
  agent_slug: string | null;
  superseded_by: string | null;
};

function toCandidate(r: RawNoteRow, pinned: boolean): Candidate {
  return {
    id: r.id,
    title: r.title ?? "(untitled)",
    created_at: r.created_at ?? "",
    note_type: r.note_type ?? "untyped",
    tags: Array.isArray(r.tags) ? r.tags : [],
    agent_slug: r.agent_slug ?? null,
    pinned,
  };
}

const CANDIDATE_COLS = "id, title, created_at, note_type, tags, slug, agent_slug, superseded_by";

async function fetchAnchorCandidates(tenant_id: string): Promise<Candidate[]> {
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select(CANDIDATE_COLS)
    .eq("tenant_id", tenant_id)
    .eq("note_type", "anchor")
    .neq("source", "agent_discovery_inferred")
    .is("superseded_by", null)
    .is("archived_at", null);
  if (error) throw new Error(`list_topics anchors read failed: ${error.message}`);
  return ((data ?? []) as RawNoteRow[])
    .filter((r) => r.note_type === "anchor" && !r.superseded_by)
    .map((r) => toCandidate(r, true));
}

async function topReferencedNoteIds(tenant_id: string): Promise<string[]> {
  const sb = serviceClient();
  const counts = new Map<string, number>();

  const { data: takeRows, error: e1 } = await sb
    .from("takes")
    .select("source_note_id")
    .eq("tenant_id", tenant_id);
  if (!e1) {
    for (const r of (takeRows ?? []) as Array<{ source_note_id: string | null }>) {
      if (r.source_note_id) counts.set(r.source_note_id, (counts.get(r.source_note_id) ?? 0) + 1);
    }
  }

  const { data: relRows, error: e2 } = await sb
    .from("memory_relation")
    .select("source_note_id")
    .eq("tenant_id", tenant_id);
  if (!e2) {
    for (const r of (relRows ?? []) as Array<{ source_note_id: string | null }>) {
      if (r.source_note_id) counts.set(r.source_note_id, (counts.get(r.source_note_id) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SALIENCE_TOP)
    .map(([id]) => id);
}

async function fetchSalientCandidates(
  tenant_id: string,
  ids: string[],
  ctx_agent_slug: string | null | undefined,
): Promise<Candidate[]> {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select(CANDIDATE_COLS)
    .eq("tenant_id", tenant_id)
    .in("id", ids)
    .neq("source", "agent_discovery_inferred")
    .is("superseded_by", null)
    .is("archived_at", null);
  if (error) throw new Error(`list_topics salient-note read failed: ${error.message}`);
  return ((data ?? []) as RawNoteRow[])
    .filter(
      (r) =>
        idSet.has(r.id) &&
        !r.superseded_by &&
        episodicVisible(r.note_type ?? "untyped", r.agent_slug ?? null, ctx_agent_slug),
    )
    .map((r) => toCandidate(r, true));
}

async function fetchOwnEpisodicCandidates(
  tenant_id: string,
  ctx_agent_slug: string | null | undefined,
  tag: string | undefined,
): Promise<Candidate[]> {
  if (!ctx_agent_slug) return [];
  let q = serviceClient()
    .from("memory_note")
    .select(CANDIDATE_COLS)
    .eq("tenant_id", tenant_id)
    .eq("note_type", AGENT_EXPERIENCE)
    .eq("agent_slug", ctx_agent_slug)
    .is("superseded_by", null)
    .is("archived_at", null);
  if (tag) q = q.contains("tags", [tag]);
  q = q.order("updated_at", { ascending: false }).limit(OWN_EPISODIC_LIMIT);
  const { data, error } = await q;
  if (error) throw new Error(`list_topics own-episodic read failed: ${error.message}`);
  return ((data ?? []) as RawNoteRow[])
    .filter(
      (r) =>
        r.note_type === AGENT_EXPERIENCE && r.agent_slug === ctx_agent_slug && !r.superseded_by,
    )
    .map((r) => toCandidate(r, false));
}

const listTopicsInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe("Max RECENT notes to scan when building the topic map (most-recently-updated first). Anchors + high-salience old notes are always included on top of this."),
  tag: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional: restrict the listing to notes carrying this exact tag."),
});

type TopicEntry = { note_id: string; title: string; created_at: string; note_type: string };
type TopicBucket = { topic: string; count: number; notes: TopicEntry[]; pinned: boolean };

export const memoryListTopicsTool: ToolSpec = {
  name: "memory_list_topics",
  effect: "read",
  description:
    "List the tenant's memory TOPICS — a compact map of the company brain's note clusters (grouped by tag, falling back to note_type for untagged notes). Returns {topics:[{topic, count, notes:[{note_id, title, created_at, note_type}]}]} — TITLES + IDS ONLY, never bodies. READ TOOL, call freely. Use this FIRST to decide which notes are worth pulling, then call memory_read with the note_ids you want. Recall is NOT capped by top-k search ranking here — the map deliberately surfaces important OLD notes (canonical anchors + the most-referenced notes), not just recent ones, so you choose what to load. Superseded/retired notes are excluded; another agent's private episodic memory is never shown.",
  input_schema: listTopicsInput,
  async execute(ctx, input: unknown) {
    const args = listTopicsInput.parse(input);
    const tenant_id = ctx.tenant_id;
    const ctxAgent = ctx.agent_slug ?? null;

    const [anchors, recentRaw, salientIds, ownEpisodic] = await Promise.all([
      fetchAnchorCandidates(tenant_id),
      listNotes(tenant_id, { limit: args.limit, tag: args.tag }),
      topReferencedNoteIds(tenant_id),
      fetchOwnEpisodicCandidates(tenant_id, ctxAgent, args.tag),
    ]);
    const recent: Candidate[] = recentRaw
      .filter((n) => !PRIVATE_NOTE_TYPE_SET.has(n.note_type))
      .map((n) =>
        toCandidate(
          {
            id: n.id,
            title: n.title,
            created_at: n.created_at,
            note_type: n.note_type,
            tags: n.tags,
            slug: n.slug,
            agent_slug: null,
            superseded_by: null,
          },
          false,
        ),
      );
    const salient = await fetchSalientCandidates(tenant_id, salientIds, ctxAgent);

    const byId = new Map<string, Candidate>();
    for (const c of [...anchors, ...salient, ...ownEpisodic, ...recent]) {
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
    let candidates = [...byId.values()];

    if (args.tag) {
      candidates = candidates.filter((c) => c.tags.includes(args.tag as string));
    }

    const byTopic = new Map<string, TopicBucket>();
    let totalEntries = 0;
    for (const c of candidates) {
      const topics = c.tags.length > 0 ? c.tags : [`(${c.note_type})`];
      for (const t of topics) {
        let bucket = byTopic.get(t);
        if (!bucket) {
          bucket = { topic: t, count: 0, notes: [], pinned: false };
          byTopic.set(t, bucket);
        }
        bucket.count += 1;
        if (c.pinned) bucket.pinned = true;
        if (bucket.notes.length < MAX_NOTES_PER_TOPIC && totalEntries < MAX_TOTAL_ENTRIES) {
          bucket.notes.push({
            note_id: c.id,
            title: truncate(c.title, MAX_TITLE_CHARS),
            created_at: c.created_at,
            note_type: c.note_type,
          });
          totalEntries += 1;
        }
      }
    }

    const all = [...byTopic.values()];
    const pinned = all.filter((t) => t.pinned).sort((a, b) => b.count - a.count);
    const rest = all.filter((t) => !t.pinned).sort((a, b) => b.count - a.count);
    const kept = [...pinned, ...rest].slice(0, Math.max(MAX_TOPICS, pinned.length));

    const topics = kept.map((t) => ({
      topic: truncate(t.topic, MAX_TOPIC_CHARS),
      count: t.count,
      notes: t.notes,
    }));

    return { topics, scanned: candidates.length };
  },
};

const MAX_READ_IDS = 20;
const MAX_BODY_CHARS_PER_NOTE = 20_000;
const MAX_TOTAL_BODY_CHARS = 120_000;
const TRUNCATION_MARKER = "\n…[truncated]";

const readInput = z.object({
  note_ids: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_READ_IDS)
    .describe(`Note ids (from memory_list_topics or memory_search) whose full bodies to fetch. Max ${MAX_READ_IDS} per call.`),
});

type ReadRow = {
  id: string;
  title: string;
  body_markdown: string;
  note_type: string;
  created_at: string;
  agent_slug: string | null;
  superseded_by: string | null;
  archived_at: string | null;
};

export const memoryReadTool: ToolSpec = {
  name: "memory_read",
  effect: "read",
  description:
    "Read the full BODIES of specific memory notes by id (ids come from memory_list_topics or memory_search). Returns {notes:[{note_id, title, body_markdown, note_type, created_at}], not_found:[...ids], superseded:[{note_id, reason}]}. READ TOOL. Superseded notes (overwritten by a newer fact) are NOT returned as bodies — they appear in `superseded` so you never act on a stale version. Ids not found for this tenant (bad id, another tenant's note, or another agent's private episodic note) appear in `not_found`. Bodies are size-capped; long notes may be truncated.",
  input_schema: readInput,
  async execute(ctx, input: unknown) {
    const args = readInput.parse(input);
    const tenant_id = ctx.tenant_id;
    const ctxAgent = ctx.agent_slug ?? null;
    const requested = Array.from(new Set(args.note_ids)).slice(0, MAX_READ_IDS);

    const { data, error } = await serviceClient()
      .from("memory_note")
      .select(
        "id, title, body_markdown, note_type, created_at, agent_slug, superseded_by, archived_at",
      )
      .eq("tenant_id", tenant_id)
      .neq("source", "agent_discovery_inferred")
      .in("id", requested);
    if (error) throw new Error(`memory_read failed: ${error.message}`);

    const rows = (data ?? []) as ReadRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    const notes: Array<{
      note_id: string;
      title: string;
      body_markdown: string;
      note_type: string;
      created_at: string;
    }> = [];
    const not_found: string[] = [];
    const superseded: Array<{ note_id: string; reason: string }> = [];

    let budget = MAX_TOTAL_BODY_CHARS;
    for (const id of requested) {
      const row = byId.get(id);
      if (!row) {
        not_found.push(id);
        continue;
      }
      if (!episodicVisible(row.note_type, row.agent_slug, ctxAgent)) {
        not_found.push(id);
        continue;
      }
      if (row.superseded_by) {
        superseded.push({ note_id: id, reason: "superseded" });
        continue;
      }
      if (row.archived_at) {
        superseded.push({ note_id: id, reason: "superseded" });
        continue;
      }
      let body = row.body_markdown ?? "";
      const remaining = Math.max(0, budget);
      if (body.length > remaining || body.length > MAX_BODY_CHARS_PER_NOTE) {
        const cap = Math.min(MAX_BODY_CHARS_PER_NOTE, remaining);
        body =
          cap <= TRUNCATION_MARKER.length
            ? ""
            : body.slice(0, cap - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
      }
      budget -= body.length;
      notes.push({
        note_id: row.id,
        title: truncate(row.title ?? "(untitled)", MAX_TITLE_CHARS),
        body_markdown: body,
        note_type: row.note_type,
        created_at: row.created_at,
      });
    }

    return { notes, not_found, superseded };
  },
};

export const agenticReadTools: ToolSpec[] = [memoryListTopicsTool, memoryReadTool];
