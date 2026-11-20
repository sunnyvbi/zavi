
import { Rand, daysBefore } from "./rand";
import { table, type Dataset } from "./types";

export const SAAS_ANCHOR = "2026-09-01T00:00:00.000Z";

type Evt = {
  id: number;
  account_id: number;
  type: string;
  at: Date;
  mrr_delta_cents: number;
};

export function buildSaas(): Dataset {
  const rand = new Rand(777001);
  const anchor = new Date(SAAS_ANCHOR);

  const plans = [
    { name: "starter", mrr: 4_900 },
    { name: "team", mrr: 19_900 },
    { name: "business", mrr: 49_900 },
    { name: "enterprise", mrr: 199_900 },
  ] as const;

  const accounts: Record<string, unknown>[] = [];
  const subscriptions: Record<string, unknown>[] = [];
  const events: Evt[] = [];
  const invoices: Record<string, unknown>[] = [];
  const seats: Record<string, unknown>[] = [];
  let evtId = 1;
  let invId = 1;
  let seatId = 1;

  for (let i = 1; i <= 260; i++) {
    const isInternal = i % 23 === 0;
    const signedUpDaysAgo = rand.int(20, 700);
    const createdAt = daysBefore(anchor, signedUpDaysAgo, rand.int(8, 20));
    const softDeleted = i % 41 === 0;

    accounts.push({
      id: i,
      name: isInternal ? `Ledgerly Internal ${i}` : `Account ${i}`,
      domain: isInternal ? "ledgerly.internal" : `acct${i}.example.com`,
      created_at: createdAt,
      is_internal: isInternal,
      deleted_at: softDeleted ? daysBefore(anchor, rand.int(1, 120), 10) : null,
      industry: rand.pick(["retail", "agency", "manufacturing", "services"]),
    });

    for (let s = 1; s <= rand.int(1, 6); s++) {
      seats.push({
        id: seatId++,
        account_id: i,
        user_email: `u${seatId}@acct${i}.example.com`,
        created_at: createdAt,
        last_seen_at: rand.chance(0.7) ? daysBefore(anchor, rand.int(0, 45), 15) : null,
      });
    }

    if (rand.chance(0.18)) continue;

    const plan = plans[rand.int(0, plans.length - 1)];
    const daysToConvert = rand.chance(0.22) ? rand.int(35, 160) : rand.int(3, 21);
    const startedAt = new Date(createdAt.getTime() + daysToConvert * 86_400_000);
    if (startedAt > anchor) continue;

    let currentMrr = plan.mrr;
    let currentPlan: string = plan.name;
    let canceledAt: Date | null = null;
    let status = "active";

    events.push({
      id: evtId++,
      account_id: i,
      type: "start",
      at: startedAt,
      mrr_delta_cents: plan.mrr,
    });

    if (rand.chance(0.3)) {
      const changeAt = new Date(startedAt.getTime() + rand.int(30, 300) * 86_400_000);
      if (changeAt <= anchor) {
        const newPlan = plans[rand.int(0, plans.length - 1)];
        if (newPlan.mrr !== currentMrr) {
          events.push({
            id: evtId++,
            account_id: i,
            type: newPlan.mrr > currentMrr ? "upgrade" : "downgrade",
            at: changeAt,
            mrr_delta_cents: newPlan.mrr - currentMrr,
          });
          currentMrr = newPlan.mrr;
          currentPlan = newPlan.name;
        }
      }
    }

    if (rand.chance(0.26)) {
      const churnAt = new Date(startedAt.getTime() + rand.int(45, 420) * 86_400_000);
      if (churnAt <= anchor) {
        events.push({
          id: evtId++,
          account_id: i,
          type: "cancel",
          at: churnAt,
          mrr_delta_cents: -currentMrr,
        });
        canceledAt = churnAt;
        status = "canceled";

        if (rand.chance(0.35)) {
          const backAt = new Date(churnAt.getTime() + rand.int(10, 90) * 86_400_000);
          if (backAt <= anchor) {
            events.push({
              id: evtId++,
              account_id: i,
              type: "reactivate",
              at: backAt,
              mrr_delta_cents: currentMrr,
            });
            canceledAt = null;
            status = "active";
          }
        }
      }
    }

    subscriptions.push({
      id: i,
      account_id: i,
      plan: currentPlan,
      mrr_cents: currentMrr,
      status,
      started_at: startedAt,
      canceled_at: canceledAt,
    });

    let cursor = new Date(startedAt.getTime());
    while (cursor <= anchor) {
      const voided = rand.chance(0.06);
      const paidThenVoided = voided && rand.chance(0.34);
      const issued = new Date(cursor.getTime());
      const paidAt = new Date(issued.getTime() + rand.int(0, 6) * 86_400_000);
      const voidedAt = new Date(paidAt.getTime() + 3 * 86_400_000);
      const paidYet = paidAt <= anchor;
      const voidedYet = voidedAt <= anchor;
      invoices.push({
        id: invId++,
        account_id: i,
        amount_cents: currentMrr,
        currency: "USD",
        issued_at: issued,
        paid_at: (voided && !paidThenVoided) || !paidYet ? null : paidAt,
        voided_at: voided && voidedYet ? voidedAt : null,
      });
      cursor = new Date(cursor.getTime() + 30 * 86_400_000);
      if (canceledAt && cursor > canceledAt) break;
    }
  }

  const scripted: {
    id: number;
    plan: (typeof plans)[number];
    startDaysBeforeAug: number;
    cancelDay: number | null;
    winBackDay: number | null;
    upgradeTo: (typeof plans)[number] | null;
  }[] = [
    { id: 901, plan: plans[1], startDaysBeforeAug: 200, cancelDay: 4, winBackDay: 19, upgradeTo: null },
    { id: 902, plan: plans[2], startDaysBeforeAug: 160, cancelDay: 9, winBackDay: 24, upgradeTo: null },
    { id: 903, plan: plans[0], startDaysBeforeAug: 120, cancelDay: 14, winBackDay: null, upgradeTo: null },
    { id: 904, plan: plans[3], startDaysBeforeAug: 300, cancelDay: 21, winBackDay: null, upgradeTo: null },
    { id: 905, plan: plans[0], startDaysBeforeAug: 90, cancelDay: null, winBackDay: null, upgradeTo: plans[2] },
    { id: 906, plan: plans[1], startDaysBeforeAug: 75, cancelDay: null, winBackDay: null, upgradeTo: plans[0] },
  ];
  const AUG = (day: number, hour = 12) => new Date(Date.UTC(2026, 7, day, hour, 0, 0));

  for (const sc of scripted) {
    const startedAt = new Date(Date.UTC(2026, 7, 1) - sc.startDaysBeforeAug * 86_400_000);
    accounts.push({
      id: sc.id,
      name: `Account ${sc.id}`,
      domain: `acct${sc.id}.example.com`,
      created_at: new Date(startedAt.getTime() - 5 * 86_400_000),
      is_internal: false,
      deleted_at: null,
      industry: "services",
    });

    let mrr = sc.plan.mrr;
    let planName: string = sc.plan.name;
    let status = "active";
    let canceledAt: Date | null = null;

    events.push({ id: evtId++, account_id: sc.id, type: "start", at: startedAt, mrr_delta_cents: mrr });

    if (sc.upgradeTo) {
      const at = AUG(6);
      events.push({
        id: evtId++,
        account_id: sc.id,
        type: sc.upgradeTo.mrr > mrr ? "upgrade" : "downgrade",
        at,
        mrr_delta_cents: sc.upgradeTo.mrr - mrr,
      });
      mrr = sc.upgradeTo.mrr;
      planName = sc.upgradeTo.name;
    }

    if (sc.cancelDay !== null) {
      events.push({
        id: evtId++,
        account_id: sc.id,
        type: "cancel",
        at: AUG(sc.cancelDay),
        mrr_delta_cents: -mrr,
      });
      status = "canceled";
      canceledAt = AUG(sc.cancelDay);

      if (sc.winBackDay !== null) {
        events.push({
          id: evtId++,
          account_id: sc.id,
          type: "reactivate",
          at: AUG(sc.winBackDay),
          mrr_delta_cents: mrr,
        });
        status = "active";
        canceledAt = null;
      }
    }

    subscriptions.push({
      id: sc.id,
      account_id: sc.id,
      plan: planName,
      mrr_cents: mrr,
      status,
      started_at: startedAt,
      canceled_at: canceledAt,
    });

    invoices.push({
      id: invId++,
      account_id: sc.id,
      amount_cents: mrr,
      currency: "USD",
      issued_at: AUG(2, 9),
      paid_at: AUG(3, 9),
      voided_at: null,
    });
  }

  return {
    shape: "saas",
    business:
      "Ledgerly is a B2B SaaS accounting product sold on monthly subscriptions. Accounts sign up, trial, " +
      "then subscribe to one of four plans. Accounts can upgrade, downgrade, cancel, and be won back. " +
      "Revenue is recurring (MRR); invoices are issued monthly and occasionally voided. " +
      "Timestamps are stored in UTC and the team reports on a UTC calendar.",
    anchorIso: SAAS_ANCHOR,
    timezone: "UTC",
    tables: [
      table(
        "accounts",
        [
          { name: "id", type: "pk" },
          { name: "name", type: "text" },
          { name: "domain", type: "text" },
          { name: "created_at", type: "timestamp" },
          { name: "is_internal", type: "bool" },
          { name: "deleted_at", type: "timestamp", nullable: true },
          { name: "industry", type: "text" },
        ],
        accounts,
      ),
      table(
        "subscriptions",
        [
          { name: "id", type: "pk" },
          { name: "account_id", type: "int" },
          { name: "plan", type: "text" },
          { name: "mrr_cents", type: "bigint" },
          { name: "status", type: "text" },
          { name: "started_at", type: "timestamp" },
          { name: "canceled_at", type: "timestamp", nullable: true },
        ],
        subscriptions,
      ),
      table(
        "subscription_events",
        [
          { name: "id", type: "pk" },
          { name: "account_id", type: "int" },
          { name: "type", type: "text" },
          { name: "at", type: "timestamp" },
          { name: "mrr_delta_cents", type: "bigint" },
        ],
        events as unknown as Record<string, unknown>[],
      ),
      table(
        "invoices",
        [
          { name: "id", type: "pk" },
          { name: "account_id", type: "int" },
          { name: "amount_cents", type: "bigint" },
          { name: "currency", type: "text" },
          { name: "issued_at", type: "timestamp" },
          { name: "paid_at", type: "timestamp", nullable: true },
          { name: "voided_at", type: "timestamp", nullable: true },
        ],
        invoices,
      ),
      table(
        "account_seats",
        [
          { name: "id", type: "pk" },
          { name: "account_id", type: "int" },
          { name: "user_email", type: "text" },
          { name: "created_at", type: "timestamp" },
          { name: "last_seen_at", type: "timestamp", nullable: true },
        ],
        seats,
      ),
    ],
  };
}
