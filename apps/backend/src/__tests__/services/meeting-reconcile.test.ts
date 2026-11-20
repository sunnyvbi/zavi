import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    rows: Array<Record<string, unknown>>;
    scanError: { message: string } | null;
    transcriptUrlByBot: Record<string, string | null>;
    recordingCountByBot: Record<string, number>;
    endedByBot: Record<string, boolean>;
    endedAtByBot: Record<string, string | null>;
    endSubCodeByBot: Record<string, string | null>;
    getBotThrowsFor: string | null;
    terminalizeClaim: Array<{ id: string }>;
    resendRows: Array<Record<string, unknown>>;
    resendError: { message: string } | null;
  } = {
    rows: [],
    scanError: null,
    transcriptUrlByBot: {},
    recordingCountByBot: {},
    endedByBot: {},
    endedAtByBot: {},
    endSubCodeByBot: {},
    getBotThrowsFor: null,
    terminalizeClaim: [{ id: "claimed" }],
    resendRows: [],
    resendError: null,
  };

  const chains: Array<Record<string, unknown[][]>> = [];
  const from = vi.fn(() => {
    const calls: Record<string, unknown[][]> = {};
    chains.push(calls);
    const b: Record<string, unknown> = {};
    for (const fn of ["select", "in", "eq", "neq", "is", "not", "lt", "gt", "order", "update"]) {
      b[fn] = (...args: unknown[]) => {
        (calls[fn] ??= []).push(args);
        return b;
      };
    }
    b.limit = async (...args: unknown[]) => {
      (calls.limit ??= []).push(args);
      return calls.neq ? { data: state.resendRows, error: state.resendError } : { data: state.rows, error: state.scanError };
    };
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: state.terminalizeClaim, error: null });
    return b;
  });
  const serviceClient = vi.fn(() => ({ from }));

  const getBot = vi.fn(async (providerBotId: string) => {
    if (state.getBotThrowsFor === providerBotId) throw new Error("recall 500");
    return {
      id: providerBotId,
      status_code: "done",
      transcript_download_url: state.transcriptUrlByBot[providerBotId] ?? null,
      recording_count: state.recordingCountByBot[providerBotId] ?? 1,
      ended: state.endedByBot[providerBotId] ?? true,
      ended_at: state.endedAtByBot[providerBotId] ?? null,
      end_sub_code: state.endSubCodeByBot[providerBotId] ?? null,
    };
  });
  const recallConfigured = vi.fn(() => true);
  const deleteBotMedia = vi.fn(async (..._args: unknown[]) => undefined);
  const cancelBot = vi.fn(async (..._args: unknown[]): Promise<string> => "removed");
  const inngestSend = vi.fn(async (..._args: unknown[]) => ({ ids: ["evt"] }));

  return { state, chains, from, serviceClient, getBot, recallConfigured, deleteBotMedia, cancelBot, inngestSend };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/meetings/recall", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, getBot: m.getBot, recallConfigured: m.recallConfigured, deleteBotMedia: m.deleteBotMedia, cancelBot: m.cancelBot };
});
vi.mock("../../../workers/client", () => ({
  inngest: { send: m.inngestSend, createFunction: (_cfg: unknown, _trig: unknown, handler: unknown) => handler },
}));

import { runMeetingReconcile, cleanUpCancelledBots } from "../../../workers/functions/meeting-reconcile";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const scanChain = () => m.chains.find((c) => c.in)!;
const updateChains = () => m.chains.filter((c) => c.update);
const updatePatch = () => updateChains()[0].update[0][0] as Record<string, unknown>;
const NOW = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  m.state.rows = [];
  m.state.scanError = null;
  m.state.transcriptUrlByBot = {};
  m.state.recordingCountByBot = {};
  m.state.endedByBot = {};
  m.state.endedAtByBot = {};
  m.state.endSubCodeByBot = {};
  m.state.getBotThrowsFor = null;
  m.state.terminalizeClaim = [{ id: "claimed" }];
  m.state.resendRows = [];
  m.state.resendError = null;
  m.chains.length = 0;
  m.getBot.mockClear();
  m.recallConfigured.mockClear();
  m.recallConfigured.mockReturnValue(true);
  m.deleteBotMedia.mockReset();
  m.deleteBotMedia.mockResolvedValue(undefined);
  m.inngestSend.mockReset();
  m.inngestSend.mockResolvedValue({ ids: ["evt"] });
  m.cancelBot.mockReset();
  m.cancelBot.mockResolvedValue("removed");
  logger.info.mockClear();
  logger.warn.mockClear();
});

