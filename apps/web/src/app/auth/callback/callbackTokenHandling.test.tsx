// @vitest-environment jsdom

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const replace = vi.fn();
const verifyOtp = vi.fn(async () => ({ error: null as { message: string } | null }));
const setSession = vi.fn(async () => ({ error: null as { message: string } | null }));
const exchangeCodeForSession = vi.fn(async () => ({ error: null as { message: string } | null }));
let params = new URLSearchParams();
let session: unknown = { user: { id: "u1" } };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => params,
}));
vi.mock("@/fonts", () => ({
  inter: { variable: "--font-inter", className: "inter" },
}));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({
  AuthMarketingPanel: () => <aside data-testid="auth-marketing-panel" />,
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: {
      verifyOtp,
      setSession,
      exchangeCodeForSession,
      getSession: async () => ({ data: { session } }),
    },
  }),
}));

import AuthCallbackPage from "./page";

function land(search: string, hash = "") {
  window.history.replaceState(null, "", `/auth/callback${search}${hash}`);
  params = new URLSearchParams(search);
}

beforeEach(() => {
  replace.mockClear();
  verifyOtp.mockReset();
  verifyOtp.mockResolvedValue({ error: null });
  setSession.mockReset();
  setSession.mockResolvedValue({ error: null });
  session = { user: { id: "u1" } };
});
afterEach(cleanup);

describe("what the recovery token leaves behind in the URL", () => {
  it("scrubs token_hash and type out of the address before navigating", async () => {
    land("?token_hash=live-token&type=recovery&next=%2Freset-password");

    render(<AuthCallbackPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/reset-password"));
    expect(window.location.search).not.toContain("live-token");
    expect(window.location.search).not.toContain("token_hash");
    expect(window.location.search).not.toContain("type=recovery");
  });

  it("keeps next in the address, which carries no credential", async () => {
    land("?token_hash=live-token&type=recovery&next=%2Freset-password");

    render(<AuthCallbackPage />);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(window.location.search).toContain("next=");
  });

  it("clears an implicit-flow fragment so the JWT pair is not left in history", async () => {
    land("", "#access_token=aaa&refresh_token=bbb");

    render(<AuthCallbackPage />);

    await waitFor(() => expect(setSession).toHaveBeenCalled());
    expect(window.location.hash).toBe("");
  });
});

describe("how many times a single-use token is spent", () => {
  it("verifies once even when the effect is mounted twice", async () => {
    land("?token_hash=live-token&type=recovery&next=%2Freset-password");

    render(
      <StrictMode>
        <AuthCallbackPage />
      </StrictMode>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(verifyOtp).toHaveBeenCalledTimes(1);
  });

  it("still reads the fragment pair after the address has been cleaned", async () => {
    land("", "#access_token=aaa&refresh_token=bbb");

    render(<AuthCallbackPage />);

    await waitFor(() => expect(setSession).toHaveBeenCalled());
    expect(setSession).toHaveBeenCalledWith({ access_token: "aaa", refresh_token: "bbb" });
  });
});

describe("what the callback tells a user whose token is already spent", () => {
  it("does not tell them to retry a link that cannot work twice", async () => {
    land("?token_hash=live-token&type=recovery&next=%2Freset-password");
    session = null;

    const { findByRole, findByText, queryByText } = render(<AuthCallbackPage />);

    expect(await findByRole("heading", { name: "Sign-in failed" }, { timeout: 5000 })).toBeTruthy();
    expect(await findByText(/Request a new link/i, {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText(/Try the link again/i)).toBeNull();
  });

  it("surfaces a rejected token as a failure rather than hanging, in plain words", async () => {
    land("?token_hash=spent&type=recovery&next=%2Freset-password");
    verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });

    const { findByText, queryByText } = render(<AuthCallbackPage />);

    expect(await findByText(/Request a new link/i)).toBeTruthy();
    expect(queryByText("Token has expired or is invalid")).toBeNull();
  });
});

describe("what the callback tells a user whose link opened in another browser", () => {
  it("explains it without Supabase's text and offers Sign in", async () => {
    land("?code=from-another-browser&next=%2Fstart");
    exchangeCodeForSession.mockResolvedValueOnce({
      error: { message: "PKCE code verifier not found in storage. use @supabase/ssr on both the server and client" },
    });

    const { findByText, getByRole, container } = render(<AuthCallbackPage />);

    expect(await findByText(/This link opened in a different browser/)).toBeTruthy();
    expect(getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(container.textContent).not.toMatch(/PKCE|supabase/i);
  });

  it("reads an expired email link's error from the hash as Request a new link", async () => {
    land("?next=%2Fstart", "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");

    const { findByText, container } = render(<AuthCallbackPage />);

    expect(await findByText(/Request a new link/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Email link is invalid/);
    expect(window.location.hash).toBe("");
  });

  it("reads a provider error from the query and scrubs it from the address", async () => {
    land("?error=server_error&error_description=PKCE+flow+state+not+found");

    const { findByText } = render(<AuthCallbackPage />);

    expect(await findByText(/This link opened in a different browser/)).toBeTruthy();
    expect(window.location.search).not.toContain("error");
  });

  it("never shows a developer string when the URL carries nothing to sign in with", async () => {
    land("");

    const { findByRole, container } = render(<AuthCallbackPage />);

    expect(await findByRole("heading", { name: "Sign-in failed" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/auth payload|magic link/i);
  });
});
