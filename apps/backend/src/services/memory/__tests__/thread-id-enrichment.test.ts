
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const memorySrc = readFileSync(
  join(__dirname, "..", "index.ts"),
  "utf-8",
);
const searchToolSrc = readFileSync(
  join(__dirname, "../../tools/memory/search.ts"),
  "utf-8",
);
const writeToolSrc = readFileSync(
  join(__dirname, "../../tools/memory/write.ts"),
  "utf-8",
);
const distillEpisodeSrc = readFileSync(
  join(__dirname, "..", "distill-episode.ts"),
  "utf-8",
);
const migrationSrc = readFileSync(
  join(
    __dirname,
    "../../../../../../supabase/migrations/20260526101823_memory_note_thread_id.sql",
  ),
  "utf-8",
);
const threadEventTypesSrc = readFileSync(
  join(__dirname, "../../agents/thread-event-types.ts"),
  "utf-8",
);
const followupMigrationSrc = readFileSync(
  join(
    __dirname,
    "../../../../../../supabase/migrations/20260526124909_memory_note_thread_id_auto_distill_chat.sql",
  ),
  "utf-8",
);
const distillSrc = readFileSync(
  join(__dirname, "..", "distill.ts"),
  "utf-8",
);
const distillChatTurnSrc = readFileSync(
  join(__dirname, "../../../../workers/functions/distill-chat-turn.ts"),
  "utf-8",
);

describe("memory_note.thread_id migration (qa-blind-fixes 2026-05-26)", () => {
  it("adds nullable thread_id column to memory_note", () => {
    expect(migrationSrc).toMatch(
      /alter table memory_note\s*\n?\s*add column (if not exists )?thread_id uuid null/i,
    );
  });

  it("backfills source='agent_run' rows via direct-UUID source_ref → agent_runs.payload.thread_id", () => {
    expect(migrationSrc).toMatch(/where mn\.source = 'agent_run'/);
    expect(migrationSrc).toMatch(
      /mn\.source_ref ~ '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$'/,
    );
    expect(migrationSrc).toMatch(/ar\.payload->>'thread_id'/);
  });

  it("backfills source='episode_distill' rows via 'episode:<uuid>' source_ref → agent_runs.payload.thread_id", () => {
    expect(migrationSrc).toMatch(/where mn\.source = 'episode_distill'/);
    expect(migrationSrc).toMatch(/mn\.source_ref like 'episode:%'/);
    expect(migrationSrc).toMatch(/substring\(mn\.source_ref from 9\)/);
  });

  it("backfill is idempotent (re-runs leave previously-populated rows alone)", () => {
    const nullGuards = migrationSrc.match(/mn\.thread_id is null/g) ?? [];
    expect(nullGuards.length).toBeGreaterThanOrEqual(2);
  });
});

describe("SearchHit.thread_id type + tool description (qa-blind-fixes 2026-05-26)", () => {
  it("SearchHit declares thread_id as optional string|null", () => {
    expect(memorySrc).toMatch(/thread_id\??:\s*string \| null/);
  });

  it("WriteNoteInput accepts thread_id (used by distill-episode + memory_write)", () => {
    expect(memorySrc).toMatch(
      /owning chat thread when this write originates[\s\S]*?thread_id\?:\s*string \| null/i,
    );
  });

  it("memory_search tool description lists thread_id in the per-hit shape", () => {
    expect(searchToolSrc).toMatch(/thread_id\?\}/);
    expect(searchToolSrc).toMatch(/cross-thread/i);
  });
});

