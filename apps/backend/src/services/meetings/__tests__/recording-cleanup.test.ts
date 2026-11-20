import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const m = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  const fail = { scan: false };

  function from(table: string) {
    const rows = (tables[table] ??= []);
    const preds: Array<(r: Row) => boolean> = [];
    const notePreds: Array<(n: Row) => boolean> = [];
    let cols = "";
    let patch: Row | null = null;
    let returning = false;
    let limit = Infinity;
    let orderBy: { c: string; asc: boolean } | null = null;
    const run = () => {
      if (fail.scan && !patch) return { data: null, error: { message: "db down" } };
      let hit = rows.filter((r) => preds.every((p) => p(r)));
      if (!patch && cols.includes("meeting_notes!inner")) {
        const notesOf = (r: Row) => (tables.meeting_notes ?? []).filter((n) => n.bot_id === r.id && notePreds.every((p) => p(n)));
        hit = hit.filter((r) => notesOf(r).length > 0).map((r) => ({ ...r, meeting_notes: notesOf(r) }));
      }
      if (orderBy) {
        const { c, asc } = orderBy;
        hit = [...hit].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
      }
      hit = hit.slice(0, limit);
      if (patch) {
        for (const r of hit) Object.assign(r, patch);
        return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: (c?: string) => {
        if (patch) returning = true;
        else cols = c ?? "";
        return q;
      },
      update: (p: Row) => ((patch = p), q),
      upsert: async (p: Row, o: { onConflict: string }) => {
        if (!rows.some((r) => r[o.onConflict] === p[o.onConflict])) rows.push({ ...p });
        return { data: null, error: null };
      },
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) =>
        c.startsWith("meeting_notes.")
          ? (notePreds.push((n) => (n[c.slice("meeting_notes.".length)] ?? null) !== v), q)
          : (preds.push((r) => r[c] !== v), q),
      insert: async (p: Row) => {
        if (table === "meeting_notes" && rows.some((r) => r.bot_id === p.bot_id)) {
          return { data: null, error: { message: "duplicate key value violates unique constraint \"meeting_notes_pkey\"" } };
        }
        rows.push(table === "meeting_notes" ? { delete_after: "2026-11-27T12:00:00.000Z", ...p } : { ...p });
        return { data: null, error: null };
      },
      in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(r[c])), q),
      is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), q),
      not: (c: string, op: string, v: unknown) => (preds.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)), q),
      lt: (c: string, v: unknown) => (preds.push((r) => r[c] != null && String(r[c]) < String(v)), q),
      gte: (c: string, v: unknown) => (preds.push((r) => r[c] != null && String(r[c]) >= String(v)), q),
      gt: (c: string, v: unknown) => (preds.push((r) => r[c] != null && (typeof v === "number" ? Number(r[c]) > v : String(r[c]) > String(v))), q),
      order: (c: string, o?: { ascending?: boolean }) => ((orderBy = { c, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: async () => {
        const out = run();
        const d = out.data as Row[] | null;
        return { data: Array.isArray(d) ? (d[0] ?? null) : d, error: out.error };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  }

  class RecallHttpError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    tables,
    fail,
    from,
    RecallHttpError,
    deleteBotMedia: vi.fn(async (..._a: unknown[]) => undefined),
    recallConfigured: vi.fn(() => true),
    getBot: vi.fn(async (..._a: unknown[]): Promise<{ transcript_download_url: string | null }> => ({ transcript_download_url: "https://recall.example/t" })),
    fetchTranscript: vi.fn(async (..._a: unknown[]) => [{ speaker: "Asha", text: "from the recording", start_s: null }]),
    send: vi.fn(async (..._a: unknown[]) => ({ ids: ["evt"] })),
  };
});

vi.mock("@/services/tenant-client", () => ({
  fleetSweepClient: () => ({ from: m.from }),
  staffCrossTenantClient: () => ({ from: m.from }),
}));
vi.mock("@/services/meetings/recall", () => ({
  deleteBotMedia: m.deleteBotMedia,
  recallConfigured: m.recallConfigured,
  RecallHttpError: m.RecallHttpError,
  getBot: m.getBot,
  fetchTranscript: m.fetchTranscript,
  transcriptToText: (segs: Array<{ speaker: string; text: string }>) => segs.map((x) => `${x.speaker}: ${x.text}`).join("\n"),
}));
vi.mock("../../../../workers/client", () => ({ inngest: { send: m.send } }));

