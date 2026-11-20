// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { START_CARD_DONE_FIXTURE, type GrowthLeaderboardRankResponse, type StartCard, type StartCardParts } from "@zavi/shared";

const R = vi.hoisted(() => ({ rank: { listed: false } as GrowthLeaderboardRankResponse }));
vi.mock("@/lib/start-card/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/start-card/api")>();
  return { ...real, getLeaderboardRank: vi.fn(async () => R.rank) };
});

import { GrowthCard, NOT_MEASURED } from "./GrowthCard";
import { getLeaderboardRank } from "@/lib/start-card/api";

afterEach(() => {
  cleanup();
  R.rank = { listed: false };
  vi.mocked(getLeaderboardRank).mockClear();
});

const DONE = START_CARD_DONE_FIXTURE;

function clone(): StartCard {
  return JSON.parse(JSON.stringify(DONE)) as StartCard;
}

const pending = { state: "pending" as const, evidence: null, fetched_at: null };

function partial(): StartCard {
  const c = clone();
  c.status = "running";
  c.score = null;
  const p = c.parts as Record<string, unknown>;
  for (const k of ["ai", "design", "compare", "diagnosis"]) p[k] = pending;
  return c;
}

function scoredBeforeDiagnosis(): StartCard {
  const c = clone();
  c.status = "running";
  (c.parts as Record<string, unknown>).diagnosis = pending;
  return c;
}

function withUnavailable(): StartCard {
  const c = clone();
  (c.parts as StartCardParts).ai = { state: "unavailable", evidence: null, unavailable_reason: "vendor_not_configured", fetched_at: null };
  c.score = { total: 53, out_of: 80, by_check: { google: 15, ai: null, seo: 13, design: 15, compare: 10 } };
  return c;
}

function layout(container: HTMLElement) {
  return {
    rows: Array.from(container.querySelectorAll("[data-testid^='check-']")).map((e) => e.getAttribute("data-testid")),
    sections: ["#1 thing holding you back", "Your competitors", "This is what I will do first"].map((t) => screen.queryAllByText(t).length),
  };
}