describe("searchMemory hydration SELECT (qa-blind-fixes 2026-05-26)", () => {
  it("primary search-path SELECT pulls thread_id from memory_note", () => {
    expect(memorySrc).toMatch(
      /\.select\("id, source, note_type, created_at, trust_tier, agent_slug, thread_id"\)/,
    );
  });

  it("hydrated.map spreads thread_id onto each hit", () => {
    const hits = memorySrc.match(/thread_id:\s*m\.thread_id/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("memory_write + distill-episode pass thread_id at write time (qa-blind-fixes 2026-05-26)", () => {
  it("memory_write tool looks up agent_runs.payload.thread_id before queueing", () => {
    expect(writeToolSrc).toMatch(/\.from\("agent_runs"\)/);
    expect(writeToolSrc).toMatch(/\.select\("payload"\)/);
    expect(writeToolSrc).toMatch(
      /\(payload as \{ thread_id\?: unknown \}\)\.thread_id/,
    );
  });

  it("memory_write passes thread_id into the queued proposal", () => {
    expect(writeToolSrc).toMatch(
      /insertProposal\(ctx\.tenant_id,\s*\{[\s\S]*?thread_id,/,
    );
  });

  it("distill-episode looks up the originating agent_run's thread_id", () => {
    expect(distillEpisodeSrc).toMatch(/lookupRunThreadId/);
    expect(distillEpisodeSrc).toMatch(/\.from\("agent_runs"\)/);
    expect(distillEpisodeSrc).toMatch(
      /\(payload as \{ thread_id\?: unknown \}\)\.thread_id/,
    );
  });

  it("distill-episode passes thread_id into writeNote", () => {
    expect(distillEpisodeSrc).toMatch(
      /writeNote\(r\.tenant_id,\s*\{[\s\S]*?thread_id,?\s*\}/,
    );
  });
});

describe("C14 trust boundary preserved (qa-blind-fixes 2026-05-26)", () => {
  it("RunEndBodySchema.status enum is still a bounded terminal whitelist", () => {
    expect(threadEventTypesSrc).toMatch(
      /RunEndBodySchema = z\.object\(\{\s*\n?\s*status:\s*z\.enum\(\["success",\s*"error",\s*"failed",\s*"cancelled"\]\)/,
    );
  });

  it("memory_note.thread_id lives on the BODY surface (memory_note table), NOT on agent_run_events.meta", () => {
    expect(migrationSrc).not.toMatch(/agent_run_events/);
    expect(migrationSrc).toMatch(/alter table memory_note/);
  });
});

describe("auto_distill_chat thread_id coverage (qa-blind-fixes FOLLOW-UP 2026-05-26)", () => {
  it("follow-up migration backfills source='auto_distill_chat' rows via direct-UUID source_ref", () => {
    expect(followupMigrationSrc).toMatch(/where mn\.source = 'auto_distill_chat'/);
    expect(followupMigrationSrc).toMatch(
      /mn\.source_ref ~ '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$'/,
    );
    expect(followupMigrationSrc).toMatch(/ar\.payload->>'thread_id'/);
  });

  it("follow-up migration is idempotent (mn.thread_id is null guard)", () => {
    expect(followupMigrationSrc).toMatch(/mn\.thread_id is null/);
  });

  it("follow-up migration does NOT touch agent_run_events (C14 boundary)", () => {
    expect(followupMigrationSrc).not.toMatch(/agent_run_events/);
  });

  it("RunDistillInput type accepts thread_id", () => {
    expect(distillSrc).toMatch(
      /thread_id\?:\s*string \| null/,
    );
    expect(distillSrc).toMatch(/qa-blind-fixes follow-up 2026-05-26/);
  });

  it("runDistill passes thread_id from input into the writeNote noteInput shape", () => {
    expect(distillSrc).toMatch(
      /thread_id:\s*input\.thread_id\s*\?\?\s*null/,
    );
  });

  it("distill-chat-turn passes thread_id from agent_runs.payload into runDistill", () => {
    expect(distillChatTurnSrc).toMatch(
      /runDistill\(\{[\s\S]*?source:\s*"auto_distill_chat"[\s\S]*?thread_id,?\s*\}/,
    );
  });

  it("distill-chat-turn comment explains the qa-blind-fixes follow-up rationale", () => {
    expect(distillChatTurnSrc).toMatch(/qa-blind-fixes follow-up 2026-05-26/i);
  });
});
