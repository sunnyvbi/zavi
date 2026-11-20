// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ replace: vi.fn(), getSession: vi.fn(), home: vi.fn(), signup: vi.fn(), search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace, push: vi.fn() }), useSearchParams: () => h.search }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn(), trackEventDeferred: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiUrl: (p: string) => p }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { getSession: h.getSession } }) }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { home: h.home, signup: h.signup } };
});

import ApplyFlow from "@/app/creators/apply/ApplyFlow";
import LoginForm from "@/app/creators/login/LoginForm";

const signedIn = (meta: Record<string, unknown> = {}) => ({ data: { session: { user: { email: "maya@example.com", user_metadata: meta } } } });
const HOME = {
  creator: { home: "/creator", has_company: false, in_any_company: false, is_creator: true },
  founder: { home: "/workspace", has_company: true, in_any_company: true, is_creator: false },
  founderNoCompany: { home: "/start", has_company: false, in_any_company: false, is_creator: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.search = new URLSearchParams();
});
afterEach(cleanup);

describe.each([
  ["/creators/apply", () => <ApplyFlow />, "Sign up"],
  ["/creators/login", () => <LoginForm />, "Sign in"],
] as const)("%s for someone already signed in", (_path, page, formButton) => {
  it("a creator goes straight to the creator area, without seeing the form", async () => {
    h.getSession.mockResolvedValue(signedIn());
    h.home.mockResolvedValue(HOME.creator);
    render(page());
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creator"));
    expect(screen.queryByRole("button", { name: new RegExp(`^${formButton}`) })).toBeNull();
  });

  it("a founder with a company is not sent anywhere: the creator form shows as before", async () => {
    h.getSession.mockResolvedValue(signedIn({ full_name: "Ravi" }));
    h.home.mockResolvedValue(HOME.founder);
    render(page());
    expect(await screen.findByRole("button", { name: new RegExp(`^${formButton}`) })).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.signup).not.toHaveBeenCalled();
  });

  it("a founder still in onboarding is never made a creator", async () => {
    h.getSession.mockResolvedValue(signedIn({ full_name: "Ravi" }));
    h.home.mockResolvedValue(HOME.founderNoCompany);
    render(page());
    expect(await screen.findByRole("button", { name: new RegExp(`^${formButton}`) })).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.signup).not.toHaveBeenCalled();
  });

  it("a creator sign-up that never finished gets its creator account and goes in", async () => {
    h.getSession.mockResolvedValue(signedIn({ full_name: "Maya Lane", zavi_signup: "creator" }));
    h.home.mockResolvedValueOnce(HOME.founderNoCompany).mockResolvedValueOnce(HOME.creator);
    h.signup.mockResolvedValue({ ok: true, created: true });
    render(page());
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creator"));
    expect(h.signup).toHaveBeenCalledWith("Maya Lane");
  });

  it("someone signed out sees the form", async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });
    render(page());
    expect(await screen.findByRole("button", { name: new RegExp(`^${formButton}`) })).toBeTruthy();
    expect(h.home).not.toHaveBeenCalled();
  });
});
