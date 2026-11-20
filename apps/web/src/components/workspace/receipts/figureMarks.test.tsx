// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { ChatBubble } from "../ChatBubble";
import type { FigureReceiptMeta } from "./receiptData";

afterEach(cleanup);

const receipts: FigureReceiptMeta[] = [
  { figure: "$41,380", kind: "catalog", source: "Stripe", sourceSlug: "stripe", label: "Net revenue" },
  { figure: "1,587", kind: "exploratory", source: "Operator DB", sourceSlug: "operator_db", sql: ["select count(*) from bookings"] },
];

function bubble(text: string, unverified: string[] = []) {
  return render(<ChatBubble role="assistant" text={text} figureReceipts={receipts} unverifiedFigures={unverified} />);
}

function noMarks(container: HTMLElement) {
  expect(within(container).queryByTestId("figure-marker")).toBeNull();
  expect(within(container).queryByTestId("receipt-chip")).toBeNull();
  expect(within(container).queryByTestId("unverified-chip")).toBeNull();
  for (const f of within(container).queryAllByTestId("figure")) {
    expect(f.querySelector("svg, img, button")).toBeNull();
    expect(f.nextElementSibling?.tagName).not.toBe("BUTTON");
  }
}

describe("figures in a chat reply", () => {
  it("a sourced, an exploratory and an unverified figure are bold with no icon", () => {
    const { container } = bubble("Net revenue is $41,380. You had 1,587 bookings. Returning customers drove $17,900.", ["$17,900"]);
    const figs = within(container).getAllByTestId("figure");
    expect(figs.map((f) => f.tagName)).toEqual(["STRONG", "STRONG", "STRONG"]);
    expect(figs.map((f) => f.textContent)).toEqual(["$41,380", "1,587", "$17,900"]);
    noMarks(container);
    expect(container.textContent).toContain("Net revenue is $41,380. You had 1,587 bookings.");
  });

  it("bolds the first occurrence only, and never inside code", () => {
    const { container } = bubble("`$41,380` in code. Net revenue is $41,380, and again $41,380.");
    expect(within(container).getAllByTestId("figure")).toHaveLength(1);
    expect(container.querySelector("code")?.querySelector("[data-testid]")).toBeNull();
  });

  it("draws the trend lead as a pill", () => {
    const { container } = bubble("**Green** up 6.2% vs Aug 1-27. Net revenue is $41,380.");
    const pill = within(container).getByTestId("trend-pill");
    expect(pill.getAttribute("data-tone")).toBe("green");
    expect(container.textContent).not.toContain("**Green**");
  });

  it("a bare two-digit count with a receipt is bold; dates and unmatched counts are not", () => {
    const { container } = render(
      <ChatBubble
        role="assistant"
        text="On Sep 27 new customers fell to 91, and 14 came back. That was 27 fewer."
        figureReceipts={[
          { figure: "91", kind: "catalog", sourceSlug: "stripe", metricId: "new_customers", label: "New customers" },
          { figure: "27", kind: "catalog", sourceSlug: "stripe", metricId: "drop", label: "Drop" },
        ]}
      />,
    );
    expect(within(container).getAllByTestId("figure").map((f) => f.textContent)).toEqual(["91", "27"]);
    expect(container.textContent).toContain("On Sep 27 new customers");
    noMarks(container);
  });

  it("keeps whole figures intact", () => {
    const figs = ["1,500", "$ 6,335", "70 %", "$1.2M"];
    const { container } = render(
      <ChatBubble
        role="assistant"
        text="We had 1,500 visits, $ 6,335 in sales, a 70 % repeat rate and $1.2M in pipeline."
        figureReceipts={figs.map((figure) => ({ figure, kind: "catalog" as const, sourceSlug: "stripe", label: "x" }))}
      />,
    );
    const wrapped = within(container).getAllByTestId("figure");
    expect(wrapped.map((f) => f.textContent)).toEqual(figs);
    for (const w of wrapped) expect(w.className).toContain("whitespace-nowrap");
    expect(container.textContent).toContain("$1.2M in pipeline");
  });

  it("a proposed value is not bolded; a claim with the same digits is (2026-10-17 cgo reply)", () => {
    const { container } = render(
      <ChatBubble
        role="assistant"
        text={
          "**Recommended next action:** Cut Google Atlanta to $10 a day. Raise Meta Atlanta to **$50** a day. " +
          "Total spend stays at $60 a day, and the stop lines stay the same ($300 on Meta, $200 on Google). " +
          "At $50 a day, Meta hits $300 around Oct 21. Last week Meta spent $10 on tests."
        }
        figureReceipts={[{ figure: "$60", kind: "worked_out", source: "Worked out from pulled numbers", formula: "$60 = $40 + $20" }]}
        unverifiedFigures={["$300", "$200", "$10"]}
      />,
    );
    expect(within(container).getAllByTestId("figure").map((f) => f.textContent)).toEqual(["$60", "$300", "$200", "$10"]);
    noMarks(container);
  });
});
