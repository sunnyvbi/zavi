// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ChatBubble } from "../ChatBubble";
import { parseNextActions } from "./NextActions";
import type { FigureReceiptMeta } from "./receiptData";

afterEach(cleanup);

const ANSWER = [
  "**Red** down 8.1% vs the week before.",
  "",
  "New customers fell to 412 last week.",
  "",
  "1. **Raise the Meta Ads spend limit** so prospecting runs again. Moves: new customers (412).",
  "2. **Check the mobile checkout page for errors.** Moves: new customers (412).",
].join("\n");

describe("parseNextActions", () => {
  it("reads 1..3 numbered actions that each name what they move", () => {
    const p = parseNextActions("Body text.\n\n1. **Send the restock email.** Moves: returning revenue.\n2. Test a bundle (Moves: new customers (412))\n\nThat is all.");
    expect(p?.before).toBe("Body text.");
    expect(p?.actions).toEqual([
      { title: "Send the restock email", moves: "returning revenue" },
      { title: "Test a bundle", moves: "new customers (412)" },
    ]);
    expect(p?.after).toBe("That is all.");
  });

  it("falls back (null) when any item lacks a Moves line, there are more than 3, or numbering is off", () => {
    expect(parseNextActions("Body.\n\n1. Do this. Moves: x.\n2. Do that.")).toBeNull();
    expect(parseNextActions("1. a Moves: x\n2. b Moves: x\n3. c Moves: x\n4. d Moves: x")).toBeNull();
    expect(parseNextActions("2. a Moves: x\n3. b Moves: y")).toBeNull();
    expect(parseNextActions("No list here.")).toBeNull();
    expect(parseNextActions("```\n1. a Moves: x\n```")).toBeNull();
  });
});

describe("the card in a chat reply", () => {
  it("renders the card with badges, titles and Moves lines", () => {
    const { container } = render(<ChatBubble role="assistant" text={ANSWER} onAskAction={async () => true} />);
    const card = within(container).getByTestId("next-actions");
    expect(card.textContent).toContain("What to do next");
    expect(card.textContent).toContain("Raise the Meta Ads spend limit so prospecting runs again");
    expect(card.textContent).toContain("Moves: new customers (412)");
    expect(within(card).getAllByRole("button", { name: "Ask Zavi to do this" })).toHaveLength(2);
    expect(container.querySelectorAll("ol").length).toBe(1);
  });

  it("sends the action title as the next message, then shows Sent and disables", async () => {
    const onAsk = vi.fn(async () => true);
    const { container } = render(<ChatBubble role="assistant" text={ANSWER} onAskAction={onAsk} />);
    const [first] = within(container).getAllByRole("button", { name: "Ask Zavi to do this" });
    fireEvent.click(first);
    await waitFor(() => expect(within(container).getByRole("button", { name: "Sent" })).toBeTruthy());
    expect(onAsk).toHaveBeenCalledWith("Raise the Meta Ads spend limit so prospecting runs again");
    expect((within(container).getByRole("button", { name: "Sent" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed send says so and leaves the button usable", async () => {
    const { container } = render(<ChatBubble role="assistant" text={ANSWER} onAskAction={async () => false} />);
    fireEvent.click(within(container).getAllByRole("button", { name: "Ask Zavi to do this" })[0]);
    await waitFor(() => expect(within(container).getByRole("alert").textContent).toContain("Could not send that"));
    expect((within(container).getAllByRole("button", { name: "Ask Zavi to do this" })[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("an answer whose list does not parse stays plain markdown, no card", () => {
    const text = "**Green** up 6%.\n\nRevenue is up.\n\n1. Send the email.\n2. Test a bundle.";
    const { container } = render(<ChatBubble role="assistant" text={text} onAskAction={async () => true} />);
    expect(within(container).queryByTestId("next-actions")).toBeNull();
    expect(container.textContent).toContain("Send the email.");
  });

  it("a reply that is not an analysis answer keeps its list as markdown", () => {
    const text = "Here is the plan.\n\n1. Send it. Moves: revenue.";
    const { container } = render(<ChatBubble role="assistant" text={text} onAskAction={async () => true} />);
    expect(within(container).queryByTestId("next-actions")).toBeNull();
  });
});

describe("single-digit money and percent figures", () => {
  it("$0 and 4% are bold when a receipt exists; a bare 3 is not, and no icon follows", () => {
    const receipts: FigureReceiptMeta[] = [
      { figure: "$0", kind: "catalog", sourceSlug: "meta_ads", metricId: "meta_ad_spend", label: "Meta Ads spend" },
      { figure: "4%", kind: "catalog", sourceSlug: "stripe", metricId: "net_revenue" },
    ];
    const { container } = render(
      <ChatBubble role="assistant" text="Prospecting spent $0 on Sunday, 4% up, across 3 campaigns and $4 of fees." figureReceipts={receipts} />,
    );
    expect(within(container).getAllByTestId("figure").map((f) => f.textContent)).toEqual(["$0", "4%"]);
    expect(within(container).queryByTestId("figure-marker")).toBeNull();
  });
});
