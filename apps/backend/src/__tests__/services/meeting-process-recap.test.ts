import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const m = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  const failSettingsRead = { on: false };
  const failStatusRead = { on: false };
  const failNotesSave = { on: false };

  function from(table: string) {
    const rows = (tables[table] ??= []);
    const preds: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "upsert" | "insert" | "delete" = "select";
    let patch: Row | Row[] | null = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let head = false;
    let selectedCols = "";
    let returning = false;
    const matches = () => rows.filter((r) => preds.every((p) => p(r)));
    const run = (): { data: unknown; error: unknown; count?: number } => {
      if (table === "tenant_meeting_settings" && op === "select" && failSettingsRead.on) {
        return { data: null, error: { message: "db down" } };
      }
      if (table === "meeting_bots" && op === "select" && selectedCols === "status" && failStatusRead.on) {
        return { data: null, error: { message: "db down" } };
      }
      if (op === "select") {
        const hit = matches();
        return head ? { data: null, error: null, count: hit.length } : { data: hit, error: null };
      }
      if (op === "update") {
        const hit = matches();
        for (const r of hit) Object.assign(r, patch as Row);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (table === "meeting_notes" && op === "upsert" && failNotesSave.on) {
        return { data: null, error: { message: "notes table down" } };
      }
      if (op === "delete") {
        const hit = matches();
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: returning ? hit : null, error: null };
      }
      const list = Array.isArray(patch) ? patch : [patch as Row];
      for (const row of list) {
        const key = upsertOpts.onConflict;
        const existing = op === "upsert" && key ? rows.find((r) => r[key] === row[key]) : undefined;
        if (existing) {
          if (!upsertOpts.ignoreDuplicates) Object.assign(existing, row);
        } else {
          const dflt = table === "meeting_notes" ? { delete_after: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {};
          rows.push({ ...dflt, ...row });
        }
      }
      return { data: null, error: null };
    };
    const q: any = {
      select: (c?: string, o?: { head?: boolean }) => {
        if (op === "select") {
          head = Boolean(o?.head);
          selectedCols = c ?? "";
        }
        else returning = true;
        return q;
      },
      eq: (c: string, v: unknown) => {
        const [col, key] = c.split("->>");
        return preds.push((r) => (key ? (r[col] as Row | undefined)?.[key] : r[col]) === v), q;
      },
      neq: (c: string, v: unknown) => (preds.push((r) => r[c] !== v), q),
      is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), q),
      lt: (c: string, v: unknown) => (preds.push((r) => r[c] != null && String(r[c]) < String(v)), q),
      limit: () => q,
      update: (p: Row) => ((op = "update"), (patch = p), q),
      insert: (p: Row | Row[]) => ((op = "insert"), (patch = p), q),
      upsert: (p: Row, o: typeof upsertOpts = {}) => ((op = "upsert"), (patch = p), (upsertOpts = o), q),
      delete: () => ((op = "delete"), q),
      maybeSingle: async () => {
        const out = run();
        if (out.error) return out;
        const d = out.data as Row[] | null;
        return { data: Array.isArray(d) ? (d[0] ?? null) : d, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  }

  const sendMeetingSummaryEmail = vi.fn(async (..._a: unknown[]) => ({ sent: 1 }));
  const sendChooseDestinationEmail = vi.fn(async (..._a: unknown[]) => ({ sent: 1 }));
  const sendRecapPostFailedEmail = vi.fn(async (..._a: unknown[]) => ({ sent: 1 }));
  const sendDistillFailureOpsAlert = vi.fn(async (..._a: unknown[]) => ({ sent: true }));
  const slackFetch = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true }));
  const uploadFileToThread = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
  const distillTranscript = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
  const deleteBotMedia = vi.fn(async (..._a: unknown[]) => undefined);
  const getBot = vi.fn(async (..._a: unknown[]) => ({ transcript_download_url: "https://recall.example/t" }));
  const writeNote = vi.fn(async (..._a: unknown[]) => ({ note_id: "n1" }));
  const rpc = vi.fn(async (..._a: unknown[]): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null }));
  return {
    tables,
    failSettingsRead,
    failStatusRead,
    failNotesSave,
    getBot,
    rpc,
    writeNote,
    from,
    sendMeetingSummaryEmail,
    sendChooseDestinationEmail,
    sendRecapPostFailedEmail,
    sendDistillFailureOpsAlert,
    slackFetch,
    uploadFileToThread,
    distillTranscript,
    deleteBotMedia,
  };
});

