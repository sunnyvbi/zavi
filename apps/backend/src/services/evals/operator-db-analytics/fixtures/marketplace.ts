
import { Rand, daysBefore } from "./rand";
import { table, type Dataset } from "./types";

export const MARKETPLACE_ANCHOR = "2026-09-01T12:00:00.000Z";

export function buildMarketplace(): Dataset {
  const rand = new Rand(20260901);
  const anchor = new Date(MARKETPLACE_ANCHOR);

  const cities = ["Los Angeles", "San Diego", "Phoenix", "Austin", "Las Vegas"] as const;
  const categories = ["sedan", "suv", "truck", "luxury"] as const;

  const users: Record<string, unknown>[] = [];
  for (let i = 1; i <= 420; i++) {
    const isTest = i % 19 === 0;
    const createdDaysAgo = rand.int(1, 400);
    users.push({
      id: i,
      email: isTest ? `qa+${i}@wheelio-internal.test` : `user${i}@example.com`,
      created_at: daysBefore(anchor, createdDaysAgo, rand.int(0, 23), rand.int(0, 59)),
      is_test: isTest,
      deleted_at: i % 37 === 0 ? daysBefore(anchor, rand.int(1, 60), 12) : null,
      country: rand.pick(["US", "US", "US", "CA"]),
    });
  }

  const listings: Record<string, unknown>[] = [];
  for (let i = 1; i <= 180; i++) {
    const hostId = rand.int(1, 420);
    listings.push({
      id: i,
      host_id: hostId,
      city: rand.pick(cities),
      category: rand.pick(categories),
      created_at: daysBefore(anchor, rand.int(30, 420), rand.int(0, 23)),
      status: i % 11 === 0 ? "removed" : i % 7 === 0 ? "paused" : "active",
      deleted_at:
        i % 11 === 0 || i % 23 === 0 ? daysBefore(anchor, rand.int(1, 90), 9) : null,
    });
  }

  const bookings: Record<string, unknown>[] = [];
  const payments: Record<string, unknown>[] = [];
  const refunds: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let paymentId = 1;
  let refundId = 1;
  let eventId = 1;

  for (let i = 1; i <= 1500; i++) {
    const listing = listings[rand.int(0, listings.length - 1)];
    const guestId = rand.int(1, 420);
    const createdDaysAgo = rand.int(0, 199);
    const createdAt = daysBefore(anchor, createdDaysAgo, rand.int(0, 23), rand.int(0, 59));

    const roll = rand.next();
    const terminal = roll < 0.62 ? "completed" : roll < 0.82 ? "cancelled" : "pending";
    const upper = i % 3 === 0;
    const status = terminal === "pending" ? "pending" : upper ? terminal.toUpperCase() : terminal;

    const grossCents = rand.int(6_500, 148_000);

    bookings.push({
      id: i,
      listing_id: listing.id,
      guest_id: guestId,
      created_at: createdAt,
      start_date: new Date(createdAt.getTime() + rand.int(1, 21) * 86_400_000),
      status,
      gross_cents: grossCents,
      currency: "USD",
    });

    events.push({
      id: eventId++,
      booking_id: i,
      event: "created",
      at: createdAt,
    });

    if (terminal !== "pending") {
      const terminalAt = new Date(createdAt.getTime() + rand.int(1, 30) * 86_400_000);
      if (terminalAt <= anchor) {
        events.push({
          id: eventId++,
          booking_id: i,
          event: terminal === "completed" ? "completed" : "cancelled",
          at: terminalAt,
        });
      }

      if (terminal === "completed" && terminalAt <= anchor) {
        const deposit = Math.round(grossCents * 0.3);
        payments.push({
          id: paymentId++,
          booking_id: i,
          amount_cents: deposit,
          captured_at: createdAt,
        });
        payments.push({
          id: paymentId++,
          booking_id: i,
          amount_cents: grossCents - deposit,
          captured_at: terminalAt,
        });

        if (rand.chance(0.12)) {
          const refundedAt = new Date(terminalAt.getTime() + rand.int(1, 10) * 86_400_000);
          if (refundedAt <= anchor) {
            refunds.push({
              id: refundId++,
              booking_id: i,
              amount_cents: Math.round(grossCents * rand.pick([0.1, 0.25, 0.5])),
              refunded_at: refundedAt,
            });
          }
        }
      }
    }
  }

  const boundary: { atIso: string; inAugustLocal: boolean }[] = [
    { atIso: "2026-08-01T03:30:00.000Z", inAugustLocal: false },
    { atIso: "2026-08-01T06:59:00.000Z", inAugustLocal: false },
    { atIso: "2026-09-01T03:15:00.000Z", inAugustLocal: true },
    { atIso: "2026-09-01T06:45:00.000Z", inAugustLocal: true },
  ];
  for (const b of boundary) {
    const id = bookings.length + 1;
    const at = new Date(b.atIso);
    const createdAt = new Date(at.getTime() - 5 * 86_400_000);
    const grossCents = 100_000;
    bookings.push({
      id,
      listing_id: listings[id % listings.length].id,
      guest_id: 7,
      created_at: createdAt,
      start_date: at,
      status: "completed",
      gross_cents: grossCents,
      currency: "USD",
    });
    events.push({ id: eventId++, booking_id: id, event: "created", at: createdAt });
    events.push({ id: eventId++, booking_id: id, event: "completed", at });
    payments.push({ id: paymentId++, booking_id: id, amount_cents: 30_000, captured_at: createdAt });
    payments.push({ id: paymentId++, booking_id: id, amount_cents: 70_000, captured_at: at });
  }

  return {
    shape: "marketplace",
    business:
      "Wheelio is a peer-to-peer car rental marketplace. Hosts list cars; guests book them by the day. " +
      "Wheelio takes a cut of every completed booking. Money is settled to hosts after the trip ends. " +
      "Timestamps are stored in UTC; the team reports on a America/Los_Angeles calendar.",
    anchorIso: MARKETPLACE_ANCHOR,
    timezone: "America/Los_Angeles",
    tables: [
      table(
        "users",
        [
          { name: "id", type: "pk" },
          { name: "email", type: "text" },
          { name: "created_at", type: "timestamp" },
          { name: "is_test", type: "bool" },
          { name: "deleted_at", type: "timestamp", nullable: true },
          { name: "country", type: "text" },
        ],
        users,
      ),
      table(
        "listings",
        [
          { name: "id", type: "pk" },
          { name: "host_id", type: "int" },
          { name: "city", type: "text" },
          { name: "category", type: "text" },
          { name: "created_at", type: "timestamp" },
          { name: "status", type: "text" },
          { name: "deleted_at", type: "timestamp", nullable: true },
        ],
        listings,
      ),
      table(
        "bookings",
        [
          { name: "id", type: "pk" },
          { name: "listing_id", type: "int" },
          { name: "guest_id", type: "int" },
          { name: "created_at", type: "timestamp" },
          { name: "start_date", type: "timestamp", forwardLooking: true },
          { name: "status", type: "text" },
          { name: "gross_cents", type: "bigint" },
          { name: "currency", type: "text" },
        ],
        bookings,
      ),
      table(
        "booking_payments",
        [
          { name: "id", type: "pk" },
          { name: "booking_id", type: "int" },
          { name: "amount_cents", type: "bigint" },
          { name: "captured_at", type: "timestamp" },
        ],
        payments,
      ),
      table(
        "booking_refunds",
        [
          { name: "id", type: "pk" },
          { name: "booking_id", type: "int" },
          { name: "amount_cents", type: "bigint" },
          { name: "refunded_at", type: "timestamp" },
        ],
        refunds,
      ),
      table(
        "booking_events",
        [
          { name: "id", type: "pk" },
          { name: "booking_id", type: "int" },
          { name: "event", type: "text" },
          { name: "at", type: "timestamp" },
        ],
        events,
      ),
    ],
  };
}
