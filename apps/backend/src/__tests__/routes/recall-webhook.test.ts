import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

const m = vi.hoisted(() => {
  const state: {
    botRow: Record<string, unknown> | null;
    botErr: { message: string } | null;
  } = { botRow: null, botErr: null };
  const maybeSingle = vi.fn(async () => ({ data: state.botRow, error: state.botErr }));
  const eqSelect = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq: eqSelect }));
  const inUpdate = vi.fn(async (..._a: unknown[]) => ({ data: null, error: null }));
  const eqUpdate = vi.fn(() => ({ in: inUpdate }));
  const update = vi.fn(() => ({ eq: eqUpdate }));
  const from = vi.fn(() => ({ select, update }));
  const serviceClient = vi.fn(() => ({ from }));
  const inngestSend = vi.fn(async (..._args: unknown[]) => ({ ids: ["evt"] }));
  return { state, maybeSingle, select, update, eqUpdate, inUpdate, from, serviceClient, inngestSend };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.inngestSend } }));

import { recallWebhook, verifySvixSignature } from "../../routes/webhooks/recall";

const SECRET = "whsec_" + Buffer.from("test-signing-key-32-bytes-long!!").toString("base64");

function sign(rawBody: string, id = "msg_1", ts = String(Math.floor(Date.now() / 1000))) {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return { id, ts, sig: `v1,${sig}` };
}

function mockReqRes(rawBody: string, headers: Record<string, string>) {
  const req = {
    body: Buffer.from(rawBody),
    header: (name: string) => headers[name.toLowerCase()],
  } as never;
  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  process.env.RECALL_WEBHOOK_SECRET = SECRET;
  m.state.botRow = null;
  m.state.botErr = null;
  m.inngestSend.mockReset();
  m.inngestSend.mockResolvedValue({ ids: ["evt"] });
  m.update.mockClear();
  m.inUpdate.mockClear();
});

describe("verifySvixSignature", () => {
  it("accepts a valid signature and rejects a tampered body", () => {
    const body = JSON.stringify({ event: "bot.done" });
    const { id, ts, sig } = sign(body);
    expect(verifySvixSignature(SECRET, body, id, ts, sig)).toBe(true);
    expect(verifySvixSignature(SECRET, body + "x", id, ts, sig)).toBe(false);
  });

  it("rejects stale timestamps (replay)", () => {
    const body = "{}";
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const { id, sig } = sign(body, "msg_1", staleTs);
    expect(verifySvixSignature(SECRET, body, id, staleTs, sig)).toBe(false);
  });
});

