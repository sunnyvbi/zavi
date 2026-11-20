
import { describe, it, expect, vi } from "vitest";
import {
  extractTextDeltaFromStreamEvent,
  type StreamDraftEmitter,
} from "../stream-draft";

function buildQueryOptions(streamDraft: StreamDraftEmitter | null) {
  return {
    model: "claude-x",
    ...(streamDraft ? { includePartialMessages: true } : {}),
  } as { model: string; includePartialMessages?: boolean };
}

async function runLoop(
  messages: Array<{ type: string; event?: unknown; text?: string }>,
  streamDraft: StreamDraftEmitter | null,
) {
  let finalText = "";
  for (const message of messages) {
    if (message.type === "assistant") {
      finalText = message.text ?? finalText;
    } else if (streamDraft && message.type === "stream_event") {
      const delta = extractTextDeltaFromStreamEvent(
        (message as { event?: unknown }).event,
      );
      if (delta) await streamDraft.push(delta);
    }
  }
  if (streamDraft) await streamDraft.finish("complete");
  return finalText;
}

function makeEmitterSpy(opts?: { pushThrows?: boolean }) {
  const pushed: string[] = [];
  let finished: string | null = null;
  const em: StreamDraftEmitter = {
    ready: async () => {},
    push: vi.fn(async (delta: string) => {
      if (opts?.pushThrows) throw new Error("emit boom");
      pushed.push(delta);
    }),
    resetTurn: vi.fn(async () => {}),
    finish: vi.fn(async (status) => {
      finished = status;
    }),
  };
  return { em, pushed, get finished() { return finished; } };
}

function textDeltaEvent(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

describe("live-token-streaming dispatcher wiring", () => {
  describe("flag gate (byte-identical when OFF)", () => {
    it("flag OFF ⇒ includePartialMessages is ABSENT from query() options", () => {
      const opts = buildQueryOptions(null);
      expect("includePartialMessages" in opts).toBe(false);
      expect(opts).toEqual({ model: "claude-x" });
    });

    it("flag ON ⇒ includePartialMessages: true is present", () => {
      const { em } = makeEmitterSpy();
      const opts = buildQueryOptions(em);
      expect(opts.includePartialMessages).toBe(true);
    });
  });

  describe("stream_event arm", () => {
    it("flag OFF ⇒ a stream_event text_delta writes NOTHING (no push, no finish)", async () => {
      const { em, pushed } = makeEmitterSpy();
      await runLoop(
        [textDeltaEvent("hello"), { type: "assistant", text: "final" }],
        null,
      );
      expect(pushed).toEqual([]);
      expect(em.push).not.toHaveBeenCalled();
      expect(em.finish).not.toHaveBeenCalled();
    });

    it("flag ON ⇒ a stream_event text_delta pushes the delta to the emitter", async () => {
      const { em, pushed } = makeEmitterSpy();
      const final = await runLoop(
        [
          textDeltaEvent("Hel"),
          textDeltaEvent("lo "),
          textDeltaEvent("world"),
          { type: "assistant", text: "Hello world" },
        ],
        em,
      );
      expect(pushed).toEqual(["Hel", "lo ", "world"]);
      expect(em.finish).toHaveBeenCalledWith("complete");
      expect(final).toBe("Hello world");
    });

    it("non-text stream_events (message_start, tool deltas, malformed) push nothing", async () => {
      const { em, pushed } = makeEmitterSpy();
      await runLoop(
        [
          { type: "stream_event", event: { type: "message_start" } },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "input_json_delta", partial_json: "{" },
            },
          },
          { type: "stream_event", event: undefined },
          { type: "assistant", text: "ok" },
        ],
        em,
      );
      expect(pushed).toEqual([]);
    });

    it("an emitter push() THROW does NOT break the loop or the terminal result", async () => {
      const { em } = makeEmitterSpy({ pushThrows: true });
      const safeEm: StreamDraftEmitter = {
        ready: em.ready,
        resetTurn: async () => {},
        push: async (d: string) => {
          try {
            await em.push(d);
          } catch {
          }
        },
        finish: em.finish,
      };
      const final = await runLoop(
        [textDeltaEvent("x"), { type: "assistant", text: "done" }],
        safeEm,
      );
      expect(final).toBe("done");
    });
  });

  describe("extractTextDeltaFromStreamEvent (pure)", () => {
    it("returns the text for a content_block_delta/text_delta", () => {
      expect(
        extractTextDeltaFromStreamEvent({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "abc" },
        }),
      ).toBe("abc");
    });
    it("returns '' for every other shape", () => {
      expect(extractTextDeltaFromStreamEvent({ type: "message_start" })).toBe("");
      expect(
        extractTextDeltaFromStreamEvent({
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{" },
        }),
      ).toBe("");
      expect(extractTextDeltaFromStreamEvent(undefined)).toBe("");
      expect(extractTextDeltaFromStreamEvent(null)).toBe("");
      expect(extractTextDeltaFromStreamEvent({})).toBe("");
    });
  });
});
