
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import {
  isStaleNoteArchiveEligible,
  staleNoteArchiveTtlDays,
  staleNoteArchiveMaxRowsPerRun,
  retentionCutoffIso,
  STALE_NOTE_ARCHIVE_PROTECTED_NOTE_TYPES,
  type StaleNoteArchiveCandidateRow,
} from "./cleanup-gc-boundaries";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const SALIENCE_LOOKUP_CHUNK = 500;
const ARCHIVE_UPDATE_CHUNK = 200;

type CandidateRow = StaleNoteArchiveCandidateRow & { id: string };

export async function archiveStaleNotesForTenant(tenant_id: string): Promise<{
  enabled: boolean;
  scanned: number;
  archived: number;
}> {
  const enabled = await getBoolSetting("memory_stale_archive_enabled", tenant_id);
  if (!enabled) return { enabled: false, scanned: 0, archived: 0 };

  const sb = serviceClient();
  const cutoff = retentionCutoffIso(
    staleNoteArchiveTtlDays(process.env.PRAXIS_MEMORY_STALE_ARCHIVE_TTL_DAYS),
  );

  const { data: rows, error } = await sb
    .from("memory_note")
    .select("id, updated_at, trust_tier, note_type, slug, superseded_by, archived_at")
    .eq("tenant_id", tenant_id)
    .is("archived_at", null)
    .is("superseded_by", null)
    .is("slug", null)
    .not("note_type", "is", null)
    .not(
      "note_type",
      "in",
      `(${STALE_NOTE_ARCHIVE_PROTECTED_NOTE_TYPES.join(",")})`,
    )
    .gte("trust_tier", 2)
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(staleNoteArchiveMaxRowsPerRun());

  if (error) {
    console.warn(`[memory-stale-note-archive] candidate scan failed for ${tenant_id}: ${error.message}`);
    return { enabled: true, scanned: 0, archived: 0 };
  }

  const candidates = (rows ?? []) as Array<{
    id: string;
    updated_at: string;
    trust_tier: number | null;
    note_type: string | null;
    slug: string | null;
    superseded_by: string | null;
    archived_at: string | null;
  }>;
  if (candidates.length === 0) return { enabled: true, scanned: 0, archived: 0 };

  const ids = candidates.map((c) => c.id);

  const referenced = new Set<string>();
  for (const idChunk of chunk(ids, SALIENCE_LOOKUP_CHUNK)) {
    const [{ data: takeRows }, { data: relRows }] = await Promise.all([
      sb.from("takes").select("source_note_id").eq("tenant_id", tenant_id).in("source_note_id", idChunk),
      sb
        .from("memory_relation")
        .select("source_note_id")
        .eq("tenant_id", tenant_id)
        .in("source_note_id", idChunk),
    ]);
    for (const r of (takeRows ?? []) as Array<{ source_note_id: string | null }>) {
      if (r.source_note_id) referenced.add(r.source_note_id);
    }
    for (const r of (relRows ?? []) as Array<{ source_note_id: string | null }>) {
      if (r.source_note_id) referenced.add(r.source_note_id);
    }
  }

  const eligibleIds: string[] = [];
  for (const c of candidates) {
    const row: CandidateRow = {
      id: c.id,
      updated_at: c.updated_at,
      trust_tier: c.trust_tier,
      note_type: c.note_type,
      slug: c.slug,
      superseded_by: c.superseded_by,
      archived_at: c.archived_at,
      inbound_take_count: referenced.has(c.id) ? 1 : 0,
      inbound_relation_count: referenced.has(c.id) ? 1 : 0,
    };
    if (isStaleNoteArchiveEligible(row, cutoff)) eligibleIds.push(c.id);
  }

  const archivedAt = new Date().toISOString();
  let archived = 0;
  for (const idChunk of chunk(eligibleIds, ARCHIVE_UPDATE_CHUNK)) {
    const { data: updated, error: upErr } = await sb
      .from("memory_note")
      .update({ archived_at: archivedAt })
      .eq("tenant_id", tenant_id)
      .is("archived_at", null)
      .in("id", idChunk)
      .select("id");
    if (upErr) {
      console.warn(`[memory-stale-note-archive] archive failed for ${tenant_id}: ${upErr.message}`);
      continue;
    }
    archived += (updated ?? []).length;
  }

  if (archived > 0) {
    console.info(
      `[memory-stale-note-archive] tenant=${tenant_id} archived=${archived} (scanned=${candidates.length}, sample=${eligibleIds.slice(0, 10).join(",")})`,
    );
  }
  return { enabled: true, scanned: candidates.length, archived };
}

export const memoryStaleNoteArchiveFn = inngest.createFunction(
  { id: "memory-stale-note-archive", concurrency: 1 },
  { cron: "0 5 * * *" },
  async ({ logger }) => {
    if (process.env.PRAXIS_MEMORY_STALE_ARCHIVE === "0") {
      logger.info("memory-stale-note-archive: kill switch set, skipping");
      return { tenants: 0, enabled_tenants: 0, scanned: 0, archived: 0 };
    }
    const { data: tenants, error } = await serviceClient().from("tenants").select("id");
    if (error) throw new Error(`tenants scan failed: ${error.message}`);
    const ids = (tenants ?? []).map((t) => t.id as string);
    let enabledTenants = 0;
    let scanned = 0;
    let archived = 0;
    for (const tid of ids) {
      try {
        const r = await archiveStaleNotesForTenant(tid);
        if (r.enabled) enabledTenants += 1;
        scanned += r.scanned;
        archived += r.archived;
      } catch (e) {
        logger.warn(`memory-stale-note-archive tenant ${tid} failed: ${(e as Error).message}`);
      }
    }
    logger.info(
      `memory-stale-note-archive: tenants=${ids.length} enabled=${enabledTenants} scanned=${scanned} archived=${archived}`,
    );
    return { tenants: ids.length, enabled_tenants: enabledTenants, scanned, archived };
  },
);
