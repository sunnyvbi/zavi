// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const signOut = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut } }) }));
vi.mock("@/lib/analytics/mixpanel", () => ({ resetAnalyticsIdentity: vi.fn() }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn() }));

import { UserMenu } from "./UserMenu";

const realLocation = window.location;
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("UserMenu sign out", () => {
  it("signs out this browser only, then goes to /login", async () => {
    const replace = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, replace } });
    render(<UserMenu email="a@b.co" />);
    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
