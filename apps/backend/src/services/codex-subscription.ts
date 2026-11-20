
import OpenAI from "openai";

let _client: OpenAI | null = null;
let _resolved = false;

export function isCodexEnabled(): boolean {
  return !!process.env.CODEX_ACCESS_TOKEN;
}

export function applyCodexBodyQuirks(bodyStr: string): string {
  try {
    const b = JSON.parse(bodyStr) as Record<string, unknown>;
    if (b && typeof b === "object" && "model" in b && "input" in b) {
      b.store = false;
      delete b.max_output_tokens;
      return JSON.stringify(b);
    }
  } catch {
  }
  return bodyStr;
}

const codexFetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  if (init?.body && typeof init.body === "string") {
    init = { ...init, body: applyCodexBodyQuirks(init.body) };
  }
  return fetch(input, init);
}) as typeof fetch;

let _expiredWarned = false;

function warnExpiredOnce(days: number): void {
  if (_expiredWarned) return;
  _expiredWarned = true;
  console.error(
    `[codex] CODEX_ACCESS_TOKEN EXPIRED ${Math.abs(days).toFixed(1)} days ago — ` +
      `codex-routed lanes (cto/plan critic, shadow replay) are DEGRADED to skipped ` +
      `until it is rotated. Re-sync: codex login && npm run sync:codex-env, then restart.`,
  );
}

export function getCodexClient(): OpenAI | null {
  const apiKey = process.env.CODEX_ACCESS_TOKEN;
  if (!apiKey) {
    _resolved = true;
    _client = null;
    return null;
  }
  const days = codexTokenDaysLeft();
  if (days !== null && days <= 0) {
    warnExpiredOnce(days);
    _client = null;
    return null;
  }
  if (_resolved) return _client;
  _resolved = true;
  _client = new OpenAI({
    apiKey,
    baseURL:
      process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex",
    defaultHeaders: {
      "chatgpt-account-id": process.env.CODEX_ACCOUNT_ID ?? "",
      originator: "codex_cli_rs",
      "OpenAI-Beta": "responses=experimental",
    },
    fetch: codexFetch,
  });
  return _client;
}

export function codexTokenExpiryEpoch(
  token = process.env.CODEX_ACCESS_TOKEN,
): number | null {
  const raw = token?.trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp
      : null;
  } catch {
    return null;
  }
}

export function codexTokenDaysLeft(nowMs = Date.now()): number | null {
  const exp = codexTokenExpiryEpoch();
  if (exp === null) return null;
  return (exp * 1000 - nowMs) / 86_400_000;
}

export const CODEX_TOKEN_WARN_DAYS = 2;

export function logCodexTokenStatus(): void {
  if (!isCodexEnabled()) return;
  const days = codexTokenDaysLeft();
  if (days === null) {
    console.warn(
      "[codex] CODEX_ACCESS_TOKEN is set but its expiry could not be read — " +
        "is it a ChatGPT OAuth token from ~/.codex/auth.json?",
    );
    return;
  }
  const when = new Date(Date.now() + days * 86_400_000).toISOString();
  if (days <= 0) {
    console.error(
      `[codex] CODEX_ACCESS_TOKEN EXPIRED ${when} — every codex-routed call will ` +
        `401. Re-sync: codex login && npm run sync:codex-env, then restart.`,
    );
    return;
  }
  if (days <= CODEX_TOKEN_WARN_DAYS) {
    console.warn(
      `[codex] CODEX_ACCESS_TOKEN expires in ${days.toFixed(1)} days (${when}) — ` +
        `rotate it before it lapses.`,
    );
    return;
  }
  console.log(`[codex] access token valid for ${days.toFixed(1)} more days (${when})`);
}

export function __resetCodexClientForTests(): void {
  _client = null;
  _resolved = false;
  _expiredWarned = false;
}

export const CODEX_SECONDARY_BACKOFF_PCT = Number(
  process.env.CODEX_SECONDARY_BACKOFF_PCT ?? 80,
);

export class CodexWeeklyCapError extends Error {
  constructor(pct: number) {
    super(
      `codex weekly cap backoff: x-codex-secondary-used-percent=${pct} >= ${CODEX_SECONDARY_BACKOFF_PCT}`,
    );
    this.name = "CodexWeeklyCapError";
  }
}

type HeaderLike =
  | Headers
  | { get(key: string): string | null }
  | Record<string, string | undefined>;

export function assertUnderWeeklyCap(headers: HeaderLike): void {
  let raw: string | null | undefined;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get(k: string): string | null }).get(
      "x-codex-secondary-used-percent",
    );
  } else if (headers) {
    const rec = headers as Record<string, string | undefined>;
    raw =
      rec["x-codex-secondary-used-percent"] ??
      rec["X-Codex-Secondary-Used-Percent"];
  }
  if (raw == null) return;
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return;
  if (pct >= CODEX_SECONDARY_BACKOFF_PCT) throw new CodexWeeklyCapError(pct);
}

export async function criticViaCodex(
  client: OpenAI,
  args: {
    model: string;
    systemPrompt: string;
    userMsg: string;
    schemaName: string;
    schema: Record<string, unknown>;
    signal: AbortSignal;
  },
): Promise<{ raw: string; usage: { input_tokens: number; output_tokens: number } }> {
  const { data: stream, response } = await client.responses
    .create(
      {
        model: args.model,
        store: false,
        stream: true,
        instructions: args.systemPrompt,
        input: [{ role: "user", content: args.userMsg }],
        text: {
          format: {
            type: "json_schema",
            name: args.schemaName,
            strict: true,
            schema: args.schema,
          },
        },
      },
      { signal: args.signal },
    )
    .withResponse();
  assertUnderWeeklyCap(response.headers);
  let raw = "";
  let usage = { input_tokens: 0, output_tokens: 0 };
  for await (const ev of stream) {
    if (ev.type === "response.output_text.delta") {
      raw += ev.delta;
    } else if (ev.type === "response.completed") {
      const u = ev.response.usage;
      usage = {
        input_tokens: u?.input_tokens ?? 0,
        output_tokens: u?.output_tokens ?? 0,
      };
    }
  }
  return { raw, usage };
}
