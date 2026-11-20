// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }), useSearchParams: () => search }));
vi.mock("next/image", () => ({ default: () => null }));
const signIn = vi.fn();
const verifyOtp = vi.fn();
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signInWithPassword: signIn, verifyOtp } }) }));
vi.mock("@/lib/api", () => ({ apiUrl: (p: string) => p }));
const { home, signup } = vi.hoisted(() => ({ home: vi.fn(), signup: vi.fn() }));
const analytics = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/events", () => ({ trackEvent: analytics, trackEventDeferred: analytics }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { home, signup } };
});
const CREATOR = { home: "/creator", has_company: false, in_any_company: false, is_creator: true };

import LoginForm from "./LoginForm";

function fill() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "maya@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass" } });
  fireEvent.click(screen.getByRole("button", { name: /^Sign in/ }));
}

beforeEach(() => {
  replace.mockReset();
  signIn.mockReset();
  home.mockReset();
  analytics.mockReset();
  home.mockResolvedValue(CREATOR);
  signup.mockReset();
  verifyOtp.mockReset();
  search = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("creator sign in", () => {
  it("lands on /creator", async () => {
    signIn.mockResolvedValue({ data: { session: {} }, error: null });
    render(<LoginForm />);
    fill();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/creator"));
  });

  it("a creator sign-up that never got its creator profile gets one at creator sign in, then lands on /creator, not /start", async () => {
    signIn.mockResolvedValue({ data: { session: { user: { email: "maya@example.com", user_metadata: { full_name: "Maya Lane", zavi_signup: "creator" } } } }, error: null });
    home
      .mockResolvedValueOnce({ home: "/start", has_company: false, in_any_company: false, is_creator: false })
      .mockResolvedValueOnce(CREATOR);
    signup.mockResolvedValue({ ok: true, created: true });
    render(<LoginForm />);
    fill();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/creator"));
    expect(signup).toHaveBeenCalledWith("Maya Lane");
    expect(replace).not.toHaveBeenCalledWith("/start");
  });

  it("an account that never signed up as a creator is not made one here, since this page shows no 18+ line", async () => {
    signIn.mockResolvedValue({ data: { session: { user: { email: "ravi@example.com", user_metadata: { full_name: "Ravi" } } } }, error: null });
    home.mockResolvedValue({ home: "/start", has_company: false, in_any_company: false, is_creator: false });
    render(<LoginForm />);
    fill();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/start"));
    expect(signup).not.toHaveBeenCalled();
  });

  it("never turns a company member into a creator: someone invited to a company still goes to /start", async () => {
    signIn.mockResolvedValue({ data: { session: { user: { email: "maya@example.com", user_metadata: {} } } }, error: null });
    home.mockResolvedValue({ home: "/start", has_company: false, in_any_company: true, is_creator: false });
    render(<LoginForm />);
    fill();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/start"));
    expect(signup).not.toHaveBeenCalled();
  });

  it("wrong password shows the wireframe message and stays", async () => {
    signIn.mockResolvedValue({ data: { session: null }, error: { message: "Invalid login credentials" } });
    render(<LoginForm />);
    fill();
    expect(await screen.findByText(/That email and password don't match/)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(analytics).toHaveBeenCalledWith("login_submitted", { method: "password", audience: "creator" });
    expect(analytics).toHaveBeenCalledWith("auth_failed", { step: "creator_password_login" });
    expect(JSON.stringify(analytics.mock.calls)).not.toContain("maya@example.com");
    expect(JSON.stringify(analytics.mock.calls)).not.toContain("secret-pass");
  });

  it("tracks the creator auth screens when the mode changes", () => {
    render(<LoginForm />);
    expect(analytics).toHaveBeenCalledWith("auth_screen_viewed", { screen: "sign_in", audience: "creator" });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code instead" }));
    expect(analytics).toHaveBeenCalledWith("auth_screen_viewed", { screen: "email_code", audience: "creator" });
  });

  it("honours a same-origin next but not an off-site one", async () => {
    signIn.mockResolvedValue({ data: { session: {} }, error: null });
    search = new URLSearchParams("next=//evil.example");
    render(<LoginForm />);
    fill();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/creator"));
  });

  it("honours a creator-area next for a creator", async () => {
    signIn.mockResolvedValue({ data: { session: {} }, error: null });
    search = new URLSearchParams("next=/creators/apply?step=make");
    render(<LoginForm />);
    fill();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/creators/apply?step=make"));
  });

  it("a company account lands on /workspace, even with next=/creator", async () => {
    signIn.mockResolvedValue({ data: { session: {} }, error: null });
    home.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: false });
    search = new URLSearchParams("next=/creator");
    render(<LoginForm />);
    fill();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace"));
    expect(replace).not.toHaveBeenCalledWith("/creator");
  });

  it("a failed home read shows an error and does not guess a page", async () => {
    signIn.mockResolvedValue({ data: { session: {} }, error: null });
    home.mockRejectedValue(new Error("down"));
    render(<LoginForm />);
    fill();
    expect(await screen.findByText(/could not open your account/)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(["/creator/..%2fworkspace", "/creators/apply%2F..%2F..%2Fworkspace", "/workspace/../creator"])(
    "a non-plain next (%s) is ignored: a creator lands on /creator",
    async (raw) => {
      signIn.mockResolvedValue({ data: { session: {} }, error: null });
      search = new URLSearchParams({ next: raw });
      render(<LoginForm />);
      fill();
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/creator"));
    },
  );
});

describe("from a \"you got a message\" email (invite link)", () => {
  const TOKEN = "33333333-3333-4333-8333-333333333333";
  function stubFetch(prefill: { status: number; body?: unknown }) {
    const f = vi.fn(async (url: string) =>
      url.startsWith("/api/creators/invite/prefill")
        ? { ok: prefill.status === 200, json: async () => prefill.body }
        : { ok: true, json: async () => ({ ok: true }) },
    );
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("opens on the email code with the invited email filled in, then makes the creator and lands in the inbox", async () => {
    const f = stubFetch({ status: 200, body: { name: "Ivy Lane", email: "ivy@example.com" } });
    verifyOtp.mockResolvedValue({ data: { session: {} }, error: null });
    signup.mockResolvedValue({ ok: true, created: true });
    search = new URLSearchParams(`src=invite_message&invite=${TOKEN}`);
    render(<LoginForm />);
    await waitFor(() => expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ivy@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    await waitFor(() => expect(f).toHaveBeenCalledWith("/api/auth/email/send-otp", expect.objectContaining({ method: "POST" })));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: /^Sign in/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/creator"));
    expect(signup).toHaveBeenCalledWith("Ivy Lane");
    expect(signup.mock.invocationCallOrder[0]).toBeLessThan(home.mock.invocationCallOrder[0]);
  });

  it("does not make a creator for a different email typed over the invited one", async () => {
    stubFetch({ status: 200, body: { name: "Ivy Lane", email: "ivy@example.com" } });
    verifyOtp.mockResolvedValue({ data: { session: {} }, error: null });
    search = new URLSearchParams(`invite=${TOKEN}`);
    render(<LoginForm />);
    await waitFor(() => expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ivy@example.com"));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "other@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: /^Sign in/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/creator"));
    expect(signup).not.toHaveBeenCalled();
  });

  it("an unknown link leaves the normal password sign in", async () => {
    stubFetch({ status: 404 });
    search = new URLSearchParams(`invite=${TOKEN}`);
    render(<LoginForm />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
  });
});
