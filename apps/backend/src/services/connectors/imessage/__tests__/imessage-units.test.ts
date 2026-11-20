
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { maskHandle, normalizeHandle } from "../handle";
import {
  callSendblue,
  imessageEnabled,
  imessageOwnsLine,
  isRecipientGone,
  verifySendblueSecret,
} from "../sendblue";
import { postIMessageReply } from "@/services/tools/imessage/_client";
import { imessageRouting } from "@/services/connectors/chat-routing";
import { sanitizeIMessagePayload } from "@/services/redactor/imessage-payload-sanitizer";
import { deriveDeliverTarget, reminderDeliverSchema } from "@/services/agents/reminders";

const KEYS = ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"];
let saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn();

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.SENDBLUE_API_KEY_ID = "kid";
  process.env.SENDBLUE_API_SECRET = "ksecret";
  process.env.SENDBLUE_FROM_NUMBER = "+13475550100";
  process.env.SENDBLUE_WEBHOOK_SECRET = "hook-secret";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("handles", () => {
  it("normalises phones to E.164 and emails to lowercase, and refuses junk", () => {
    expect(normalizeHandle("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizeHandle("14155550123")).toBe("+14155550123");
    expect(normalizeHandle(" Ann@iCloud.COM ")).toBe("ann@icloud.com");
    for (const junk of ["", "abc", "+0123", "12", "a@b@c", null, 42]) expect(normalizeHandle(junk)).toBeNull();
  });

  it("masks phones to the last four and emails to a letter and the domain", () => {
    expect(maskHandle("+14155550123")).toBe("+1 ••• ••• 0123");
    expect(maskHandle("+447700900123")).toBe("••• 0123");
    expect(maskHandle("ann@icloud.com")).toBe("a•••@icloud.com");
  });
});

describe("Sendblue adapter", () => {
  it("is off unless every required secret is set", () => {
    expect(imessageEnabled()).toBe(true);
    for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET", "SENDBLUE_FROM_NUMBER", "SENDBLUE_WEBHOOK_SECRET"]) {
      const v = process.env[k];
      delete process.env[k];
      expect(imessageEnabled()).toBe(false);
      process.env[k] = v;
    }
    process.env.SENDBLUE_FROM_NUMBER = "zavi@example.com";
    expect(imessageEnabled()).toBe(false);
  });

  it("owns only its own line", () => {
    expect(imessageOwnsLine("+13475550100")).toBe(true);
    expect(imessageOwnsLine("+13475559999")).toBe(false);
    expect(imessageOwnsLine("")).toBe(false);
    delete process.env.SENDBLUE_API_SECRET;
    expect(imessageOwnsLine("+13475550100")).toBe(false);
  });

  it("accepts only the exact webhook secret", () => {
    expect(verifySendblueSecret("hook-secret")).toBe(true);
    for (const bad of ["", "hook-secre", "hook-secret ", undefined, ["hook-secret"]]) {
      expect(verifySendblueSecret(bad)).toBe(false);
    }
  });

  it("authenticates every call and always sends from our line", async () => {
    fetchMock.mockResolvedValue(reply(202, { status: "QUEUED" }));
    expect(await callSendblue("/api/send-message", { number: "+14155550123", content: "hi" })).toEqual({ ok: true, status: 202 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.sendblue.com/api/send-message");
    expect(init.headers).toMatchObject({ "sb-api-key-id": "kid", "sb-api-secret-key": "ksecret" });
    expect(JSON.parse(init.body)).toEqual({ from_number: "+13475550100", number: "+14155550123", content: "hi" });
  });

  it("classifies an opt-out or a blacklisted number as gone, and other failures as not", async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { status: "DECLINED", error_key: "OPTED_OUT" }));
    const optedOut = await callSendblue("/api/send-message", {});
    expect(optedOut).toMatchObject({ ok: false, status: 400, errorKey: "OPTED_OUT" });
    expect(isRecipientGone(optedOut)).toBe(true);

    fetchMock.mockResolvedValueOnce(reply(200, { status: "ERROR", error_code: 4002, error_message: "blacklisted" }));
    expect(isRecipientGone(await callSendblue("/api/send-message", {}))).toBe(true);

    fetchMock.mockResolvedValueOnce(reply(429, { message: "slow down" }));
    const limited = await callSendblue("/api/send-message", {});
    expect(limited.ok).toBe(false);
    expect(isRecipientGone(limited)).toBe(false);

    fetchMock.mockResolvedValueOnce(reply(400, { status: "ERROR", error_message: "bad number +14155550123" }));
    expect((await callSendblue("/api/send-message", {})).errorMessage).toBe("http_400");

    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await callSendblue("/api/send-message", {})).toEqual({ ok: false, status: 0, errorMessage: "ECONNRESET" });
  });
});

