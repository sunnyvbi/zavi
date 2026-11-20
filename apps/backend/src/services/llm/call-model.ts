
import {
  getAnthropic,
  heliconePropertyHeaders,
  type HeliconeTags,
} from "@/services/anthropic";
import { getOpenAi } from "@/services/openai";
import { isFixedTemperatureModel, type Provider } from "@/services/llm/models";
import { normalizeUsage, type NormalizedUsage } from "@/services/llm/normalize-usage";
import {
  classifyProviderError,
  isRetryableSameModel,
} from "@/services/llm/provider-errors";
import { alert } from "@/services/logging/alert";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000] as const;

const PROVIDER_DEFAULT_TEMPERATURE = 1;

const _temperatureDropAlerted = new Set<string>();

function alertTemperatureDropped(model: string, requested: number): void {
  if (requested === PROVIDER_DEFAULT_TEMPERATURE) return;
  const key = `${model}:${requested}`;
  if (_temperatureDropAlerted.has(key)) return;
  _temperatureDropAlerted.add(key);
  void alert({
    source: "llm.call_model",
    code: "temperature_dropped",
    msg:
      `temperature ${requested} was requested for model '${model}', which only accepts ` +
      "the provider default — the parameter was OMITTED and this call samples at that " +
      "default instead. Drop the temperature at the call site or switch to a " +
      "temperature-capable model.",
  }).catch(() => {});
}

export type CallModelOpts = {
  provider: Provider;
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  max_tokens: number;
  temperature?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  tags?: HeliconeTags;
};

export type CallModelResult = {
  text: string;
  usage: NormalizedUsage;
  provider: Provider;
};

export async function callModel(opts: CallModelOpts): Promise<CallModelResult> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 1));
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await callModelOnce(opts);
    } catch (err) {
      lastErr = err;
      const classified = classifyProviderError(err, opts.provider);
      const shouldRetry =
        attempt < maxAttempts - 1 && isRetryableSameModel(classified.kind);
      if (!shouldRetry) throw err;

      const nextAttempt = attempt + 2;
      const delayMs = retryDelayMs(classified.retryDelayMs, attempt);
      console.warn(
        `[callModel] ${opts.provider} ${classified.kind}; retrying attempt ${nextAttempt}/${maxAttempts}: ${classified.message}`,
      );
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastErr ?? new Error("callModel retry loop exhausted");
}

function retryDelayMs(providerRetryDelayMs: number | null, attempt: number): number {
  if (process.env.NODE_ENV === "test") return 0;
  if (
    providerRetryDelayMs !== null &&
    providerRetryDelayMs >= 0 &&
    providerRetryDelayMs <= 30_000
  ) {
    return providerRetryDelayMs;
  }
  return DEFAULT_RETRY_DELAYS_MS[attempt] ?? 5_000;
}

async function callModelOnce(opts: CallModelOpts): Promise<CallModelResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (opts.provider === "bedrock" || opts.provider === "fireworks") {
    throw new Error(
      `callModel: provider '${opts.provider}' is not supported on the aux path yet ` +
        `(${opts.provider} runs only through the agentic engine via pickEngine). ` +
        "Use 'anthropic' or 'openai' for aux callModel calls.",
    );
  }

  if (opts.provider === "openai") {
    const client = getOpenAi();
    if (!client) {
      throw new Error(
        "callModel: OPENAI_API_KEY unset but provider 'openai' was requested — set the key or use provider 'anthropic'.",
      );
    }
    const messages = [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      ...opts.messages,
    ];
    const fixedTempModel = isFixedTemperatureModel(opts.model);
    if (opts.temperature !== undefined && fixedTempModel) {
      alertTemperatureDropped(opts.model, opts.temperature);
    }
    const resp = await client.chat.completions.create(
      {
        model: opts.model,
        max_completion_tokens: opts.max_tokens,
        ...(opts.temperature !== undefined && !fixedTempModel
          ? { temperature: opts.temperature }
          : {}),
        messages,
      },
      { signal },
    );
    const text = resp.choices[0]?.message?.content ?? "";
    return {
      text,
      usage: normalizeUsage(resp.usage, "openai"),
      provider: "openai",
    };
  }

  const resp = await getAnthropic().messages.create(
    {
      model: opts.model,
      max_tokens: opts.max_tokens,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages,
    },
    {
      signal,
      headers: opts.tags ? heliconePropertyHeaders(opts.tags) : undefined,
    },
  );
  const text = resp.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return {
    text,
    usage: normalizeUsage(resp.usage, "anthropic"),
    provider: "anthropic",
  };
}