vi.mock("../../../workers/client", () => ({
  inngest: { send: vi.fn(), createFunction: (_c: unknown, _t: unknown, handler: unknown) => handler },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/services/meetings/recall", () => ({
  getBot: m.getBot,
  fetchTranscript: async () => [
    { speaker: "Asha", text: "We ship the pricing page Friday." },
    { speaker: "Ben", text: "I will review it Thursday." },
  ],
  deleteBotMedia: m.deleteBotMedia,
  transcriptToText: (segs: Array<{ speaker: string; text: string }>) => segs.map((s) => `${s.speaker}: ${s.text}`).join("\n"),
}));
vi.mock("@/services/meetings/distill", () => ({ distillTranscript: m.distillTranscript, defaultExpiry: () => null }));
vi.mock("@/services/meetings/minutes", () => ({
  generateMinutes: async () => ({ tldr: "Pricing page ships Friday.", decisions: ["Ship Friday"], action_items: [], topics: [], open_questions: [] }),
}));
vi.mock("@/services/meetings/summary-email", () => ({
  sendMeetingSummaryEmail: m.sendMeetingSummaryEmail,
  sendChooseDestinationEmail: m.sendChooseDestinationEmail,
  sendRecapPostFailedEmail: m.sendRecapPostFailedEmail,
  sendDistillFailureOpsAlert: m.sendDistillFailureOpsAlert,
  renderMeetingSummary: () => ({ subject: "s", html: "h", text: "SUMMARY: Pricing page ships Friday." }),
}));
vi.mock("@/services/memory", () => ({ writeNote: m.writeNote }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: m.uploadFileToThread }));

import {
  meetingProcessFn,
  deleteExpiredMeetingNotes,
  blankOldMeetingExcerpts,
  meetingNotesRetentionFn,
} from "../../../workers/functions/meeting-process";

const handler = meetingProcessFn as unknown as (ctx: unknown) => Promise<unknown>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const T = "tenant-1";

function bot(over: Row = {}): Row {
  return {
    id: "b1",
    tenant_id: T,
    provider_bot_id: "rb1",
    status: "call_ended",
    scheduled_date: "2026-10-27",
    source: "scheduled",
    requested_by: null,
    slack_team_id: null,
    slack_channel_id: null,
    slack_thread_ts: null,
    summary_email_sent_at: null,
    default_slack_posted_at: null,
    ...over,
  };
}

function seed(settings: Row | null, botOver: Row = {}) {
  for (const k of Object.keys(m.tables)) delete m.tables[k];
  m.tables.meeting_bots = [bot(botOver)];
  m.tables.tenants = [{ id: T, name: "Acme" }];
  m.tables.meeting_atoms = [];
  m.tables.meeting_notes = [];
  m.tables.tenant_meeting_settings = settings ? [{ tenant_id: T, recap_destination: null, choose_destination_email_at: null, slack_channel_id: null, slack_channel_name: null, ...settings }] : [];
}

const run = (attempt?: number) =>
  handler({
    event: { data: { meeting_bot_id: "b1", tenant_id: "payload-tenant-is-ignored" } },
    step: { run: async (_name: string, fn: () => unknown) => fn() },
    logger,
    attempt,
  });

const posts = () => m.slackFetch.mock.calls.filter((c) => c[1] === "chat.postMessage").map((c) => c[2] as Row);

beforeEach(() => {
  m.failSettingsRead.on = false;
  m.failStatusRead.on = false;
  m.failNotesSave.on = false;
  m.getBot.mockClear();
  m.rpc.mockReset();
  m.rpc.mockImplementation(async () => ({ data: null, error: null }));
  m.sendDistillFailureOpsAlert.mockReset();
  m.sendDistillFailureOpsAlert.mockResolvedValue({ sent: true });
  for (const f of [
    m.sendMeetingSummaryEmail,
    m.sendChooseDestinationEmail,
    m.sendRecapPostFailedEmail,
    m.sendDistillFailureOpsAlert,
    m.slackFetch,
    m.uploadFileToThread,
    m.deleteBotMedia,
  ]) f.mockClear();
  m.slackFetch.mockImplementation(async () => ({ ok: true }));
  m.deleteBotMedia.mockReset();
  m.deleteBotMedia.mockResolvedValue(undefined);
  m.distillTranscript.mockReset();
  m.distillTranscript.mockResolvedValue([]);
  logger.error.mockClear();
  m.writeNote.mockClear();
});

