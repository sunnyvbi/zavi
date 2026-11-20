// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const resource = vi.hoisted(() => ({ value: { data: null as unknown, loading: false } }));
vi.mock("@/components/humans/useHumanResource", () => ({ useHumanResource: () => resource.value }));
const cardsState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./useCards", () => ({ useCreatorCards: () => cardsState.value }));
vi.mock("@/lib/creator/introVideo", () => ({ openIntroVideo: vi.fn() }));

import { ApplicantsDrawer } from "./ApplicantsDrawer";

const ORDER = "Oldest first. Applicants are never ranked by fit or quality.";

function brief(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    business_name: "UpcarAI",
    title: "Upcar: first real rental from a local owner, price on screen",
    angle: "a",
    hook: "h",
    format: "f",
    deliverables: 1,
    budget_usd: 150,
    lane: "ugc_video",
    delivery_days: 7,
    posted_at: "2026-10-21T13:07:45Z",
    answer_by: "2026-10-26T13:07:45Z",
    applicant_cap: 20,
    applicant_count: 0,
    spots_left: 20,
    open: true,
    closed_reason: null,
    ...over,
  };
}

function show(over: Record<string, unknown> = {}, applicants: unknown[] = []) {
  resource.value = {
    loading: false,
    data: {
      applicants,
      order: ORDER,
      brief: brief(over),
      applicant_count: applicants.length,
      spots_line: "",
      answer_by_line: "",
      decline_note: "Comedian",
      decline_note_is_default: false,
    },
  };
  window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=applicants&brief=b1");
  return render(<ApplicantsDrawer />);
}

const statValue = (label: string) => screen.getByText(label).closest("div")?.querySelector("dd")?.textContent;

afterEach(() => {
  cleanup();
  cardsState.value = {};
});

describe("the applicants drawer summary", () => {
  it("puts the brief title in the body, not the drawer title, with its status, numbers and the order", () => {
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Upcar: first real rental from a local owner, price on screen" })).toBeTruthy();
    expect(screen.queryByText(/^Applicants: /)).toBeNull();
    expect(screen.getByText("Open").className).toContain("bg-successBg");
    expect(statValue("Applied")).toBe("0 of 20");
    expect(statValue("Answer by")).toBe("Oct 26");
    expect(statValue("Budget")).toBe("$150 per video");
    expect(screen.getByText("“Comedian”")).toBeTruthy();
    expect(screen.getByText(ORDER)).toBeTruthy();
  });

  it("says plainly when nobody applied yet, and until when applications come in", () => {
    show();
    expect(screen.getByText("No applications yet")).toBeTruthy();
    expect(screen.getByText(/Their applications show up here, until Oct 26\./)).toBeTruthy();
  });

  it("a closed brief reads Closed and promises no more applications", () => {
    show({ open: false, closed_reason: "answer_by_passed", budget_usd: null, applicant_cap: null });
    expect(screen.getByText("Closed").className).toContain("bg-bone");
    expect(statValue("Applied")).toBe("0");
    expect(statValue("Budget")).toBe("Not set");
    expect(screen.queryByText(/until Oct 26/)).toBeNull();
  });

  it("Read the published brief is a button that opens the brief drawer", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Read the published brief" }));
    expect(window.location.search).toContain("drawer=brief");
    expect(window.location.search).toContain("brief=b1");
  });
});

const APPLICANT = {
  application_id: "a1",
  human_member_id: "m1",
  display_name: "Mohit Dudhat",
  slug: null,
  city: null,
  country_code: "US",
  bookable: true,
  status: "applied",
  note: "Description fits me well.",
  applied_at: "2026-10-21T14:10:00Z",
  quoted_rate_usd: 5,
  fees: { price_cents: 500, business_fee_cents: 50, business_total_cents: 550, business_fee_label: "10%" },
  hire_state: null,
};

const CARD = {
  human_member_id: "m1",
  slug: null,
  display_name: "Mohit Dudhat",
  city: null,
  country_code: "US",
  bio: "I film real trips.",
  lanes: ["ugc_video"],
  niches: ["Tech"],
  has_intro_video: false,
  photo_url: null,
  bookable: true,
  socials: [],
  packages: [],
  rating: { average: null, count: 0 },
};

describe("an applicant card", () => {
  it("shows the creator the way Find creators does, with the application in a compact bar under it", () => {
    cardsState.value = { m1: CARD };
    show({}, [APPLICANT]);
    const li = screen.getByTestId("applicant");
    expect(li.querySelector("article")).not.toBeNull();
    expect(li.textContent).toContain("I film real trips.");
    expect(li.textContent).toContain("Applied to this brief");
    expect(li.textContent).toContain("\u201cDescription fits me well.\u201d");
    expect(li.textContent).toContain("$5 quote · you pay $5.50 with Zavi's fee");
    const hire = screen.getByRole("button", { name: "Hire and pay $5.50" });
    expect(hire.className).toContain("h-9");
    expect(hire.className).not.toContain("h-10");
    expect(screen.getByRole("button", { name: "Message Mohit" }).className).toContain("h-9");
  });

  it("Hire opens the hire drawer for this application, Message opens the thread", () => {
    cardsState.value = { m1: CARD };
    show({}, [APPLICANT]);
    fireEvent.click(screen.getByRole("button", { name: "Hire and pay $5.50" }));
    expect(window.location.search).toContain("drawer=hire");
    expect(window.location.search).toContain("application=a1");
    show({}, [APPLICANT]);
    fireEvent.click(screen.getAllByRole("button", { name: "Message Mohit" })[0]);
    expect(window.location.search).toContain("drawer=thread");
    expect(window.location.search).toContain("creator=m1");
  });

  it("a closed brief offers no Hire, and a creator Zavi cannot pay says so", () => {
    cardsState.value = { m1: CARD };
    show({ open: false }, [{ ...APPLICANT, bookable: false }]);
    expect(screen.queryByRole("button", { name: /^Hire and pay/ })).toBeNull();
    expect(screen.getByText(/cannot be hired/)).toBeTruthy();
  });
});
