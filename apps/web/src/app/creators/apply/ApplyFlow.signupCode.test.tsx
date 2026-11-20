// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signUp: vi.fn(),
  signIn: vi.fn(),
  verifyOtp: vi.fn(),
  resend: vi.fn(),
  replace: vi.fn(),
  creatorSignup: vi.fn(),
  home: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn(), trackEventDeferred: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { signUp: h.signUp, signInWithPassword: h.signIn, verifyOtp: h.verifyOtp, resend: h.resend } }),
}));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { ...actual.creatorApi, signup: h.creatorSignup, home: h.home } };
});

import ApplyFlow from "./ApplyFlow";

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.signUp.mockResolvedValue({ data: { user: { id: "u1", identities: [{ id: "i" }] }, session: null }, error: null });
  h.verifyOtp.mockResolvedValue({ data: { session: {} }, error: null });
  h.resend.mockResolvedValue({ error: null });
  h.creatorSignup.mockResolvedValue({ created: true });
  h.home.mockResolvedValue({ home: "/creator" });
});
afterEach(cleanup);

function signUp() {
  render(<ApplyFlow />);
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Maya" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "maya@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
}

describe("creator sign-up asks for the emailed code", () => {
  it("shows the code step, verifies type signup, then hands off to the finish step", async () => {
    signUp();
    expect(await screen.findByText("Confirm your email.")).toBeTruthy();
    expect(screen.getByText(/Check your spam or junk folder/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "48203917" } });
    await waitFor(() => expect(h.verifyOtp).toHaveBeenCalledWith({ email: "maya@example.com", token: "48203917", type: "signup" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creators/apply?finish=1"));
    expect(h.creatorSignup).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("zavi.creatorSignupName")).toBe("Maya");
  });

  it("a general throttle is shown as an error, not as 'use the code we sent'", async () => {
    h.signUp.mockResolvedValue({ data: { user: { id: "u1", identities: [] }, session: null }, error: null });
    h.signIn.mockResolvedValue({ data: {}, error: { code: "email_not_confirmed", message: "Email not confirmed" } });
    h.resend.mockResolvedValue({ error: { message: "Request rate limit reached" } });
    signUp();
    expect(await screen.findByText(/rate limit/i)).toBeTruthy();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });

  it("an unconfirmed account inside Supabase's resend window still gets the code step", async () => {
    h.signUp.mockResolvedValue({ data: { user: { id: "u1", identities: [] }, session: null }, error: null });
    h.signIn.mockResolvedValue({ data: {}, error: { code: "email_not_confirmed", message: "Email not confirmed" } });
    h.resend.mockResolvedValue({ error: { message: "For security purposes, you can only request this after 41 seconds." } });
    signUp();
    expect(await screen.findByText("Enter the code we emailed you a moment ago.")).toBeTruthy();
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("a wrong code keeps the step with a plain message", async () => {
    h.verifyOtp.mockResolvedValue({ data: {}, error: { message: "Token has expired or is invalid" } });
    signUp();
    await screen.findByText("Confirm your email.");
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "11112222" } });
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    expect(h.creatorSignup).not.toHaveBeenCalled();
  });

  it("an existing account signs in instead of waiting on a code", async () => {
    h.signUp.mockResolvedValue({ data: { user: { id: "u1", identities: [] }, session: null }, error: null });
    h.signIn.mockResolvedValue({ data: { session: {} }, error: null });
    signUp();
    await waitFor(() => expect(h.creatorSignup).toHaveBeenCalled());
    expect(screen.queryByText("Confirm your email.")).toBeNull();
  });
});
