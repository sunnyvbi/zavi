// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  search: new URLSearchParams(),
  signIn: vi.fn(),
  oauth: vi.fn(),
  home: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: h.replace }),
  useSearchParams: () => h.search,
}));
vi.mock("@/fonts", () => ({ inter: { variable: "--font-inter", className: "inter" } }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { signInWithPassword: h.signIn, signInWithOAuth: h.oauth } }),
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

beforeEach(() => {
  h.replace.mockReset();
  h.signIn.mockReset();
  h.oauth.mockReset();
  h.home.mockReset();
  h.signIn.mockResolvedValue({ data: { session: {} }, error: null });
  h.oauth.mockResolvedValue({ data: {}, error: null });
});
afterEach(cleanup);

function signInWithPassword() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "maya@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass-1" } });
  const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  fireEvent.submit(submit.form!);
}

describe("business /login with a creator-area next", () => {
  it("a company account lands on /workspace, not /creator", async () => {
    h.search = new URLSearchParams("next=/creator");
    h.home.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: true });
    render(<LoginPage />);
    signInWithPassword();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
    expect(h.replace).not.toHaveBeenCalledWith("/creator");
  });

  it("a creator with no company keeps the creator deep link", async () => {
    h.search = new URLSearchParams("next=/creator/jobs/o1");
    h.home.mockResolvedValue({ home: "/creator", has_company: false, in_any_company: false, is_creator: true });
    render(<LoginPage />);
    signInWithPassword();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creator/jobs/o1"));
  });

  it("OAuth never hands /creator to the callback; it goes through /start", async () => {
    h.search = new URLSearchParams("next=/creator");
    render(<LoginPage />);
    fireEvent.click(screen.getAllByRole("button", { name: /Google/ })[0]);
    await waitFor(() => expect(h.oauth).toHaveBeenCalled());
    const redirectTo = h.oauth.mock.calls[0][0].options.redirectTo as string;
    expect(new URL(redirectTo).searchParams.get("next")).toBe("/start");
  });

  it.each(["/workspace/../creator", "/creator/..%2fworkspace", "/workspace%2F..%2Fcreator"])(
    "a non-plain next (%s) is no next: the account goes to /workspace",
    async (raw) => {
      h.search = new URLSearchParams({ next: raw });
      render(<LoginPage />);
      signInWithPassword();
      await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
      expect(h.home).not.toHaveBeenCalled();
    },
  );

  it("a failed home read stays on the page with an error (the deep link is kept)", async () => {
    h.search = new URLSearchParams("next=/creator/jobs/o1");
    h.home.mockRejectedValue(new Error("down"));
    render(<LoginPage />);
    signInWithPassword();
    expect(await screen.findByText(/could not open your account/)).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
