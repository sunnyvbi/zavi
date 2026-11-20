
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  launched: null as { type: string; url: string } | null,
  launchResponse: {
    ok: true,
    redirectUrl: "https://ext-id.chromiumapp.org/callback?code=THE_CODE",
  } as unknown,
  fetchCalls: [] as { url: string; init: RequestInit }[],
  redeemStatus: 200,
  redeemBody: { access_token: "A_tok", refresh_token: "R_tok" } as unknown,
  setSessionArgs: null as unknown,
  setSessionResult: {
    data: { session: { access_token: "A_tok" } },
    error: null as { message: string } | null,
  },
  signOutArgs: undefined as unknown,
}));

vi.mock("./supabase", () => ({
  supabase: () => ({
    auth: {
      setSession: async (args: unknown) => {
        state.setSessionArgs = args;
        return state.setSessionResult;
      },
      signOut: async (opts?: unknown) => {
        state.signOutArgs = opts;
        return { error: null };
      },
    },
  }),
}));

import {
  AuthCancelledError,
  AuthError,
  EXPIRED_MESSAGE,
  GENERIC_MESSAGE,
  extractConnectCode,
  signInWithZavi,
  signOut,
} from "./auth";
import { API_BASE, CONNECT_URL } from "../shared/config";

beforeEach(() => {
  state.launched = null;
  state.launchResponse = {
    ok: true,
    redirectUrl: "https://ext-id.chromiumapp.org/callback?code=THE_CODE",
  };
  state.fetchCalls = [];
  state.redeemStatus = 200;
  state.redeemBody = { access_token: "A_tok", refresh_token: "R_tok" };
  state.setSessionArgs = null;
  state.setSessionResult = { data: { session: { access_token: "A_tok" } }, error: null };
  state.signOutArgs = undefined;

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: async (m: { type: string; url: string }) => {
        state.launched = m;
        return state.launchResponse;
      },
    },
  };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    state.fetchCalls.push({ url: String(url), init });
    return {
      ok: state.redeemStatus >= 200 && state.redeemStatus < 300,
      status: state.redeemStatus,
      json: async () => state.redeemBody,
    };
  }) as unknown as typeof fetch;
});

describe("signInWithZavi", () => {
  it("opens the connect screen with NO query params", async () => {
    await signInWithZavi();
    expect(state.launched).toEqual({ type: "zavi:auth:launch", url: CONNECT_URL });
    expect(new URL(CONNECT_URL).search).toBe("");
  });

  it("redeems the code with no Authorization header and stores the session", async () => {
    const session = await signInWithZavi();

    expect(state.fetchCalls).toHaveLength(1);
    const [call] = state.fetchCalls;
    expect(call.url).toBe(`${API_BASE}/api/extension/connect/redeem`);
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ code: "THE_CODE" });
    expect(JSON.stringify(call.init.headers)).not.toMatch(/authorization/i);

    expect(state.setSessionArgs).toEqual({ access_token: "A_tok", refresh_token: "R_tok" });
    expect(session.access_token).toBe("A_tok");
  });

  it("maps a 400 to the expired copy and anything else to the generic copy", async () => {
    state.redeemStatus = 400;
    await expect(signInWithZavi()).rejects.toThrow(EXPIRED_MESSAGE);

    state.redeemStatus = 502;
    await expect(signInWithZavi()).rejects.toThrow(GENERIC_MESSAGE);

    state.redeemStatus = 500;
    await expect(signInWithZavi()).rejects.toThrow(GENERIC_MESSAGE);
  });

  it("treats a closed window as a cancel, not a failure", async () => {
    state.launchResponse = { ok: false, error: "Sign-in was closed before it finished." };
    await expect(signInWithZavi()).rejects.toBeInstanceOf(AuthCancelledError);
    await expect(signInWithZavi()).rejects.toThrow("Sign-in cancelled");
    expect(state.fetchCalls).toHaveLength(0);
  });

  it("refuses a redeem response missing either token", async () => {
    state.redeemBody = { access_token: "A_tok" };
    await expect(signInWithZavi()).rejects.toThrow(GENERIC_MESSAGE);
    expect(state.setSessionArgs).toBeNull();
  });

  it("surfaces a setSession failure as the generic copy, never the raw error", async () => {
    state.setSessionResult = { data: { session: null }, error: { message: "jwt malformed" } } as never;
    await expect(signInWithZavi()).rejects.toThrow(GENERIC_MESSAGE);
  });
});

describe("extractConnectCode", () => {
  it("reads the code from the QUERY string", () => {
    expect(extractConnectCode("https://x.chromiumapp.org/callback?code=abc")).toBe("abc");
  });

  it("ignores a fragment, which chrome.identity strips anyway", () => {
    expect(extractConnectCode("https://x.chromiumapp.org/callback#code=abc")).toBeNull();
  });

  it("treats an explicit error param as a cancel", () => {
    expect(() =>
      extractConnectCode("https://x.chromiumapp.org/callback?error=access_denied"),
    ).toThrow(AuthCancelledError);
  });

  it("returns null on a non-URL rather than throwing something raw", () => {
    expect(extractConnectCode("not a url")).toBeNull();
  });
});

describe("T13 sign-out is scoped to this device", () => {
  it("passes scope: local, never global and never nothing", async () => {
    await signOut();
    expect(state.signOutArgs).toEqual({ scope: "local" });
  });
});

describe("AuthError shape", () => {
  it("a cancel is still an AuthError, so one catch handles both", () => {
    expect(new AuthCancelledError()).toBeInstanceOf(AuthError);
  });
});