import { retryRecordingDeletes, repairUnsavedTranscripts, deleteKeptRecordings } from "../recording-cleanup";
import { requestMeetingReprocess } from "../reprocess";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const OLD = "2026-10-26T10:00:00.000Z";
const LIVE_NOTE = "2026-11-20T00:00:00.000Z";
const NEW_RULES = "2026-10-27T12:00:00.000Z";
const note = (bot_id: string, over: Row = {}): Row => ({ bot_id, tenant_id: "t1", transcript: "Asha: hi", delete_after: LIVE_NOTE, ...over });
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function bot(id: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: "t1",
    provider_bot_id: `r-${id}`,
    status: "ingested",
    media_deleted_at: null,
    updated_at: OLD,
    created_at: OLD,
    scheduled_date: "2026-10-27",
    transcript_chars: 100,
    error: null,
    summary_email_sent_at: "2026-10-27T10:00:00.000Z",
    default_slack_posted_at: "2026-10-27T10:00:00.000Z",
    ...over,
  };
}
const row = (id: string) => m.tables.meeting_bots.find((r) => r.id === id)!;

beforeEach(() => {
  for (const k of Object.keys(m.tables)) delete m.tables[k];
  m.tables.tenants = [{ id: "t1", slug: "upcar-ai" }];
  m.tables.meeting_notes = [];
  m.fail.scan = false;
  m.deleteBotMedia.mockReset();
  m.deleteBotMedia.mockResolvedValue(undefined);
  m.recallConfigured.mockReturnValue(true);
  m.send.mockClear();
  m.getBot.mockReset();
  m.getBot.mockResolvedValue({ transcript_download_url: "https://recall.example/t" });
  logger.error.mockClear();
});