describe("meeting-process: lasting facts save to the brain with no card", () => {
  const BOT = "11111111-1111-4111-8111-111111111111";
  const seedFacts = () => {
    seed({ recap_destination: "off" }, { id: BOT });
    m.tables.decisions = [];
    m.distillTranscript.mockResolvedValue([
      { atom_type: "decision", title: "Pricing page ships Fridays", body: "Ship cadence is Friday.", owner: "Asha", confidence: "high", memory_class: "canonical", source_excerpt: "We ship the pricing page Friday." },
      { atom_type: "commitment", title: "Ben reviews Thursday", body: "", owner: "Ben", confidence: "high", memory_class: "active_ops", source_excerpt: "" },
    ]);
  };
  const runFacts = (onStep?: (name: string) => void) =>
    handler({
      event: { data: { meeting_bot_id: BOT } },
      step: { run: async (n: string, fn: () => unknown) => (onStep?.(n), fn()) },
      logger,
    });

  it("a meeting turned off after its facts were stored writes nothing to the brain", async () => {
    seedFacts();
    await runFacts((n) => {
      if (n === "save-facts") m.tables.meeting_bots[0].status = "cancelled";
    });
    expect(m.writeNote).not.toHaveBeenCalled();
    expect(m.tables.meeting_atoms.find((a) => a.memory_class === "canonical")?.status).toBe("pending_review");
  });

  it("Notetaker turned off while the meeting was still processing writes nothing to the brain", async () => {
    seedFacts();
    m.tables.tenant_meeting_settings = [{ tenant_id: T, enabled: false }];
    await runFacts();
    expect(m.writeNote).not.toHaveBeenCalled();
    expect(m.tables.meeting_atoms.find((a) => a.memory_class === "canonical")?.status).toBe("pending_review");
  });

  it("a meeting that already has a Save-notes card (here rejected) is left to the card: nothing is auto-written", async () => {
    seedFacts();
    m.tables.decisions = [
      { id: "d1", tenant_id: T, decision_class: "notetaker.write_atoms", status: "rejected", body: { meeting_bot_id: BOT } },
    ];
    await runFacts();
    expect(m.writeNote).not.toHaveBeenCalled();
    expect(m.tables.meeting_atoms.find((a) => a.memory_class === "canonical")?.status).toBe("pending_review");
  });

  it("writes the canonical fact straight to the brain, marks it approved, and proposes no decision", async () => {
    seedFacts();
    await runFacts();
    expect(m.writeNote).toHaveBeenCalledTimes(1);
    const [tenant, note] = m.writeNote.mock.calls[0] as [string, Row];
    expect(tenant).toBe(T);
    expect(note).toMatchObject({ title: "[standup 2026-10-27] Pricing page ships Fridays", source: "meeting_distill", source_ref: `meeting:${BOT}` });
    expect(m.rpc).not.toHaveBeenCalledWith("emit_decision", expect.anything());
    const canonical = m.tables.meeting_atoms.find((a) => a.memory_class === "canonical");
    expect(canonical?.status).toBe("approved");
    expect(m.tables.meeting_atoms.find((a) => a.memory_class === "active_ops")?.status).toBe("auto_stored");
  });
});

describe("meeting-process: notes stay in Zavi", () => {
  it("saves the written summary and the transcript for the bot's own tenant, once", async () => {
    seed({ recap_destination: "off" });
    await run();
    expect(m.tables.meeting_notes).toHaveLength(1);
    const notes = m.tables.meeting_notes[0];
    expect(notes).toMatchObject({ bot_id: "b1", tenant_id: T });
    expect(notes.minutes).toMatchObject({ tldr: "Pricing page ships Friday." });
    expect(notes.transcript).toBe("Asha: We ship the pricing page Friday.\nBen: I will review it Thursday.");
    m.tables.meeting_notes[0].delete_after = "2026-11-26T00:00:00Z";
    m.tables.meeting_bots[0].status = "processing";
    await run();
    expect(m.tables.meeting_notes).toHaveLength(1);
    expect(m.tables.meeting_notes[0].delete_after).toBe("2026-11-26T00:00:00Z");
  });
});

