import { describe, it, expect, vi } from "vitest";
import {
  dbFetchTimeoutMs,
  fetchWithTimeout,
  timeoutForRequest,
  DEFAULT_DB_FETCH_TIMEOUT_MS,
} from "../db-fetch-timeout";

const hanging = vi.fn((_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
  }),
);

describe("dbFetchTimeoutMs", () => {
  it("defaults to 30s, honours a number, 0 disables, junk falls back", () => {
    expect(DEFAULT_DB_FETCH_TIMEOUT_MS).toBe(30_000);
    expect(dbFetchTimeoutMs({})).toBe(30_000);
    expect(dbFetchTimeoutMs({ SUPABASE_FETCH_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(dbFetchTimeoutMs({ SUPABASE_FETCH_TIMEOUT_MS: "0" })).toBe(0);
    expect(dbFetchTimeoutMs({ SUPABASE_FETCH_TIMEOUT_MS: "abc" })).toBe(30_000);
    expect(dbFetchTimeoutMs({ SUPABASE_FETCH_TIMEOUT_MS: "-5" })).toBe(30_000);
  });
});

describe("timeoutForRequest", () => {
  it("storage transfers get the longer bound, queries and auth keep theirs", () => {
    expect(timeoutForRequest("https://x.supabase.co/storage/v1/object/b/k", 30_000)).toBe(600_000);
    expect(timeoutForRequest("https://x.supabase.co/rest/v1/agent_runs", 30_000)).toBe(30_000);
    expect(timeoutForRequest("https://x.supabase.co/auth/v1/user", 30_000)).toBe(30_000);
    expect(timeoutForRequest("https://x.supabase.co/storage/v1/object/b/k", 900_000)).toBe(900_000);
  });
});

describe("fetchWithTimeout", () => {
  it("aborts a hanging request after the timeout", async () => {
    const f = fetchWithTimeout(20, hanging as unknown as typeof fetch);
    await expect(f("https://x.supabase.co/rest/v1/t")).rejects.toThrow(/timed out/);
  });

  it("returns the response when it arrives in time", async () => {
    const ok = vi.fn(async () => new Response("ok"));
    const r = await fetchWithTimeout(1000, ok as unknown as typeof fetch)("https://x/rest/v1/t");
    expect(await r.text()).toBe("ok");
  });

  it("0 means no timeout: the base fetch is returned unchanged", () => {
    const base = vi.fn() as unknown as typeof fetch;
    expect(fetchWithTimeout(0, base)).toBe(base);
  });

  it("a caller's own abort (init.signal) still works", async () => {
    const f = fetchWithTimeout(10_000, hanging as unknown as typeof fetch);
    const ac = new AbortController();
    const p = f("https://x/rest/v1/t", { signal: ac.signal });
    ac.abort(new Error("caller cancelled"));
    await expect(p).rejects.toThrow("caller cancelled");
  });

  it("a signal carried on a Request object is honoured too", async () => {
    const f = fetchWithTimeout(10_000, hanging as unknown as typeof fetch);
    const ac = new AbortController();
    const p = f(new Request("https://x/rest/v1/t", { signal: ac.signal }));
    ac.abort(new Error("request cancelled"));
    await expect(p).rejects.toThrow("request cancelled");
  });

  it("removes its listener from the caller's signal once the request settles", async () => {
    const ok = vi.fn(async () => new Response("ok"));
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    await fetchWithTimeout(1000, ok as unknown as typeof fetch)("https://x/rest/v1/t", { signal: ac.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