describe("postIMessageReply", () => {
  it("sends plain text, split into ordered bubbles", async () => {
    fetchMock.mockResolvedValue(reply(202, { status: "QUEUED" }));
    const para = "word ".repeat(250).trim();
    const r = await postIMessageReply({ handle: "+14155550123", text: `## Results\n\n**${para}**\n\n${para}` }, { gapMs: 0 });
    expect(r).toEqual({ ok: true, chunks: 2 });
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).content as string);
    expect(sent[0]!.startsWith("Results")).toBe(true);
    expect(sent.join("")).not.toMatch(/\*\*|##/);
  });

  it("turns a web-only action link into something a phone can use", async () => {
    fetchMock.mockResolvedValue(reply(202, { status: "QUEUED" }));
    await postIMessageReply(
      { handle: "+14155550123", text: "Nothing is connected yet, so [connect it here](/__praxis_action__/connect:operator_db)." },
      { gapMs: 0 },
    );
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body).content as string;
    expect(sent).toContain("connect it here");
    expect(sent).not.toMatch(/__praxis_action__|\]\(/);
  });

  it("stops at the first failure and reports how many bubbles landed", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(202, { status: "QUEUED" }))
      .mockResolvedValueOnce(reply(400, { status: "DECLINED", error_key: "OPTED_OUT" }));
    const long = `${"a ".repeat(700)}\n\n${"b ".repeat(700)}\n\n${"c ".repeat(700)}`;
    expect(await postIMessageReply({ handle: "+14155550123", text: long }, { gapMs: 0 })).toEqual({
      ok: false,
      gone: true,
      sent: 1,
      error: "OPTED_OUT",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports disabled without calling Sendblue when the surface is off", async () => {
    delete process.env.SENDBLUE_WEBHOOK_SECRET;
    expect(await postIMessageReply({ handle: "+14155550123", text: "hi" })).toMatchObject({ ok: false, disabled: true, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("routing, archive copy and reminders", () => {
  it("needs both our line and the handle to route a reply", () => {
    expect(imessageRouting({ imessage: { line: "+13475550100", handle: "+14155550123", text: "x" } })).toEqual({
      line: "+13475550100",
      handle: "+14155550123",
    });
    expect(imessageRouting({ imessage: { handle: "+14155550123" } })).toBeNull();
    expect(imessageRouting(null)).toBeNull();
  });

  it("archives no raw sender and no media link", () => {
    const out = sanitizeIMessagePayload({
      message_handle: "mh-1",
      sendblue_number: "+13475550100",
      from_number: "+14155550123",
      content: "call me at 415-555-0123",
      media_url: "https://cdn.sendblue.co/private.jpg",
      accountEmail: "ops@zaviagent.com",
    });
    expect(out).toMatchObject({ message_handle: "mh-1", sendblue_number: "+13475550100", has_media: true });
    const s = JSON.stringify(out);
    expect(s).not.toContain("4155550123");
    expect(s).not.toContain("555-0123");
    expect(s).not.toContain("private.jpg");
    expect(s).not.toContain("ops@zaviagent.com");
  });

  it("delivers a reminder set from iMessage back to the same thread", () => {
    const t = deriveDeliverTarget({ chat_routing: { kind: "imessage", line: "+13475550100", handle: "+14155550123" } });
    expect(t).toEqual({ kind: "imessage", line: "+13475550100", handle: "+14155550123" });
    expect(reminderDeliverSchema.safeParse(t).success).toBe(true);
  });
});
