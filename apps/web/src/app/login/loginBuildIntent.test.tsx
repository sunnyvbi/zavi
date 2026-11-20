// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  search: new URLSearchParams("signup=1"),
  signUp: vi.fn(),
  signIn: vi.fn(),
  verifyOtp: vi.fn(),
  resend: vi.fn(),
  home: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: h.replace }),
  useSearchParams: () => h.search,
}));
vi.mock("@/fonts", () => ({ inter: { variable: "--font-inter", className: "inter" } }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: { signUp: h.signUp, signInWithPassword: h.signIn, verifyOtp: h.verifyOtp, resend: h.resend, signInWithOAuth: vi.fn() },
  }),
}));
vi.mock("@/lib/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiUrl: (p: string) => `http://api.test${p}` }));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({ AuthMarketingPanel: () => null }));
vi.mock("@/components/auth/SlackWorkspaceHint", () => ({ SlackWorkspaceHint: () => null }));
vi.mock("@/components/marketing/ZaviWordmark", () => ({ ZaviWordmark: () => null }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { home: h.home } };
});

import LoginPage from "./page";
import { clearStash, writeStash } from "@/app/start/ideaStartStorage";

beforeEach(() => {
  h.search = new URLSearchParams("signup=1&intent=build&next=%2Fstart%3Fresume%3Dbuild");
  h.home.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("a sign-up that came to build a site talks about the site", () => {
  it("says Zavi builds the website, never 'see your growth plan', and shows the saved idea", async () => {
    writeStash({ intent: "fresh", idea: "I run a home cleaning service in San Jose" });
    render(<LoginPage />);
    expect(await screen.findByText("Create a free account and Zavi builds your website. No card.")).toBeTruthy();
    expect(screen.queryByText(/see your growth plan/)).toBeNull();
    expect((await screen.findByTestId("saved-idea")).textContent).toBe("Your idea is saved: “I run a home cleaning service in San Jose”");
  });

  it("a long idea is cut short and never spills the whole text", async () => {
    writeStash({ intent: "fresh", idea: `A bakery site ${"with fresh bread ".repeat(30)}` });
    render(<LoginPage />);
    const line = (await screen.findByTestId("saved-idea")).textContent ?? "";
    expect(line.length).toBeLessThan(200);
    expect(line).toMatch(/…”$/);
  });

  it("with no saved idea it still uses build wording and shows no empty idea line", async () => {
    clearStash();
    render(<LoginPage />);
    expect(await screen.findByText("Create a free account and Zavi builds your website. No card.")).toBeTruthy();
    expect(screen.queryByTestId("saved-idea")).toBeNull();
  });

  it("a growth sign-up keeps the growth plan wording and never shows a stashed idea", async () => {
    h.search = new URLSearchParams("signup=1");
    writeStash({ intent: "fresh", idea: "I run a home cleaning service in San Jose" });
    render(<LoginPage />);
    expect(await screen.findByText("Create a free account to see your growth plan. No card.")).toBeTruthy();
    expect(screen.queryByTestId("saved-idea")).toBeNull();
    expect(screen.queryByText(/Zavi builds your website\. No card/)).toBeNull();
  });
});
