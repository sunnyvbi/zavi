// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const replace = vi.fn();
let params = new URLSearchParams();

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
      verifyOtp: async () => ({ error: null }),
      getSession: async () => ({ data: { session: { user: { id: "u1" } } } }),
    },
  }),
}));

import AuthCallbackPage from "./page";

function landOn(next: string) {
  params = new URLSearchParams({ token_hash: "hash-xyz", type: "recovery", next });
  render(<AuthCallbackPage />);
}

beforeEach(() => replace.mockClear());
afterEach(cleanup);

describe("where the auth callback sends a freshly-authenticated user", () => {
  it("refuses an absolute attacker URL in next and falls back to /start", async () => {
    landOn("https://attacker.example/steal");

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith("/start");
    expect(replace).not.toHaveBeenCalledWith("https://attacker.example/steal");
  });

  it("refuses a protocol-relative next, which a browser resolves off-origin", async () => {
    landOn("//attacker.example/steal");

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith("/start");
  });

  it("refuses a backslash-smuggled next", async () => {
    landOn("/\\attacker.example");

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith("/start");
  });

  it("still honours the same-origin deep link the invite and reset flows rely on", async () => {
    landOn("/reset-password");

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith("/reset-password");
  });

  it.each(["/workspace/%2e%2e/creator", "/workspace/../creator", "/creator/%"])(
    "a non-plain path (%s) is no next: /start decides",
    async (next) => {
      landOn(next);
      await waitFor(() => expect(replace).toHaveBeenCalled());
      expect(replace).toHaveBeenCalledWith("/start");
    },
  );

  it("keeps a plain path whose query carries %-encoding", async () => {
    landOn("/creator/jobs?q=a%20b");
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith("/creator/jobs?q=a%20b");
  });
});