describe("meeting-process: where the summary goes", () => {
  it("not chosen: nothing is posted or emailed, not even to the summon thread; the owner is asked once", async () => {
    seed({ recap_destination: null, slack_channel_id: null }, { slack_channel_id: "C-THREAD", slack_thread_ts: "1.2" });
    await run();
    expect(posts()).toHaveLength(0);
    expect(m.sendMeetingSummaryEmail).not.toHaveBeenCalled();
    expect(m.sendChooseDestinationEmail).toHaveBeenCalledTimes(1);
    expect(m.sendChooseDestinationEmail).toHaveBeenCalledWith(T);
    expect(m.tables.tenant_meeting_settings[0].choose_destination_email_at).toBeTruthy();

    m.tables.meeting_bots.push(bot({ id: "b2", provider_bot_id: "rb2" }));
    await handler({ event: { data: { meeting_bot_id: "b2" } }, step: { run: async (_n: string, fn: () => unknown) => fn() }, logger });
    expect(m.sendChooseDestinationEmail).toHaveBeenCalledTimes(1);
    expect(m.tables.meeting_notes).toHaveLength(2);
  });

  it("not chosen and no settings row at all: a row is made to hold the ask, and no channel is posted to", async () => {
    seed(null);
    await run();
    expect(posts()).toHaveLength(0);
    expect(m.sendChooseDestinationEmail).toHaveBeenCalledTimes(1);
    expect(m.tables.tenant_meeting_settings).toHaveLength(1);
    expect(m.tables.tenant_meeting_settings[0]).toMatchObject({ tenant_id: T });
  });

  it("a channel saved before the choice existed is never posted to", async () => {
    seed({ recap_destination: null, slack_channel_id: "C-OLD", slack_channel_name: "zavi-updates" });
    await run();
    expect(posts()).toHaveLength(0);
    expect(m.uploadFileToThread).not.toHaveBeenCalled();
  });

  it("off: nothing leaves Zavi and nobody is asked", async () => {
    seed({ recap_destination: "off" }, { slack_channel_id: "C-THREAD", slack_thread_ts: "1.2", requested_by: "u-9" });
    await run();
    expect(posts()).toHaveLength(0);
    expect(m.sendMeetingSummaryEmail).not.toHaveBeenCalled();
    expect(m.sendChooseDestinationEmail).not.toHaveBeenCalled();
    expect(m.tables.meeting_notes).toHaveLength(1);
  });

  it("email: the summary email to owner + requester and the summon-thread reply; no channel post", async () => {
    seed({ recap_destination: "email" }, { slack_channel_id: "C-THREAD", slack_thread_ts: "1.2", requested_by: "u-9" });
    await run();
    expect(m.sendMeetingSummaryEmail).toHaveBeenCalledTimes(1);
    expect(m.sendMeetingSummaryEmail.mock.calls[0][0]).toMatchObject({ tenant_id: T, requested_by: "u-9" });
    expect(posts()).toEqual([expect.objectContaining({ channel: "C-THREAD", thread_ts: "1.2" })]);
    expect(m.uploadFileToThread).not.toHaveBeenCalled();
  });

  it("slack: the team channel gets the summary and the transcript file; no email", async () => {
    seed({ recap_destination: "slack", slack_channel_id: "C-TEAM", slack_channel_name: "standups" });
    await run();
    expect(posts()).toEqual([expect.objectContaining({ channel: "C-TEAM", text: "SUMMARY: Pricing page ships Friday." })]);
    expect(m.uploadFileToThread).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, channel_id: "C-TEAM" }));
    expect(m.sendMeetingSummaryEmail).not.toHaveBeenCalled();
    expect(m.tables.meeting_bots[0].default_slack_posted_at).toBeTruthy();
  });

  it("slack + summoned from a thread: the thread reply and the team channel", async () => {
    seed({ recap_destination: "slack", slack_channel_id: "C-TEAM", slack_channel_name: "standups" }, { slack_channel_id: "C-THREAD", slack_thread_ts: "1.2" });
    await run();
    expect(posts().map((p) => p.channel)).toEqual(["C-THREAD", "C-TEAM"]);
  });

  it("slack refused the post: the owner gets one email with no meeting content, and a replay neither posts nor emails again", async () => {
    seed({ recap_destination: "slack", slack_channel_id: "C-TEAM", slack_channel_name: "standups" });
    m.slackFetch.mockImplementation(async () => {
      throw new Error("Slack API chat.postMessage not ok: not_in_channel");
    });
    await run();
    expect(m.sendRecapPostFailedEmail).toHaveBeenCalledTimes(1);
    expect(m.sendRecapPostFailedEmail).toHaveBeenCalledWith(T, "standups");
    expect(m.uploadFileToThread).not.toHaveBeenCalled();

    m.slackFetch.mockImplementation(async () => ({ ok: true }));
    m.tables.meeting_bots[0].status = "processing";
    await run();
    expect(posts()).toHaveLength(1);
    expect(m.sendRecapPostFailedEmail).toHaveBeenCalledTimes(1);
  });

  it("switched to off after the plan was made: no send step uses the remembered plan", async () => {
    seed({ recap_destination: "slack", slack_channel_id: "C-TEAM", slack_channel_name: "standups" }, { slack_channel_id: "C-THREAD", slack_thread_ts: "1.2" });
    await handler({
      event: { data: { meeting_bot_id: "b1" } },
      step: {
        run: async (name: string, fn: () => unknown) => {
          const out = await fn();
          if (name === "recap-plan") Object.assign(m.tables.tenant_meeting_settings[0], { recap_destination: "off", slack_channel_id: null });
          return out;
        },
      },
      logger,
    });
    expect(posts()).toHaveLength(0);
    expect(m.uploadFileToThread).not.toHaveBeenCalled();
    expect(m.tables.meeting_bots[0].default_slack_posted_at).toBeNull();
  });

  it("switched from email to slack after the plan: the email is not sent", async () => {
    seed({ recap_destination: "email" });
    await handler({
      event: { data: { meeting_bot_id: "b1" } },
      step: {
        run: async (name: string, fn: () => unknown) => {
          const out = await fn();
          if (name === "recap-plan") Object.assign(m.tables.tenant_meeting_settings[0], { recap_destination: "slack", slack_channel_id: "C-NEW" });
          return out;
        },
      },
      logger,
    });
    expect(m.sendMeetingSummaryEmail).not.toHaveBeenCalled();
  });

  it("the choose-where email that could not be sent is asked again at the next meeting", async () => {
    seed({ recap_destination: null });
    m.sendChooseDestinationEmail.mockResolvedValueOnce({ sent: 0, reason: "no_recipients" } as never);
    await run();
    expect(m.tables.tenant_meeting_settings[0].choose_destination_email_at).toBeNull();
    m.tables.meeting_bots.push(bot({ id: "b2", provider_bot_id: "rb2" }));
    await handler({ event: { data: { meeting_bot_id: "b2" } }, step: { run: async (_n: string, fn: () => unknown) => fn() }, logger });
    expect(m.sendChooseDestinationEmail).toHaveBeenCalledTimes(2);
    expect(m.tables.tenant_meeting_settings[0].choose_destination_email_at).toBeTruthy();
  });

  it("the team channel is posted with the primary workspace token (where the channel was looked up), even for a meeting summoned from another workspace", async () => {
    seed({ recap_destination: "slack", slack_channel_id: "C-TEAM", slack_channel_name: "standups" }, { slack_team_id: "T-SECOND", slack_channel_id: "C-THREAD", slack_thread_ts: "1.2" });
    await run();
    const calls = m.slackFetch.mock.calls.filter((c) => c[1] === "chat.postMessage");
    expect(calls.find((c) => (c[2] as Row).channel === "C-THREAD")?.[3]).toBe("T-SECOND");
    expect(calls.find((c) => (c[2] as Row).channel === "C-TEAM")?.[3]).toBeUndefined();
  });

  it("a settings read error sends nothing (fail closed); the notes are still saved", async () => {
    seed({ recap_destination: "slack", slack_channel_id: "C-TEAM" });
    m.failSettingsRead.on = true;
    await run();
    expect(posts()).toHaveLength(0);
    expect(m.sendMeetingSummaryEmail).not.toHaveBeenCalled();
    expect(m.sendChooseDestinationEmail).not.toHaveBeenCalled();
    expect(m.tables.meeting_notes).toHaveLength(1);
  });

  it("a status read error never saves or posts blind (it might hide a cancel): the step throws so Inngest retries it", async () => {
    seed({ recap_destination: "email" }, { slack_channel_id: "C-THREAD", slack_thread_ts: "1.2" });
    const failFrom = (stepName: string) =>
      handler({
        event: { data: { meeting_bot_id: "b1" } },
        step: {
          run: async (name: string, fn: () => unknown) => {
            m.failStatusRead.on = name === stepName;
            try {
              return await fn();
            } finally {
              m.failStatusRead.on = false;
            }
          },
        },
        logger,
      });
    await expect(failFrom("save-notes")).rejects.toThrow(/notes save: bot status read failed/);
    expect(m.tables.meeting_notes).toHaveLength(0);

    seed({ recap_destination: "email" }, { slack_channel_id: "C-THREAD", slack_thread_ts: "1.2" });
    await expect(failFrom("slack-summary")).rejects.toThrow(/thread summary: bot status read failed/);
    expect(posts()).toHaveLength(0);
    m.tables.meeting_bots[0].status = "processing";
    await run();
    expect(posts()).toHaveLength(1);
  });

  it("a distill failure still pages ops whatever the team chose", async () => {
    seed({ recap_destination: "off" });
    m.distillTranscript.mockRejectedValue(new Error("llm down"));
    await run();
    expect(m.sendDistillFailureOpsAlert).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });

  it("a meeting cancelled before processing saves and sends nothing", async () => {
    seed({ recap_destination: "slack", slack_channel_id: "C-TEAM" }, { status: "cancelled" });
    await run();
    expect(m.tables.meeting_notes).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });
});

