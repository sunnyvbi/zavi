
import { serviceClient } from "@/services/supabase";
import { PRIVATE_NOTE_TYPES, searchMemory } from "./index";

export const MEMORY_SLUGS = [
  "company",
  "ops",
  "policies",
  "disputes",
  "support",
] as const;

export type MemoryDocSlug = (typeof MEMORY_SLUGS)[number];

export type MemoryDocs = Record<MemoryDocSlug, string>;

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_SLUG_RE = /^[a-z0-9_-]{1,48}$/;

export class InvalidSlugError extends Error {
  constructor(kind: string, value: string) {
    super(
      `Invalid ${kind}: ${JSON.stringify(value)}. Must match ${
        kind === "tenant_id" ? TENANT_UUID_RE.source : AGENT_SLUG_RE.source
      }`,
    );
    this.name = "InvalidSlugError";
  }
}

export function assertValidTenantId(s: string): void {
  if (typeof s !== "string" || !TENANT_UUID_RE.test(s)) {
    throw new InvalidSlugError("tenant_id", s);
  }
}

export function assertValidAgentSlug(s: string): void {
  if (typeof s !== "string" || !AGENT_SLUG_RE.test(s)) {
    throw new InvalidSlugError("agent slug", s);
  }
}

export async function loadMemoryDocs(tenant_id: string): Promise<MemoryDocs> {
  assertValidTenantId(tenant_id);
  const out: MemoryDocs = {
    company: "",
    ops: "",
    policies: "",
    disputes: "",
    support: "",
  };
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("slug, body_markdown")
    .eq("tenant_id", tenant_id)
    .in("slug", MEMORY_SLUGS as unknown as string[])
    .neq("source", "agent_discovery_inferred")
    .is("superseded_by", null)
    .is("archived_at", null);
  if (error) {
    throw new Error(`memory_note anchor read failed for tenant ${tenant_id}: ${error.message}`);
  }
  for (const row of data ?? []) {
    const slug = (row as { slug: string | null }).slug;
    if (slug && (MEMORY_SLUGS as readonly string[]).includes(slug)) {
      out[slug as MemoryDocSlug] = (row as { body_markdown: string }).body_markdown ?? "";
    }
  }
  return out;
}

export async function loadAgentEpisodic(
  tenant_id: string,
  agent_slug: string,
  limit: number = 20,
): Promise<string> {
  assertValidTenantId(tenant_id);
  assertValidAgentSlug(agent_slug);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("title, body_markdown, created_at")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", agent_slug)
    .in("note_type", PRIVATE_NOTE_TYPES as unknown as string[])
    .is("superseded_by", null)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  if (error) {
    throw new Error(
      `agent_experience read failed for tenant=${tenant_id} agent_slug=${agent_slug}: ${error.message}`,
    );
  }
  const rows = (data ?? []) as Array<{
    title: string | null;
    body_markdown: string | null;
    created_at: string | null;
  }>;
  return renderEpisodicRows(rows);
}

type EpisodicRow = {
  id?: string;
  title: string | null;
  body_markdown: string | null;
  created_at: string | null;
};

function renderEpisodicRows(rows: EpisodicRow[]): string {
  if (rows.length === 0) return "";
  return rows
    .map((r, i) => {
      const heading = `### ${i + 1}. ${r.title || "(untitled)"}${r.created_at ? ` — ${r.created_at}` : ""}`;
      const body = (r.body_markdown ?? "").trim();
      return `${heading}\n${body}`;
    })
    .join("\n\n");
}

export type EpisodicSearchFn = (
  tenant_id: string,
  query: string,
  k: number,
  ctx: { agent_slug: string; run_id?: string | null; deadline_at?: number | null },
) => Promise<Array<{ note_id: string; note_type?: string | null; agent_slug?: string | null }>>;

const EPISODIC_SEARCH_OVERFETCH = 40;
const EPISODIC_SEARCH_TIMEOUT_MS = 5000;

export async function loadAgentEpisodicRelevant(
  tenant_id: string,
  agent_slug: string,
  taskText: string,
  opts: { k?: number; run_id?: string | null; search?: EpisodicSearchFn } = {},
): Promise<string> {
  assertValidTenantId(tenant_id);
  assertValidAgentSlug(agent_slug);
  const k = Math.max(1, Math.min(20, Math.floor(opts.k ?? 5)));
  const privateTypes = PRIVATE_NOTE_TYPES as unknown as string[];

  let rankedIds: string[] = [];
  const query = taskText.trim().slice(0, 2000);
  if (query.length > 0) {
    try {
      const search: EpisodicSearchFn = opts.search ?? searchMemory;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hits = await Promise.race([
        search(tenant_id, query, EPISODIC_SEARCH_OVERFETCH, {
          agent_slug,
          run_id: opts.run_id ?? null,
          deadline_at: Date.now() + EPISODIC_SEARCH_TIMEOUT_MS - 1000,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("episodic search timed out")),
            EPISODIC_SEARCH_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      for (const h of hits) {
        if (
          h.agent_slug === agent_slug &&
          typeof h.note_type === "string" &&
          privateTypes.includes(h.note_type) &&
          !rankedIds.includes(h.note_id)
        ) {
          rankedIds.push(h.note_id);
        }
      }
    } catch (e) {
      console.warn(
        `[loadAgentEpisodicRelevant] search failed, using recency for tenant=${tenant_id} agent_slug=${agent_slug}: ${(e as Error).message}`,
      );
      rankedIds = [];
    }
  }

  const picked: EpisodicRow[] = [];
  if (rankedIds.length > 0) {
    const { data, error } = await serviceClient()
      .from("memory_note")
      .select("id, title, body_markdown, created_at")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", agent_slug)
      .in("note_type", privateTypes)
      .is("superseded_by", null)
      .is("archived_at", null)
      .in("id", rankedIds.slice(0, EPISODIC_SEARCH_OVERFETCH));
    if (error) {
      console.warn(
        `[loadAgentEpisodicRelevant] ranked read failed, using recency for tenant=${tenant_id} agent_slug=${agent_slug}: ${error.message}`,
      );
    } else {
      const byId = new Map(((data ?? []) as EpisodicRow[]).map((r) => [r.id, r]));
      for (const id of rankedIds) {
        const row = byId.get(id);
        if (row) picked.push(row);
        if (picked.length >= k) break;
      }
    }
  }

  if (picked.length < k) {
    const { data, error } = await serviceClient()
      .from("memory_note")
      .select("id, title, body_markdown, created_at")
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", agent_slug)
      .in("note_type", privateTypes)
      .is("superseded_by", null)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(k + picked.length);
    if (error) {
      throw new Error(
        `agent_experience read failed for tenant=${tenant_id} agent_slug=${agent_slug}: ${error.message}`,
      );
    }
    const have = new Set(picked.map((r) => r.id));
    for (const row of (data ?? []) as EpisodicRow[]) {
      if (picked.length >= k) break;
      if (!have.has(row.id)) picked.push(row);
    }
  }
  return renderEpisodicRows(picked);
}
