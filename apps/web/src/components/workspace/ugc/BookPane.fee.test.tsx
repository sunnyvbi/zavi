// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./useCards", async (orig) => ({
  ...(await orig<typeof import("./useCards")>()),
  useCreatorCards: () => ({
    m1: {
      packages: [
        { id: "p1", kind: "ugc_video", title: "1 UGC video, 30 seconds", price_cents: 15_000, business_total_cents: 16_500, video_length_seconds: 30, ad_rights_days: 90, delivery_days: 7 },
      ],
    },
  }),
}));

import { BookPane } from "./CreatorHiringCards";

afterEach(cleanup);

describe("the book card says what the button price is made of", () => {
  it("shows the creator's price, the Zavi fee on its own line, and a button total that adds up", () => {
    render(<BookPane creators={[{ human_member_id: "m1", display_name: "Mohit Dudhat", location: { city: null }, from_price_cents: 15_000 } as never]} />);
    const card = screen.getByText("Mohit Dudhat").closest("li") as HTMLElement;
    expect(card.textContent).toContain("$150");
    expect(within(card).getByTestId("book-fee-line").textContent).toBe("+ $15 Zavi fee (10%)");
    expect(within(card).getByRole("button").textContent).toBe("Book for $165");
  });
});
