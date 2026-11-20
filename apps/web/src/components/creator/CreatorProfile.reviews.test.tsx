// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/creator/profile" }));
vi.mock("next/image", () => ({ default: () => null }));
const api = vi.hoisted(() => ({ profile: vi.fn(), storefront: vi.fn(), reviews: vi.fn() }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: { ...api, me: vi.fn() } };
});
vi.mock("./CreatorChrome", async () => {
  const actual = await vi.importActual<typeof import("./CreatorChrome")>("./CreatorChrome");
  return {
    ...actual,
    useCreatorMe: () => ({
      me: { vetting_state: "approved", setup: { dob: true, make: true, package: true, done: 3, complete: true }, creator: { display_name: "Maya", country_code: "US" } },
      reload: () => {},
    }),
  };
});

import { CreatorProfileScreen } from "./CreatorProfile";

const none = { review_count: 0, avg_communication: null, avg_timeliness: null, avg_satisfaction: null, avg_overall: null };

beforeEach(() => {
  api.storefront.mockResolvedValue({ packages: [] });
  api.profile.mockResolvedValue({ bio: null, intro_video_name: null, niches: ["Tech"], niche_options: ["Tech"], country_code: "US", packages: [], accounts: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Your reviews on the creator's own profile", () => {
  it("shows the review a business left: the overall score, each score, the business and what it wrote", async () => {
    api.reviews.mockResolvedValue({
      aggregates: { review_count: 1, avg_communication: 5, avg_timeliness: 4, avg_satisfaction: 5, avg_overall: 4.666 },
      reviews: [{ id: "r1", business_name: "UpcarAI", communication: 5, timeliness: 4, satisfaction: 5, body: "Great video, on brief.", created_at: "2026-10-22T07:00:00Z" }],
    });
    render(<CreatorProfileScreen />);
    const overall = await screen.findByTestId("review-overall");
    expect(overall.textContent).toContain("4.7");
    expect(overall.textContent).toContain("from 1 review");
    expect(screen.queryByText("No reviews yet")).toBeNull();
    expect(screen.queryByText("Not rated yet")).toBeNull();
    expect(screen.getAllByText("5.0 / 5")).toHaveLength(2);
    expect(screen.getByText("4.0 / 5")).toBeTruthy();
    const review = screen.getByTestId("review");
    expect(within(review).getByText("UpcarAI")).toBeTruthy();
    expect(within(review).getByText("Great video, on brief.")).toBeTruthy();
  });

  it("with no reviews still says so, and never shows a zero score", async () => {
    api.reviews.mockResolvedValue({ aggregates: none, reviews: [] });
    render(<CreatorProfileScreen />);
    expect(await screen.findByText("No reviews yet")).toBeTruthy();
    expect(screen.getAllByText("Not rated yet")).toHaveLength(3);
    expect(screen.queryByText(/0\.0/)).toBeNull();
  });

  it("a failed reviews read says so in the card and leaves the rest of the profile up", async () => {
    api.reviews.mockRejectedValue(new Error("down"));
    render(<CreatorProfileScreen />);
    expect(await screen.findByText("Your reviews did not load.")).toBeTruthy();
    expect(screen.queryByText("No reviews yet")).toBeNull();
    expect(screen.getByText(/Niches:/)).toBeTruthy();
  });
});
