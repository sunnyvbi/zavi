import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeTranscript,
  transcriptToText,
  getBot,
  noRecordingReason,
  asRecallSubCode,
  classifyForReconcile,
  deleteBotMedia,
  cancelBot,
} from "../../services/meetings/recall";

describe("normalizeTranscript", () => {
  it("normalizes Recall async transcript participant/words shape", () => {
    const raw = [
      {
        participant: { name: "Jay Patel" },
        words: [
          { text: "I", start_timestamp: { relative: 12.5 } },
          { text: "fixed", start_timestamp: { relative: 12.9 } },
          { text: "change password", start_timestamp: { relative: 13.2 } },
        ],
      },
      {
        participant: { name: null },
        words: [{ text: "thanks", start_timestamp: { relative: 20 } }],
      },
    ];
    const segs = normalizeTranscript(raw);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({
      speaker: "Jay Patel",
      text: "I fixed change password",
      start_s: 12.5,
    });
    expect(segs[1].speaker).toBe("Unknown");
  });

  it("tolerates flat {speaker, text} shape and drops empty segments", () => {
    const segs = normalizeTranscript([
      { speaker: "Reethika", text: "released the Android ticket" },
      { speaker: "X", words: [] },
      { participant: { name: "Y" } },
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0].start_s).toBeNull();
  });

  it("returns [] on non-array garbage", () => {
    expect(normalizeTranscript(null)).toEqual([]);
    expect(normalizeTranscript({ nope: true })).toEqual([]);
    expect(normalizeTranscript("text")).toEqual([]);
  });

  it("transcriptToText renders speaker-prefixed lines", () => {
    const txt = transcriptToText([
      { speaker: "A", text: "hello", start_s: 0 },
      { speaker: "B", text: "world", start_s: 1 },
    ]);
    expect(txt).toBe("A: hello\nB: world");
  });
});

describe("classifyForReconcile", () => {
  const base = { transcript_download_url: null, recording_count: 0, ended: false };
  it("ready when a transcript url is downloadable", () => {
    expect(classifyForReconcile({ ...base, transcript_download_url: "https://s3/x", ended: true, recording_count: 1 }, 0)).toBe("ready");
  });
  it("in_progress when not ended", () => {
    expect(classifyForReconcile({ ...base, ended: false }, 99 * 60_000)).toBe("in_progress");
  });
  it("no_recording ONLY after the grace window (never admitted)", () => {
    expect(classifyForReconcile({ ...base, ended: true, recording_count: 0 }, 11 * 60_000)).toBe("no_recording");
  });
  it("in_progress (NOT no_recording) inside grace — recording may attach post-done", () => {
    expect(classifyForReconcile({ ...base, ended: true, recording_count: 0 }, 60_000)).toBe("in_progress");
  });
  it("rendering when recording exists + transcript pending within deadline", () => {
    expect(classifyForReconcile({ ...base, ended: true, recording_count: 1 }, 60_000)).toBe("rendering");
  });
  it("stale when transcript never renders past the deadline", () => {
    expect(classifyForReconcile({ ...base, ended: true, recording_count: 1 }, 31 * 60_000)).toBe("stale");
  });
});

describe("deleteBotMedia", () => {
  const origFetch = global.fetch;
  const origKey = process.env.RECALL_API_KEY;
  afterEach(() => {
    global.fetch = origFetch;
    process.env.RECALL_API_KEY = origKey;
  });

  function mockDelete(status: number, body = "") {
    process.env.RECALL_API_KEY = "test";
    global.fetch = vi.fn(
      async () =>
        ({
          ok: status >= 200 && status < 300,
          status,
          text: async () => body,
        }) as unknown as Response,
    ) as typeof fetch;
  }

  it("resolves only when Recall accepts the delete", async () => {
    mockDelete(200, "{}");
    await expect(deleteBotMedia("b-ok")).resolves.toBeUndefined();
  });

  it("throws on Recall 400 because in-progress media is not deleted", async () => {
    mockDelete(400, "Cannot delete media for an in-progress bot.");
    await expect(deleteBotMedia("b-in-progress")).rejects.toThrow(
      /recall delete media 400: Cannot delete media/,
    );
  });

  it("the error carries Recall's HTTP status, so a cleanup can tell a bot Recall no longer has (404)", async () => {
    mockDelete(404, "Not found.");
    await expect(deleteBotMedia("b-gone")).rejects.toMatchObject({ name: "RecallHttpError", status: 404 });
  });

  it("throws on Recall 409 because delete completion is not confirmed", async () => {
    mockDelete(409, "A request to delete media for this bot is already in progress.");
    await expect(deleteBotMedia("b-deleting")).rejects.toThrow(
      /recall delete media 409: A request to delete media/,
    );
  });
});

