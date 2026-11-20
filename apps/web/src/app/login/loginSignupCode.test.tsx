// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
vi.mock("@/components/auth/AuthMarketingPanel", () => ({
  AuthMarketingPanel: (props: { otpSent?: boolean }) => (
    <span data-testid="auth-marketing-panel" data-otp-sent={String(Boolean(props.otpSent))} />
  ),
}));
vi.mock("@/components/auth/SlackWorkspaceHint", () => ({ SlackWorkspaceHint: () => null }));
vi.mock("@/components/marketing/ZaviWordmark", () => ({ ZaviWordmark: () => null }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { home: h.home } };
});

import LoginPage from "./page";

const user = { id: "u1", identities: [{ id: "i1" }] };

beforeEach(() => {
  h.search = new URLSearchParams("signup=1");
  for (const f of [h.replace, h.signUp, h.signIn, h.verifyOtp, h.resend, h.home]) f.mockReset();
  h.signUp.mockResolvedValue({ data: { user, session: null }, error: null });
  h.verifyOtp.mockResolvedValue({ data: { session: {} }, error: null });
  h.resend.mockResolvedValue({ data: {}, error: null });
});
afterEach(cleanup);

function fill(email = "maya@example.com", password = "secret-pass-1") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  fireEvent.submit(submit.form!);
}

function typeCode(code: string) {
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: code } });
}

describe("password sign-up asks for the emailed code", () => {
  it("shows the confirm screen, verifies type signup, then goes in", async () => {
    render(<LoginPage />);
    fill();
    expect(await screen.findByText("Confirm your email.")).toBeTruthy();
    expect(screen.getByText(/Check your spam or junk folder/)).toBeTruthy();
    typeCode("48203917");
    await waitFor(() => expect(h.verifyOtp).toHaveBeenCalledWith({ email: "maya@example.com", token: "48203917", type: "signup" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
  });

  it("starts the OTP panel animation when website onboarding reaches the code screen", async () => {
    h.search = new URLSearchParams("signup=1&next=%2Fstart%3Fwebsite%3Dexample.com");
    render(<LoginPage />);
    expect(screen.getByTestId("auth-marketing-panel").getAttribute("data-otp-sent")).toBe("false");
    fill();
    await screen.findByText("Confirm your email.");
    expect(screen.getByTestId("auth-marketing-panel").getAttribute("data-otp-sent")).toBe("true");
  });

  it("a wrong or expired code stays on the screen with a plain message", async () => {
    h.verifyOtp.mockResolvedValue({ data: {}, error: { message: "Token has expired or is invalid", status: 403, code: "otp_expired" } });
    render(<LoginPage />);
    fill();
    await screen.findByText("Confirm your email.");
    typeCode("11112222");
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("an existing confirmed account (no identities) says so instead of waiting on a code", async () => {
    h.signUp.mockResolvedValue({ data: { user: { id: "u1", identities: [] }, session: null }, error: null });
    render(<LoginPage />);
    fill();
    expect(await screen.findByText(/You already have an account with this email/)).toBeTruthy();
    expect(screen.queryByText("Confirm your email.")).toBeNull();
  });

  it("signing in before ever entering the code sends a fresh code and asks for it", async () => {
    h.search = new URLSearchParams();
    h.signIn.mockResolvedValue({ data: {}, error: { message: "Email not confirmed", status: 400, code: "email_not_confirmed" } });
    render(<LoginPage />);
    fill();
    expect(await screen.findByText("Confirm your email first.")).toBeTruthy();
    expect(h.resend).toHaveBeenCalledWith({ type: "signup", email: "maya@example.com" });
    typeCode("48203917");
    await waitFor(() => expect(h.verifyOtp).toHaveBeenCalledWith(expect.objectContaining({ type: "signup" })));
  });

  it("signing in again inside Supabase's resend window still asks for the code already sent", async () => {
    h.search = new URLSearchParams();
    h.signIn.mockResolvedValue({ data: {}, error: { message: "Email not confirmed", status: 400, code: "email_not_confirmed" } });
    h.resend.mockResolvedValue({ data: {}, error: { message: "For security purposes, you can only request this after 41 seconds.", status: 429, code: "over_email_send_rate_limit" } });
    render(<LoginPage />);
    fill();
    expect(await screen.findByText(/Enter the 8-digit code we emailed you a moment ago/)).toBeTruthy();
    typeCode("48203917");
    await waitFor(() => expect(h.verifyOtp).toHaveBeenCalledWith(expect.objectContaining({ type: "signup" })));
  });

  it("if only the landing step fails after a good code, Continue retries the landing, not the used code", async () => {
    h.search = new URLSearchParams("signup=1&next=/creator/jobs/o1");
    h.home.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ home: "/creator" });
    render(<LoginPage />);
    fill();
    await screen.findByText("Confirm your email.");
    typeCode("48203917");
    expect(await screen.findByText(/could not open your account/)).toBeTruthy();
    fireEvent.submit(screen.getByLabelText("Verification code").closest("form")!);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creator/jobs/o1"));
    expect(h.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it("a general throttle on the resend stays an error on the sign-in form", async () => {
    h.search = new URLSearchParams();
    h.signIn.mockResolvedValue({ data: {}, error: { message: "Email not confirmed", status: 400, code: "email_not_confirmed" } });
    h.resend.mockResolvedValue({ data: {}, error: { message: "Request rate limit reached", status: 429, code: "over_request_rate_limit" } });
    render(<LoginPage />);
    fill();
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });

  it("with confirmation off (a session comes back) it still goes straight in", async () => {
    h.signUp.mockResolvedValue({ data: { user, session: {} }, error: null });
    render(<LoginPage />);
    fill();
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/workspace"));
    expect(screen.queryByText("Confirm your email.")).toBeNull();
  });
});
