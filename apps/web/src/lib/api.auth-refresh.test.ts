import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let token = "stale";
let refreshOk = true;
let refreshError: unknown = new Error("no session");
const signOut = vi.fn(async () => ({ error: null }));
let staleSessionRead = false;
const refreshSession = vi.fn(async () => {
  if (!refreshOk) return { data: { session: null }, error: refreshError };
  token = "fresh";
  return { data: { session: { access_token: token } }, error: null };
});

vi.mock("./supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: staleSessionRead ? "stale" : token } } }),
      refreshSession,
      signOut,
    },
  }),
}));

import { apiFetch } from "./api";

const bearerOf = (call: unknown[]) =>
  new Headers((call[1] as RequestInit).headers).get("Authorization");

describe("apiFetch refresh-once-on-401", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    token = "stale";
    refreshOk = true;
    refreshError = new Error("no session");
    signOut.mockClear();
    staleSessionRead = false;
    refreshSession.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes the session and replays the request with the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const res = await apiFetch("/api/workspace/autopilot/build-status?run_id=b1");

    expect(res.status).toBe(200);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchMock.mock.calls[0])).toBe("Bearer stale");
    expect(bearerOf(fetchMock.mock.calls[1])).toBe("Bearer fresh");
  });

  it("returns the original 401 when the refresh fails", async () => {
    refreshOk = false;
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));

    const res = await apiFetch("/api/x");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays a POST, since a 401 is rejected before the handler runs", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const res = await apiFetch("/api/x", { method: "POST", body: '{"a":1}' });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe('{"a":1}');
  });

  it("uses the refreshed token even when the cached session still reads stale", async () => {
    staleSessionRead = true;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get("Authorization") === "Bearer fresh"
        ? new Response("{}", { status: 200 })
        : new Response("{}", { status: 401 }),
    );

    const response = await apiFetch("/api/workspace/setup/progress", {
      method: "POST", body: '{"step":"docs","outcome":"skipped"}',
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerOf(fetchMock.mock.calls[1])).toBe("Bearer fresh");
  });

  it("single-flights the refresh when several pollers 401 at once", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get("Authorization") === "Bearer fresh"
        ? new Response("{}", { status: 200 })
        : new Response("{}", { status: 401 }),
    );

    const all = await Promise.all([
      apiFetch("/api/a"),
      apiFetch("/api/b"),
      apiFetch("/api/c"),
    ]);

    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the response is fine", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/x");
    expect(refreshSession).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a session the auth server no longer knows", () => {
  const fetchMock = vi.fn();
  const assign = vi.fn();

  beforeEach(() => {
    token = "stale";
    refreshOk = false;
    signOut.mockClear();
    assign.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { pathname: "/workspace", search: "?tab=growth-strategy", assign } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a rejected refresh token (400 invalid refresh token) clears the session and sends the founder to sign in, back to the same page", async () => {
    refreshError = Object.assign(new Error("Invalid Refresh Token: Refresh Token Not Found"), { status: 400, name: "AuthApiError" });
    const res = await apiFetch("/api/workspace/growth/plan");
    expect(res.status).toBe(401);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(assign).toHaveBeenCalledWith("/login?next=%2Fworkspace%3Ftab%3Dgrowth-strategy");
  });

  it("an auth outage (network error or 5xx on refresh) never signs anyone out", async () => {
    for (const err of [
      Object.assign(new Error("Failed to fetch"), { status: 0, name: "AuthRetryableFetchError" }),
      Object.assign(new Error("upstream"), { status: 522, name: "AuthRetryableFetchError" }),
      Object.assign(new Error("Request rate limit reached"), { status: 429, name: "AuthApiError" }),
      Object.assign(new Error("Request timeout"), { status: 408, name: "AuthApiError" }),
      new Error("no status at all"),
    ]) {
      refreshError = err;
      await apiFetch("/api/workspace/growth/plan");
    }
    expect(signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a visitor with no session at all (supabase-js AuthSessionMissingError, status 400) is never sent to sign in", async () => {
    vi.stubGlobal("window", { location: { pathname: "/start", search: "", assign } });
    refreshError = Object.assign(new Error("Auth session missing!"), { status: 400, name: "AuthSessionMissingError" });
    await apiFetch("/api/onboarding/brainstorm");
    expect(signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("already on the sign-in page: clears the session without looping a redirect", async () => {
    vi.stubGlobal("window", { location: { pathname: "/login", search: "", assign } });
    refreshError = Object.assign(new Error("Invalid Refresh Token"), { status: 400, name: "AuthApiError" });
    await apiFetch("/api/x");
    expect(signOut).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
