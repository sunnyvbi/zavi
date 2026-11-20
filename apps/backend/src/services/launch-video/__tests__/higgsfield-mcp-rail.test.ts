
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/services/tenant-client", () => ({
  platformSecretRpc: (...a: unknown[]) => rpc(...a),
}));

import {
  getPlatformAccessToken,
  __resetTokenCacheForTests,
  REFRESH_SECRET_KEY,
} from "@/services/connectors/higgsfield/token-provider";
import { generateMcpImage } from "../platform-higgsfield-mcp";

function sse(result: unknown): string {
  return `event: message\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id: 1 })}\n\n`;
}

function mockFetchSequence(...responses: Array<{ status?: number; body: string }>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const r of responses) {
    spy.mockResolvedValueOnce({
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      text: async () => r.body,
    } as unknown as Response);
  }
  return spy;
}

function mockSecretStore(initial: string | null) {
  let stored = initial;
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "get_platform_secret") return { data: stored, error: null };
    if (name === "set_platform_secret") {
      stored = args.p_value as string;
      return { data: null, error: null };
    }
    if (name === "rotate_platform_secret_cas") {
      if (stored !== null && stored !== args.p_expected) return { data: false, error: null };
      stored = args.p_new as string;
      return { data: true, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return {
    get current() {
      return stored;
    },
  };
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  __resetTokenCacheForTests();
  rpc.mockReset();
  process.env.HIGGSFIELD_OAUTH_CLIENT_ID = "cid_test";
  process.env.HIGGSFIELD_OAUTH_CLIENT_SECRET = "csecret_test";
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

describe("token provider — rotation is the whole ballgame", () => {
  it("persists the rotated refresh token before handing out the access token", async () => {
    const store = mockSecretStore("refresh_v1");
    mockFetchSequence({
      body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }),
    });

    const token = await getPlatformAccessToken();
    expect(token).toBe("at_1");
    expect(store.current).toBe("refresh_v2");
  });

  it("writes the rotation through a compare-and-swap keyed on what it minted from", async () => {
    mockSecretStore("refresh_v1");
    mockFetchSequence({
      body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }),
    });
    await getPlatformAccessToken();

    const cas = rpc.mock.calls.find(([n]) => n === "rotate_platform_secret_cas");
    expect(cas).toBeTruthy();
    expect(cas![1]).toMatchObject({
      p_key: REFRESH_SECRET_KEY,
      p_expected: "refresh_v1",
      p_new: "refresh_v2",
    });
  });

  it("does not rewrite the secret when the server returns the same token", async () => {
    mockSecretStore("refresh_v1");
    mockFetchSequence({
      body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v1", expires_in: 86400 }),
    });
    await getPlatformAccessToken();
    expect(rpc.mock.calls.some(([n]) => n === "rotate_platform_secret_cas")).toBe(false);
  });

  it("single-flights a burst so one refresh is consumed, not five", async () => {
    mockSecretStore("refresh_v1");
    const spy = mockFetchSequence({
      body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }),
    });

    const all = await Promise.all([
      getPlatformAccessToken(),
      getPlatformAccessToken(),
      getPlatformAccessToken(),
      getPlatformAccessToken(),
      getPlatformAccessToken(),
    ]);
    expect(all).toEqual(["at_1", "at_1", "at_1", "at_1", "at_1"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("caches across calls so a healthy process refreshes about once a day", async () => {
    mockSecretStore("refresh_v1");
    const spy = mockFetchSequence({
      body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }),
    });
    await getPlatformAccessToken();
    await getPlatformAccessToken();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("leaves the stored credential untouched when the refresh is rejected", async () => {
    const store = mockSecretStore("refresh_v1");
    mockFetchSequence({ status: 400, body: '{"error":"invalid_grant"}' });
    await expect(getPlatformAccessToken()).rejects.toThrow(/400/);
    expect(store.current).toBe("refresh_v1");
  });

  it("never echoes the refresh token in the thrown error", async () => {
    mockSecretStore("supersecretrefreshvalue");
    mockFetchSequence({ status: 400, body: '{"error":"invalid_grant","hint":"supersecretrefreshvalue"}' });
    await expect(getPlatformAccessToken()).rejects.toThrow(/«redacted»/);
  });

  it("says what to do when there is no credential at all", async () => {
    mockSecretStore(null);
    await expect(getPlatformAccessToken()).rejects.toThrow(/bootstrap/);
  });
});

async function withFakeWaits<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const p = fn();
    await vi.runAllTimersAsync();
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

