
import { isProviderAuthError, isUsageLimitError } from "./infra-retry";
import { getOAuthTokenPoolOverride } from "./oauth-token-source";
import { seatLabelForToken } from "./seat-identity";
import {
  isSeatCoolingShared,
  publishSeatCooldown,
} from "./seat-cooldown-store";
import { usageLimitBenchMs } from "./seat-limit";
import { orderByRoom, seatHeadroomRoutingEnabled } from "./seat-usage-store";

export type AgentAuthMode = "oauth" | "api_key" | "none";

export function preferApiKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PRAXIS_AGENT_AUTH_MODE?.trim().toLowerCase() === "api_key";
}

export function preferApiKeyForProductBuilderCodegen(args: {
  isProductBuilderCodegen: boolean;
  apiKey?: string | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = args.env ?? process.env;
  if (preferApiKeyFromEnv(env)) return true;
  if (env.PRAXIS_BUILDER_AUTH_MODE?.trim().toLowerCase() === "oauth")
    return false;
  if (!args.isProductBuilderCodegen) return false;
  return Boolean(args.apiKey?.trim());
}

export function resolveAgentAuthMode(args: {
  oauthToken?: string | null;
  apiKey?: string | null;
  preferApiKey: boolean;
}): AgentAuthMode {
  const oauthToken = args.oauthToken?.trim() || undefined;
  const apiKey = args.apiKey?.trim() || undefined;
  if (args.preferApiKey) {
    return apiKey ? "api_key" : oauthToken ? "oauth" : "none";
  }
  return oauthToken ? "oauth" : apiKey ? "api_key" : "none";
}

export type PromptCacheTtl = "1h" | "5m";

export const MCP_DESCRIPTION_MAX_CHARS = 12_000;

export function buildAgentChildEnv(args: {
  mode: AgentAuthMode;
  oauthToken?: string | null;
  apiKey?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
  promptCacheTtl?: PromptCacheTtl;
}): NodeJS.ProcessEnv {
  const base = args.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = { ...base };
  if (args.promptCacheTtl === "5m") {
    env.ENABLE_PROMPT_CACHING_1H = "0";
    env.FORCE_PROMPT_CACHING_5M = "1";
  } else if (env.ENABLE_PROMPT_CACHING_1H === undefined) {
    env.ENABLE_PROMPT_CACHING_1H = "1";
  }
  if (env.MCP_CONNECTION_NONBLOCKING === undefined) env.MCP_CONNECTION_NONBLOCKING = "0";
  if (env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH === undefined) {
    env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(MCP_DESCRIPTION_MAX_CHARS);
  }
  const oauthToken = args.oauthToken?.trim() || undefined;
  const apiKey = args.apiKey?.trim() || undefined;
  delete env.CLAUDE_CODE_OAUTH_TOKENS;
  if (args.mode === "api_key") {
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (args.mode === "oauth") {
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

export function resolveOAuthTokenPool(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = getOAuthTokenPoolOverride();
  if (override.length) return override;
  for (const raw of [env.CLAUDE_CODE_OAUTH_TOKENS, env.CLAUDE_CODE_OAUTH_TOKEN]) {
    const toks = (raw ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (toks.length) return toks;
  }
  return [];
}

export function resolveAttemptTokens(args: {
  pool: string[];
  apiKey?: string | null;
  preferApiKey: boolean;
  startOffset?: number;
  now?: number;
}): Array<string | undefined> {
  const resolvedMode = resolveAgentAuthMode({
    oauthToken: args.pool[0],
    apiKey: args.apiKey,
    preferApiKey: args.preferApiKey,
  });
  if (resolvedMode === "oauth" && args.pool.length >= 2) {
    return orderAttemptTokens({
      pool: args.pool,
      startOffset: args.startOffset ?? 0,
      now: args.now,
    });
  }
  return [args.pool[0]];
}

let rrCounter = 0;

export function nextStartOffset(poolLength: number): number {
  if (poolLength < 2) return 0;
  const offset = rrCounter % poolLength;
  rrCounter = (rrCounter + 1) % (poolLength * 1_000_000);
  return offset;
}

export function tokenCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PRAXIS_OAUTH_TOKEN_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60_000;
}

const cooldownUntil = new Map<string, number>();

export function markTokenCooldown(
  token: string | undefined,
  now: number = Date.now(),
  ms: number = tokenCooldownMs(),
): void {
  if (!token) return;
  const until = Math.max(now + ms, cooldownUntil.get(token) ?? 0);
  cooldownUntil.set(token, until);
  for (const [t, cd] of cooldownUntil) if (cd <= now) cooldownUntil.delete(t);
  publishSeatCooldown({ seat: seatLabelForToken(token), until });
}

export function isTokenCooling(token: string, now: number = Date.now()): boolean {
  const until = cooldownUntil.get(token);
  if (until != null && until > now) return true;
  return isSeatCoolingShared(seatLabelForToken(token), now);
}

export function _resetTokenRotationForTest(): void {
  rrCounter = 0;
  cooldownUntil.clear();
}

export function orderAttemptTokens(args: {
  pool: string[];
  startOffset?: number;
  now?: number;
}): string[] {
  const { pool } = args;
  if (pool.length < 2) return [...pool];
  const now = args.now ?? Date.now();
  const off = ((args.startOffset ?? 0) % pool.length + pool.length) % pool.length;
  const rotated = [...pool.slice(off), ...pool.slice(0, off)];
  if (seatHeadroomRoutingEnabled()) {
    return orderByRoom(rotated, (t) => isTokenCooling(t, now), (t) => seatLabelForToken(t), now);
  }
  const hot = rotated.filter((t) => !isTokenCooling(t, now));
  const cooling = rotated.filter((t) => isTokenCooling(t, now));
  return [...hot, ...cooling];
}

export function benchSeatForLimit(
  token: string | undefined,
  text: string,
  sdkResetsAtSec?: number | null,
  now: number = Date.now(),
): void {
  markTokenCooldown(token, now, usageLimitBenchMs(text, now, sdkResetsAtSec));
}

export function shouldRotateOnUsageLimit(args: {
  hasMoreTokens: boolean;
  attemptDirty: boolean;
  aborted: boolean;
  resultText: string | null;
}): boolean {
  return (
    args.hasMoreTokens &&
    !args.attemptDirty &&
    !args.aborted &&
    (isUsageLimitError(args.resultText) || isProviderAuthError(args.resultText))
  );
}

export function planUsageLimitRetry(args: {
  hasMoreTokens: boolean;
  attemptDirty: boolean;
  aborted: boolean;
  resultText: string | null;
  durableAttached: boolean;
}): "rotate" | "rotate_without_durable" | "none" {
  if (
    !shouldRotateOnUsageLimit({
      hasMoreTokens: args.hasMoreTokens,
      attemptDirty: args.attemptDirty,
      aborted: args.aborted,
      resultText: args.resultText,
    })
  )
    return "none";
  return args.durableAttached ? "rotate_without_durable" : "rotate";
}
