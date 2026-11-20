// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams("state=live") }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({ default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn(), trackEventDeferred: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { me: async () => ({ creator: { country_code: "US" } }) } };
});

import ApplyFlow from "./ApplyFlow";

afterEach(cleanup);

describe("the You're live screen", () => {
  it("points to payout setup now, never to the first accepted job", async () => {
    render(<ApplyFlow />);
    expect(await screen.findByText("You're live on Zavi")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/first accepted job/);
    expect(screen.getByRole("link", { name: "Earnings" }).getAttribute("href")).toBe("/creator/earnings");
  });
});
