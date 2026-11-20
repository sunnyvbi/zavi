import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
const getUser = vi.fn();
vi.mock("@/lib/supabase", () => ({
  createServerSupabase: () => ({ auth: { getUser } }),
}));

import { resolveMarketingSession, MARKETING_SESSION_DEADLINE_MS } from "./resolveCta";

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveMarketingSession deadline", () => {
  it("falls back to the signed-out CTA when auth hangs, instead of stalling the page", async () => {
    vi.useFakeTimers();
    getUser.mockReturnValue(new Promise(() => {}));
    const p = resolveMarketingSession();
    await vi.advanceTimersByTimeAsync(MARKETING_SESSION_DEADLINE_MS + 1);
    await expect(p).resolves.toEqual({
      cta: { href: "/start", label: "Get Started" },
      email: null,
    });
  });

  it("uses the real answer when auth responds in time", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    await expect(resolveMarketingSession()).resolves.toMatchObject({ cta: { href: "/start" } });
  });
});
