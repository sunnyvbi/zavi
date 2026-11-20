import { describe, it, expect } from "vitest";
import {
  MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS,
  memorySignalRetentionDays,
  retentionCutoffIso,
  isMemorySignalGcEligible,
  syntheticThreadsMaxRowsPerRun,
  shouldContinueBatchLoop,
  SYNTHETIC_THREADS_BATCH_SIZE,
  SYNTHETIC_THREADS_MAX_BATCHES_PER_RUN,
  SYNTHETIC_THREADS_RETENTION_DAYS,
  CHAT_IMAGE_RETENTION_DAYS,
  CHAT_IMAGE_BATCH_SIZE,
  STALE_NOTE_ARCHIVE_DEFAULT_TTL_DAYS,
  STALE_NOTE_ARCHIVE_BATCH_SIZE,
  STALE_NOTE_ARCHIVE_MAX_BATCHES_PER_RUN,
  STALE_NOTE_ARCHIVE_PROTECTED_NOTE_TYPES,
  staleNoteArchiveTtlDays,
  staleNoteArchiveMaxRowsPerRun,
  isStaleNoteArchiveEligible,
  type StaleNoteArchiveCandidateRow,
  LAUNCH_VIDEO_PUBLIC_RETENTION_DAYS,
  LAUNCH_VIDEO_PUBLIC_REAP_BATCH_SIZE,
  LAUNCH_VIDEO_PUBLIC_REAPABLE_STATUSES,
  isLaunchVideoPublicJobReapEligible,
  isLaunchVideoShellTenantReapEligible,
  type LaunchVideoPublicReapCandidate,
  type LaunchVideoShellTenantCandidate,
} from "./cleanup-gc-boundaries";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("memorySignalRetentionDays — retention clamp", () => {
  it("uses the default when unset", () => {
    expect(memorySignalRetentionDays(undefined)).toBe(
      MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS,
    );
    expect(MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it("accepts a valid positive override (string or number)", () => {
    expect(memorySignalRetentionDays("30")).toBe(30);
    expect(memorySignalRetentionDays(120)).toBe(120);
  });

  it("floors fractional days", () => {
    expect(memorySignalRetentionDays("45.9")).toBe(45);
  });

  it("SAFETY: a zero / negative / non-finite override falls back to default, NEVER 0", () => {
    expect(memorySignalRetentionDays("0")).toBe(MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS);
    expect(memorySignalRetentionDays(0)).toBe(MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS);
    expect(memorySignalRetentionDays("-5")).toBe(MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS);
    expect(memorySignalRetentionDays("garbage")).toBe(
      MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS,
    );
    expect(memorySignalRetentionDays("NaN")).toBe(
      MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS,
    );
    expect(memorySignalRetentionDays("")).toBe(MEMORY_SIGNAL_DEFAULT_RETENTION_DAYS);
  });
});

describe("retentionCutoffIso — UTC epoch math (DST-irrelevant)", () => {
  const now = Date.parse("2026-05-22T12:00:00.000Z");

  it("subtracts exactly N×86_400_000 ms", () => {
    expect(retentionCutoffIso(30, now)).toBe(
      new Date(now - 30 * MS_PER_DAY).toISOString(),
    );
    expect(retentionCutoffIso(90, now)).toBe("2026-02-21T12:00:00.000Z");
  });

  it("0 days → now (boundary)", () => {
    expect(retentionCutoffIso(0, now)).toBe("2026-05-22T12:00:00.000Z");
  });

  it("crossing a DST boundary still subtracts whole 24h days (no calendar drift)", () => {
    const acrossDst = Date.parse("2026-03-15T00:00:00.000Z");
    expect(retentionCutoffIso(30, acrossDst)).toBe(
      new Date(acrossDst - 30 * MS_PER_DAY).toISOString(),
    );
  });
});

describe("isMemorySignalGcEligible — THE silent-data-loss safety predicate", () => {
  const cutoff = "2026-02-21T12:00:00.000Z";

  it("eligible iff older-than-cutoff AND distilled", () => {
    expect(
      isMemorySignalGcEligible(
        { created_at: "2026-01-01T00:00:00.000Z", distilled_at: "2026-01-05T00:00:00.000Z" },
        cutoff,
      ),
    ).toBe(true);
  });

  it("SAFETY: a row with distilled_at=null is NEVER eligible, even when very old", () => {
    expect(
      isMemorySignalGcEligible(
        { created_at: "2020-01-01T00:00:00.000Z", distilled_at: null },
        cutoff,
      ),
    ).toBe(false);
  });

  it("a distilled-but-recent row (newer than cutoff) is NOT eligible", () => {
    expect(
      isMemorySignalGcEligible(
        { created_at: "2026-05-01T00:00:00.000Z", distilled_at: "2026-05-02T00:00:00.000Z" },
        cutoff,
      ),
    ).toBe(false);
  });

  it("a row exactly at the cutoff is NOT eligible (strict <)", () => {
    expect(
      isMemorySignalGcEligible({ created_at: cutoff, distilled_at: cutoff }, cutoff),
    ).toBe(false);
  });

  it("treats undefined distilled_at like null (defensive)", () => {
    expect(
      isMemorySignalGcEligible(
        { created_at: "2020-01-01T00:00:00.000Z", distilled_at: undefined as unknown as null },
        cutoff,
      ),
    ).toBe(false);
  });
});

describe("synthetic-threads batch bounds", () => {
  it("constants match the documented 50K/run safety valve", () => {
    expect(SYNTHETIC_THREADS_BATCH_SIZE).toBe(1000);
    expect(SYNTHETIC_THREADS_MAX_BATCHES_PER_RUN).toBe(50);
    expect(SYNTHETIC_THREADS_RETENTION_DAYS).toBe(30);
    expect(syntheticThreadsMaxRowsPerRun()).toBe(50_000);
  });

  it("loop continues on a full batch under the cap", () => {
    expect(
      shouldContinueBatchLoop({ batchesDone: 1, lastBatchSize: 1000 }),
    ).toBe(true);
  });

  it("loop STOPS when the per-run batch cap is reached", () => {
    expect(
      shouldContinueBatchLoop({ batchesDone: 50, lastBatchSize: 1000 }),
    ).toBe(false);
  });

  it("loop STOPS on an empty batch (no more rows)", () => {
    expect(
      shouldContinueBatchLoop({ batchesDone: 3, lastBatchSize: 0 }),
    ).toBe(false);
  });

  it("loop STOPS on a short batch (drained — less than a full page)", () => {
    expect(
      shouldContinueBatchLoop({ batchesDone: 3, lastBatchSize: 999 }),
    ).toBe(false);
  });

  it("respects custom cap/size overrides (for testability)", () => {
    expect(
      shouldContinueBatchLoop({
        batchesDone: 2,
        lastBatchSize: 10,
        maxBatches: 5,
        batchSize: 10,
      }),
    ).toBe(true);
    expect(
      shouldContinueBatchLoop({
        batchesDone: 5,
        lastBatchSize: 10,
        maxBatches: 5,
        batchSize: 10,
      }),
    ).toBe(false);
  });
});

describe("chat-image sweep constants", () => {
  it("30-day TTL and 100-object batch size", () => {
    expect(CHAT_IMAGE_RETENTION_DAYS).toBe(30);
    expect(CHAT_IMAGE_BATCH_SIZE).toBe(100);
  });
});

describe("staleNoteArchiveTtlDays — TTL clamp", () => {
  it("defaults to a conservative 180 days", () => {
    expect(staleNoteArchiveTtlDays(undefined)).toBe(180);
    expect(STALE_NOTE_ARCHIVE_DEFAULT_TTL_DAYS).toBe(180);
  });
  it("accepts a valid positive override (string or number) and floors", () => {
    expect(staleNoteArchiveTtlDays("365")).toBe(365);
    expect(staleNoteArchiveTtlDays(200)).toBe(200);
    expect(staleNoteArchiveTtlDays("180.9")).toBe(180);
  });
  it("SAFETY: zero / negative / non-finite falls back to default (never archives recent)", () => {
    expect(staleNoteArchiveTtlDays("0")).toBe(180);
    expect(staleNoteArchiveTtlDays(0)).toBe(180);
    expect(staleNoteArchiveTtlDays("-30")).toBe(180);
    expect(staleNoteArchiveTtlDays("garbage")).toBe(180);
  });
  it("per-run row cap is the cost guard (500 × 20 = 10K)", () => {
    expect(STALE_NOTE_ARCHIVE_BATCH_SIZE).toBe(500);
    expect(STALE_NOTE_ARCHIVE_MAX_BATCHES_PER_RUN).toBe(20);
    expect(staleNoteArchiveMaxRowsPerRun()).toBe(10_000);
  });
});

describe("isStaleNoteArchiveEligible — THE archival safety predicate", () => {
  const cutoff = "2026-01-01T00:00:00.000Z";
  const OLD = "2025-06-01T00:00:00.000Z";
  const RECENT = "2026-06-01T00:00:00.000Z";

  const base: StaleNoteArchiveCandidateRow = {
    updated_at: OLD,
    trust_tier: 2,
    note_type: "untyped",
    slug: null,
    superseded_by: null,
    archived_at: null,
    inbound_take_count: 0,
    inbound_relation_count: 0,
  };

  it("ARCHIVES an old, low-trust, low-salience, unreferenced declarative note", () => {
    expect(isStaleNoteArchiveEligible(base, cutoff)).toBe(true);
    expect(isStaleNoteArchiveEligible({ ...base, trust_tier: 3 }, cutoff)).toBe(true);
  });

  it("NEVER archives operator-trust notes (tier 0 or 1)", () => {
    expect(isStaleNoteArchiveEligible({ ...base, trust_tier: 0 }, cutoff)).toBe(false);
    expect(isStaleNoteArchiveEligible({ ...base, trust_tier: 1 }, cutoff)).toBe(false);
  });

  it("NEVER archives an unknown-trust (null) note — fails closed", () => {
    expect(isStaleNoteArchiveEligible({ ...base, trust_tier: null }, cutoff)).toBe(false);
  });

  it("NEVER archives anchors (slug-bearing)", () => {
    expect(
      isStaleNoteArchiveEligible({ ...base, slug: "company", note_type: "anchor", trust_tier: 2 }, cutoff),
    ).toBe(false);
    expect(isStaleNoteArchiveEligible({ ...base, slug: "ops" }, cutoff)).toBe(false);
  });

  it("NEVER archives operator_preference or correction note types", () => {
    expect(isStaleNoteArchiveEligible({ ...base, note_type: "operator_preference" }, cutoff)).toBe(false);
    expect(isStaleNoteArchiveEligible({ ...base, note_type: "correction" }, cutoff)).toBe(false);
    for (const t of STALE_NOTE_ARCHIVE_PROTECTED_NOTE_TYPES) {
      expect(isStaleNoteArchiveEligible({ ...base, note_type: t }, cutoff)).toBe(false);
    }
  });

  it("NEVER archives a null note_type — fails closed", () => {
    expect(isStaleNoteArchiveEligible({ ...base, note_type: null }, cutoff)).toBe(false);
  });

  it("NEVER archives a high-salience note (any inbound take OR relation)", () => {
    expect(isStaleNoteArchiveEligible({ ...base, inbound_take_count: 1 }, cutoff)).toBe(false);
    expect(isStaleNoteArchiveEligible({ ...base, inbound_relation_count: 1 }, cutoff)).toBe(false);
  });

  it("NEVER archives a recently-touched note (updated_at >= cutoff)", () => {
    expect(isStaleNoteArchiveEligible({ ...base, updated_at: RECENT }, cutoff)).toBe(false);
    expect(isStaleNoteArchiveEligible({ ...base, updated_at: cutoff }, cutoff)).toBe(false);
  });

  it("IDEMPOTENT: an already-archived note is never re-archived", () => {
    expect(
      isStaleNoteArchiveEligible({ ...base, archived_at: "2026-02-01T00:00:00.000Z" }, cutoff),
    ).toBe(false);
  });

  it("skips already-superseded notes (already out of recall)", () => {
    expect(
      isStaleNoteArchiveEligible({ ...base, superseded_by: "00000000-0000-0000-0000-000000000001" }, cutoff),
    ).toBe(false);
  });

  it("REVERSIBLE: clearing archived_at makes a still-stale note eligible again", () => {
    const archived = { ...base, archived_at: "2026-02-01T00:00:00.000Z" };
    expect(isStaleNoteArchiveEligible(archived, cutoff)).toBe(false);
    const restored = { ...archived, archived_at: null };
    expect(isStaleNoteArchiveEligible(restored, cutoff)).toBe(true);
  });
});

describe("launch-video-public retention constants", () => {
  it("is a 30-day window, matching the sibling reapers in this directory", () => {
    expect(LAUNCH_VIDEO_PUBLIC_RETENTION_DAYS).toBe(30);
    expect(LAUNCH_VIDEO_PUBLIC_RETENTION_DAYS).toBe(SYNTHETIC_THREADS_RETENTION_DAYS);
    expect(LAUNCH_VIDEO_PUBLIC_RETENTION_DAYS).toBe(CHAT_IMAGE_RETENTION_DAYS);
  });

  it("'claimed' is NOT in the reapable status list", () => {
    expect(LAUNCH_VIDEO_PUBLIC_REAPABLE_STATUSES).not.toContain("claimed");
    expect([...LAUNCH_VIDEO_PUBLIC_REAPABLE_STATUSES].sort()).toEqual([
      "failed",
      "queued",
      "ready",
      "rendering",
    ]);
  });

  it("scans a bounded batch per run", () => {
    expect(LAUNCH_VIDEO_PUBLIC_REAP_BATCH_SIZE).toBeGreaterThan(0);
    expect(LAUNCH_VIDEO_PUBLIC_REAP_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });
});

describe("isLaunchVideoPublicJobReapEligible — NEVER REAP A CLAIMED JOB", () => {
  const cutoff = "2026-08-01T00:00:00.000Z";
  const OLD = "2026-06-01T00:00:00.000Z";
  const RECENT = "2026-08-20T00:00:00.000Z";

  const base: LaunchVideoPublicReapCandidate = {
    created_at: OLD,
    status: "ready",
    claimed_by_user_id: null,
    claimed_at: null,
    tenant_kind: "launch_video_shell",
  };

  it("reaps an old, unclaimed job on a live shell tenant", () => {
    expect(isLaunchVideoPublicJobReapEligible(base, cutoff)).toBe(true);
    for (const status of ["queued", "rendering", "ready", "failed"]) {
      expect(isLaunchVideoPublicJobReapEligible({ ...base, status }, cutoff)).toBe(true);
    }
  });

  it("NEVER reaps status='claimed' — even when everything else says reap", () => {
    expect(
      isLaunchVideoPublicJobReapEligible(
        { ...base, status: "claimed", created_at: "2020-01-01T00:00:00.000Z" },
        cutoff,
      ),
    ).toBe(false);
  });

  it("NEVER reaps a job with claimed_by_user_id set, whatever the status says", () => {
    expect(
      isLaunchVideoPublicJobReapEligible(
        { ...base, claimed_by_user_id: "00000000-0000-0000-0000-0000000000aa" },
        cutoff,
      ),
    ).toBe(false);
  });

  it("NEVER reaps a job with claimed_at set, whatever the status says", () => {
    expect(
      isLaunchVideoPublicJobReapEligible({ ...base, claimed_at: "2026-06-02T00:00:00.000Z" }, cutoff),
    ).toBe(false);
  });

  it("NEVER reaps a job whose tenant was PROMOTED to a real workspace", () => {
    expect(isLaunchVideoPublicJobReapEligible({ ...base, tenant_kind: "real" }, cutoff)).toBe(false);
    expect(isLaunchVideoPublicJobReapEligible({ ...base, tenant_kind: "test" }, cutoff)).toBe(false);
  });

  it("FAILS CLOSED on an unknown tenant kind (missing tenant row -> null)", () => {
    expect(isLaunchVideoPublicJobReapEligible({ ...base, tenant_kind: null }, cutoff)).toBe(false);
  });

  it("FAILS CLOSED on a null or unrecognized status (a future status is protected by default)", () => {
    expect(isLaunchVideoPublicJobReapEligible({ ...base, status: null }, cutoff)).toBe(false);
    expect(isLaunchVideoPublicJobReapEligible({ ...base, status: "" }, cutoff)).toBe(false);
    expect(isLaunchVideoPublicJobReapEligible({ ...base, status: "archived" }, cutoff)).toBe(false);
    expect(isLaunchVideoPublicJobReapEligible({ ...base, status: "CLAIMED" }, cutoff)).toBe(false);
  });

  it("does NOT reap a job inside the retention window", () => {
    expect(isLaunchVideoPublicJobReapEligible({ ...base, created_at: RECENT }, cutoff)).toBe(false);
    expect(isLaunchVideoPublicJobReapEligible({ ...base, created_at: cutoff }, cutoff)).toBe(false);
  });
});

describe("isLaunchVideoShellTenantReapEligible — orphan shells only", () => {
  const cutoff = "2026-08-01T00:00:00.000Z";
  const base: LaunchVideoShellTenantCandidate = {
    created_at: "2026-06-01T00:00:00.000Z",
    kind: "launch_video_shell",
    job_count: 0,
    member_count: 0,
  };

  it("reaps an old shell with zero jobs and zero members (the leaked-on-insert-failure case)", () => {
    expect(isLaunchVideoShellTenantReapEligible(base, cutoff)).toBe(true);
  });

  it("NEVER reaps a tenant that still has a job row", () => {
    expect(isLaunchVideoShellTenantReapEligible({ ...base, job_count: 1 }, cutoff)).toBe(false);
  });

  it("NEVER reaps a tenant with a member attached", () => {
    expect(isLaunchVideoShellTenantReapEligible({ ...base, member_count: 1 }, cutoff)).toBe(false);
  });

  it("NEVER reaps a non-shell tenant (real / test / null)", () => {
    expect(isLaunchVideoShellTenantReapEligible({ ...base, kind: "real" }, cutoff)).toBe(false);
    expect(isLaunchVideoShellTenantReapEligible({ ...base, kind: "test" }, cutoff)).toBe(false);
    expect(isLaunchVideoShellTenantReapEligible({ ...base, kind: null }, cutoff)).toBe(false);
  });

  it("does NOT reap a shell inside the retention window, and fails closed on a null created_at", () => {
    expect(
      isLaunchVideoShellTenantReapEligible({ ...base, created_at: "2026-08-20T00:00:00.000Z" }, cutoff),
    ).toBe(false);
    expect(isLaunchVideoShellTenantReapEligible({ ...base, created_at: null }, cutoff)).toBe(false);
  });
});
