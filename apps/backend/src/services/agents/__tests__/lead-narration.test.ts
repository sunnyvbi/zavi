
import { describe, it, expect } from "vitest";
import { isProgressNarration, stripLeadNarration } from "@/services/agents/lead-narration";
import { selectChatReplyText } from "@/services/agents/chat-reply-text";

describe("stripLeadNarration", () => {
  it("drops the prod opener and keeps the answer", () => {
    const body = "Numbers are in. Writing up the read now.\n\n**Red on revenue.** Fee income fell 10% last week.";
    expect(stripLeadNarration(body)).toEqual({
      text: "**Red on revenue.** Fee income fell 10% last week.",
      stripped: true,
    });
  });

  it("drops two narration paragraphs in a row", () => {
    const body = "Let me pull the numbers.\n\nNow I have the full picture.\n\nSignups fell after the price change.";
    expect(stripLeadNarration(body).text).toBe("Signups fell after the price change.");
  });

  it.each([
    "Revenue fell 12% last week.",
    "Revenue fell sharply last week.",
    "Short answer: no.",
    "Done. Your campaign is paused.",
    "I checked and the pixel is broken.",
    "I checked the database, nothing matched.",
    "I checked the database.",
    "I looked at the funnel; zero signups came through.",
    "Let me check: no orders came in.",
    "Checking the inbox turned up nothing now.",
    "I pulled the ad that was losing money.",
    "Pausing the Meta campaign now.",
    "Putting the budget up now.",
    "Want me to draft it?",
    "Here's the email.",
  ])("keeps a real opener: %s", (first) => {
    const body = `${first}\n\nMore detail follows here.`;
    expect(stripLeadNarration(body)).toEqual({ text: body, stripped: false });
  });

  it("keeps a reply that is only narration (nothing to lead with instead)", () => {
    expect(stripLeadNarration("Pulling the numbers now.").stripped).toBe(false);
    expect(stripLeadNarration("Numbers are in.\n\n   ").stripped).toBe(false);
  });

  it("keeps a multi-line first paragraph", () => {
    const body = "Numbers are in.\nRevenue is down.\n\nDetail.";
    expect(stripLeadNarration(body).stripped).toBe(false);
  });

  it("judges bold narration by its words", () => {
    expect(isProgressNarration("**Numbers are in.**")).toBe(true);
    expect(isProgressNarration("**Bookings are in decline.**")).toBe(false);
  });

  it("is applied by the chat reply selector, with a meta flag", () => {
    const sel = selectChatReplyText({
      result: { output_text: "Numbers are in.\n\nBookings rose 4%.", parsed: null, parse_ok: true },
      agentSlug: "cgo",
    });
    expect(sel.text).toBe("Bookings rose 4%.");
    expect(sel.meta.lead_narration_removed).toBe(true);
  });
});
