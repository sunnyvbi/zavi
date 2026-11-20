// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { START_CARD_DONE_FIXTURE, type GrowthLeaderboardRankResponse } from "@zavi/shared";

const H = vi.hoisted(() => ({ rank: { listed: false } as GrowthLeaderboardRankResponse }));
vi.mock("@/lib/start-card/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/start-card/api")>();
  return {
    ...real,
    getLeaderboardRank: vi.fn(async () => H.rank),
    getStartCard: vi.fn(async () => START_CARD_DONE_FIXTURE),
  };
});

import { RemoveMySite, YourRank } from "./MyCard";
import { MY_CARD_KEY, getLeaderboardRank } from "@/lib/start-card/api";

const ID = START_CARD_DONE_FIXTURE.public_id;

beforeEach(() => {
  localStorage.clear();
  H.rank = { listed: false };
  vi.mocked(getLeaderboardRank).mockClear();
});
afterEach(cleanup);

describe("YourRank", () => {
  it("renders nothing when this browser has no card, without asking the backend", async () => {
    const { container } = render(<YourRank />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
    expect(getLeaderboardRank).not.toHaveBeenCalled();
  });

  it("shows rank, score and #1 problem for a listed card, with Open my card", async () => {
    localStorage.setItem(MY_CARD_KEY, ID);
    H.rank = { listed: true, rank: 214, total: 1284 };
    render(<YourRank />);
    const link = await screen.findByRole("link", { name: "Open my card" });
    expect(link.getAttribute("href")).toBe(`/r/${ID}`);
    const strip = screen.getByTestId("your-rank");
    expect(strip.textContent).toContain("#214 of 1,284");
    expect(strip.textContent).toContain(START_CARD_DONE_FIXTURE.domain);
    expect(strip.textContent).toContain(`${START_CARD_DONE_FIXTURE.score!.total}/100`);
    expect(within(strip).queryByText(/Checking your rank/)).toBeNull();
  });

  it("shows Checking your rank… while it asks, then nothing when the card is not listed", async () => {
    localStorage.setItem(MY_CARD_KEY, ID);
    const { container } = render(<YourRank />);
    expect(screen.getByText(/Checking your rank/)).toBeTruthy();
    await vi.waitFor(() => expect(container.innerHTML).toBe(""));
    expect(getLeaderboardRank).toHaveBeenCalledWith(ID);
  });
});

describe("RemoveMySite", () => {
  it("links the viewer's own result when this browser has a card", async () => {
    localStorage.setItem(MY_CARD_KEY, ID);
    render(<RemoveMySite />);
    expect((await screen.findByRole("link", { name: "Open my result" })).getAttribute("href")).toBe(`/r/${ID}`);
  });

  it("otherwise explains where Report / remove lives", async () => {
    render(<RemoveMySite />);
    expect((await screen.findByTestId("remove-my-site")).textContent).toContain("Report / remove");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
