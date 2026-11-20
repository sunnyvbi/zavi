
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

type CapturedCall = {
  options: {
    resume?: string;
    systemPrompt?: string;
    model?: string;
    [k: string]: unknown;
  };
  yielded: Array<{ content: MessageParam["content"] }>;
};

const captured: CapturedCall[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* (args: {
    prompt: AsyncIterable<{ message: { content: MessageParam["content"] } }>;
    options: CapturedCall["options"];
  }) {
    const yielded: CapturedCall["yielded"] = [];
    for await (const msg of args.prompt) {
      yielded.push({ content: msg.message.content });
    }
    captured.push({ options: args.options, yielded });
    yield {
      type: "result" as const,
      subtype: "success" as const,
      session_id: "captured-session-id-stub",
      result: "ok",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }),
}));

describe("generic-dispatcher SDK chat dispatch — Layer 2 integration", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it.todo(
    "chat turn with sdk_session_id set → options.resume === sdk_session_id AND yielded prompt content does NOT contain 'Prior conversation:'",
  );

  it.todo(
    "chat turn without sdk_session_id → options.resume === undefined AND yielded prompt MAY contain 'Prior conversation:'",
  );

  it.todo(
    "chat turn with images + sdk_session_id → options.resume set AND yielded content is the image-block array (not flattened to string)",
  );

  it("scaffolding sanity — mock captures the SDK call shape", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const stream = query({
      prompt: (async function* () {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: "hi" },
          parent_tool_use_id: null,
          session_id: "stub",
        };
      })(),
      options: { systemPrompt: "stub", resume: "abc-uuid" },
    });
    for await (const _ of stream) {
    }
    expect(captured).toHaveLength(1);
    expect(captured[0].options.resume).toBe("abc-uuid");
    expect(captured[0].yielded).toHaveLength(1);
    expect(captured[0].yielded[0].content).toBe("hi");
  });
});
