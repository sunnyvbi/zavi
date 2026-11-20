
import { HarnessFailure } from "@/services/eval/shadow-harness";
import {
  OPENROUTER_BASE_URL,
  OpenRouterRunRecorder,
  makeOpenRouterFetch,
} from "@/services/llm/openrouter";
import type { ManifestEntry } from "./manifest";

export type CompleteRequest = {
  model: ManifestEntry;
  system: string;
  user: string;
  maxTokens?: number;
};

export type CompleteResult = { text: string; billedUsd: number };

export interface BenchModelClient {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export class OpenRouterBenchClient implements BenchModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string = OPENROUTER_BASE_URL,
    private readonly baseFetch: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new HarnessFailure("OPENROUTER_API_KEY is not set");
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (req.model.route !== "shared_loop" || !req.model.upstream) {
      throw new HarnessFailure(`model ${req.model.key} is not an OpenRouter shared-loop entry`);
    }
    const pin = { upstream: req.model.upstream };
    const rec = new OpenRouterRunRecorder(pin);
    const f = makeOpenRouterFetch(pin, rec, this.baseFetch);
    const res = await f(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model.model_id,
        max_tokens: req.maxTokens ?? 4000,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    await rec.settle();
    const v = rec.verdict();
    if (v === "unpinned_route") {
      throw new HarnessFailure(`${req.model.key}: response served by an unpinned route`);
    }
    if (v === "no_usage_cost") {
      throw new HarnessFailure(`${req.model.key}: response carried no billed cost; refusing the model`);
    }
    return { text: json.choices?.[0]?.message?.content ?? "", billedUsd: rec.totalCostUsd() };
  }
}

export class FakeBenchClient implements BenchModelClient {
  readonly calls: CompleteRequest[] = [];
  constructor(
    private readonly respond: (req: CompleteRequest) => string,
    private readonly usdPerCall = 0.01,
  ) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push(req);
    return { text: this.respond(req), billedUsd: this.usdPerCall };
  }
}
