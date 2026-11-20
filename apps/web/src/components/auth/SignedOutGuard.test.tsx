// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AuthListener = (event: string) => void;

let session: { access_token: string } | null = { access_token: "t" };
let sessionError: Error | null = null;
const listeners = new Set<AuthListener>();
const unsubscribe = vi.fn();

const auth = {
  getSession: vi.fn(async () => ({ data: { session }, error: sessionError })),
  onAuthStateChange: vi.fn((cb: AuthListener) => {
    listeners.add(cb);
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            unsubscribe();
            listeners.delete(cb);
          },
        },
      },
    };
  }),
};

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth }) }));

import { SignedOutGuard } from "./SignedOutGuard";

const realLocation = window.location;
const replace = vi.fn();
const reload = vi.fn();

function transition(type: "pageshow" | "pagehide", persisted: boolean) {
  const e = new Event(type) as PageTransitionEvent;
  Object.defineProperty(e, "persisted", { value: persisted });
  window.dispatchEvent(e);
}
const pageshow = (persisted: boolean) => transition("pageshow", persisted);

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  session = { access_token: "t" };
  sessionError = null;
  listeners.clear();
  document.documentElement.style.visibility = "";
  Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, replace, reload } });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  vi.clearAllMocks();
});

describe("SignedOutGuard", () => {
  it("leaves a signed-in workspace alone on mount", async () => {
    render(<SignedOutGuard />);
    await flush();
    expect(replace).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads a page restored from the back-forward cache, even when someone is signed in now", async () => {
    render(<SignedOutGuard />);
    await flush();
    session = { access_token: "someone-else" };
    pageshow(true);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("reloads a restored page after this document already left on SIGNED_OUT", async () => {
    render(<SignedOutGuard />);
    await flush();
    session = null;
    act(() => listeners.forEach((cb) => cb("SIGNED_OUT")));
    expect(replace).toHaveBeenCalledTimes(1);
    pageshow(true);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("hides the page as it enters the back-forward cache, and only then", async () => {
    render(<SignedOutGuard />);
    await flush();
    transition("pagehide", false);
    expect(document.documentElement.style.visibility).toBe("");
    transition("pagehide", true);
    expect(document.documentElement.style.visibility).toBe("hidden");
  });

  it("sends a workspace remounted from the router cache with no session to /login", async () => {
    session = null;
    render(<SignedOutGuard />);
    await flush();
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("does nothing on an ordinary, non-restored pageshow", async () => {
    render(<SignedOutGuard />);
    await flush();
    const checks = auth.getSession.mock.calls.length;
    session = null;
    pageshow(false);
    await flush();
    expect(auth.getSession.mock.calls.length).toBe(checks);
    expect(replace).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("follows a sign-out made in another tab, navigating once", async () => {
    render(<SignedOutGuard />);
    await flush();
    session = null;
    act(() => listeners.forEach((cb) => cb("SIGNED_OUT")));
    act(() => listeners.forEach((cb) => cb("SIGNED_OUT")));
    await flush();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("ignores auth events other than SIGNED_OUT", async () => {
    render(<SignedOutGuard />);
    await flush();
    act(() => listeners.forEach((cb) => cb("TOKEN_REFRESHED")));
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not bounce a user out when the session read fails transiently", async () => {
    session = null;
    sessionError = new Error("network");
    render(<SignedOutGuard />);
    await flush();
    expect(replace).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted, and a session read still in flight does not navigate", async () => {
    session = null;
    const { unmount } = render(<SignedOutGuard />);
    unmount();
    await flush();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    pageshow(true);
    listeners.forEach((cb) => cb("SIGNED_OUT"));
    await flush();
    expect(replace).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
