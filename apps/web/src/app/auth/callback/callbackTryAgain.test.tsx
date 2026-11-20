// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let params = new URLSearchParams();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => params }));
vi.mock("@/fonts", () => ({ inter: { variable: "--font-inter", className: "inter" } }));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({ AuthMarketingPanel: () => null }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { exchangeCodeForSession: async () => ({ error: { message: "code verifier missing" } }) } }),
}));

import AuthCallbackPage from "./page";

afterEach(cleanup);

describe("a failed sign-in link offers the right Try again", () => {
  it("sends a creator back to the creator sign in, keeping where they were going", async () => {
    params = new URLSearchParams({ code: "c1", next: "/creators/apply?finish=1" });
    render(<AuthCallbackPage />);
    const link = (await screen.findByRole("link", { name: /^(Try again|Sign in)$/ })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/creators/login?next=%2Fcreators%2Fapply%3Ffinish%3D1");
  });

  it("keeps everyone else on the business sign in", async () => {
    params = new URLSearchParams({ code: "c1", next: "/workspace" });
    render(<AuthCallbackPage />);
    expect(((await screen.findByRole("link", { name: /^(Try again|Sign in)$/ })) as HTMLAnchorElement).getAttribute("href")).toBe("/login");
  });
});
