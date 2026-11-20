// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type AuthListener = (event: string, session: { user?: { id: string } } | null) => void;

function fakeClient(opts: { token?: string | null; userId?: string | null }) {
  let listener: AuthListener | null = null;
  let resolveUser!: () => void;
  const gate = new Promise<void>((r) => (resolveUser = r));
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: opts.token ? { access_token: opts.token } : null },
    })),
    getUser: vi.fn(async (_jwt?: string) => {
      await gate;
      return { data: { user: opts.userId ? { id: opts.userId } : null } };
    }),
    onAuthStateChange: vi.fn((cb: AuthListener) => {
      listener = cb;
      return { data: { subscription: { unsubscribe() {} } } };
    }),
  };
  return {
    sb: { auth } as unknown as SupabaseClient,
    auth,
    release: () => resolveUser(),
    emit: (event: string, session: { user?: { id: string } } | null) =>
      listener?.(event, session),
  };
}

let getVerifiedUser: typeof import("./verifiedUser").getVerifiedUser;

beforeEach(async () => {
  vi.resetModules();
  ({ getVerifiedUser } = await import("./verifiedUser"));
});

describe("getVerifiedUser", () => {
  it("verifies once for concurrent callers, passing the token (lock-free path)", async () => {
    const c = fakeClient({ token: "tok-1", userId: "u1" });
    const calls = [getVerifiedUser(c.sb), getVerifiedUser(c.sb), getVerifiedUser(c.sb)];
    c.release();
    const users = await Promise.all(calls);
    expect(users.map((u) => u?.id)).toEqual(["u1", "u1", "u1"]);
    expect(c.auth.getUser).toHaveBeenCalledTimes(1);
    expect(c.auth.getUser).toHaveBeenCalledWith("tok-1");
  });

  it("reuses a confirmed user briefly instead of re-verifying", async () => {
    const c = fakeClient({ token: "tok-1", userId: "u1" });
    c.release();
    await getVerifiedUser(c.sb);
    await getVerifiedUser(c.sb);
    expect(c.auth.getUser).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a null (session still hydrating) — the next call asks again", async () => {
    const c = fakeClient({ token: "tok-1", userId: null });
    c.release();
    expect(await getVerifiedUser(c.sb)).toBeNull();
    await getVerifiedUser(c.sb);
    expect(c.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it("returns null without a network call when there is no session", async () => {
    const c = fakeClient({ token: null, userId: "u1" });
    expect(await getVerifiedUser(c.sb)).toBeNull();
    expect(c.auth.getUser).not.toHaveBeenCalled();
  });

  it("forgets the confirmed user on sign-out", async () => {
    const c = fakeClient({ token: "tok-1", userId: "u1" });
    c.release();
    await getVerifiedUser(c.sb);
    c.emit("SIGNED_OUT", null);
    await getVerifiedUser(c.sb);
    expect(c.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it("forgets the confirmed user when a different person signs in", async () => {
    const c = fakeClient({ token: "tok-1", userId: "u1" });
    c.release();
    await getVerifiedUser(c.sb);
    c.emit("SIGNED_IN", { user: { id: "someone-else" } });
    await getVerifiedUser(c.sb);
    expect(c.auth.getUser).toHaveBeenCalledTimes(2);
  });
});