describe("getBot ended/recording detection", () => {
  const origFetch = global.fetch;
  const origKey = process.env.RECALL_API_KEY;
  afterEach(() => {
    global.fetch = origFetch;
    process.env.RECALL_API_KEY = origKey;
  });
  function mockBot(body: unknown) {
    process.env.RECALL_API_KEY = "test";
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response) as typeof fetch;
  }
  it("call_ended (BEFORE bot.done) is NOT terminal — ended=false, ended_at null", async () => {
    mockBot({ id: "b1", status_changes: [{ code: "call_ended", created_at: "2026-06-15T05:00:00Z" }], recordings: [] });
    const bot = await getBot("b1");
    expect(bot.ended).toBe(false);
    expect(bot.recording_count).toBe(0);
    expect(bot.ended_at).toBeNull();
  });
  it("done + recording + transcript url → ended, ended_at=done's created_at, ready url", async () => {
    mockBot({
      id: "b2",
      status_changes: [
        { code: "call_ended", created_at: "2026-06-15T05:00:00Z" },
        { code: "done", created_at: "2026-06-15T05:00:05Z" },
      ],
      recordings: [{ media_shortcuts: { transcript: { data: { download_url: "https://s3/t" } } } }],
    });
    const bot = await getBot("b2");
    expect(bot.ended).toBe(true);
    expect(bot.recording_count).toBe(1);
    expect(bot.transcript_download_url).toBe("https://s3/t");
    expect(bot.ended_at).toBe("2026-06-15T05:00:05Z");
  });
  it("done + zero recordings (never admitted) → ended, recording_count 0, null url; missing created_at → ended_at null (conservative)", async () => {
    mockBot({ id: "b3", status_changes: [{ code: "done" }], recordings: [] });
    const bot = await getBot("b3");
    expect(bot.ended).toBe(true);
    expect(bot.recording_count).toBe(0);
    expect(bot.transcript_download_url).toBeNull();
    expect(bot.ended_at).toBeNull();
    expect(bot.end_sub_code).toBeNull();
  });
  it("a fatal dead link → end_sub_code is the fatal change's sub_code", async () => {
    mockBot({
      id: "b4",
      status_changes: [
        { code: "joining_call", sub_code: null, created_at: "2026-10-27T04:31:00Z" },
        { code: "fatal", sub_code: "meeting_not_found", created_at: "2026-10-27T04:31:20Z" },
      ],
      recordings: [],
    });
    const bot = await getBot("b4");
    expect(bot.ended).toBe(true);
    expect(bot.end_sub_code).toBe("meeting_not_found");
  });
  it("a waiting-room timeout → end_sub_code comes from call_ended (done carries none)", async () => {
    mockBot({
      id: "b5",
      status_changes: [
        { code: "in_waiting_room", created_at: "2026-10-27T04:31:20Z" },
        { code: "call_ended", sub_code: "timeout_exceeded_waiting_room", created_at: "2026-10-27T04:41:20Z" },
        { code: "done", sub_code: null, created_at: "2026-10-27T04:41:25Z" },
      ],
      recordings: [],
    });
    expect((await getBot("b5")).end_sub_code).toBe("timeout_exceeded_waiting_room");
  });
  it("a sub_code that is not a plain snake_case code is dropped", async () => {
    mockBot({ id: "b6", status_changes: [{ code: "fatal", sub_code: "<script>Oops</script>" }], recordings: [] });
    expect((await getBot("b6")).end_sub_code).toBeNull();
  });
});

