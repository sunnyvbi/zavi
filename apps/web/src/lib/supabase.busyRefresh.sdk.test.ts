import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { keepSessionOnBusyRefresh } from "./supabase";

let server: Server;
let base = "";
let refreshStatus = 429;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/auth/v1/token") && req.url.includes("grant_type=refresh_token")) {
      res.writeHead(refreshStatus, { "content-type": "application/json" }).end(JSON.stringify({ code: refreshStatus, error_code: refreshStatus === 429 ? "over_request_rate_limit" : "refresh_token_not_found", msg: "nope" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

function header(o: object) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

async function storedSessionAfterRefresh(wrap: boolean): Promise<boolean> {
  const storage = memoryStorage();
  const key = "sb-test-auth-token";
  const exp = Math.floor(Date.now() / 1000) - 60;
  const access = `${header({ alg: "HS256", typ: "JWT" })}.${header({ sub: "u1", exp, aud: "authenticated", role: "authenticated" })}.sig`;
  storage.setItem(key, JSON.stringify({ access_token: access, refresh_token: "rt-1", expires_at: exp, expires_in: -60, token_type: "bearer", user: { id: "u1", aud: "authenticated" } }));
  const client = createClient(base, "anon", {
    auth: { storage, storageKey: key, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
    global: { fetch: wrap ? keepSessionOnBusyRefresh(fetch) : fetch },
  });
  await client.auth.getSession();
  return storage.m.has(key);
}

describe("supabase-js itself, with the busy-refresh wrapper", () => {
  it("a 429 on refresh keeps the stored session with the wrapper", async () => {
    refreshStatus = 429;
    expect(await storedSessionAfterRefresh(true)).toBe(true);
  }, 60_000);

  it("without the wrapper, the same 429 makes supabase-js delete the session (the bug)", async () => {
    refreshStatus = 429;
    expect(await storedSessionAfterRefresh(false)).toBe(false);
  }, 60_000);

  it("a rejected refresh token (400) still ends the session with the wrapper", async () => {
    refreshStatus = 400;
    expect(await storedSessionAfterRefresh(true)).toBe(false);
  }, 60_000);
});
