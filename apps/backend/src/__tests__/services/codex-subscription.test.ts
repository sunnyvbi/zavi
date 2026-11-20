import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isCodexEnabled,
  getCodexClient,
  assertUnderWeeklyCap,
  CodexWeeklyCapError,
  criticViaCodex,
  applyCodexBodyQuirks,
  __resetCodexClientForTests,
} from "@/services/codex-subscription";

const ENV_KEYS = [
  "CODEX_ACCESS_TOKEN",
  "CODEX_ACCOUNT_ID",
  "CODEX_BASE_URL",
  "CODEX_SECONDARY_BACKOFF_PCT",
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetCodexClientForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetCodexClientForTests();
});

describe("codex-subscription — gating (dark by default)", () => {
  it("isCodexEnabled() is false and getCodexClient() is null when CODEX_ACCESS_TOKEN unset", () => {
    expect(isCodexEnabled()).toBe(false);
    expect(getCodexClient()).toBeNull();
  });

  it("returns a configured client (codex baseURL) when CODEX_ACCESS_TOKEN is set", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    process.env.CODEX_ACCOUNT_ID = "acct-123";
    expect(isCodexEnabled()).toBe(true);
    const client = getCodexClient();
    expect(client).not.toBeNull();
    expect(client!.baseURL).toContain("/backend-api/codex");
  });

  it("honors CODEX_BASE_URL override", () => {
    process.env.CODEX_ACCESS_TOKEN = "test-token";
    process.env.CODEX_BASE_URL = "https://example.test/codex";
    const client = getCodexClient();
    expect(client!.baseURL).toContain("example.test");
  });
});

describe("codex-subscription — applyCodexBodyQuirks (transport enforcement)", () => {
  it("forces store:false and strips max_output_tokens on a responses body", () => {
    const out = JSON.parse(
      applyCodexBodyQuirks(
        JSON.stringify({
          model: "gpt-5.5",
          input: [{ role: "user", content: "hi" }],
          store: true,
          max_output_tokens: 1500,
          stream: true,
        }),
      ),
    );
    expect(out.store).toBe(false);
    expect(out.max_output_tokens).toBeUndefined();
    expect(out.stream).toBe(true);
  });

  it("leaves non-responses JSON and non-JSON bodies untouched", () => {
    expect(applyCodexBodyQuirks('{"foo":1}')).toBe('{"foo":1}');
    expect(applyCodexBodyQuirks("not json")).toBe("not json");
  });
});

describe("codex-subscription — assertUnderWeeklyCap (weekly backoff)", () => {
  const hdr = (pct: string | null) => ({
    get: (k: string) =>
      k.toLowerCase() === "x-codex-secondary-used-percent" ? pct : null,
  });

  it("throws CodexWeeklyCapError at/over the threshold (default 80)", () => {
    expect(() => assertUnderWeeklyCap(hdr("80"))).toThrow(CodexWeeklyCapError);
    expect(() => assertUnderWeeklyCap(hdr("95"))).toThrow(CodexWeeklyCapError);
  });

  it("passes under the threshold", () => {
    expect(() => assertUnderWeeklyCap(hdr("79"))).not.toThrow();
    expect(() => assertUnderWeeklyCap(hdr("0"))).not.toThrow();
  });

  it("no-ops when the header is absent or non-numeric (never block on a bad header)", () => {
    expect(() => assertUnderWeeklyCap(hdr(null))).not.toThrow();
    expect(() => assertUnderWeeklyCap(hdr("garbage"))).not.toThrow();
    expect(() => assertUnderWeeklyCap({})).not.toThrow();
  });

  it("reads from a plain record header bag too", () => {
    expect(() =>
      assertUnderWeeklyCap({ "x-codex-secondary-used-percent": "90" }),
    ).toThrow(CodexWeeklyCapError);
  });
});

describe("codex-subscription — criticViaCodex (responses→critic mapping)", () => {
  function fakeClient(opts: {
    outputText: string;
    usage: { input_tokens: number; output_tokens: number };
    secondaryPct?: string;
  }) {
    async function* events() {
      yield { type: "response.output_text.delta", delta: opts.outputText };
      yield { type: "response.completed", response: { usage: opts.usage } };
    }
    const create = vi.fn((_body?: unknown, _opts?: unknown) => ({
      withResponse: async () => ({
        data: events(),
        response: {
          headers: {
            get: (k: string) =>
              k.toLowerCase() === "x-codex-secondary-used-percent"
                ? (opts.secondaryPct ?? "10")
                : null,
          },
        },
      }),
    }));
    return { client: { responses: { create } }, create };
  }

  const args = {
    model: "gpt-5.5",
    systemPrompt: "sys",
    userMsg: "user",
    schemaName: "critic_verdict",
    schema: { type: "object" } as Record<string, unknown>,
    signal: new AbortController().signal,
  };

  it("accumulates stream text + usage; sends top-level instructions, stream:true, store:false, json_schema, NO max_output_tokens", async () => {
    const { client, create } = fakeClient({
      outputText: '{"verdict":"pass"}',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const r = await criticViaCodex(client as never, args);
    expect(r.raw).toBe('{"verdict":"pass"}');
    expect(r.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    const body = create.mock.calls[0][0] as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("sys");
    expect(body.max_output_tokens).toBeUndefined();
    expect((body.text as { format: { type: string } }).format.type).toBe(
      "json_schema",
    );
  });

  it("throws CodexWeeklyCapError when the weekly window is over cap", async () => {
    const { client } = fakeClient({
      outputText: "{}",
      usage: { input_tokens: 1, output_tokens: 1 },
      secondaryPct: "99",
    });
    await expect(criticViaCodex(client as never, args)).rejects.toBeInstanceOf(
      CodexWeeklyCapError,
    );
  });
});
