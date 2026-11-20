import { describe, expect, it } from "vitest";
import { briefMentionsBooking } from "../booking-signal";

describe("briefMentionsBooking: a brief that asks for online booking, not one that only mentions the word", () => {
  it.each([
    "A barber shop where customers book an appointment online",
    "Dog groomer with online booking and a price list",
    "Yoga studio: book a class, see the timetable",
    "Restaurant site with table reservations and the menu",
    "No parking on site, but clients can book appointments online",
    "Walk-ins welcome. Online bookings open every Monday",
    "Salon with appointments",
  ])("asks for booking: %s", (brief) => {
    expect(briefMentionsBooking(brief)).toBe(true);
  });

  it.each([
    "Walk-in barber, no appointments",
    "A bakery with no bookings, just the menu and opening hours",
    "Coffee shop, walk-ins only, no reservations needed",
    "Florist landing page. Call us for reservations",
    "Pizza place: phone us to make a reservation",
    "Corner shop that does not take bookings",
    "Tattoo studio without appointments",
    "",
  ])("does not ask for booking: %s", (brief) => {
    expect(briefMentionsBooking(brief)).toBe(false);
  });

  it("is not stateful between calls", () => {
    const brief = "Spa with online booking";
    expect(briefMentionsBooking(brief)).toBe(true);
    expect(briefMentionsBooking(brief)).toBe(true);
    expect(briefMentionsBooking(null)).toBe(false);
  });
});
