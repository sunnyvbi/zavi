// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

const APPROVED = {
  vetting_state: "approved",
  setup: { dob: true, make: true, package: true, done: 3, complete: true },
};
const h = vi.hoisted(() => ({
  search: "",
  me: null as unknown,
  api: {
    briefs: vi.fn(),
    openBrief: vi.fn(),
    briefQuote: vi.fn(),
    applyToBrief: vi.fn(),
  },
}));
const api = h.api;
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: h.api };
});

vi.mock("./CreatorChrome", async () => {
  const actual = await vi.importActual<typeof import("./CreatorChrome")>("./CreatorChrome");
  return { ...actual, useCreatorMe: () => ({ me: h.me, reload: () => {} }) };
});

import { CreatorBriefsBoard } from "./CreatorBriefs";

const FEES = {
  price_cents: 18_000,
  business_fee_cents: 1_800,
  business_total_cents: 19_800,
  creator_fee_cents: 2_700,
  creator_payout_cents: 15_300,
};

function brief(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    business_name: "Acme Coffee",
    title: "Spring menu launch",
    angle: "1 Instagram Reel, 30 to 45s: a real morning routine that features the new oat latte.",
    hook: "Hook in the first 2 seconds.",
    format: "Instagram Reels",
    deliverables: 1,
    lane: "ugc_video",
    budget_usd: 200,
    delivery_days: 7,
    posted_at: "2026-09-20T00:00:00Z",
    answer_by: "2026-10-02T12:00:00Z",
    applicant_cap: 10,
    applicant_count: 3,
    spots_left: 7,
    open: true,
    closed_reason: null,
    spots_line: "7 places left before this brief closes to new applications.",
    answer_by_line: "Everyone who applies hears back by 2026-10-02.",
    ...over,
  };
}

function board(briefs: ReturnType<typeof brief>[], applied_closed: ReturnType<typeof brief>[] = []) {
  return {
    briefs,
    applied_closed,
    order: "Newest first",
    count_line: `${briefs.length} open briefs`,
    lanes: [],
    apply: { available: true, endpoint: "/api/humans/open-briefs/:briefId/apply", method: "POST" },
  };
}

beforeEach(() => {
  h.search = "";
  h.me = APPROVED;
  for (const f of Object.values(api)) f.mockReset();
  api.briefQuote.mockResolvedValue({ fees: FEES, explain: "" });
});
afterEach(() => cleanup());

