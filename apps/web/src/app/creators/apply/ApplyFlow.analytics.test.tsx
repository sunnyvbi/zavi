// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ signup: vi.fn(), track: vi.fn(), replace: vi.fn(), finish: false, search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.finish ? "finish=1" : h.search),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: h.track, trackEventDeferred: h.track }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: {
  getSession: async () => ({ data: { session: h.finish ? { user: { user_metadata: {}, app_metadata: { provider: "google" } } } : null } }),
  signUp: async () => ({ data: { session: null }, error: { message: "already registered" } }),
  signInWithPassword: async () => ({ data: { session: {} }, error: null }),
} }) }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: {
    signup: h.signup,
    home: async () => ({ home: "/creator", has_company: false, in_any_company: false, is_creator: true }),
  } };
});

import ApplyFlow from "./ApplyFlow";

beforeEach(() => { vi.clearAllMocks(); h.finish = false; h.search = ""; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("creator signup analytics", () => {
  it("includes creator accounts created after OAuth", async () => {
    h.finish = true;
    h.signup.mockResolvedValue({ ok: true, created: true });
    render(<ApplyFlow />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/creators/apply?step=goal"));
    expect(h.track).toHaveBeenCalledWith("creator_signup_completed", { method: "google" });
  });

  it.each([true, false])("uses the actual created result (%s)", async (created) => {
    h.signup.mockResolvedValue({ ok: true, created });
    render(<ApplyFlow />);
    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Maya" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "maya@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith(created ? "/creators/apply?step=goal" : "/creator"));
    expect(h.track).toHaveBeenCalledWith(created ? "creator_signup_completed" : "creator_logged_in", { method: "password" });
    expect(h.track).not.toHaveBeenCalledWith(created ? "creator_logged_in" : "creator_signup_completed", expect.anything());
    expect(JSON.stringify(h.track.mock.calls)).not.toContain("maya@example.com");
    expect(JSON.stringify(h.track.mock.calls)).not.toContain("secret-pass");
  });
});

describe("signup from the invite email", () => {
  it("fills in the invited name and email, so only the password is left", async () => {
    const f = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ name: "Ivy Lane", email: "ivy@example.com" }) }));
    vi.stubGlobal("fetch", f);
    h.search = "src=invite&invite=33333333-3333-4333-8333-333333333333";
    render(<ApplyFlow />);
    await waitFor(() => expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("ivy@example.com"));
    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Ivy Lane");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect(String(f.mock.calls[0][0])).toContain("/api/creators/invite/prefill?t=33333333-3333-4333-8333-333333333333");
  });

  it("an unknown link leaves the form empty", async () => {
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal("fetch", f);
    h.search = "src=invite&invite=33333333-3333-4333-8333-333333333333";
    render(<ApplyFlow />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
  });
});