describe("generateMcpImage — submit, poll, url", () => {
  function primedToken() {
    mockSecretStore("refresh_v1");
    return {
      body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }),
    };
  }

  it("returns the rendered image url", async () => {
    const tok = primedToken();
    mockFetchSequence(
      tok,
      { body: sse({ structuredContent: { results: [{ id: "job_1", status: "pending" }] } }) },
      {
        body: sse({
          structuredContent: {
            generation: { status: "completed", results: { rawUrl: "https://cdn.example/x.png" } },
          },
        }),
      },
    );

    const r = await generateMcpImage({ prompt: "a blue mug" });
    expect(r).toMatchObject({ ok: true, url: "https://cdn.example/x.png", jobId: "job_1" });
  });

  it("parses SSE framing rather than assuming one JSON document", async () => {
    const tok = primedToken();
    mockFetchSequence(
      tok,
      { body: "event: message\ndata: " + JSON.stringify({ result: { structuredContent: { results: [{ id: "job_2" }] } }, jsonrpc: "2.0", id: 1 }) + "\n\n" },
      { body: sse({ structuredContent: { generation: { status: "completed", results: { rawUrl: "https://cdn.example/y.png" } } } }) },
    );
    const r = await generateMcpImage({ prompt: "x" });
    expect(r.ok && r.url).toBe("https://cdn.example/y.png");
  });

  it("reports a job that ended without a url instead of inventing one", async () => {
    const tok = primedToken();
    mockFetchSequence(
      tok,
      { body: sse({ structuredContent: { results: [{ id: "job_3" }] } }) },
      { body: sse({ structuredContent: { generation: { status: "failed", results: {} } } }) },
    );
    const r = await generateMcpImage({ prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/failed/);
  });

  it("keeps polling while the job is still in progress (sync only waits ~25s)", async () => {
    const tok = primedToken();
    const spy = mockFetchSequence(
      tok,
      { body: sse({ structuredContent: { results: [{ id: "job_4" }] } }) },
      { body: sse({ structuredContent: { generation: { status: "in_progress", results: {} } } }) },
      { body: sse({ structuredContent: { generation: { status: "queued" } } }) },
      { body: sse({ structuredContent: { generation: { status: "completed", results: { rawUrl: "https://cdn.example/w.png" } } } }) },
    );
    const r = await withFakeWaits(() => generateMcpImage({ prompt: "x" }));
    expect(r).toMatchObject({ ok: true, url: "https://cdn.example/w.png", jobId: "job_4" });
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("keeps polling through a status it has never seen, or none at all", async () => {
    const tok = primedToken();
    mockFetchSequence(
      tok,
      { body: sse({ structuredContent: { results: [{ id: "job_5" }] } }) },
      { body: sse({ structuredContent: { generation: { status: "Starting" } } }) },
      { body: sse({ structuredContent: {} }) },
      { body: sse({ structuredContent: { generation: { status: "completed", results: { rawUrl: "https://cdn.example/v.png" } } } }) },
    );
    const r = await withFakeWaits(() => generateMcpImage({ prompt: "x" }));
    expect(r).toMatchObject({ ok: true, url: "https://cdn.example/v.png" });
  });

  it("waits the server's poll_after_seconds between polls instead of hot-looping", async () => {
    vi.useFakeTimers();
    try {
      const tok = primedToken();
      const spy = mockFetchSequence(
        tok,
        { body: sse({ structuredContent: { results: [{ id: "job_6" }] } }) },
        { body: sse({ structuredContent: { generation: { status: "in_progress" }, poll_after_seconds: 5 } }) },
        { body: sse({ structuredContent: { generation: { status: "completed", results: { rawUrl: "https://cdn.example/u.png" } } } }) },
      );
      const p = generateMcpImage({ prompt: "x" });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(spy).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(p).resolves.toMatchObject({ ok: true, url: "https://cdn.example/u.png" });
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies vendor credit exhaustion on this rail too", async () => {
    const tok = primedToken();
    mockFetchSequence(tok, { status: 403, body: '{"detail":"not_enough_credits"}' });
    const r = await generateMcpImage({ prompt: "x" });
    expect(r.ok === false && r.reason).toBe("vendor_wallet_exhausted");
  });

  it("calls a dead credential a credential problem, not a retryable blip", async () => {
    mockSecretStore("refresh_v1");
    mockFetchSequence({ status: 400, body: '{"error":"invalid_grant"}' });
    const r = await generateMcpImage({ prompt: "x" });
    expect(r.ok === false && r.reason).toBe("credential_rejected");
  });

  it("surfaces an in-band isError result rather than treating it as success", async () => {
    const tok = primedToken();
    mockFetchSequence(tok, {
      body: sse({ isError: true, content: [{ type: "text", text: "model unavailable" }] }),
    });
    const r = await generateMcpImage({ prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/model unavailable/);
  });
});

describe("access token rejected early — re-mint once, stay on MCP", () => {
  it("drops a 401'd cached token, mints a fresh one, and retries on the MCP host", async () => {
    const store = mockSecretStore("refresh_v1");
    const spy = mockFetchSequence(
      { body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }) },
      { status: 401, body: '{"error":"Unauthorized"}' },
      { body: JSON.stringify({ access_token: "at_2", refresh_token: "refresh_v3", expires_in: 86400 }) },
      { body: sse({ structuredContent: { results: [{ id: "job_9" }] } }) },
      { body: sse({ structuredContent: { generation: { status: "completed", results: { rawUrl: "https://cdn.example/z.png" } } } }) },
    );

    const r = await generateMcpImage({ prompt: "x" });
    expect(r).toMatchObject({ ok: true, url: "https://cdn.example/z.png" });
    expect(store.current).toBe("refresh_v3");

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.startsWith("https://mcp.higgsfield.ai/"))).toBe(true);
    const auth = spy.mock.calls
      .filter((c) => String(c[0]).endsWith("/mcp"))
      .map((c) => (c[1] as RequestInit).headers as Record<string, string>)
      .map((h) => h.Authorization);
    expect(auth).toEqual(["Bearer at_1", "Bearer at_2", "Bearer at_2"]);
  });

  it("retries only once: a second 401 is reported as a credential problem", async () => {
    mockSecretStore("refresh_v1");
    const spy = mockFetchSequence(
      { body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }) },
      { status: 401, body: '{"error":"Unauthorized"}' },
      { body: JSON.stringify({ access_token: "at_2", refresh_token: "refresh_v3", expires_in: 86400 }) },
      { status: 401, body: '{"error":"Unauthorized"}' },
    );
    const r = await generateMcpImage({ prompt: "x" });
    expect(r.ok === false && r.reason).toBe("credential_rejected");
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("reports revocation when the re-mint after a 401 is refused", async () => {
    mockSecretStore("refresh_v1");
    mockFetchSequence(
      { body: JSON.stringify({ access_token: "at_1", refresh_token: "refresh_v2", expires_in: 86400 }) },
      { status: 401, body: '{"error":"Unauthorized"}' },
      { status: 400, body: '{"error":"invalid_grant"}' },
    );
    const r = await generateMcpImage({ prompt: "x" });
    expect(r.ok === false && r.reason).toBe("credential_rejected");
    expect(r.ok === false && r.error).toMatch(/token unavailable/);
  });
});

