import { describe, expect, it } from "vitest";

import { AUTH_OUTAGE_MESSAGE } from "@/lib/authOutage";
import {
  DIFFERENT_BROWSER_MESSAGE,
  GENERIC_AUTH_ERROR,
  LINK_EXPIRED_MESSAGE,
  SIGN_IN_CANCELLED_MESSAGE,
  callbackFailure,
  humanAuthMessage,
  loginErrorParamMessage,
} from "./authMessages";

const PKCE =
  "PKCE code verifier not found in storage. This can happen if the auth flow was initiated in a different browser or device, or if the storage was cleared. For SSR frameworks (Next.js, SvelteKit, etc.), use @supabase/ssr on both the server and client to store the code verifier in cookies.";

describe("humanAuthMessage", () => {
  it.each([
    ["an empty message", ""],
    ["an object", "[object Object]"],
    ["a JSON body", '{"code":"bad"}'],
  ])("falls back to the generic copy for %s", (_name, raw) => {
    expect(humanAuthMessage(raw)).toBe(GENERIC_AUTH_ERROR);
    expect(humanAuthMessage(new Error(raw))).toBe(GENERIC_AUTH_ERROR);
  });

  it("reads an outage as an outage", () => {
    expect(humanAuthMessage(new Error("fetch failed"))).toBe(AUTH_OUTAGE_MESSAGE);
  });
});

describe("loginErrorParamMessage", () => {
  it("shows nothing when there is no error", () => {
    expect(loginErrorParamMessage(null)).toBeNull();
    expect(loginErrorParamMessage("  ")).toBeNull();
  });

  it.each([
    ["access_denied"],
    ["The user cancelled the sign-in"],
    ["User denied access"],
  ])("reads %s as a cancel", (raw) => {
    expect(loginErrorParamMessage(raw)).toBe(SIGN_IN_CANCELLED_MESSAGE);
  });

  it("explains a missing PKCE verifier in plain words", () => {
    expect(loginErrorParamMessage(PKCE)).toBe(DIFFERENT_BROWSER_MESSAGE);
    expect(loginErrorParamMessage("invalid request: both auth code and code verifier should be non-empty")).toBe(
      DIFFERENT_BROWSER_MESSAGE,
    );
  });

  it.each([
    ["No auth code returned from provider."],
    ["Supabase env not configured."],
    ["Click here: https://evil.example to restore your account"],
  ])("never echoes unknown text: %s", (raw) => {
    expect(loginErrorParamMessage(raw)).toBe(GENERIC_AUTH_ERROR);
  });
});

describe("callbackFailure", () => {
  it("sends a different-browser link back to sign in", () => {
    expect(callbackFailure(new Error(PKCE))).toEqual({ message: DIFFERENT_BROWSER_MESSAGE, action: "Sign in" });
  });

  it.each([
    ["Token has expired or is invalid"],
    ["Email link is invalid or has expired"],
    ["Sign-in did not complete. Request a new link to try again."],
  ])("asks for a new link when %s", (raw) => {
    expect(callbackFailure(new Error(raw))).toEqual({ message: LINK_EXPIRED_MESSAGE, action: "Try again" });
  });

  it("falls back to generic copy for anything else", () => {
    expect(callbackFailure(new Error("No auth payload in URL."))).toEqual({
      message: GENERIC_AUTH_ERROR,
      action: "Try again",
    });
    expect(callbackFailure(undefined).message).toBe(GENERIC_AUTH_ERROR);
  });
});
