import type { Model } from "@openai/agents";

type ModelRequest = Parameters<Model["getResponse"]>[0];
type ModelResponse = Awaited<ReturnType<Model["getResponse"]>>;
type StreamEvent = Model["getStreamedResponse"] extends (r: never) => AsyncIterable<infer E> ? E : never;

export type TurnHook = (t: { text: string; turn: number; hasToolCalls: boolean }) => void | Promise<void>;

export class TurnHookModel implements Model {
  private turn = 0;
  getRetryAdvice?: Model["getRetryAdvice"];
  constructor(
    private readonly inner: Model,
    private readonly hook: TurnHook,
  ) {
    if (inner.getRetryAdvice) this.getRetryAdvice = (args) => inner.getRetryAdvice!(args);
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const res = await this.inner.getResponse(request);
    await this.fire(textOf(res.output as unknown[]), hasCalls(res.output as unknown[]));
    return res;
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    let buf = "";
    for await (const ev of this.inner.getStreamedResponse(request)) {
      const e = ev as { type?: string; delta?: unknown; response?: { output?: unknown[] } };
      if (e?.type === "output_text_delta" && typeof e.delta === "string") buf += e.delta;
      if (e?.type === "response_done") {
        const out = e.response?.output ?? [];
        await this.fire(textOf(out) || buf, hasCalls(out));
      }
      yield ev;
    }
  }

  private async fire(text: string, hasToolCalls: boolean): Promise<void> {
    const turn = this.turn++;
    try {
      await this.hook({ text, turn, hasToolCalls });
    } catch (e) {
      console.warn(`[turn-hook-model] hook threw (turn ${turn}); gate state left unchanged: ${(e as Error).message}`);
    }
  }
}

function textOf(output: unknown[]): string {
  return (output ?? [])
    .filter((o): o is { type: string; content?: unknown[] } => (o as { type?: string })?.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c): c is { type: string; text: string } => {
      const x = c as { type?: string; text?: unknown };
      return x?.type === "output_text" && typeof x.text === "string";
    })
    .map((c) => c.text)
    .join("");
}

function hasCalls(output: unknown[]): boolean {
  return (output ?? []).some((o) => (o as { type?: string })?.type === "function_call");
}