describe("GrowthCard", () => {
  it("keeps the same layout empty, partial and done", () => {
    const states: (StartCard | null)[] = [null, partial(), scoredBeforeDiagnosis(), DONE, withUnavailable()];
    const shapes = states.map((card) => {
      const { container, unmount } = render(<GrowthCard card={card} domain="brightloaf.example" />);
      const shape = layout(container);
      unmount();
      return shape;
    });
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0].rows).toEqual(["check-google", "check-ai", "check-seo", "check-design", "check-compare"]);
  });

  it("empty: every slot says it is checking, no score", () => {
    render(<GrowthCard card={null} domain="brightloaf.example" />);
    expect(screen.getByText("Scoring your site…")).toBeTruthy();
    expect(screen.getAllByText("Checking…").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByRole("img", { name: "Growth score being calculated" })).toBeTruthy();
  });

  it("partial: finished checks and competitors show; score, #1 problem and action do not", () => {
    render(<GrowthCard card={partial()} domain="brightloaf.example" />);
    const google = screen.getByTestId("check-google");
    expect(within(google).getByText("15/20")).toBeTruthy();
    expect(within(google).getByText(DONE.parts.google!.evidence!.note!)).toBeTruthy();
    expect(within(screen.getByTestId("check-ai")).getByText("–/20")).toBeTruthy();
    expect(screen.getByText("Crumbhouse")).toBeTruthy();
    expect(screen.getByText("no site found")).toBeTruthy();
    expect(screen.queryByText(/Your growth score/)).toBeNull();
    expect(screen.queryByText(DONE.parts.diagnosis!.evidence!.constraint.title)).toBeNull();
    expect(screen.getByText(/Checked from the United States/)).toBeTruthy();
  });

  it("holds the score back until the #1 problem is written, then shows them together", () => {
    const { rerender } = render(<GrowthCard card={scoredBeforeDiagnosis()} domain="brightloaf.example" />);
    expect(screen.queryByText(/Your growth score/)).toBeNull();
    rerender(<GrowthCard card={DONE} domain="brightloaf.example" />);
    expect(screen.getByText("Your growth score: 63/100")).toBeTruthy();
    expect(screen.getByText(DONE.parts.diagnosis!.evidence!.constraint.title)).toBeTruthy();
    expect(screen.getByText(DONE.parts.diagnosis!.evidence!.action_this_week.title)).toBeTruthy();
    expect(screen.getByText(/We checked: “sourdough bakery portland” on Google/)).toBeTruthy();
  });

  it("unavailable: the check says not measured and the score is out of N", () => {
    render(<GrowthCard card={withUnavailable()} domain="brightloaf.example" />);
    expect(within(screen.getByTestId("check-ai")).getByText(NOT_MEASURED)).toBeTruthy();
    expect(screen.getByText("Your growth score: 53/80")).toBeTruthy();
    expect(screen.getByText(/1 of 5 checks could not be measured/)).toBeTruthy();
  });

  it("competitor scores use the comparison's own scale, with the visitor's row alongside", () => {
    render(<GrowthCard card={DONE} domain="brightloaf.example" />);
    expect(screen.getByText("71/80")).toBeTruthy();
    expect(screen.getByText("31/80")).toBeTruthy();
    expect(screen.getByText(/You: 53\/80 on Google, AI answers, SEO and design\./)).toBeTruthy();
  });

  it("never names a check it did not measure: the You line and the We checked line", () => {
    const c = withUnavailable();
    (c.parts as StartCardParts).google = { state: "unavailable", evidence: null, unavailable_reason: "vendor_not_configured", fetched_at: null };
    const cmp = (c.parts as StartCardParts).compare!;
    cmp.evidence = { ...cmp.evidence!, checks_used: ["seo", "design"] };
    render(<GrowthCard card={c} domain="brightloaf.example" />);
    expect(screen.getByText(/You: \d+\/40 on SEO and design\./)).toBeTruthy();
    const checked = screen.getByText(/We checked:/);
    expect(checked.textContent).not.toMatch(/on Google/);
    expect(checked.textContent).not.toMatch(/ChatGPT/);
    expect(checked.textContent).toMatch(/Google PageSpeed/);
  });
});

