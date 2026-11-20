// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/creator/profile" }));
vi.mock("next/image", () => ({ default: () => null }));
const api = vi.hoisted(() => ({ profile: vi.fn(), setupMake: vi.fn(), storefront: vi.fn(), reviews: vi.fn(async () => ({ aggregates: { review_count: 0, avg_communication: null, avg_timeliness: null, avg_satisfaction: null, avg_overall: null }, reviews: [] })) }));
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

beforeEach(() => {
  api.profile.mockReset();
  api.setupMake.mockReset();
  api.storefront.mockReset();
  api.storefront.mockResolvedValue({ packages: [] });
  api.profile.mockResolvedValue({
    bio: null,
    intro_video_name: null,
    niches: ["Tech"],
    niche_options: ["Tech"],
    country_code: "US",
    packages: [],
    accounts: [
      { platform: "tiktok", handle: "maya", url: "https://www.tiktok.com/@maya", followers: 1200, label: "" },
      { platform: "instagram", handle: "maya.ig", url: "https://www.instagram.com/maya.ig", followers: null, label: "" },
    ],
  });
});
afterEach(cleanup);

describe("Your accounts", () => {
  it("removing one account does not send the other with 0 followers", async () => {
    render(<CreatorProfileScreen />);
    await screen.findByText("Followers not added");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(api.setupMake).not.toHaveBeenCalled();
    expect(await screen.findByText(/Add the follower count/)).toBeTruthy();
  });

  it("two accounts with no count: the first count typed is kept while the second is asked for", async () => {
    api.setupMake.mockResolvedValue({ ok: true });
    api.profile.mockResolvedValue({
      bio: null, intro_video_name: null, niches: ["Tech"], niche_options: ["Tech"], country_code: "US", packages: [],
      accounts: [
        { platform: "tiktok", handle: "maya", url: "https://www.tiktok.com/@maya", followers: null, label: "" },
        { platform: "instagram", handle: "maya.ig", url: "https://www.instagram.com/maya.ig", followers: null, label: "" },
      ],
    });
    render(<CreatorProfileScreen />);
    await screen.findAllByText("Followers not added");
    const fillCount = async (n: string) => {
      fireEvent.change(await screen.findByPlaceholderText("48,000"), { target: { value: n } });
      fireEvent.click(screen.getByRole("button", { name: "Save account" }));
    };
    const accountLi = screen.getAllByText("Followers not added")[0].closest("li")!;
    fireEvent.click(within(accountLi).getByRole("button", { name: /Edit/ }));
    await fillCount("1200");
    expect(api.setupMake).not.toHaveBeenCalled();
    expect(await screen.findByText(/Add the follower count/)).toBeTruthy();
    await fillCount("800");
    await waitFor(() => expect(api.setupMake).toHaveBeenCalledTimes(1));
    const sent = api.setupMake.mock.calls[0][0] as Array<{ followers: number }>;
    expect(sent.map((a) => a.followers).sort()).toEqual([1200, 800].sort());
  });
});
