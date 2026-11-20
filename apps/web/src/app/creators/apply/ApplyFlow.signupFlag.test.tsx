// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ signUp: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn(), trackEventDeferred: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signUp: h.signUp } }) }));

import ApplyFlow from "./ApplyFlow";

afterEach(cleanup);

describe("creator sign up marks the account as a creator", () => {
  it("sends the creator flag with the sign up, so any later sign in can finish the creator account", async () => {
    h.signUp.mockResolvedValue({ data: { session: null }, error: null });
    render(<ApplyFlow />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Maya" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "maya@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    await waitFor(() => expect(h.signUp).toHaveBeenCalledTimes(1));
    expect(h.signUp.mock.calls[0][0].options.data).toEqual({ full_name: "Maya", zavi_signup: "creator" });
  });
});