describe("meeting-process: the recording at Recall is deleted once the transcript is saved in Zavi", () => {
  const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0];

  it("deletes the recording right after the transcript is saved, before any summary is sent", async () => {
    seed({ recap_destination: "email" });
    await run();
    expect(m.tables.meeting_notes).toHaveLength(1);
    expect(m.deleteBotMedia).toHaveBeenCalledTimes(1);
    expect(m.deleteBotMedia).toHaveBeenCalledWith("rb1");
    expect(m.tables.meeting_bots[0].media_deleted_at).toBeTruthy();
    expect(order(m.deleteBotMedia)).toBeLessThan(order(m.sendMeetingSummaryEmail));
  });

  it("a failed automatic summary still deletes the recording, and says the transcript is saved", async () => {
    seed({ recap_destination: "email" });
    m.distillTranscript.mockRejectedValue(new Error("llm down"));
    await run();
    expect(m.tables.meeting_notes[0].transcript).toContain("Asha: We ship the pricing page Friday.");
    expect(m.deleteBotMedia).toHaveBeenCalledWith("rb1");
    expect(m.tables.meeting_bots[0].media_deleted_at).toBeTruthy();
    expect(m.sendDistillFailureOpsAlert.mock.calls[0][0]).toMatchObject({ meeting_bot_id: "b1", kind: "distill_failed", transcript_saved: true });
    expect(m.sendMeetingSummaryEmail.mock.calls[0][0]).toMatchObject({ distill_failed: true, transcript_saved: true, team_alerted: true });
  });

  it("an ops page that did not go out: the failure notice does not say the team was told", async () => {
    seed({ recap_destination: "email" });
    m.distillTranscript.mockRejectedValue(new Error("llm down"));
    m.sendDistillFailureOpsAlert.mockResolvedValue({ sent: false, logged: true } as never);
    await run();
    expect(m.sendMeetingSummaryEmail.mock.calls[0][0]).toMatchObject({ distill_failed: true, team_alerted: false });
  });

  it("an ops page that reached neither email nor praxis_logs is retried; on the last attempt the run goes on", async () => {
    seed({ recap_destination: "email" });
    m.distillTranscript.mockRejectedValue(new Error("llm down"));
    m.sendDistillFailureOpsAlert.mockResolvedValue({ sent: false, logged: false } as never);
    await expect(run(0)).rejects.toThrow(/ops page: neither the email nor the log row landed/);
    seed({ recap_destination: "email" });
    await run(2);
    expect(m.sendMeetingSummaryEmail.mock.calls[0][0]).toMatchObject({ team_alerted: false });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("ops page lost"));
  });

  it("a notes save blip is retried: the step throws before its last attempt, and nothing is deleted", async () => {
    seed({ recap_destination: "email" });
    m.failNotesSave.on = true;
    await expect(run(0)).rejects.toThrow(/notes save: upsert failed: notes table down/);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(m.sendMeetingSummaryEmail).not.toHaveBeenCalled();
  });

  it("transcript not saved on the last attempt and the summary failed: the recording is the only copy, so it is kept and ops are paged", async () => {
    seed({ recap_destination: "email" });
    m.distillTranscript.mockRejectedValue(new Error("llm down"));
    m.failNotesSave.on = true;
    await run(2);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(m.tables.meeting_bots[0].media_deleted_at).toBeUndefined();
    expect(m.sendDistillFailureOpsAlert.mock.calls[0][0]).toMatchObject({ kind: "distill_failed", transcript_saved: false });
    expect(m.sendMeetingSummaryEmail.mock.calls[0][0]).toMatchObject({ distill_failed: true, transcript_saved: false });
  });

  it("transcript not saved on the last attempt but the summary worked: the recording is kept, ops are paged, the summary still goes out", async () => {
    seed({ recap_destination: "email" });
    m.failNotesSave.on = true;
    await run(2);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(m.sendDistillFailureOpsAlert.mock.calls[0][0]).toMatchObject({ kind: "transcript_not_saved", transcript_saved: false });
    expect(m.sendMeetingSummaryEmail.mock.calls[0][0]).toMatchObject({ distill_failed: false });
  });

  it("the bot status cannot be read on the last attempt: nothing is saved blind, the recording is kept, ops are paged", async () => {
    seed({ recap_destination: "off" });
    await handler({
      event: { data: { meeting_bot_id: "b1" } },
      step: {
        run: async (name: string, fn: () => unknown) => {
          m.failStatusRead.on = name === "save-notes";
          try {
            return await fn();
          } finally {
            m.failStatusRead.on = false;
          }
        },
      },
      logger,
      attempt: 2,
    });
    expect(m.tables.meeting_notes).toHaveLength(0);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(m.sendDistillFailureOpsAlert.mock.calls[0][0]).toMatchObject({ kind: "transcript_not_saved" });
  });

  it("a notes row already past its 30 days is not a saved transcript: the recording is kept and ops are paged", async () => {
    seed({ recap_destination: "off" }, { status: "failed" });
    m.tables.meeting_notes = [
      { bot_id: "b1", tenant_id: T, minutes: null, transcript: "Asha: old words", delete_after: new Date(Date.now() - 1000).toISOString() },
    ];
    await run(2);
    expect(m.getBot).toHaveBeenCalledTimes(1);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(m.sendDistillFailureOpsAlert.mock.calls[0][0]).toMatchObject({ kind: "transcript_not_saved", transcript_saved: false });
  });

  it("a meeting turned off (cancelled) after its facts were saved: no notes, no page, and the reconcile cron deletes the recording", async () => {
    seed({ recap_destination: "email" });
    await handler({
      event: { data: { meeting_bot_id: "b1" } },
      step: {
        run: async (name: string, fn: () => unknown) => {
          if (name === "save-notes") m.tables.meeting_bots[0].status = "cancelled";
          return fn();
        },
      },
      logger,
    });
    expect(m.tables.meeting_notes).toHaveLength(0);
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
    expect(m.sendDistillFailureOpsAlert).not.toHaveBeenCalled();
  });

  it("a delete Recall refuses is logged, leaves the row unmarked for the reconcile retry, and the summary still goes out", async () => {
    seed({ recap_destination: "email" });
    m.deleteBotMedia.mockRejectedValue(new Error("recall delete media 500: boom"));
    await run();
    expect(m.tables.meeting_bots[0].media_deleted_at).toBeUndefined();
    expect(m.sendMeetingSummaryEmail).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("delete_media failed"));
  });

  it("an empty transcript deletes the recording and records it", async () => {
    seed({ recap_destination: "off" });
    m.getBot.mockResolvedValueOnce({ transcript_download_url: "https://recall.example/empty" });
    const recall = await import("@/services/meetings/recall");
    const spy = vi.spyOn(recall, "fetchTranscript").mockResolvedValueOnce([]);
    await run();
    spy.mockRestore();
    expect(m.deleteBotMedia).toHaveBeenCalledWith("rb1");
    expect(m.tables.meeting_bots[0]).toMatchObject({ status: "ingested", atoms_count: 0 });
    expect(m.tables.meeting_bots[0].media_deleted_at).toBeTruthy();
    expect(m.tables.meeting_notes).toHaveLength(0);
  });
});