describe("refresh race — the loser must recover, not lose a paid image", () => {
  it("retries once against the token the winner persisted", async () => {
    let stored = "refresh_v1";
    let reads = 0;
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_platform_secret") {
        reads += 1;
        if (reads > 1) stored = "refresh_v2";
        return { data: stored, error: null };
      }
      if (name === "rotate_platform_secret_cas") return { data: true, error: null };
      return { data: null, error: null };
    });
    mockFetchSequence(
      { status: 400, body: '{"error":"invalid_grant"}' },
      { body: JSON.stringify({ access_token: "at_winner", refresh_token: "refresh_v3", expires_in: 86400 }) },
    );

    await expect(getPlatformAccessToken()).resolves.toBe("at_winner");
  });

  it("waits for a winner that has not persisted its rotation YET", async () => {
    let stored = "refresh_v1";
    let reads = 0;
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_platform_secret") {
        reads += 1;
        if (reads >= 3) stored = "refresh_v2";
        return { data: stored, error: null };
      }
      return { data: true, error: null };
    });
    mockFetchSequence(
      { status: 400, body: '{"error":"invalid_grant"}' },
      { body: JSON.stringify({ access_token: "at_after_wait", refresh_token: "refresh_v3", expires_in: 86400 }) },
    );
    await expect(getPlatformAccessToken()).resolves.toBe("at_after_wait");
  });

  it("gives up and reports revocation when the token never moves", async () => {
    mockSecretStore("refresh_v1");
    const spy = mockFetchSequence(
      { status: 400, body: '{"error":"invalid_grant"}' },
      { body: JSON.stringify({ access_token: "should_not_be_reached" }) },
    );
    await expect(getPlatformAccessToken()).rejects.toThrow(/invalid_grant/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-grant failure", async () => {
    mockSecretStore("refresh_v1");
    const spy = mockFetchSequence(
      { status: 500, body: "upstream boom" },
      { body: JSON.stringify({ access_token: "should_not_be_reached" }) },
    );
    await expect(getPlatformAccessToken()).rejects.toThrow(/500/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
