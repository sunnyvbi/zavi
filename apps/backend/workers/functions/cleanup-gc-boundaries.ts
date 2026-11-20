

export const MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS = 90;

export function memorySignalRetentionDays(
  rawEnv: string | number | undefined,
): number {
  const raw = Number(rawEnv ?? MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function retentionCutoffIso(
  retentionDays: number,
  now: number = Date.now(),
): string {
  return new Date(now - retentionDays * MS_PER_DAY).toISOString();
}

export interface GcCandidateRow {
  created_at: string;
  distilled_at: string | null;
}

export function isMemorySignalGcEligible(
  row: GcCandidateRow,
  cutoffIso: string,
): boolean {
  if (row.distilled_at === null || row.distilled_at === undefined) return false;
  return row.created_at < cutoffIso;
}

export const SYNTHETIC_THREADS_BATCH_SIZE = 1000;
export const SYNTHETIC_THREADS_MAX_BATCHES_PER_RUN = 50;
export const SYNTHETIC_THREADS_RETENTION_DAYS = 30;

export function syntheticThreadsMaxRowsPerRun(): number {
  return SYNTHETIC_THREADS_BATCH_SIZE * SYNTHETIC_THREADS_MAX_BATCHES_PER_RUN;
}

export function shouldContinueBatchLoop(args: {
  batchesDone: number;
  lastBatchSize: number;
  maxBatches?: number;
  batchSize?: number;
}): boolean {
  const maxBatches = args.maxBatches ?? SYNTHETIC_THREADS_MAX_BATCHES_PER_RUN;
  const batchSize = args.batchSize ?? SYNTHETIC_THREADS_BATCH_SIZE;
  if (args.batchesDone >= maxBatches) return false;
  if (args.lastBatchSize === 0) return false;
  if (args.lastBatchSize < batchSize) return false;
  return true;
}

export const CHAT_IMAGE_RETENTION_DAYS = 30;
export const CHAT_IMAGE_BATCH_SIZE = 100;

export const STALE_NOTE_ARCHIVE_DEFAULT_TTL_DAYS = 180;

export const STALE_NOTE_ARCHIVE_BATCH_SIZE = 500;
export const STALE_NOTE_ARCHIVE_MAX_BATCHES_PER_RUN = 20;

export const STALE_NOTE_ARCHIVE_PROTECTED_NOTE_TYPES: readonly string[] = [
  "anchor",
  "operator_preference",
  "correction",
];

export function staleNoteArchiveTtlDays(
  rawEnv: string | number | undefined,
): number {
  const raw = Number(rawEnv ?? STALE_NOTE_ARCHIVE_DEFAULT_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : STALE_NOTE_ARCHIVE_DEFAULT_TTL_DAYS;
}

export function staleNoteArchiveMaxRowsPerRun(): number {
  return STALE_NOTE_ARCHIVE_BATCH_SIZE * STALE_NOTE_ARCHIVE_MAX_BATCHES_PER_RUN;
}

export interface StaleNoteArchiveCandidateRow {
  updated_at: string;
  trust_tier: number | null;
  note_type: string | null;
  slug: string | null;
  superseded_by: string | null;
  archived_at: string | null;
  inbound_take_count: number;
  inbound_relation_count: number;
}

export function isStaleNoteArchiveEligible(
  row: StaleNoteArchiveCandidateRow,
  cutoffIso: string,
): boolean {
  if (row.archived_at !== null && row.archived_at !== undefined) return false;
  if (row.superseded_by !== null && row.superseded_by !== undefined) return false;
  if (row.slug !== null && row.slug !== undefined) return false;
  if (row.note_type === null || row.note_type === undefined) return false;
  if (STALE_NOTE_ARCHIVE_PROTECTED_NOTE_TYPES.includes(row.note_type)) return false;
  if (row.trust_tier === null || row.trust_tier === undefined) return false;
  if (row.trust_tier < 2) return false;
  if (row.inbound_take_count > 0) return false;
  if (row.inbound_relation_count > 0) return false;
  return row.updated_at < cutoffIso;
}

export const LAUNCH_VIDEO_PUBLIC_RETENTION_DAYS = 30;
export const LAUNCH_VIDEO_PUBLIC_REAP_BATCH_SIZE = 200;

export const LAUNCH_VIDEO_PUBLIC_REAPABLE_STATUSES: readonly string[] = [
  "queued",
  "rendering",
  "ready",
  "failed",
];

export interface LaunchVideoPublicReapCandidate {
  created_at: string;
  status: string | null;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  tenant_kind: string | null;
}

export function isLaunchVideoPublicJobReapEligible(
  row: LaunchVideoPublicReapCandidate,
  cutoffIso: string,
): boolean {
  if (row.status === null || row.status === undefined) return false;
  if (!LAUNCH_VIDEO_PUBLIC_REAPABLE_STATUSES.includes(row.status)) return false;
  if (row.claimed_by_user_id !== null && row.claimed_by_user_id !== undefined) return false;
  if (row.claimed_at !== null && row.claimed_at !== undefined) return false;
  if (row.tenant_kind !== "launch_video_shell") return false;
  return row.created_at < cutoffIso;
}

export interface LaunchVideoShellTenantCandidate {
  created_at: string | null;
  kind: string | null;
  job_count: number;
  member_count: number;
}

export function isLaunchVideoShellTenantReapEligible(
  row: LaunchVideoShellTenantCandidate,
  cutoffIso: string,
): boolean {
  if (row.kind !== "launch_video_shell") return false;
  if (row.job_count > 0) return false;
  if (row.member_count > 0) return false;
  if (!row.created_at) return false;
  return row.created_at < cutoffIso;
}