describe("meeting-process: a reprocess reads the transcript saved in Zavi", () => {
  const SAVED = "Asha: The launch moves to Monday.\nBen: I own the checklist.";

  it("reads meeting_notes instead of Recall, fills in a missing summary, and does not delete a recording already gone", async () => {
    seed({ recap_destination: "off" }, { status: "failed", media_deleted_at: "2026-10-27T10:00:00.000Z" });
    m.tables.meeting_notes = [
      { bot_id: "b1", tenant_id: T, minutes: null, transcript: SAVED, delete_after: new Date(Date.now() + 86_400_000).toISOString() },
    ];
    await run();
    expect(m.getBot).not.toHaveBeenCalled();
    expect(m.distillTranscript.mock.calls[0][0]).toBe(SAVED);
    expect(m.tables.meeting_notes).toHaveLength(1);
    expect(m.tables.meeting_notes[0].transcript).toBe(SAVED);
    expect(m.tables.meeting_notes[0].minutes).toMatchObject({ tldr: "Pricing page ships Friday." });
    expect(m.tables.meeting_bots[0]).toMatchObject({ status: "ingested", transcript_chars: SAVED.length });
    expect(m.deleteBotMedia).not.toHaveBeenCalled();
  });

  it("never reads another tenant's saved transcript", async () => {
    seed({ recap_destination: "off" }, { status: "failed" });
    m.tables.meeting_notes = [
      { bot_id: "b1", tenant_id: "tenant-2", minutes: null, transcript: SAVED, delete_after: new Date(Date.now() + 86_400_000).toISOString() },
    ];
    await run();
    expect(m.getBot).toHaveBeenCalledTimes(1);
    expect(m.distillTranscript.mock.calls[0][0]).toContain("Asha: We ship the pricing page Friday.");
  });

  it("a saved transcript past its 30 days is not used", async () => {
    seed({ recap_destination: "off" }, { status: "failed" });
    m.tables.meeting_notes = [
      { bot_id: "b1", tenant_id: T, minutes: null, transcript: SAVED, delete_after: new Date(Date.now() - 1000).toISOString() },
    ];
    await run();
    expect(m.getBot).toHaveBeenCalledTimes(1);
    expect(m.distillTranscript.mock.calls[0][0]).not.toBe(SAVED);
  });
});

