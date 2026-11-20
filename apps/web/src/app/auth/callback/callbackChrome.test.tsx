// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const params = new URLSearchParams("code=pending");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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
      exchangeCodeForSession: () => new Promise(() => {}),
    },
  }),
}));

import AuthCallbackPage from "./page";

afterEach(cleanup);

describe("the auth callback while it is still working", () => {
  it("centres the single loading line instead of left-aligning it in the column", async () => {
    render(<AuthCallbackPage />);

    const line = await screen.findByText(/Signing you in/);
    expect(line.className).toContain("justify-center");
    expect(line.className).toContain("text-center");
  });

  it("leaves the marketing panel off — it is an interstitial, not an auth page", async () => {
    render(<AuthCallbackPage />);

    await screen.findByText(/Signing you in/);
    await waitFor(() => {
      expect(screen.queryByTestId("auth-marketing-panel")).toBeNull();
    });
  });
});