describe("the Briefs tab", () => {
  it("loads the real board shape (apply, not apply_seam) and shows list + detail + Apply", async () => {
    api.briefs.mockResolvedValue(board([brief("b1"), brief("b2", { business_name: "Lumen Skin", title: "Three unboxing videos" })]));
    api.openBrief.mockResolvedValue({ my_application: null });
    render(<CreatorBriefsBoard />);

    expect(await screen.findByRole("heading", { name: "Briefs for you" })).toBeTruthy();
    expect(screen.getByText(/Businesses write these\. Set your own price/)).toBeTruthy();
    expect(screen.getAllByText("3 creators applied")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Spring menu launch", level: 2 })).toBeTruthy();
    expect(screen.getByText("If you are hired: 2 rounds of changes, and the business is charged at hire.")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Apply" })).toBeTruthy();
    expect(screen.getByText("One application per brief. Acme Coffee answers by Oct 2.")).toBeTruthy();
  });

  it("a creator who is not approved sees the missing setup step, never the Apply form", async () => {
    h.me = { vetting_state: "pending", setup: { dob: true, make: true, package: false, done: 2, complete: false } };
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockRejectedValue(new Error("not_approved"));
    render(<CreatorBriefsBoard />);
    expect(await screen.findByRole("heading", { name: "Before you apply: add your first package" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Apply" })).toBeNull();
    expect(screen.queryByText(/couldn't check your application/)).toBeNull();
    expect(api.openBrief).not.toHaveBeenCalled();
    expect(screen.queryByText(/do not need a package/)).toBeNull();
    expect(screen.getByRole("link", { name: /3\. Your first package/ }).getAttribute("href")).toBe("/creators/apply?step=package");
  });

  it("a creator with all three steps but still in review is told review is pending", async () => {
    h.me = { vetting_state: "under_review", setup: { dob: true, make: true, package: true, done: 3, complete: true } };
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockRejectedValue(new Error("not_approved"));
    render(<CreatorBriefsBoard />);
    expect(await screen.findByRole("heading", { name: "Before you apply: Zavi is reviewing your profile" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Apply" })).toBeNull();
  });

  it("opens the brief named in ?brief= (the email link)", async () => {
    h.search = "brief=b2";
    api.briefs.mockResolvedValue(board([brief("b1"), brief("b2", { title: "Three unboxing videos" })]));
    api.openBrief.mockResolvedValue({ my_application: null });
    render(<CreatorBriefsBoard />);
    expect(await screen.findByRole("heading", { name: "Three unboxing videos", level: 2 })).toBeTruthy();
  });

  it("shows the backend's receive figure and posts price + note to the apply route", async () => {
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockResolvedValue({ my_application: null });
    api.applyToBrief.mockResolvedValue({ ok: true, application_id: "a1", fees: FEES, answer_by_line: "" });
    render(<CreatorBriefsBoard />);

    await screen.findByRole("heading", { name: "Apply" });
    const priceInput = screen.getByDisplayValue("180");
    await waitFor(() => expect(screen.getByTestId("receive-line").textContent).toContain("$153"));
    expect(api.briefQuote).toHaveBeenCalledWith("b1", "180");

    const button = screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Why you fit, and how you would film it."), {
      target: { value: "I shoot morning routines every week." },
    });
    fireEvent.change(priceInput, { target: { value: "180" } });
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });

    expect(api.applyToBrief).toHaveBeenCalledWith("b1", "180", "I shoot morning routines every week.");
    expect(await screen.findByText("Your price $180 · you receive $153")).toBeTruthy();
    expect(screen.getAllByText("Applied, waiting").length).toBeGreaterThan(0);
    expect(screen.getByText("Acme Coffee answers by Oct 2. We email you either way.")).toBeTruthy();
  });

  it("a 3-video brief at $150 per video says so and starts the quote at 90% of the whole job, not of one video", async () => {
    api.briefs.mockResolvedValue(board([brief("b3", { deliverables: 3, budget_usd: 150, title: "Three unboxing videos" })]));
    api.openBrief.mockResolvedValue({ my_application: null });
    api.applyToBrief.mockResolvedValue({ ok: true, application_id: "a3", fees: FEES, answer_by_line: "" });
    render(<CreatorBriefsBoard />);

    await screen.findByRole("heading", { name: "Apply" });
    expect(screen.getAllByText("3 videos · $150 per video")).toHaveLength(2);
    expect(screen.queryByText("$150")).toBeNull();

    const priceInput = screen.getByLabelText(/Your price for all 3 videos/) as HTMLInputElement;
    expect(priceInput.value).toBe("405");
    expect(screen.queryByDisplayValue("135")).toBeNull();
    expect(screen.getByText(/One price for all 3 videos\. Filled in a little under the \$450 budget \(\$150 per video\)/)).toBeTruthy();

    await waitFor(() => expect(api.briefQuote).toHaveBeenCalled());
    expect(api.briefQuote.mock.calls.map((c) => c[1])).toEqual(["405"]);

    fireEvent.change(screen.getByPlaceholderText("Why you fit, and how you would film it."), {
      target: { value: "Three takes, one per product." },
    });
    await waitFor(() => expect((screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    });
    expect(api.applyToBrief).toHaveBeenCalledWith("b3", "405", "Three takes, one per product.");
  });

  it("a one-video brief keeps its 90% start and calls the field the price for the video", async () => {
    api.briefs.mockResolvedValue(board([brief("b1", { deliverables: null })]));
    api.openBrief.mockResolvedValue({ my_application: null });
    render(<CreatorBriefsBoard />);
    await screen.findByRole("heading", { name: "Apply" });
    expect((screen.getByLabelText(/Your price for the video/) as HTMLInputElement).value).toBe("180");
    expect(screen.getAllByText("1 video · $200 per video")).toHaveLength(2);
  });

  it("shows a refusal from the apply route in plain words", async () => {
    const { CreatorApiError } = await import("@/lib/creator/api");
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockResolvedValue({ my_application: null });
    api.applyToBrief.mockRejectedValue(
      new CreatorApiError("cap_reached", "This brief has taken all the applications it will take.", 409),
    );
    render(<CreatorBriefsBoard />);
    await screen.findByRole("heading", { name: "Apply" });
    await waitFor(() => expect(screen.getByTestId("receive-line").textContent).toContain("$153"));
    fireEvent.change(screen.getByPlaceholderText("Why you fit, and how you would film it."), {
      target: { value: "hi" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    });
    expect(await screen.findByText("This brief has taken all the applications it will take.")).toBeTruthy();
  });

  it("the applied state: closed briefs keep their Hired / Not picked outcome, with the business note", async () => {
    api.briefs.mockResolvedValue(
      board(
        [brief("b1")],
        [
          brief("b2", { title: "Three unboxing videos", open: false }),
          brief("b3", { title: "Gym demos", open: false }),
        ],
      ),
    );
    const app = (status: string, over: Record<string, unknown> = {}) => ({
      application_id: `a-${status}`,
      status,
      note: "I shoot morning routines every week.",
      quoted_rate_usd: 180,
      fees: FEES,
      applied_at: "2026-09-21T00:00:00Z",
      ...over,
    });
    api.openBrief.mockImplementation(async (id: string) => ({
      my_application:
        id === "b1"
          ? app("applied")
          : id === "b2"
            ? app("approved", { hired_order_id: "o-9", hired_order_status: "in_progress" })
            : app("rejected", { business_note: "We went with a creator in Austin." }),
    }));
    render(<CreatorBriefsBoard />);

    expect(await screen.findByRole("heading", { name: "Your applications" })).toBeTruthy();
    expect(screen.getAllByText("Applied, waiting").length).toBeGreaterThan(0);
    expect(screen.getByText("Hired")).toBeTruthy();
    expect(screen.getByText("Not picked this time")).toBeTruthy();

    fireEvent.click(screen.getByText("Three unboxing videos"));
    expect(await screen.findByText("Acme Coffee hired you and paid. The job is in progress.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open job/ }).getAttribute("href")).toBe("/creator/jobs/o-9");

    fireEvent.click(screen.getByText("Gym demos"));
    expect(await screen.findByText("Note from Acme Coffee")).toBeTruthy();
    expect(screen.getByText("\u201cWe went with a creator in Austin.\u201d")).toBeTruthy();
    expect(
      screen.getByText("Your application is closed. Nothing was charged and nothing is owed."),
    ).toBeTruthy();
  });

  it("a finished hired job does not say it is in progress", async () => {
    api.briefs.mockResolvedValue(board([], [brief("b1", { open: false })]));
    api.openBrief.mockResolvedValue({
      my_application: {
        application_id: "a1",
        status: "approved",
        note: "n",
        quoted_rate_usd: 180,
        fees: FEES,
        applied_at: "2026-09-21T00:00:00Z",
        hired_order_id: "o-1",
        hired_order_status: "completed",
      },
    });
    render(<CreatorBriefsBoard />);
    expect(await screen.findByText("Acme Coffee hired you and paid. The job is finished.")).toBeTruthy();
  });

  it("a hire that was later cancelled says the charge was refunded, not paid", async () => {
    api.briefs.mockResolvedValue(board([], [brief("b1", { open: false })]));
    api.openBrief.mockResolvedValue({
      my_application: {
        application_id: "a1",
        status: "approved",
        note: "n",
        quoted_rate_usd: 180,
        fees: FEES,
        applied_at: "2026-09-21T00:00:00Z",
        hired_order_id: "o-1",
        hired_order_status: "cancelled",
      },
    });
    render(<CreatorBriefsBoard />);
    expect(
      await screen.findByText("Acme Coffee hired you, then the job was cancelled and the charge was refunded."),
    ).toBeTruthy();
    expect(screen.queryByText(/hired you and paid/)).toBeNull();
  });

  it("an approved application with no paid order is NOT shown as hired (checkout still open)", async () => {
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockResolvedValue({
      my_application: {
        application_id: "a1",
        status: "approved",
        note: "n",
        quoted_rate_usd: 180,
        fees: FEES,
        applied_at: "2026-09-21T00:00:00Z",
        hired_order_id: null,
      },
    });
    render(<CreatorBriefsBoard />);
    expect(await screen.findByText("Acme Coffee answers by Oct 2. We email you either way.")).toBeTruthy();
    expect(screen.queryByText("Hired")).toBeNull();
    expect(screen.queryByText(/hired you and paid/)).toBeNull();
  });

  it("a failed quote shows an error, never $0, and keeps Apply disabled", async () => {
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockResolvedValue({ my_application: null });
    api.briefQuote.mockRejectedValue(new Error("network"));
    render(<CreatorBriefsBoard />);
    await screen.findByRole("heading", { name: "Apply" });
    fireEvent.change(screen.getByPlaceholderText("Why you fit, and how you would film it."), {
      target: { value: "hi" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("receive-line").textContent).toContain("couldn't calculate your payout"),
    );
    expect(screen.getByTestId("receive-line").textContent).not.toContain("$0");
    expect((screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Apply stays disabled while the quote for a new price is still loading", async () => {
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockResolvedValue({ my_application: null });
    render(<CreatorBriefsBoard />);
    await screen.findByRole("heading", { name: "Apply" });
    await waitFor(() => expect(screen.getByTestId("receive-line").textContent).toContain("$153"));
    fireEvent.change(screen.getByPlaceholderText("Why you fit, and how you would film it."), {
      target: { value: "hi" },
    });
    fireEvent.change(screen.getByDisplayValue("180"), { target: { value: "250" } });
    expect((screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an application lookup that fails shows an error instead of the Apply form", async () => {
    api.briefs.mockResolvedValue(board([brief("b1")]));
    api.openBrief.mockRejectedValue(new Error("500"));
    render(<CreatorBriefsBoard />);
    expect(
      await screen.findByText("We couldn't check your application for this brief. Reload to try again."),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Apply" })).toBeNull();
  });

  it("a ?brief= link to a brief that is gone does not open another business's brief", async () => {
    h.search = "brief=gone";
    api.briefs.mockResolvedValue(board([brief("b1", { business_name: "Lumen Skin" })]));
    api.openBrief.mockResolvedValue({ my_application: null });
    render(<CreatorBriefsBoard />);
    expect(await screen.findByText("That brief is not open any more. Pick another brief from the list.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Apply" })).toBeNull();
  });

  it("an empty board keeps the same layout with empty slots", async () => {
    api.briefs.mockResolvedValue(board([]));
    render(<CreatorBriefsBoard />);
    expect(
      await screen.findByText(
        "No briefs for you right now. Briefs that fit your platforms and niches show here and in your Inbox.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Pick a brief to see what the business wants, the budget and the deadline.")).toBeTruthy();
  });
});