describe("meeting fact quotes after 30 days", () => {
  it("blanks them through the database function and reports the counts", async () => {
    m.rpc.mockImplementation(async () => ({ data: { facts: 435, cards: 33 }, error: null }));
    expect(await blankOldMeetingExcerpts()).toEqual({ facts: 435, cards: 33 });
    expect(m.rpc).toHaveBeenCalledWith("notetaker_blank_old_excerpts");
  });

  it("throws on a database error", async () => {
    m.rpc.mockImplementation(async () => ({ data: null, error: { message: "function missing" } }));
    await expect(blankOldMeetingExcerpts()).rejects.toThrow(/meeting excerpt retention failed: function missing/);
  });

  it("the hourly job still deletes due notes when blanking fails, and the run fails so Inngest shows it", async () => {
    seed(null);
    m.tables.meeting_notes = [{ bot_id: "old", tenant_id: T, delete_after: "2026-01-01T00:00:00.000Z" }];
    m.rpc.mockImplementation(async () => ({ data: null, error: { message: "function missing" } }));
    const job = meetingNotesRetentionFn as unknown as () => Promise<unknown>;
    await expect(job()).rejects.toThrow(/function missing/);
    expect(m.tables.meeting_notes).toHaveLength(0);

    m.rpc.mockImplementation(async () => ({ data: { facts: 2, cards: 1 }, error: null }));
    await expect(job()).resolves.toEqual({ deleted: 0, excerpts_blanked: { facts: 2, cards: 1 } });
  });
});

describe("meeting notes retention", () => {
  it("deletes only notes past their 30 days", async () => {
    seed(null);
    m.tables.meeting_notes = [
      { bot_id: "old", tenant_id: T, delete_after: "2026-10-26T00:00:00.000Z" },
      { bot_id: "other-tenant-old", tenant_id: "tenant-2", delete_after: "2026-10-01T00:00:00.000Z" },
      { bot_id: "fresh", tenant_id: T, delete_after: "2026-11-20T00:00:00.000Z" },
    ];
    const out = await deleteExpiredMeetingNotes(new Date("2026-10-27T12:00:00.000Z"));
    expect(out).toEqual({ deleted: 2 });
    expect(m.tables.meeting_notes.map((r) => r.bot_id)).toEqual(["fresh"]);
  });
});
