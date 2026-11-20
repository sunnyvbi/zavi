
import { Rand, daysBefore } from "./rand";
import { table, type Dataset } from "./types";

export const LOGISTICS_ANCHOR = "2026-09-01T12:00:00.000Z";

export function buildLogistics(): Dataset {
  const rand = new Rand(404404);
  const anchor = new Date(LOGISTICS_ANCHOR);

  const customers: Record<string, unknown>[] = [];
  for (let i = 1; i <= 120; i++) {
    customers.push({
      id: i,
      name: `Shipper ${i}`,
      created_at: daysBefore(anchor, rand.int(60, 800), 10),
      is_test: i % 29 === 0,
    });
  }

  const shipments: Record<string, unknown>[] = [];
  const scans: Record<string, unknown>[] = [];
  let scanId = 1;

  const scan = (shipmentId: number, event: string, at: Date, location: string) => {
    scans.push({ id: scanId++, shipment_id: shipmentId, event, scanned_at: at, location });
  };

  const cities = ["Newark", "Dallas", "Reno", "Tampa", "Columbus"] as const;

  for (let i = 1; i <= 900; i++) {
    const customerId = rand.int(1, 120);
    const createdAt = daysBefore(anchor, rand.int(0, 100), rand.int(6, 20));
    const serviceLevel = rand.pick(["ground", "two_day", "overnight"]);
    const promisedDays = serviceLevel === "overnight" ? 1 : serviceLevel === "two_day" ? 2 : 5;
    const promisedAt = new Date(createdAt.getTime() + promisedDays * 86_400_000);
    const carrier = rand.pick(["Halyard", "Halyard", "partner_regional"]);
    const origin = rand.pick(cities);

    const roll = rand.next();
    const inTransit = roll < 0.14;
    const late = rand.chance(0.24);
    const actualDays = promisedDays + (late ? rand.int(1, 6) : 0);
    const earlyBy = late ? 0 : rand.chance(0.85) ? rand.int(2, 20) * 3_600_000 : 0;
    const deliveredAt = new Date(createdAt.getTime() + actualDays * 86_400_000 - earlyBy);
    const delivered = !inTransit && deliveredAt <= anchor;

    shipments.push({
      id: i,
      customer_id: customerId,
      created_at: createdAt,
      promised_at: promisedAt,
      delivered_at: delivered ? deliveredAt : null,
      carrier,
      service_level: serviceLevel,
      origin_city: origin,
      status: delivered ? "delivered" : "in_transit",
    });

    scan(i, "picked_up", createdAt, origin);
    if (rand.chance(0.3)) scan(i, "picked_up", createdAt, origin);

    const midAt = new Date(createdAt.getTime() + 0.5 * promisedDays * 86_400_000);
    if (midAt <= anchor) {
      scan(i, "in_transit", midAt, rand.pick(cities));
      if (rand.chance(0.25)) scan(i, "in_transit", midAt, rand.pick(cities));
    }

    const oofdAt = new Date(deliveredAt.getTime() - 4 * 3_600_000);
    if (delivered && oofdAt <= anchor) {
      scan(i, i % 2 === 0 ? "out_for_delivery" : "with_courier", oofdAt, rand.pick(cities));
    }

    if (delivered) {
      scan(i, "delivered", deliveredAt, rand.pick(cities));
      if (rand.chance(0.04)) {
        const exAt = new Date(deliveredAt.getTime() + rand.int(1, 5) * 86_400_000);
        if (exAt <= anchor) scan(i, "exception", exAt, rand.pick(cities));
      }
    } else if (rand.chance(0.2)) {
      const exAt = new Date(createdAt.getTime() + rand.int(1, 4) * 86_400_000);
      if (exAt <= anchor) scan(i, "exception", exAt, rand.pick(cities));
    }
  }

  return {
    shape: "logistics",
    business:
      "Halyard is a parcel carrier. Every shipment is promised by a date (promised_at) and is on time when " +
      "it is delivered on or before that date. Some shipments are still in transit and have no delivery " +
      "date yet. Each physical step is recorded in the scans table — the carrier's push retries mean the " +
      "same step is sometimes recorded more than once, and older depots still send `with_courier` for what " +
      "newer ones call `out_for_delivery`. Some parcels are handed to a regional partner rather than " +
      "carried by Halyard. Timestamps are stored in UTC and the team reports on a UTC calendar.",
    anchorIso: LOGISTICS_ANCHOR,
    timezone: "UTC",
    tables: [
      table(
        "customers",
        [
          { name: "id", type: "pk" },
          { name: "name", type: "text" },
          { name: "created_at", type: "timestamp" },
          { name: "is_test", type: "bool" },
        ],
        customers,
      ),
      table(
        "shipments",
        [
          { name: "id", type: "pk" },
          { name: "customer_id", type: "int" },
          { name: "created_at", type: "timestamp" },
          { name: "promised_at", type: "timestamp", forwardLooking: true },
          { name: "delivered_at", type: "timestamp", nullable: true },
          { name: "carrier", type: "text" },
          { name: "service_level", type: "text" },
          { name: "origin_city", type: "text" },
          { name: "status", type: "text" },
        ],
        shipments,
      ),
      table(
        "scans",
        [
          { name: "id", type: "pk" },
          { name: "shipment_id", type: "int" },
          { name: "event", type: "text" },
          { name: "scanned_at", type: "timestamp" },
          { name: "location", type: "text" },
        ],
        scans,
      ),
    ],
  };
}
