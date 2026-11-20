
import Anthropic from "@anthropic-ai/sdk";
import { MODELS, isFixedTemperatureModel } from "@/services/llm/models";
import {
  resolveAgentAuthMode,
  preferApiKeyFromEnv,
  resolveOAuthTokenPool,
  resolveAttemptTokens,
  nextStartOffset,
  benchSeatForLimit,
} from "@/services/agents/agent-auth";
import { isUsageLimitError } from "@/services/agents/infra-retry";
import { alert } from "@/services/logging/alert";

const _clients = new Map<string, Anthropic>();
let _facade: Anthropic | null = null;

export function hasAnthropicAuth(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || resolveOAuthTokenPool().length > 0);
}

function buildAnthropicOpts(
  extra?: ConstructorParameters<typeof Anthropic>[0],
  forcedOauthToken?: string,
): ConstructorParameters<typeof Anthropic>[0] {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = forcedOauthToken ?? resolveOAuthTokenPool()[0];
  if (!apiKey && !oauthToken) {
    throw new Error(
      "No Anthropic auth: set ANTHROPIC_API_KEY (metered) or CLAUDE_CODE_OAUTH_TOKEN (subscription) in .env.local for local dev, or in your deployment env.",
    );
  }
  const authMode = resolveAgentAuthMode({
    oauthToken,
    apiKey,
    preferApiKey: preferApiKeyFromEnv(),
  });
  const heliconeKey = process.env.HELICONE_API_KEY;
  const opts: ConstructorParameters<typeof Anthropic>[0] =
    authMode === "api_key" ? { apiKey } : { authToken: oauthToken };
  if (heliconeKey) {
    opts.baseURL = "https://anthropic.helicone.ai";
    opts.defaultHeaders = {
      "Helicone-Auth": `Bearer ${heliconeKey}`,
    };
  }
  return { timeout: 600_000, ...opts, ...extra };
}

export function getAnthropic(): Anthropic {
  assertAnthropicAuth();
  if (!_facade) {
    _facade = {
      messages: {
        create: (
          params: Anthropic.Messages.MessageCreateParamsNonStreaming,
          requestOptions?: Parameters<Anthropic["messages"]["create"]>[1],
        ) => createMessageWithFailover(params, requestOptions),
      },
    } as unknown as Anthropic;
  }
  return _facade;
}

function assertAnthropicAuth(): void {
  if (!process.env.ANTHROPIC_API_KEY && resolveOAuthTokenPool().length === 0) {
    throw new Error(
      "No Anthropic auth: set ANTHROPIC_API_KEY (metered) or CLAUDE_CODE_OAUTH_TOKEN (subscription) in .env.local for local dev, or in your deployment env.",
    );
  }
}

function clientForCredential(token: string | undefined, rotating: boolean): Anthropic {
  const mode = resolveAgentAuthMode({
    oauthToken: token,
    apiKey: process.env.ANTHROPIC_API_KEY,
    preferApiKey: preferApiKeyFromEnv(),
  });
  const key = `${mode === "api_key" ? "api_key" : `oauth:${token ?? ""}`}|${rotating ? "r1" : "default"}`;
  let client = _clients.get(key);
  if (!client) {
    client = new Anthropic(buildAnthropicOpts(rotating ? { maxRetries: 1 } : undefined, token));
    _clients.set(key, client);
  }
  return client;
}

export function _resetAnthropicClientsForTest(): void {
  _clients.clear();
  _facade = null;
}

export function getFreshAnthropic(): Anthropic {
  return new Anthropic(buildAnthropicOpts({ maxRetries: 1, timeout: 90_000 }));
}

