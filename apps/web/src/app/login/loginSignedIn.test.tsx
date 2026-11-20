// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  search: new URLSearchParams(),
  getSession: vi.fn(),
  signIn: vi.fn(),
  home: vi.fn(),
  signup: vi.fn(),
  track: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: h.replace }),
  useSearchParams: () => h.search,
}));
vi.mock("@/fonts", () => ({ inter: { variable: "--font-inter", className: "inter" } }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { getSession: h.getSession, signInWithPassword: h.signIn } }),
}));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn(), trackEventDeferred: h.track }));
vi.mock("@/lib/api", () => ({ apiUrl: (p: string) => `http://api.test${p}` }));
vi.mock("@/components/auth/AuthMarketingPanel", () => ({ AuthMarketingPanel: () => null }));
vi.mock("@/components/auth/SlackWorkspaceHint", () => ({ SlackWorkspaceHint: () => null }));
vi.mock("@/components/marketing/ZaviWordmark", () => ({ ZaviWordmark: () => null }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { home: h.home, signup: h.signup } };
});

import LoginPage from "./page";

const COMPANY = { home: "/workspace", has_company: true, in_any_company: true, is_creator: false };
const COMPANY_AND_CREATOR = { home: "/workspace", has_company: true, in_any_company: true, is_creator: true };
const NO_COMPANY = { home: "/start", has_company: false, in_any_company: false, is_creator: false };
const CREATOR = { home: "/creator", has_company: false, in_any_company: false, is_creator: true };

function signedIn(meta: Record<string, unknown> = {}) {
  h.getSession.mockResolvedValue({ data: { session: { user: { id: "u-1", email: "f@acme.com", user_metadata: meta } } } });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emailField = () => screen.queryByLabelText("Email");

beforeEach(() => {
  h.replace.mockReset();
  h.getSession.mockReset();
  h.signIn.mockReset();
  h.home.mockReset();
  h.signup.mockReset();
  h.track.mockReset();
  h.search = new URLSearchParams();
});
afterEach(cleanup);

describe("founder /login when already signed in", () => {
  it("a company account never sees the form: Checking first, then /workspace", async () => {
    signedIn();
    const pending = deferred<typeof COMPANY>();
    h.home.mockReturnValue(pending.promise);
    render(<LoginPage />);
    await waitFor(() => expect(h.home).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toBe("Checking your account…");
    expect(emailField()).toBeNull();
    expect(screen.queryByRole("button", { name: /Google/ })).toBeNull();
    await act(async () => pending.resolve(COMPANY));
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledWith("/workspace");
    expect(emailField()).toBeNull();
    expect(h.track).not.toHaveBeenCalledWith("auth_screen_viewed", expect.anything());
  });

  it("a company account on the sign-up form (?signup=1) also lands on /workspace", async () => {
    h.search = new URLSearchParams("signup=1");
    signedIn();
    h.home.mockResolvedValue(COMPANY);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
    expect(screen.queryByText("Create your workspace.")).toBeNull();
  });

  it("a company account keeps a plain ?next= deep link", async () => {
    h.search = new URLSearchParams({ next: "/tools?use=t-9" });
    signedIn();
    h.home.mockResolvedValue(COMPANY);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/tools?use=t-9"));
  });

  it.each(["/creator", "/creator/jobs/o1"])("a company account that is also a creator is never sent into %s", async (raw) => {
    h.search = new URLSearchParams({ next: raw });
    signedIn();
    h.home.mockResolvedValue(COMPANY_AND_CREATOR);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it.each(["", "signup=1", "next=/creator"])("a founder with no company goes to /start (?%s)", async (q) => {
    h.search = new URLSearchParams(q);
    signedIn();
    h.home.mockResolvedValue(NO_COMPANY);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/start"));
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(emailField()).toBeNull();
  });

  it("a founder with no company mid-signup keeps the onboarding next instead of restarting at /start", async () => {
    const next = "/onboarding/past-work?website=acme.com&resume=website";
    h.search = new URLSearchParams({ signup: "1", next });
    signedIn();
    h.home.mockResolvedValue(NO_COMPANY);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(next));
  });

  it("a creator goes to /creator, never /start or /workspace", async () => {
    signedIn();
    h.home.mockResolvedValue(CREATOR);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creator"));
    expect(h.replace).not.toHaveBeenCalledWith("/start");
    expect(h.replace).not.toHaveBeenCalledWith("/workspace");
  });

  it("a creator keeps a creator deep link", async () => {
    h.search = new URLSearchParams({ next: "/creator/jobs/o1" });
    signedIn();
    h.home.mockResolvedValue(CREATOR);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creator/jobs/o1"));
  });

  it("a creator signup whose creator profile is not made yet is handed to creator sign in, not /start, and nothing is written here", async () => {
    signedIn({ zavi_signup: "creator" });
    h.home.mockResolvedValue(NO_COMPANY);
    render(<LoginPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creators/login"));
    expect(h.replace).not.toHaveBeenCalledWith("/start");
    expect(h.signup).not.toHaveBeenCalled();
  });

  it("signed out: the sign-in form shows, the backend is never asked, nothing redirects", async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });
    render(<LoginPage />);
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(screen.getByText("Open your workspace.")).toBeTruthy();
    expect(h.home).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.track).toHaveBeenCalledWith("auth_screen_viewed", expect.objectContaining({ screen: "sign_in" }));
  });

  it("signed out on ?signup=1: the create-account form shows", async () => {
    h.search = new URLSearchParams("signup=1");
    h.getSession.mockResolvedValue({ data: { session: null } });
    render(<LoginPage />);
    expect(await screen.findByText("Create your workspace.")).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("a failed account lookup falls back to the form instead of guessing a destination", async () => {
    signedIn();
    h.home.mockRejectedValue(new Error("backend down"));
    render(<LoginPage />);
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("a failed session read falls back to the form", async () => {
    h.getSession.mockRejectedValue(new Error("storage blocked"));
    render(<LoginPage />);
    expect(await screen.findByLabelText("Email")).toBeTruthy();
    expect(h.home).not.toHaveBeenCalled();
  });

  it("leaving the page mid-check never redirects afterwards", async () => {
    signedIn();
    const pending = deferred<typeof COMPANY>();
    h.home.mockReturnValue(pending.promise);
    const view = render(<LoginPage />);
    await waitFor(() => expect(h.home).toHaveBeenCalled());
    view.unmount();
    await act(async () => pending.resolve(COMPANY));
    expect(h.replace).not.toHaveBeenCalled();
  });
});

it.each([COMPANY, NO_COMPANY, CREATOR])("keeps tagged sign-in routing for home=$home without creating a workspace", async (home) => {
  const next = "/workspace?utm_source=linkedin&utm_medium=social&utm_campaign=launch2";
  h.search = new URLSearchParams({ next });
  signedIn();
  h.home.mockResolvedValue(home);
  render(<LoginPage />);
  await waitFor(() => expect(h.replace).toHaveBeenCalledWith(home.home === "/creator" ? "/creator" : next));
  expect(h.signup).not.toHaveBeenCalled();
});
