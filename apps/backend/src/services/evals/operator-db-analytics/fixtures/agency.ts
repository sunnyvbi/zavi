
import { Rand, daysBefore } from "./rand";
import { table, type Dataset } from "./types";

export const AGENCY_ANCHOR = "2026-09-01T12:00:00.000Z";

const WORKDAY_MINUTES = 8 * 60;

export function buildAgency(): Dataset {
  const rand = new Rand(51501);
  const anchor = new Date(AGENCY_ANCHOR);

  const clients: Record<string, unknown>[] = [];
  for (let i = 1; i <= 40; i++) {
    const isInternal = i % 6 === 0;
    clients.push({
      id: i,
      name: isInternal ? `Kestrel Internal ${i}` : `Client ${i}`,
      created_at: daysBefore(anchor, rand.int(120, 900), rand.int(9, 18)),
      is_internal: isInternal,
      deleted_at: i % 19 === 0 ? daysBefore(anchor, rand.int(10, 200), 11) : null,
      industry: rand.pick(["retail", "fintech", "health", "media"]),
    });
  }

  const staff: Record<string, unknown>[] = [];
  for (let i = 1; i <= 26; i++) {
    const isContractor = i % 5 === 0;
    const hiredAt = daysBefore(anchor, rand.int(60, 1200), 9);
    const leftAt =
      i === 3
        ? new Date(Date.UTC(2026, 7, 8, 17, 0, 0))
        : i === 11
          ? new Date(Date.UTC(2026, 7, 19, 17, 0, 0))
          : i === 22
            ? new Date(Date.UTC(2026, 7, 27, 17, 0, 0))
            : null;
    staff.push({
      id: i,
      name: `Person ${i}`,
      hired_at: hiredAt,
      left_at: leftAt,
      is_contractor: isContractor,
      cost_rate_cents_per_hour: isContractor ? rand.int(6_500, 9_500) : rand.int(4_000, 7_000),
    });
  }

  const projects: Record<string, unknown>[] = [];
  for (let i = 1; i <= 60; i++) {
    const clientId = rand.int(1, 40);
    const billingType = rand.pick([
      "time_and_materials",
      "time_and_materials",
      "retainer",
      "fixed_fee",
    ]);
    const startedAt = daysBefore(anchor, rand.int(140, 400), 9);
    projects.push({
      id: i,
      client_id: clientId,
      name: `Project ${i}`,
      billing_type: billingType,
      fixed_fee_cents: billingType === "fixed_fee" ? rand.int(800_000, 6_000_000) : null,
      monthly_retainer_cents: billingType === "retainer" ? rand.int(300_000, 1_500_000) : null,
      started_at: startedAt,
      ended_at: i % 9 === 0 ? daysBefore(anchor, rand.int(1, 60), 17) : null,
    });
  }

  const internalClientIds = new Set(clients.filter((c) => c.is_internal === true).map((c) => c.id));

  const timeEntries: Record<string, unknown>[] = [];
  let teId = 1;
  for (let d = 0; d < 120; d++) {
    const workedOn = daysBefore(anchor, d, 12);
    const dow = workedOn.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const s of staff) {
      const left = s.left_at as Date | null;
      if (left && workedOn > left) continue;
      if ((s.hired_at as Date) > workedOn) continue;
      const entries = rand.int(2, 3);
      for (let k = 0; k < entries; k++) {
        const open = projects.filter(
          (pr) =>
            (pr.started_at as Date) <= workedOn &&
            (pr.ended_at === null || workedOn <= (pr.ended_at as Date)),
        );
        if (open.length === 0) continue;
        const openInternal = open.filter((pr) => internalClientIds.has(pr.client_id));
        const project =
          rand.chance(0.14) && openInternal.length > 0
            ? openInternal[rand.int(0, openInternal.length - 1)]
            : open[rand.int(0, open.length - 1)];
        const billable = rand.chance(0.72);
        timeEntries.push({
          id: teId++,
          project_id: project.id,
          staff_id: s.id,
          worked_on: workedOn,
          minutes: rand.pick([30, 45, 60, 90, 120, 150, 180, 240]),
          billable,
          billed_rate_cents_per_hour: billable ? rand.int(11_000, 26_000) : null,
        });
      }
    }
  }

  return {
    shape: "agency",
    business:
      "Kestrel is a B2B design and engineering agency. Staff log their time against client projects in " +
      "MINUTES. A project is billed one of three ways: time_and_materials (the logged billable time is " +
      "invoiced at that entry's rate), retainer (the client pays a flat monthly amount no matter how many " +
      "hours are logged), or fixed_fee (the client pays one agreed price for the whole project). Some staff " +
      "are contractors rather than employees. A standard working day is 8 hours and nobody logs on " +
      "weekends. Timestamps are stored in UTC and the team reports on a UTC calendar.",
    anchorIso: AGENCY_ANCHOR,
    timezone: "UTC",
    tables: [
      table(
        "clients",
        [
          { name: "id", type: "pk" },
          { name: "name", type: "text" },
          { name: "created_at", type: "timestamp" },
          { name: "is_internal", type: "bool" },
          { name: "deleted_at", type: "timestamp", nullable: true },
          { name: "industry", type: "text" },
        ],
        clients,
      ),
      table(
        "staff",
        [
          { name: "id", type: "pk" },
          { name: "name", type: "text" },
          { name: "hired_at", type: "timestamp" },
          { name: "left_at", type: "timestamp", nullable: true },
          { name: "is_contractor", type: "bool" },
          { name: "cost_rate_cents_per_hour", type: "bigint" },
        ],
        staff,
      ),
      table(
        "projects",
        [
          { name: "id", type: "pk" },
          { name: "client_id", type: "int" },
          { name: "name", type: "text" },
          { name: "billing_type", type: "text" },
          { name: "fixed_fee_cents", type: "bigint", nullable: true },
          { name: "monthly_retainer_cents", type: "bigint", nullable: true },
          { name: "started_at", type: "timestamp" },
          { name: "ended_at", type: "timestamp", nullable: true },
        ],
        projects,
      ),
      table(
        "time_entries",
        [
          { name: "id", type: "pk" },
          { name: "project_id", type: "int" },
          { name: "staff_id", type: "int" },
          { name: "worked_on", type: "timestamp" },
          { name: "minutes", type: "int" },
          { name: "billable", type: "bool" },
          { name: "billed_rate_cents_per_hour", type: "bigint", nullable: true },
        ],
        timeEntries,
      ),
    ],
  };
}

export const AGENCY_WORKDAY_MINUTES = WORKDAY_MINUTES;