describe("GrowthCard sharing", () => {
  const share = () => screen.getByRole("button", { name: /Share my score/ }) as HTMLButtonElement;
  const challenge = () => screen.getByRole("button", { name: /Challenge 3 founders/ }) as HTMLButtonElement;

  it("is visible but disabled while checks run", () => {
    render(<GrowthCard card={partial()} domain="brightloaf.example" />);
    expect(share().disabled).toBe(true);
    expect(challenge().disabled).toBe(true);
    expect(screen.getByText(/Sharing unlocks when all 5 checks are done/)).toBeTruthy();
  });

  it("unlocks once done, then copies the result and challenge links", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    render(<GrowthCard card={DONE} domain="brightloaf.example" />);
    expect(share().disabled).toBe(false);
    fireEvent.click(share());
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/r/${DONE.public_id}`));
    fireEvent.click(challenge());
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/start?ref=${DONE.public_id}`),
    );
  });

  it("when the copy fails, the link itself is shown (not 'use the address bar')", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    render(<GrowthCard card={DONE} domain="brightloaf.example" />);
    fireEvent.click(challenge());
    await vi.waitFor(() => expect(screen.getByText(/Couldn.t copy/)).toBeTruthy());
    expect(screen.getByText(`${window.location.origin}/start?ref=${DONE.public_id}`)).toBeTruthy();
    expect(screen.queryByText(/address bar/)).toBeNull();
  });

  it("a failed card says there is nothing to share instead of promising sharing", () => {
    const c = partial();
    c.status = "failed";
    render(<GrowthCard card={c} domain="brightloaf.example" />);
    expect(screen.getByText(/couldn't finish, so there is nothing to share yet/)).toBeTruthy();
    expect(screen.queryByText(/Sharing unlocks when all 5 checks are done/)).toBeNull();
  });

  it("the score title is a heading and Report / remove says whether it is open", () => {
    render(<GrowthCard card={DONE} domain="brightloaf.example" />);
    expect(screen.getByRole("heading", { name: /Your growth score/ })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /Report \/ remove/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("read-only (the result page) has no share buttons, but keeps Report / remove", () => {
    render(<GrowthCard card={DONE} domain="brightloaf.example" readOnly />);
    expect(screen.queryByRole("button", { name: /Share my score/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Report \/ remove/ })).toBeTruthy();
  });

  it("opens Report / remove on load from the notice email's remove link", () => {
    render(<GrowthCard card={DONE} domain="brightloaf.example" readOnly openReport />);
    expect(screen.getByRole("button", { name: /Report \/ remove/ }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("leaderboard rank line", () => {
  it("shows '#rank of total · See the leaderboard' on a finished, listed card", async () => {
    R.rank = { listed: true, rank: 214, total: 1284 };
    render(<GrowthCard card={DONE} domain={DONE.domain} readOnly />);
    const line = await screen.findByTestId("leaderboard-rank");
    expect(line.textContent).toContain("#214 of 1,284");
    expect(within(line).getByRole("link", { name: "See the leaderboard" }).getAttribute("href")).toBe("/growth");
    expect(getLeaderboardRank).toHaveBeenCalledWith(DONE.public_id);
  });

  it("shows nothing when the card is not listed", async () => {
    render(<GrowthCard card={DONE} domain={DONE.domain} readOnly />);
    await vi.waitFor(() => expect(getLeaderboardRank).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("leaderboard-rank")).toBeNull();
  });

  it("does not ask until the card is done", () => {
    R.rank = { listed: true, rank: 1, total: 1 };
    render(<GrowthCard card={partial()} domain={DONE.domain} />);
    expect(getLeaderboardRank).not.toHaveBeenCalled();
    expect(screen.queryByTestId("leaderboard-rank")).toBeNull();
  });
  it("We checked names the ranked term scored and the broad term, once Google is in", () => {
    const c = clone();
    const g = (c.parts as StartCardParts).google!;
    g.evidence = {
      ...g.evidence!,
      search_term: "artisan bread delivery",
      scored_term: "artisan bread delivery",
      term_source: "ranked",
      broad_term: "sourdough bakery portland",
      broad_position: null,
      broad_results_checked: 100,
      broad_top_domain: "other.example",
    };
    render(<GrowthCard card={c} domain="brightloaf.example" />);
    expect(screen.getByText(/We checked: “artisan bread delivery” and “sourdough bakery portland” on Google/)).toBeTruthy();
  });

  it("We checked leaves out the broad term when its search failed", () => {
    const c = clone();
    const g = (c.parts as StartCardParts).google!;
    g.evidence = {
      ...g.evidence!,
      search_term: "artisan bread delivery",
      scored_term: "artisan bread delivery",
      term_source: "ranked",
      broad_term: "sourdough bakery portland",
      broad_position: undefined,
    };
    render(<GrowthCard card={c} domain="brightloaf.example" />);
    const checked = screen.getByText(/We checked:/).textContent ?? "";
    expect(checked).toMatch(/artisan bread delivery/);
    expect(checked).not.toMatch(/sourdough/);
  });

  it("We checked waits for the Google check instead of showing a term that may change", () => {
    const c = partial();
    (c.parts as Record<string, unknown>).google = pending;
    render(<GrowthCard card={c} domain="brightloaf.example" />);
    expect(screen.getByText(/We checked:/).textContent).not.toMatch(/sourdough/);
    expect(screen.getByLabelText("Picking your search")).toBeTruthy();
  });
});