describe("noRecordingReason (what reconcile stores for a bot that recorded nothing)", () => {
  it("prefers Recall's end sub_code, then a specific stored code, else no_recording", () => {
    expect(noRecordingReason("meeting_not_found", null)).toBe("meeting_not_found");
    expect(noRecordingReason("timeout_exceeded_waiting_room", "meeting_not_found")).toBe("timeout_exceeded_waiting_room");
    expect(noRecordingReason(null, "meeting_not_found")).toBe("meeting_not_found");
    expect(noRecordingReason(null, null)).toBe("no_recording");
  });
  it("never treats Zavi's own generic reasons or free text as specific", () => {
    expect(noRecordingReason(null, "no_recording")).toBe("no_recording");
    expect(noRecordingReason(null, "fatal")).toBe("no_recording");
    expect(noRecordingReason("fatal", "transcript_stuck")).toBe("no_recording");
    expect(noRecordingReason(null, "transcript_failed:audio_missing")).toBe("no_recording");
    expect(noRecordingReason(null, "recall create bot 500: boom")).toBe("no_recording");
  });
  it("asRecallSubCode accepts only snake_case codes", () => {
    expect(asRecallSubCode(" meeting_not_found ")).toBe("meeting_not_found");
    expect(asRecallSubCode("Meeting Not Found")).toBeNull();
    expect(asRecallSubCode(42)).toBeNull();
    expect(asRecallSubCode("")).toBeNull();
  });
});

describe("cancelBot (Notetaker off calls back a sent bot)", () => {
  const origFetch = global.fetch;
  const origKey = process.env.RECALL_API_KEY;
  afterEach(() => {
    global.fetch = origFetch;
    process.env.RECALL_API_KEY = origKey;
  });

  type Reply = { status: number; body?: unknown };
  function mockRecall(routes: { del?: Reply; leave?: Reply; get?: Reply }) {
    process.env.RECALL_API_KEY = "test";
    const calls: Array<{ method: string; url: string }> = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      const r = method === "DELETE" ? routes.del : url.endsWith("/leave_call/") ? routes.leave : routes.get;
      const status = r?.status ?? 500;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => r?.body ?? {},
        text: async () => JSON.stringify(r?.body ?? ""),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }
  const botWith = (...codes: string[]) => ({ status: 200, body: { id: "b", status_changes: codes.map((code) => ({ code })), recordings: [] } });

  it("deletes a bot booked more than 10 minutes ahead (DELETE 204) and stops there", async () => {
    const calls = mockRecall({ del: { status: 204 } });
    await expect(cancelBot("b-1", { leaveIfInCall: true })).resolves.toBe("deleted");
    expect(calls).toEqual([{ method: "DELETE", url: "https://us-west-2.recall.ai/api/v1/bot/b-1/" }]);
  });

  it("on 405 cannot_delete_bot (under 10 minutes or joining) removes it with leave_call", async () => {
    const calls = mockRecall({ del: { status: 405, body: { code: "cannot_delete_bot" } }, leave: { status: 200, body: { id: "b-2" } } });
    await expect(cancelBot("b-2", { leaveIfInCall: true })).resolves.toBe("removed");
    expect(calls.map((c) => c.method + " " + c.url.replace("https://us-west-2.recall.ai", ""))).toEqual([
      "DELETE /api/v1/bot/b-2/",
      "POST /api/v1/bot/b-2/leave_call/",
    ]);
  });

  it("keeps a bot already in the call when leaveIfInCall is false (link cleared), without calling leave_call", async () => {
    const calls = mockRecall({ del: { status: 405 }, get: botWith("joining_call", "in_call_recording"), leave: { status: 200 } });
    await expect(cancelBot("b-3", { leaveIfInCall: false })).resolves.toBe("in_call");
    expect(calls.some((c) => c.url.endsWith("/leave_call/"))).toBe(false);
  });

  it("still removes a bot that has not got in yet when leaveIfInCall is false", async () => {
    mockRecall({ del: { status: 405 }, get: botWith("joining_call", "in_waiting_room"), leave: { status: 200 } });
    await expect(cancelBot("b-4", { leaveIfInCall: false })).resolves.toBe("removed");
  });

  it("treats a missing bot, or one that already ended, as gone", async () => {
    mockRecall({ del: { status: 404 } });
    await expect(cancelBot("b-5", { leaveIfInCall: true })).resolves.toBe("gone");
    mockRecall({ del: { status: 405 }, leave: { status: 400 }, get: botWith("in_call_recording", "call_ended", "done") });
    await expect(cancelBot("b-6", { leaveIfInCall: true })).resolves.toBe("gone");
  });

  it("throws when Recall refuses and the bot may still join, so the save can tell the team", async () => {
    mockRecall({ del: { status: 405 }, leave: { status: 400, body: "nope" }, get: botWith("joining_call") });
    await expect(cancelBot("b-7", { leaveIfInCall: true })).rejects.toThrow(/recall leave call 400/);
    mockRecall({ del: { status: 500, body: "boom" } });
    await expect(cancelBot("b-8", { leaveIfInCall: true })).rejects.toThrow(/recall delete bot 500/);
  });
});
