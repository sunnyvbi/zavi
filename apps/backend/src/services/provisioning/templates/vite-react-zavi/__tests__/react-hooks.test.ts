// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createZavi, type FetchLike, type KeyValueStorage, type ResponseLike } from "../files/src/zavi/client";

const SITE = "11111111-2222-4333-8444-555555555555";
const NOW = 1_800_000_000;

function res(status: number, body?: unknown): ResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, headers: { get: () => null }, text: async () => text };
}
function token(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "ES256" })}.${b(claims)}.sig`;
}
function session(role: string) {
  return {
    access_token: token({ sub: "00000000-0000-4000-8000-000000000001", email: "owner@x.test", site_role: role, exp: NOW + 3600 }),
    refresh_token: "refresh-1",
    expires_at: NOW + 3600,
    token_type: "bearer",
  };
}
function memStorage(): KeyValueStorage {
  const data: Record<string, string> = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; }, removeItem: (k) => { delete data[k]; } };
}
function makeZavi() {
  const fetch: FetchLike = async () => res(200, { data: {} });
  return createZavi({ fetch, origin: "https://shop.zavi.site", siteId: async () => SITE, storage: memStorage(), locks: null, now: () => NOW * 1000 });
}

const h = vi.hoisted(() => ({ zavi: null as unknown }));
vi.mock("../files/src/zavi/index", () => ({
  get zavi() { return h.zavi; },
}));

import { useIsAdmin, useSession } from "../files/src/zavi/react";

type Z = ReturnType<typeof makeZavi>;
const z = () => h.zavi as Z;

describe("useSession / useIsAdmin", () => {
  beforeEach(() => { h.zavi = makeZavi(); });

  it("a page mounted after an email-link sign-in in the same tab sees the signed-in admin", async () => {
    await z().auth.ready();
    await z().auth.adoptSession(session("admin"));
    const { result } = renderHook(() => ({ s: useSession(), a: useIsAdmin() }));
    await waitFor(() => expect(result.current.s.loading).toBe(false));
    expect(result.current.s.session).not.toBeNull();
    expect(result.current.s.user?.role).toBe("admin");
    expect(result.current.a).toEqual({ isAdmin: true, loading: false });
  });

  it("follows a sign-in and a sign-out that happen while mounted", async () => {
    const { result } = renderHook(() => useIsAdmin());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
    await act(async () => { await z().auth.adoptSession(session("admin")); });
    expect(result.current.isAdmin).toBe(true);
    await act(async () => { await z().auth.signOut(); });
    expect(result.current.isAdmin).toBe(false);
  });

  it("a non-admin session is not an admin, and the user object is stable across renders", async () => {
    await z().auth.ready();
    await z().auth.adoptSession(session("user"));
    const { result, rerender } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = result.current.user;
    expect(first?.role).toBe("user");
    rerender();
    expect(result.current.user).toBe(first);
  });
});
