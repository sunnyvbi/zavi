// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ReceiptChip, UnverifiedChip } from "./Receipts";
import type { ReceiptData } from "./receiptData";

afterEach(cleanup);

function openDrawer(chip: HTMLElement): HTMLElement {
  fireEvent.click(chip);
  return document.body.querySelector('[role="dialog"]') as HTMLElement;
}

describe("receipt drawer", () => {
  it("a catalog chip shows definition, time zone, currency and params", () => {
    const r: ReceiptData = {
      kind: "catalog",
      figure: "$41,380",
      source: "Stripe",
      sourceSlug: "stripe",
      label: "Net revenue",
      definition: "Charges minus refunds and fees.",
      window: { since: "2026-09-01", until: "2026-09-27" },
      tz: "America/Los_Angeles",
      currency: "USD",
      fetchedAt: "2026-09-28T16:12:00Z",
      params: [["grain", "day"]],
    };
    const { container } = render(<ReceiptChip r={r} />);
    const dialog = openDrawer(within(container).getByTestId("receipt-chip"));
    expect(dialog.textContent).toContain("How this number was worked out");
    expect(dialog.textContent).toContain("Charges minus refunds and fees.");
    expect(dialog.textContent).toContain("America/Los_Angeles");
    expect(dialog.textContent).toContain("USD");
    expect(dialog.textContent).toContain("grain:");
  });

  it("an exploratory chip shows the query", () => {
    const r: ReceiptData = { kind: "exploratory", figure: "1,587", sourceSlug: "operator_db", sql: ["select count(*) from bookings"] };
    const { container } = render(<ReceiptChip r={r} />);
    expect(within(container).getByTestId("receipt-chip").getAttribute("data-kind")).toBe("exploratory");
    openDrawer(within(container).getByTestId("receipt-chip"));
    expect(document.body.querySelector("pre")?.textContent).toContain("select count(*) from bookings");
  });

  it("an unverified chip explains that no source returned the number", () => {
    const { container } = render(<UnverifiedChip figure="$17,900" />);
    const dialog = openDrawer(within(container).getByTestId("unverified-chip"));
    expect(dialog.textContent).toContain("Why this number is marked");
    expect(dialog.textContent).toContain("No source returned this number");
  });

  it("an unverified compute shows its formula", () => {
    const { container } = render(
      <UnverifiedChip figure="37.93%" receipt={{ kind: "compute", figure: "37.93%", formula: "pct_change(30000, 41380) = 37.93" }} />,
    );
    const dialog = openDrawer(within(container).getByTestId("unverified-chip"));
    expect(dialog.textContent).toContain("Worked out from a number typed in");
    expect(dialog.textContent).toContain("pct_change(30000, 41380) = 37.93");
  });

  it("Escape closes the drawer", () => {
    const { container } = render(<UnverifiedChip figure="$1" />);
    openDrawer(within(container).getByTestId("unverified-chip"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
