// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OfferCard } from "./OfferCard";
import type { CreatorOfferView } from "./types";

const offer = (over: Partial<CreatorOfferView> = {}): CreatorOfferView =>
  ({
    id: "o1",
    human_member_id: "m1",
    thread_id: "t1",
    proposed_by: "tenant",
    kind: "ugc_video",
    terms: { title: "1 UGC video", content_type: "ugc", count: 1 },
    price_cents: 14000,
    delivery_days: 7,
    note: null,
    status: "open",
    expires_at: "2026-10-24T00:00:00Z",
    responded_at: null,
    created_at: "2026-10-21T14:00:00Z",
    fees: { price_cents: 14000, business_fee_cents: 1400, business_total_cents: 15400, business_fee_label: "10%" },
    expired: false,
    ...over,
  }) as CreatorOfferView;

afterEach(cleanup);

const tile = (label: string) => screen.getByText(label).closest("div")?.querySelector("dd")?.textContent;

describe("the offer card in a conversation", () => {
  it("an open offer you sent: facts as tiles, the total in its own strip, one compact Withdraw", () => {
    const onAct = vi.fn();
    render(<OfferCard offer={offer()} creatorName="Mohit Dudhat" onAccept={vi.fn()} onAct={onAct} />);
    const card = screen.getByTestId("offer-card");
    expect(card.className).toContain("border-ink/25");
    expect(card.className).not.toContain("border-2");
    expect(card.className).not.toContain("opacity-70");
    expect(screen.getByText("Waiting for Mohit")).toBeTruthy();
    expect(tile("Due after start")).toBe("7 days");
    expect(tile("Changes")).toBe("2 rounds");
    expect(tile("Price")).toBe("$140");
    expect(screen.getByText("You pay").parentElement?.textContent).toContain("$154 with Zavi's 10% fee");
    const withdraw = screen.getByRole("button", { name: "Withdraw" });
    expect(withdraw.className).toContain("h-9");
    fireEvent.click(withdraw);
    expect(onAct).toHaveBeenCalledWith("withdraw");
  });

  it("a declined offer is muted and has no buttons", () => {
    render(<OfferCard offer={offer({ status: "declined" })} creatorName="Mohit Dudhat" onAccept={vi.fn()} onAct={vi.fn()} />);
    expect(screen.getByTestId("offer-card").className).toContain("opacity-70");
    expect(screen.getByText("Mohit declined")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("an offer from the creator offers Decline and Accept and pay", () => {
    const onAccept = vi.fn();
    render(<OfferCard offer={offer({ proposed_by: "creator" })} creatorName="Mohit Dudhat" onAccept={onAccept} onAct={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept and pay" }));
    expect(onAccept).toHaveBeenCalled();
  });

  it("an accepted, unpaid offer asks you to pay", () => {
    render(<OfferCard offer={offer({ status: "accepted", awaiting_payment: true })} creatorName="Mohit Dudhat" onAccept={vi.fn()} onAct={vi.fn()} />);
    expect(screen.getByText("Mohit accepted. Pay to start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay $154" })).toBeTruthy();
  });
});

describe("an offer Zavi's agent made that the creator accepted", () => {
  it("says it waits for the founder's approval on the hire card, with no Pay button", () => {
    render(
      <OfferCard
        offer={offer({ status: "accepted", awaiting_approval: true } as Partial<CreatorOfferView>)}
        creatorName="Mohit Dudhat"
        onAccept={vi.fn()}
        onAct={vi.fn()}
      />,
    );
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
    expect(screen.getByText(/Approve the hire card in What Zavi wants to do/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pay/ })).toBeNull();
  });
});
