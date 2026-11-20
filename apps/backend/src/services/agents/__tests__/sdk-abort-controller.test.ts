
import { describe, it, expect, vi, beforeEach } from "vitest";

let lastQueryArgs: { options?: { abortController?: AbortController } } | undefined;
const queryMock = vi.fn(
  (args: { options?: { abortController?: AbortController } }) => {
    lastQueryArgs = args;
    const signal = args.options?.abortController?.signal;
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "turn-1" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      if (!signal?.aborted) {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "turn-2" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      }
      yield {
        type: "result",
        subtype: signal?.aborted ? "error_during_execution" : "success",
        session_id: "sess-abort-test",
        total_cost_usd: 0.001,
      };
    })();
  },
);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({ name: "mock", instance: {} })),
  tool: vi.fn(
    (name: string, _desc: string, _schema: unknown, handler: unknown) => ({
      name,
      handler,
    }),
  ),
}));

async function dispatchLikeRunGeneric(controller: AbortController) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const stream = (query as unknown as typeof queryMock)({
    options: { abortController: controller },
  });
  const turns: string[] = [];
  for await (const message of stream as AsyncIterable<{
    type: string;
    message?: { content?: Array<{ text?: string }> };
  }>) {
    if (message.type === "assistant") {
      const t = message.message?.content?.[0]?.text;
      if (t) turns.push(t);
    }
  }
  return turns;
}

describe("Agent-SDK abort controller wiring", () => {
  beforeEach(() => {
    lastQueryArgs = undefined;
    queryMock.mockClear();
  });

  it("passes an AbortController through to query() options", async () => {
    const controller = new AbortController();
    await dispatchLikeRunGeneric(controller);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(lastQueryArgs?.options?.abortController).toBeInstanceOf(
      AbortController,
    );
    expect(lastQueryArgs?.options?.abortController).toBe(controller);
    expect(lastQueryArgs?.options?.abortController?.signal.aborted).toBe(false);
  });

  it("does not short-circuit when the signal is never aborted", async () => {
    const controller = new AbortController();
    const turns = await dispatchLikeRunGeneric(controller);
    expect(turns).toEqual(["turn-1", "turn-2"]);
  });

  it("short-circuits in-flight work once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const turns = await dispatchLikeRunGeneric(controller);

    expect(controller.signal.aborted).toBe(true);
    expect(turns).toEqual(["turn-1"]);
    expect(turns).not.toContain("turn-2");
  });
});