const OLD = "2026-06-15T11:00:00.000Z";

describe("runMeetingReconcile", () => {
  it("skips entirely when Recall is not configured", async () => {
    m.recallConfigured.mockReturnValue(false);
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 0, reEnqueued: 0, terminalized: 0 });
    expect(m.from).not.toHaveBeenCalled();
  });

  it("re-enqueues a failed/0-char bot once its transcript is ready", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "failed", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": "https://s3/transcript.json" };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 1, terminalized: 0 });
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
    const evt = m.inngestSend.mock.calls[0][0] as unknown as { id: string; name: string; data: { meeting_bot_id: string } };
    expect(evt.name).toBe("meeting.bot.status");
    const bucket = Math.floor(NOW.getTime() / (15 * 60 * 1000));
    expect(evt.id).toBe(`recall-reconcile:rb-1:${bucket}`);
    expect(evt.data.meeting_bot_id).toBe("mb-1");
  });

  it("does NOT enqueue when the transcript is still rendering (recording exists, within deadline)", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "processing", updated_at: NOW.toISOString() }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 1 };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 0 });
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("terminalizes a never-admitted bot (ended, 0 recordings, past grace) so it leaves the scan", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "failed", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 0 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": OLD };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 1 });
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
    expect((m.inngestSend.mock.calls[0][0] as unknown as { name: string }).name).toBe("meeting.notice");
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    const patch = updatePatch();
    expect(patch).toMatchObject({ status: "failed", error: "no_recording" });
    expect(patch.media_deleted_at).toBeTruthy();
  });

  it("terminalizes a transcript_stuck bot (recording exists, transcript never rendered past deadline) + frees the media", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "processing", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 1 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": OLD };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 1 });
    const patch = updatePatch();
    expect(patch).toMatchObject({ status: "failed", error: "transcript_stuck" });
    expect(m.deleteBotMedia).toHaveBeenCalledWith("rb-1");
  });

  it("does NOT mark media_deleted_at when Recall media delete fails", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "processing", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 1 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": OLD };
    m.deleteBotMedia.mockRejectedValueOnce(
      new Error("recall delete media 400: Cannot delete media for an in-progress bot."),
    );
    const out = await runMeetingReconcile(logger, NOW);

    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 0 });
    expect(m.deleteBotMedia).toHaveBeenCalledWith("rb-1");
    expect(updateChains()).toHaveLength(0);
  });

  it("does NOT terminalize a LONG meeting that just ended — age measured from remote ended_at, NOT stale local updated_at (Codex prosecutor regression)", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "processing", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 1 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": NOW.toISOString() };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("does NOT terminalize an ended bot when Recall gives no ended_at timestamp (conservative — unproven grace)", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "failed", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 0 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": null };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 0 });
  });

  it("does NOT terminalize a bot that has not ended yet (still in call)", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "processing", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 0 };
    m.state.endedByBot = { "rb-1": false };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("does NOT count a terminalize whose guarded CAS lost the race (concurrent success won)", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "failed", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 0 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": OLD };
    m.state.terminalizeClaim = [];
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 0, terminalized: 0 });
  });

  it("a single bot's Recall error does not abort the sweep", async () => {
    m.state.rows = [
      { id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "failed" },
      { id: "mb-2", tenant_id: "t-1", provider_bot_id: "rb-2", status: "failed" },
    ];
    m.state.getBotThrowsFor = "rb-1";
    m.state.transcriptUrlByBot = { "rb-2": "https://s3/t2.json" };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out.scanned).toBe(2);
    expect(out.reEnqueued).toBe(1);
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
  });

  function deadBot(row: Record<string, unknown> = {}) {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "failed", updated_at: OLD, error: null, ...row }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 0 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": OLD };
  }
  const patchError = () => updatePatch().error;

  it("keeps the webhook's specific reason (meeting_not_found) instead of overwriting it with no_recording", async () => {
    deadBot({ error: "meeting_not_found" });
    const out = await runMeetingReconcile(logger, NOW);
    expect(out.terminalized).toBe(1);
    expect(patchError()).toBe("meeting_not_found");
  });

  it("queues the failure notice for the retried delivery worker, one event per bot (the row leaves the scan now)", async () => {
    deadBot({ error: "meeting_not_found" });
    await runMeetingReconcile(logger, NOW);
    expect(m.inngestSend).toHaveBeenCalledWith({
      id: "meeting-notice:no_record:mb-1",
      name: "meeting.notice",
      data: { meeting_bot_id: "mb-1", tenant_id: "t-1" },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("reason=meeting_not_found notice=queued"));
  });

  it("if the notice cannot be queued, never posts around the worker: the row stays unhandled for the re-send pass", async () => {
    deadBot({ error: "meeting_not_found" });
    m.inngestSend.mockRejectedValueOnce(new Error("inngest 503"));
    const out = await runMeetingReconcile(logger, NOW);
    expect(out.terminalized).toBe(1);
    expect(updatePatch()).not.toHaveProperty("failed_notice_at");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("reason=meeting_not_found notice=queue_failed"));
  });

  it("takes the reason from Recall's own status_changes when the webhook never stored it (dropped delivery)", async () => {
    deadBot({ error: null });
    m.state.endSubCodeByBot = { "rb-1": "meeting_not_found" };
    await runMeetingReconcile(logger, NOW);
    expect(patchError()).toBe("meeting_not_found");
  });

  it("prefers Recall's reason over a generic stored one, and keeps a waiting-room timeout", async () => {
    deadBot({ error: "fatal" });
    m.state.endSubCodeByBot = { "rb-1": "timeout_exceeded_waiting_room" };
    await runMeetingReconcile(logger, NOW);
    expect(patchError()).toBe("timeout_exceeded_waiting_room");
  });

  it("stays generic no_recording when nobody knows why (and ignores free-text errors as reasons)", async () => {
    deadBot({ error: "recall create bot 500: upstream exploded" });
    await runMeetingReconcile(logger, NOW);
    expect(patchError()).toBe("no_recording");
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("does not post a no-record notice for a transcript that never rendered", async () => {
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "processing", updated_at: OLD, error: null }];
    m.state.transcriptUrlByBot = { "rb-1": null };
    m.state.recordingCountByBot = { "rb-1": 1 };
    m.state.endedByBot = { "rb-1": true };
    m.state.endedAtByBot = { "rb-1": OLD };
    await runMeetingReconcile(logger, NOW);
    expect(patchError()).toBe("transcript_stuck");
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("does not queue a notice when the terminalize CAS lost the race", async () => {
    deadBot({ error: "meeting_not_found" });
    m.state.terminalizeClaim = [];
    await runMeetingReconcile(logger, NOW);
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("re-sends a failure notice that is still unhandled 20+ minutes after its bot was terminalized", async () => {
    m.state.resendRows = [{ id: "mb-9", tenant_id: "t-9" }];
    await runMeetingReconcile(logger, NOW);
    const bucket = Math.floor(NOW.getTime() / (15 * 60 * 1000));
    expect(m.inngestSend).toHaveBeenCalledWith({
      id: `meeting-notice:no_record:mb-9:${bucket}`,
      name: "meeting.notice",
      data: { meeting_bot_id: "mb-9", tenant_id: "t-9" },
    });
    const resend = m.chains.find((c) => c.neq)!;
    expect(resend.eq).toEqual([["status", "failed"], ["transcript_chars", 0]]);
    expect(resend.is).toEqual([["failed_notice_at", null]]);
    expect(resend.not).toEqual([["media_deleted_at", "is", null], ["provider_bot_id", "is", null]]);
    expect(resend.neq).toEqual([["error", "transcript_stuck"]]);
    expect(resend.lt).toEqual([["updated_at", new Date(NOW.getTime() - 20 * 60 * 1000).toISOString()]]);
    expect(resend.gt).toEqual([["updated_at", new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString()]]);
    expect(resend.limit).toEqual([[25]]);
  });

  it("a failing re-send pass never breaks the sweep", async () => {
    m.state.resendError = { message: "timeout" };
    m.state.rows = [{ id: "mb-1", tenant_id: "t-1", provider_bot_id: "rb-1", status: "failed", updated_at: OLD }];
    m.state.transcriptUrlByBot = { "rb-1": "https://s3/transcript.json" };
    const out = await runMeetingReconcile(logger, NOW);
    expect(out).toEqual({ scanned: 1, reEnqueued: 1, terminalized: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unhandled-notice scan failed"));
  });

  it("applies the scan filters (status/0-chars/media-null/aged, capped)", async () => {
    await runMeetingReconcile(logger, NOW);
    const scan = scanChain();
    expect(scan.select).toBeTruthy();
    expect(scan.in).toEqual([["status", ["processing", "failed"]]]);
    expect(scan.eq).toContainEqual(["transcript_chars", 0]);
    expect(scan.is).toContainEqual(["media_deleted_at", null]);
    expect(scan.limit).toEqual([[25]]);
  });
});

describe("cleanUpCancelledBots (bots Zavi called back when Notetaker was turned off)", () => {
  it("scans only cancelled rows with a Recall bot and media not yet handled, with no age cut-off", async () => {
    await cleanUpCancelledBots(logger, NOW);
    const scan = m.chains[0];
    expect(scan.eq).toContainEqual(["status", "cancelled"]);
    expect(scan.is).toContainEqual(["media_deleted_at", null]);
    expect(scan.not).toContainEqual(["provider_bot_id", "is", null]);
    expect(scan.gt).toBeUndefined();
    expect(scan.lt).toBeUndefined();
  });

  it("retries a cancel Recall refused before cleaning up", async () => {
    m.state.rows = [{ id: "mb-stuck", provider_bot_id: "rb-stuck", error: "cancel_failed" }];
    m.state.recordingCountByBot = { "rb-stuck": 1 };
    expect(await cleanUpCancelledBots(logger, NOW)).toEqual({ cleaned: 1 });
    expect(m.cancelBot).toHaveBeenCalledWith("rb-stuck", { leaveIfInCall: true });
    expect(updateChains()[0].update[0][0]).toMatchObject({ error: "cancelled_retried" });
    expect(m.deleteBotMedia).toHaveBeenCalledWith("rb-stuck");
  });

  it("a refused retry leaves the row for the next sweep", async () => {
    m.state.rows = [{ id: "mb-stuck", provider_bot_id: "rb-stuck", error: "cancel_failed" }];
    m.cancelBot.mockRejectedValueOnce(new Error("recall leave call 400"));
    expect(await cleanUpCancelledBots(logger, NOW)).toEqual({ cleaned: 0 });
    expect(updateChains()).toHaveLength(0);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("a bot Recall no longer has (404) holds nothing: marked without a delete call", async () => {
    const { RecallHttpError } = await import("@/services/meetings/recall");
    m.state.rows = [{ id: "mb-gone", provider_bot_id: "rb-gone" }];
    m.getBot.mockRejectedValueOnce(new RecallHttpError(404, "recall get bot 404: not found"));
    expect(await cleanUpCancelledBots(logger, NOW)).toEqual({ cleaned: 1 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(updatePatch()).toEqual({ media_deleted_at: NOW.toISOString() });
  });

  it("once Recall says the bot ended, deletes its partial recording and marks the row", async () => {
    m.state.rows = [{ id: "mb-left", provider_bot_id: "rb-left" }];
    m.state.recordingCountByBot = { "rb-left": 1 };
    const out = await cleanUpCancelledBots(logger, NOW);
    expect(out).toEqual({ cleaned: 1 });
    expect(m.deleteBotMedia).toHaveBeenCalledWith("rb-left");
    expect(updatePatch()).toEqual({ media_deleted_at: NOW.toISOString() });
    expect(updateChains()[0].eq).toContainEqual(["status", "cancelled"]);
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("a bot that never recorded is marked without a delete call", async () => {
    m.state.rows = [{ id: "mb-none", provider_bot_id: "rb-none" }];
    m.state.recordingCountByBot = { "rb-none": 0 };
    expect(await cleanUpCancelledBots(logger, NOW)).toEqual({ cleaned: 1 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("leaves a bot still leaving the call, and a failed Recall read, for the next sweep", async () => {
    m.state.rows = [
      { id: "mb-leaving", provider_bot_id: "rb-leaving" },
      { id: "mb-err", provider_bot_id: "rb-err" },
    ];
    m.state.endedByBot = { "rb-leaving": false };
    m.state.getBotThrowsFor = "rb-err";
    expect(await cleanUpCancelledBots(logger, NOW)).toEqual({ cleaned: 0 });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(updateChains()).toHaveLength(0);
  });
});