describe("recallWebhook", () => {
  it("503 when secret unset (inert until configured)", async () => {
    delete process.env.RECALL_WEBHOOK_SECRET;
    const { req, res } = mockReqRes("{}", {});
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(503);
  });

  it("401 on bad signature", async () => {
    const { req, res } = mockReqRes(JSON.stringify({ event: "bot.done" }), {
      "svix-id": "msg_1",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,bogus",
    });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(401);
  });

  it("ignores unknown bot ids (fail-closed tenant boundary)", async () => {
    const body = JSON.stringify({
      event: "bot.done",
      data: { data: { code: "done" }, bot: { id: "stranger-bot" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { ignored?: string }).ignored).toBe("unknown_bot");
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("accepts Recall's standard-webhooks header names (webhook-*)", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "processing" };
    const body = JSON.stringify({
      event: "transcript.done",
      data: { data: { code: "done" }, bot: { id: "rb-1" }, transcript: { id: "tr-1" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("in the waiting room: queues ONE waiting notice per bot for the retried delivery worker", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "joining" };
    const body = JSON.stringify({ event: "bot.in_waiting_room", data: { data: { code: "in_waiting_room" }, bot: { id: "rb-1" } } });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(m.inngestSend).toHaveBeenCalledWith({
      id: "meeting-notice:waiting:mb-1",
      name: "meeting.notice",
      data: { meeting_bot_id: "mb-1", tenant_id: "t-1", kind: "waiting" },
    });
  });

  it("in the waiting room: answers 503 when the notice cannot be queued, so Recall retries the delivery", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "joining" };
    m.inngestSend.mockRejectedValueOnce(new Error("inngest 503"));
    const body = JSON.stringify({ event: "bot.in_waiting_room", data: { data: { code: "in_waiting_room" }, bot: { id: "rb-1" } } });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(503);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("bot.done NO LONGER enqueues (transcript artifact not yet ready)", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "in_call" };
    const body = JSON.stringify({
      event: "bot.done",
      data: { data: { code: "done" }, bot: { id: "rb-1" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("transcript.done enqueues meeting.bot.status with a transcript-specific id", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "processing" };
    const body = JSON.stringify({
      event: "transcript.done",
      data: { data: { code: "done" }, bot: { id: "rb-1" }, transcript: { id: "tr-9" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
    const evt = m.inngestSend.mock.calls[0][0] as unknown as {
      id: string;
      name: string;
      data: { meeting_bot_id: string };
    };
    expect(evt.name).toBe("meeting.bot.status");
    expect(evt.id).toBe("recall-transcript:rb-1:tr-9");
    expect(evt.data.meeting_bot_id).toBe("mb-1");
  });

  it("transcript.done falls back to the bot id when transcript.id is missing", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "processing" };
    const body = JSON.stringify({
      event: "transcript.done",
      data: { data: { code: "done" }, bot: { id: "rb-1" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
    const evt = m.inngestSend.mock.calls[0][0] as unknown as { id: string };
    expect(evt.id).toBe("recall-transcript:rb-1:rb-1");
  });

  it("transcript.done enqueues even for an already-failed bot (recovery)", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "failed" };
    const body = JSON.stringify({
      event: "transcript.done",
      data: { data: { code: "done" }, bot: { id: "rb-1" }, transcript: { id: "tr-2" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(m.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("transcript.failed records the vendor sub_code (incl. on an already-failed row)", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "failed" };
    const body = JSON.stringify({
      event: "transcript.failed",
      data: { data: { code: "failed", sub_code: "diarization_failed" }, bot: { id: "rb-1" }, transcript: { id: "tr-3" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledTimes(1);
  });

  it("transcript.failed never regresses an already-ingested bot", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "ingested" };
    const body = JSON.stringify({
      event: "transcript.failed",
      data: { data: { code: "failed", sub_code: "x" }, bot: { id: "rb-1" }, transcript: { id: "tr-4" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("transcript.done for an unknown bot is fail-closed (C8)", async () => {
    m.state.botRow = null;
    const body = JSON.stringify({
      event: "transcript.done",
      data: { data: { code: "done" }, bot: { id: "stranger" }, transcript: { id: "tr-5" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { ignored?: string }).ignored).toBe("unknown_bot");
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it("never regresses a terminal status on out-of-order delivery", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "ingested" };
    const body = JSON.stringify({
      event: "bot.in_call_recording",
      data: { data: { code: "in_call_recording" }, bot: { id: "rb-1" } },
    });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sig,
    });
    await recallWebhook(req, res as never);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("status writes are conditional on a live status, so an event that read a live row cannot revive a cancelled one", async () => {
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "in_call" };
    const body = JSON.stringify({ event: "bot.call_ended", data: { data: { code: "call_ended" }, bot: { id: "rb-1" } } });
    const { id, ts, sig } = sign(body);
    const { req, res } = mockReqRes(body, { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });
    await recallWebhook(req, res as never);
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.inUpdate).toHaveBeenCalledWith("status", ["scheduled", "joining", "in_call", "call_ended", "processing"]);
  });

  it("a bot Zavi called back (cancelled): its leaving events, waiting notice and transcript are all ignored", async () => {
    const post = async (event: string, extra: Record<string, unknown> = {}) => {
      const body = JSON.stringify({ event, data: { data: { code: event.replace(/^bot\./, "") }, bot: { id: "rb-1" }, ...extra } });
      const { id, ts, sig } = sign(body);
      const { req, res } = mockReqRes(body, { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });
      await recallWebhook(req, res as never);
      return res;
    };
    m.state.botRow = { id: "mb-1", tenant_id: "t-1", status: "cancelled" };
    for (const event of ["bot.in_waiting_room", "bot.in_call_recording", "bot.call_ended", "bot.done", "bot.fatal", "transcript.failed"]) {
      const res = await post(event);
      expect(res.statusCode).toBe(200);
    }
    const done = await post("transcript.done", { transcript: { id: "tr-1" } });
    expect(done.statusCode).toBe(200);
    expect((done.jsonBody as { ignored?: string }).ignored).toBe("cancelled");
    expect(m.update).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
  });
});