describe("retryRecordingDeletes (reconcile retry)", () => {
  it("deletes only processed meetings whose transcript is saved and whose recording is still at Recall", async () => {
    m.tables.meeting_bots = [
      bot("saved"),
      bot("no-notes"),
      bot("already", { media_deleted_at: OLD }),
      bot("processing", { status: "processing" }),
      bot("cancelled", { status: "cancelled" }),
      bot("just-ingested", { updated_at: "2026-10-28T11:50:00.000Z" }),
    ];
    m.tables.meeting_notes = ["saved", "already", "processing", "cancelled", "just-ingested"].map((id) => note(id));
    const out = await retryRecordingDeletes(logger, NOW);
    expect(out).toEqual({ deleted: 1 });
    expect(m.deleteBotMedia.mock.calls).toEqual([["r-saved"]]);
    expect(row("saved").media_deleted_at).toBe(NOW.toISOString());
    expect(row("no-notes").media_deleted_at).toBeNull();
  });

  it("a notes row is not proof: blank, past its 30 days, or another tenant's, the recording stays", async () => {
    m.tables.meeting_bots = [bot("hollow"), bot("spaces"), bot("expired"), bot("cross")];
    m.tables.meeting_notes = [
      note("hollow", { transcript: "" }),
      note("spaces", { transcript: "   " }),
      note("expired", { delete_after: "2026-10-27T00:00:00.000Z" }),
      note("cross", { tenant_id: "t2" }),
    ];
    expect(await retryRecordingDeletes(logger, NOW)).toEqual({ deleted: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("also deletes an empty capture's recording (nothing to save), never a meeting whose transcript is not saved", async () => {
    m.tables.meeting_bots = [
      bot("empty", { transcript_chars: 0 }),
      bot("unsaved", { transcript_chars: 900 }),
      bot("empty-fresh", { transcript_chars: 0, updated_at: "2026-10-28T11:50:00.000Z" }),
    ];
    const out = await retryRecordingDeletes(logger, NOW);
    expect(out).toEqual({ deleted: 1 });
    expect(m.deleteBotMedia.mock.calls).toEqual([["r-empty"]]);
    expect(row("unsaved").media_deleted_at).toBeNull();
  });

  it("a Recall refusal leaves the row unmarked for the next sweep; a bot Recall no longer has is marked", async () => {
    m.tables.meeting_bots = [bot("refused"), bot("gone")];
    m.tables.meeting_notes = [note("refused"), note("gone")];
    m.deleteBotMedia.mockImplementation(async (id: unknown) => {
      if (id === "r-refused") throw new m.RecallHttpError(500, "recall delete media 500");
      throw new m.RecallHttpError(404, "recall delete media 404");
    });
    const out = await retryRecordingDeletes(logger, NOW);
    expect(out).toEqual({ deleted: 1 });
    expect(row("refused").media_deleted_at).toBeNull();
    expect(row("gone").media_deleted_at).toBe(NOW.toISOString());
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("refused"));
  });

  it("never throws on a scan error, and does nothing without a Recall key", async () => {
    m.tables.meeting_bots = [bot("saved")];
    m.tables.meeting_notes = [note("saved")];
    m.fail.scan = true;
    await expect(retryRecordingDeletes(logger, NOW)).resolves.toEqual({ deleted: 0 });
    m.fail.scan = false;
    m.recallConfigured.mockReturnValue(false);
    await expect(retryRecordingDeletes(logger, NOW)).resolves.toEqual({ deleted: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });
});

describe("repairUnsavedTranscripts (reconcile repair)", () => {
  const HOURS_AGO = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

  it("saves the transcript from the kept recording (kept to the meeting's own 30 days), confirms it, then deletes the recording", async () => {
    m.tables.meeting_bots = [bot("unsaved", { created_at: NEW_RULES, updated_at: HOURS_AGO(3) })];
    expect(await repairUnsavedTranscripts(logger, NOW)).toEqual({ repaired: 1 });
    expect(m.tables.meeting_notes).toEqual([
      expect.objectContaining({
        bot_id: "unsaved",
        tenant_id: "t1",
        transcript: "Asha: from the recording",
        minutes: null,
        delete_after: "2026-11-26T12:00:00.000Z",
      }),
    ]);
    expect(m.deleteBotMedia).toHaveBeenCalledWith("r-unsaved");
    expect(row("unsaved").media_deleted_at).toBe(NOW.toISOString());
  });

  it("leaves alone: any notes row, too recent, a meeting from before the new rules (the one-off's), an empty capture", async () => {
    m.tables.meeting_bots = [
      bot("has-notes", { created_at: NEW_RULES, updated_at: HOURS_AGO(3) }),
      bot("fresh", { created_at: NEW_RULES, updated_at: HOURS_AGO(0.5) }),
      bot("legacy", { updated_at: HOURS_AGO(3) }),
      bot("empty", { created_at: NEW_RULES, updated_at: HOURS_AGO(3), transcript_chars: 0 }),
    ];
    m.tables.meeting_notes = [note("has-notes", { transcript: "" })];
    expect(await repairUnsavedTranscripts(logger, NOW)).toEqual({ repaired: 0 });
    expect(m.getBot).not.toHaveBeenCalled();
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("a meeting past its 30 days: the recording is deleted and no transcript is saved", async () => {
    const LATER = new Date("2026-12-01T12:00:00.000Z");
    m.tables.meeting_bots = [bot("past-30", { created_at: NEW_RULES, updated_at: "2026-11-20T00:00:00.000Z" })];
    expect(await repairUnsavedTranscripts(logger, LATER)).toEqual({ repaired: 0 });
    expect(m.getBot).not.toHaveBeenCalled();
    expect(m.tables.meeting_notes).toHaveLength(0);
    expect(m.deleteBotMedia).toHaveBeenCalledWith("r-past-30");
  });

  it("no readable transcript at Recall: nothing saved, the recording stays", async () => {
    m.tables.meeting_bots = [bot("unreadable", { created_at: NEW_RULES, updated_at: HOURS_AGO(3) })];
    m.getBot.mockResolvedValueOnce({ transcript_download_url: null });
    expect(await repairUnsavedTranscripts(logger, NOW)).toEqual({ repaired: 0 });
    expect(m.tables.meeting_notes).toHaveLength(0);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(row("unreadable").updated_at).toBe(NOW.toISOString());
  });

  it("an unreadable recording near the end of its 30 days is still picked up, and deleted, when they end", async () => {
    const before = new Date("2026-11-26T11:30:00.000Z");
    m.tables.meeting_bots = [bot("closing", { created_at: NEW_RULES, updated_at: "2026-11-20T00:00:00.000Z" })];
    m.getBot.mockResolvedValue({ transcript_download_url: null });
    expect(await repairUnsavedTranscripts(logger, before)).toEqual({ repaired: 0 });
    expect(row("closing").updated_at).toBe("2026-11-26T11:00:00.000Z");
    const after = new Date("2026-11-26T12:15:00.000Z");
    await repairUnsavedTranscripts(logger, after);
    expect(m.deleteBotMedia).toHaveBeenCalledWith("r-closing");
    expect(m.tables.meeting_notes).toHaveLength(0);
  });

  it("unreadable recordings do not starve a readable one behind them", async () => {
    const stuck = Array.from({ length: 10 }, (_, i) => bot(`stuck-${i}`, { created_at: NEW_RULES, updated_at: HOURS_AGO(20 - i) }));
    m.tables.meeting_bots = [...stuck, bot("readable", { created_at: NEW_RULES, updated_at: HOURS_AGO(5) })];
    m.getBot.mockImplementation(async (id: unknown) => ({ transcript_download_url: id === "r-readable" ? "https://recall.example/t" : null }));
    await repairUnsavedTranscripts(logger, NOW);
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    expect(await repairUnsavedTranscripts(logger, later)).toEqual({ repaired: 1 });
    expect(row("readable").media_deleted_at).toBe(later.toISOString());
  });
});

describe("deleteKeptRecordings (one-off)", () => {
  const seedKept = () => {
    m.tables.meeting_bots = [
      bot("failed-summary", { error: "distill output not parseable as JSON" }),
      bot("empty", { transcript_chars: 0 }),
      bot("done", { media_deleted_at: OLD }),
      bot("cancelled", { status: "cancelled" }),
      bot("live", { status: "processing" }),
    ];
  };

  it("--dry lists every kept recording of a processed meeting and changes nothing", async () => {
    seedKept();
    const lines: string[] = [];
    const out = await deleteKeptRecordings({ dry: true, now: NOW, log: (l) => lines.push(l) });
    expect(out).toEqual({ found: 2, deleted: 0, gone: 0, failed: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("failed-summary upcar-ai 2026-10-27");
    expect(lines.join("\n")).toContain("(summary failed)");
    expect(row("failed-summary").media_deleted_at).toBeNull();
  });

  it("deletes and marks them; a second run finds nothing", async () => {
    seedKept();
    const out = await deleteKeptRecordings({ dry: false, now: NOW, log: () => undefined });
    expect(out).toEqual({ found: 2, deleted: 2, gone: 0, failed: 0 });
    expect(m.deleteBotMedia.mock.calls.map((c) => c[0]).sort()).toEqual(["r-empty", "r-failed-summary"]);
    expect(row("failed-summary").media_deleted_at).toBe(NOW.toISOString());
    expect(row("cancelled").media_deleted_at).toBeNull();
    expect(row("live").media_deleted_at).toBeNull();

    m.deleteBotMedia.mockClear();
    expect(await deleteKeptRecordings({ dry: false, now: NOW, log: () => undefined })).toEqual({ found: 0, deleted: 0, gone: 0, failed: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("a failed delete is reported and stays listed for the next run", async () => {
    seedKept();
    m.deleteBotMedia.mockImplementation(async (id: unknown) => {
      if (id === "r-empty") throw new m.RecallHttpError(400, "recall delete media 400");
    });
    const out = await deleteKeptRecordings({ dry: false, now: NOW, log: () => undefined });
    expect(out).toEqual({ found: 2, deleted: 1, gone: 0, failed: 1 });
    expect(row("empty").media_deleted_at).toBeNull();
    expect((await deleteKeptRecordings({ dry: true, now: NOW, log: () => undefined })).found).toBe(1);
  });

  it("never touches a meeting created under the new rules (the cron's repair owns it), nor one processed in the last 30 minutes", async () => {
    m.tables.meeting_bots = [
      bot("new-rules", { created_at: NEW_RULES, updated_at: NEW_RULES }),
      bot("recent", { updated_at: "2026-10-28T11:45:00.000Z" }),
    ];
    expect(await deleteKeptRecordings({ dry: false, now: NOW, log: () => undefined })).toEqual({ found: 0, deleted: 0, gone: 0, failed: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("refuses to delete without a Recall key", async () => {
    seedKept();
    m.recallConfigured.mockReturnValue(false);
    await expect(deleteKeptRecordings({ dry: false, now: NOW, log: () => undefined })).rejects.toThrow(/RECALL_API_KEY/);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });
});

describe("requestMeetingReprocess (staff)", () => {
  const LIVE = "2026-11-20T00:00:00.000Z";
  const PAST = "2026-10-20T00:00:00.000Z";

  it("summary failed: re-opens it, clears the delivery latches, and queues one run that reads the saved transcript", async () => {
    m.tables.meeting_bots = [bot("b1", { media_deleted_at: OLD, error: "distill failed" })];
    m.tables.meeting_notes = [{ bot_id: "b1", tenant_id: "t1", transcript: "Asha: hi there", delete_after: LIVE }];
    const out = await requestMeetingReprocess("b1", { dry: false, now: NOW });
    expect(out).toEqual({ ok: true, mode: "rerun", queued: true, reads: "zavi", tenant_id: "t1" });
    expect(row("b1")).toMatchObject({ status: "failed", summary_email_sent_at: null, default_slack_posted_at: null });
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toMatchObject({ name: "meeting.bot.status", data: { meeting_bot_id: "b1", tenant_id: "t1" } });
  });

  it("--dry changes nothing", async () => {
    m.tables.meeting_bots = [bot("b1", { media_deleted_at: OLD, error: "distill failed" })];
    m.tables.meeting_notes = [{ bot_id: "b1", tenant_id: "t1", transcript: "Asha: hi there", delete_after: LIVE }];
    expect(await requestMeetingReprocess("b1", { dry: true, now: NOW })).toEqual({ ok: true, mode: "rerun", queued: false, reads: "zavi", tenant_id: "t1" });
    expect(row("b1").status).toBe("ingested");
    expect(m.send).not.toHaveBeenCalled();
  });

  it("summary failed and the transcript was never saved: the re-run reads the kept recording", async () => {
    m.tables.meeting_bots = [bot("b1", { error: "distill failed" })];
    expect(await requestMeetingReprocess("b1", { dry: true, now: NOW })).toMatchObject({ ok: true, mode: "rerun", reads: "recall" });
  });

  it("summary went out but the transcript was not saved: saves it from the recording, deletes the recording, sends nothing", async () => {
    m.tables.meeting_bots = [bot("b1")];
    const out = await requestMeetingReprocess("b1", { dry: false, now: NOW });
    expect(out).toEqual({ ok: true, mode: "save_transcript", done: true, tenant_id: "t1" });
    expect(m.tables.meeting_notes).toEqual([
      expect.objectContaining({ bot_id: "b1", tenant_id: "t1", minutes: null, transcript: "Asha: from the recording", delete_after: "2026-11-25T10:00:00.000Z" }),
    ]);
    expect(m.deleteBotMedia).toHaveBeenCalledWith("r-b1");
    expect(row("b1")).toMatchObject({ status: "ingested", media_deleted_at: NOW.toISOString(), summary_email_sent_at: expect.any(String) });
    expect(m.send).not.toHaveBeenCalled();
  });

  it("summary went out and an old notes row exists but is empty: the transcript is written into it and confirmed before the delete", async () => {
    m.tables.meeting_bots = [bot("b1")];
    m.tables.meeting_notes = [{ bot_id: "b1", tenant_id: "t1", minutes: null, transcript: "", delete_after: LIVE }];
    expect(await requestMeetingReprocess("b1", { dry: false, now: NOW })).toMatchObject({ ok: true, mode: "save_transcript", done: true });
    expect(m.tables.meeting_notes).toHaveLength(1);
    expect(m.tables.meeting_notes[0].transcript).toBe("Asha: from the recording");
    expect(m.deleteBotMedia).toHaveBeenCalledWith("r-b1");
  });

  it("a write that does not land keeps the recording", async () => {
    m.tables.meeting_bots = [bot("b1")];
    m.tables.meeting_notes = [{ bot_id: "b1", tenant_id: "t2", minutes: null, transcript: "", delete_after: LIVE }];
    await expect(requestMeetingReprocess("b1", { dry: false, now: NOW })).rejects.toThrow(/recording kept/);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(row("b1").media_deleted_at).toBeNull();
  });

  it("a meeting more than 30 days old: never re-run, no transcript saved (even once its notes row is gone), only the kept recording is deleted", async () => {
    const OLD_MEETING = "2026-09-20T10:00:00.000Z";
    m.tables.meeting_bots = [bot("gone-notes", { created_at: OLD_MEETING }), bot("failed-old", { created_at: OLD_MEETING, error: "distill failed" })];
    m.tables.meeting_notes = [];
    for (const id of ["gone-notes", "failed-old"]) {
      expect(await requestMeetingReprocess(id, { dry: false, rerun: true, now: NOW })).toEqual({ ok: true, mode: "past_30_days", done: true, tenant_id: "t1" });
    }
    expect(m.getBot).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.tables.meeting_notes).toHaveLength(0);
    expect(m.deleteBotMedia.mock.calls.map((c) => c[0])).toEqual(["r-gone-notes", "r-failed-old"]);
    m.tables.meeting_bots.push(bot("old-clean", { created_at: OLD_MEETING, media_deleted_at: OLD }));
    expect(await requestMeetingReprocess("old-clean", { dry: false, now: NOW })).toEqual({ ok: false, reason: "nothing_to_read" });
  });

  it("--rerun re-runs and re-sends a meeting whose summary went out (staff's explicit call)", async () => {
    m.tables.meeting_bots = [bot("b1", { media_deleted_at: OLD })];
    m.tables.meeting_notes = [{ bot_id: "b1", tenant_id: "t1", transcript: "Asha: hi there", delete_after: LIVE }];
    expect(await requestMeetingReprocess("b1", { dry: false, now: NOW })).toEqual({ ok: false, reason: "nothing_to_do" });
    expect(await requestMeetingReprocess("b1", { dry: false, rerun: true, now: NOW })).toMatchObject({ ok: true, mode: "rerun", queued: true });
    expect(row("b1")).toMatchObject({ status: "failed", summary_email_sent_at: null });
  });

  it("refuses: nothing to do, nothing to read, cancelled, still running, another tenant's transcript, unknown id", async () => {
    m.tables.meeting_bots = [
      bot("done", { media_deleted_at: OLD }),
      bot("expired", { media_deleted_at: OLD, error: "distill failed" }),
      bot("cancelled", { status: "cancelled" }),
      bot("running", { status: "processing" }),
      bot("cross", { media_deleted_at: OLD, error: "distill failed" }),
    ];
    m.tables.meeting_notes = [
      { bot_id: "done", tenant_id: "t1", transcript: "Asha: hi", delete_after: LIVE },
      { bot_id: "expired", tenant_id: "t1", transcript: "Asha: hi", delete_after: PAST },
      { bot_id: "cross", tenant_id: "t2", transcript: "Asha: hi", delete_after: LIVE },
    ];
    expect(await requestMeetingReprocess("done", { dry: false, now: NOW })).toEqual({ ok: false, reason: "nothing_to_do" });
    expect(await requestMeetingReprocess("expired", { dry: false, now: NOW })).toEqual({ ok: false, reason: "nothing_to_read" });
    expect(await requestMeetingReprocess("cancelled", { dry: false, now: NOW })).toEqual({ ok: false, reason: "cancelled" });
    expect(await requestMeetingReprocess("running", { dry: false, now: NOW })).toEqual({ ok: false, reason: "in_progress" });
    expect(await requestMeetingReprocess("cross", { dry: false, now: NOW })).toEqual({ ok: false, reason: "nothing_to_read" });
    expect(await requestMeetingReprocess("missing", { dry: false, now: NOW })).toEqual({ ok: false, reason: "not_found" });
    expect(m.send).not.toHaveBeenCalled();
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });
});
