// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/pricing" }));
vi.mock("@/lib/api", () => ({ apiUrl: (path: string) => `http://api.test${path}` }));
vi.mock("@/lib/consent", () => ({
  OPEN_PREFERENCES_EVENT: "zavi:open-cookie-preferences",
  hasAnalyticsConsent: () => true,
  readConsent: () => ({ status: "unset" }),
  signalsRejection: () => false,
  subscribe: () => () => {},
  withdrawAnalyticsConsent: () => {},
  writeConsent: () => {},
}));
const touch = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/lib/analytics/first-touch", () => ({ captureFirstTouch: touch.capture }));

import { CookieBanner } from "./CookieBanner";

afterEach(() => cleanup());

describe("accepting analytics captures the first touch on the landing page", () => {
  it("captures on Accept, so the landing and referrer are not read on the next full load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
    render(<CookieBanner />);
    await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(touch.capture).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