export function isRetryableAnthropicError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  const hay = `${(e as { name?: string })?.name ?? ""} ${String((e as { message?: string })?.message ?? "")}`.toLowerCase();
  return /overloaded|aborterror|abort error|econnreset|etimedout|socket hang up|premature close|connection error|network|timeout|fetcherror/.test(
    hay,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runWithTokenFailover<T>(
  tokens: Array<string | undefined>,
  doCall: (token: string | undefined) => Promise<T>,
  sleepFn: (ms: number) => Promise<void> = sleep,
  signal?: { aborted: boolean } | null,
  benchOnUsageLimit = true,
): Promise<T> {
  const list = tokens.length > 0 ? tokens : [undefined];
  let lastErr: unknown;
  for (let i = 0; i < list.length; i++) {
    try {
      return await doCall(list[i]);
    } catch (e) {
      lastErr = e;
      const errText = String((e as { message?: unknown })?.message ?? "");
      if (benchOnUsageLimit && isUsageLimitError(errText)) {
        benchSeatForLimit(list[i], errText);
      }
      if (signal?.aborted) throw e;
      if (i === list.length - 1 || !isRetryableAnthropicError(e)) throw e;
      await sleepFn(200 * (i + 1));
    }
  }
  throw lastErr;
}

const CLAUDE_CODE_SYSTEM_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";

export function withClaudeCodeSystemBlock(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const lead: Anthropic.Messages.TextBlockParam = { type: "text", text: CLAUDE_CODE_SYSTEM_BLOCK };
  const sys = params.system;
  if (sys === undefined) return { ...params, system: [lead] };
  if (typeof sys === "string") {
    if (sys.startsWith(CLAUDE_CODE_SYSTEM_BLOCK)) return params;
    return { ...params, system: [lead, { type: "text", text: sys }] };
  }
  if (sys[0]?.type === "text" && sys[0].text === CLAUDE_CODE_SYSTEM_BLOCK) return params;
  return { ...params, system: [lead, ...sys] };
}

export function withoutRejectedSampling(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  if (!isFixedTemperatureModel(params.model)) return params;
  const { temperature: _t, top_p: _p, top_k: _k, ...rest } = params;
  return rest;
}

function alertOnRefusal(m: Anthropic.Messages.Message): Anthropic.Messages.Message {
  if ((m.stop_reason as string) === "refusal") {
    const category = (m as { stop_details?: { category?: string | null } }).stop_details?.category ?? "unknown";
    void alert({
      source: "anthropic.aux",
      code: "model_refusal",
      msg: `Model ${m.model} declined an aux call (category ${category}); the caller got empty text.`,
    });
  }
  return m;
}

export async function createMessageWithFailover(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  requestOptions?: Parameters<Anthropic["messages"]["create"]>[1],
): Promise<Anthropic.Messages.Message> {
  assertAnthropicAuth();
  params = withoutRejectedSampling(params);
  const pool = resolveOAuthTokenPool();
  const tokens = resolveAttemptTokens({
    pool,
    apiKey: process.env.ANTHROPIC_API_KEY,
    preferApiKey: preferApiKeyFromEnv(),
    startOffset: nextStartOffset(pool.length),
  });
  const rotating = tokens.length > 1;
  const modeFor = (token: string | undefined) =>
    resolveAgentAuthMode({
      oauthToken: token,
      apiKey: process.env.ANTHROPIC_API_KEY,
      preferApiKey: preferApiKeyFromEnv(),
    });
  const onOAuth = modeFor(tokens[0]) === "oauth";
  return runWithTokenFailover(
    tokens,
    (token) =>
      clientForCredential(token, rotating).messages.create(
        modeFor(token) === "oauth" ? withClaudeCodeSystemBlock(params) : params,
        requestOptions,
      ).then(alertOnRefusal) as Promise<Anthropic.Messages.Message>,
    sleep,
    requestOptions?.signal ?? null,
    onOAuth,
  );
}

export type HeliconeTags = {
  tenantId?: string | null;
  agentSlug?: string | null;
  runId?: string | null;
};

export function heliconePropertyHeaders(tags: HeliconeTags): Record<string, string> {
  const headers: Record<string, string> = {};
  if (tags.tenantId) headers["Helicone-Property-Tenant-Id"] = tags.tenantId;
  if (tags.agentSlug) headers["Helicone-Property-Agent-Slug"] = tags.agentSlug;
  if (tags.runId) headers["Helicone-Property-Run-Id"] = tags.runId;
  return headers;
}

const SUBSCRIPTION_ONLY =
  !process.env.ANTHROPIC_API_KEY && resolveOAuthTokenPool().length > 0;

export const DEFAULT_MODEL = SUBSCRIPTION_ONLY
  ? MODELS.anthropic.haiku
  : MODELS.anthropic.sonnet;
export const DEFAULT_FAST_MODEL = SUBSCRIPTION_ONLY
  ? MODELS.anthropic.haiku
  : MODELS.anthropic.sonnet;

export type LLMUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  } | null;
};

export type ModelPrice = {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
};
export const PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
};

const MAX_PRICE: ModelPrice = Object.values(PRICING).reduce<ModelPrice>(
  (m, p) => ({ input: Math.max(m.input, p.input), output: Math.max(m.output, p.output) }),
  { input: 0, output: 0 },
);
const _unpricedModelsAlerted = new Set<string>();

const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_1H_MULT = 2;

export function cachedSystemBlock(
  text: string,
): Anthropic.Messages.TextBlockParam {
  return {
    type: "text",
    text,
    cache_control: { type: "ephemeral" },
  } as unknown as Anthropic.Messages.TextBlockParam;
}

export function estimateCostUsd(
  model: string,
  usage: LLMUsage,
  opts?: { onUnpriced?: "max" | "throw"; tenant_id?: string | null },
): number {
  let p = PRICING[model];
  if (!p) {
    if (opts?.onUnpriced === "throw") {
      throw new Error(
        `estimateCostUsd: unpriced model id '${model}'. Add it to PRICING before pricing it.`,
      );
    }
    p = MAX_PRICE;
    if (!_unpricedModelsAlerted.has(model)) {
      _unpricedModelsAlerted.add(model);
      void alert({
        source: "cost.estimate",
        code: "unpriced_model",
        msg: `Unpriced model id '${model}' — charged at MAX rate. Add it to PRICING.`,
        tenant_id: opts?.tenant_id ?? null,
      });
    }
  }
  const cacheWriteRate = p.cacheWrite ?? p.input * CACHE_WRITE_MULT;
  const cacheWrite1hRate = p.input * CACHE_WRITE_1H_MULT;
  const cacheReadRate = p.cacheRead ?? p.input * CACHE_READ_MULT;
  const totalWrites = usage.cache_creation_input_tokens ?? 0;
  const writes1h = Math.min(
    Math.max(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, 0),
    totalWrites,
  );
  const writes5m = Math.max(totalWrites - writes1h, 0);
  const inputCost =
    (usage.input_tokens / 1_000_000) * p.input +
    (writes5m / 1_000_000) * cacheWriteRate +
    (writes1h / 1_000_000) * cacheWrite1hRate +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * cacheReadRate;
  const outputCost = (usage.output_tokens / 1_000_000) * p.output;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}
