import { describe, expect, it, vi } from "vitest";
import { keepSessionOnBusyRefresh } from "./supabase";

const REFRESH = "https://proj.supabase.co/auth/v1/token?grant_type=refresh_token";

describe("a busy auth server during a token refresh never ends the session", () => {
  it.each([408, 429])("a %i on the refresh call reaches supabase-js as a network failure, which it retries and keeps the session", async (status) => {
    const wrapped = keepSessionOnBusyRefresh(vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch);
    await expect(wrapped(REFRESH, { method: "POST" })).rejects.toThrow(TypeError);
    await expect(wrapped(new URL(REFRESH), { method: "POST" })).rejects.toThrow(TypeError);
    await expect(wrapped(new Request(REFRESH, { method: "POST" }))).rejects.toThrow(TypeError);
  });

  it("a rejected refresh token (400) still comes back as the auth server said, so a dead session still ends", async () => {
    const wrapped = keepSessionOnBusyRefresh(vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch);
    expect((await wrapped(REFRESH, { method: "POST" })).status).toBe(400);
  });

  it("a 429 anywhere else (sign-in, data reads) is passed through unchanged", async () => {
    const wrapped = keepSessionOnBusyRefresh(vi.fn(async () => new Response("{}", { status: 429 })) as unknown as typeof fetch);
    expect((await wrapped("https://proj.supabase.co/auth/v1/token?grant_type=password", { method: "POST" })).status).toBe(429);
    expect((await wrapped("https://proj.supabase.co/rest/v1/tenants?select=id")).status).toBe(429);
  });
});
