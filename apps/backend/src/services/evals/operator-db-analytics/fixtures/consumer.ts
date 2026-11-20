
import { Rand, daysBefore } from "./rand";
import { table, type Dataset } from "./types";

export const CONSUMER_ANCHOR = "2026-09-01T00:00:00.000Z";

export function buildConsumer(): Dataset {
  const rand = new Rand(909090);
  const anchor = new Date(CONSUMER_ANCHOR);

  const users: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let eventId = 1;

  const push = (userId: number, name: string, at: Date, props: unknown = {}) => {
    events.push({ id: eventId++, user_id: userId, name, at, props: JSON.stringify(props) });
  };

  for (let i = 1; i <= 900; i++) {
    const signedUpDaysAgo = rand.int(0, 179);
    const signedUpAt = daysBefore(anchor, signedUpDaysAgo, rand.int(0, 23), rand.int(0, 59));
    const platform = rand.pick(["ios", "android", "web"]);
    const channel = rand.pick(["organic", "paid_social", "referral", "seo"]);

    users.push({
      id: i,
      signed_up_at: signedUpAt,
      platform,
      acquisition_channel: channel,
      country: rand.pick(["US", "US", "GB", "IN", "BR"]),
    });

    if (rand.chance(0.09)) continue;

    push(i, "app_opened", signedUpAt, { platform });
    const opens = rand.int(1, 12);
    for (let k = 0; k < opens; k++) {
      const at = new Date(
        signedUpAt.getTime() + rand.int(0, Math.min(14, signedUpDaysAgo + 1)) * 86_400_000,
      );
      if (at <= anchor) push(i, "app_opened", at, { platform });
    }

    const activated = rand.chance(0.55);
    if (activated) {
      const at = new Date(signedUpAt.getTime() + rand.int(0, 3) * 86_400_000);
      if (at <= anchor) push(i, "habit_created", at, { habit_kind: rand.pick(["water", "walk", "read"]) });
    }

    const startedCheckout = activated && rand.chance(0.4);
    if (startedCheckout) {
      const at = new Date(signedUpAt.getTime() + rand.int(1, 20) * 86_400_000);
      if (at <= anchor) {
        push(i, i % 2 === 0 ? "checkout_started" : "begin_checkout", at, { plan: "pro" });
        if (rand.chance(0.3)) push(i, i % 2 === 0 ? "checkout_started" : "begin_checkout", at, { plan: "pro" });
      }
    }

    const subscribed = startedCheckout && rand.chance(0.45);
    if (subscribed) {
      const at = new Date(signedUpAt.getTime() + rand.int(1, 25) * 86_400_000);
      if (at <= anchor) push(i, "subscription_started", at, { plan: "pro", price_cents: 999 });
    }

    if (signedUpDaysAgo >= 30 && rand.chance(0.38)) {
      const at = new Date(signedUpAt.getTime() + rand.int(30, 44) * 86_400_000);
      if (at <= anchor) push(i, "app_opened", at, { platform });
    }
  }

  return {
    shape: "consumer",
    business:
      "Pulse is a consumer habit-tracking mobile app with a paid Pro tier. Everything the product does is " +
      "written to one append-only `app_events` table: app_opened, habit_created, checkout_started (older " +
      "clients still send begin_checkout for the same step), and subscription_started. " +
      "Timestamps are stored in UTC and the team reports on a UTC calendar.",
    anchorIso: CONSUMER_ANCHOR,
    timezone: "UTC",
    tables: [
      table(
        "app_users",
        [
          { name: "id", type: "pk" },
          { name: "signed_up_at", type: "timestamp" },
          { name: "platform", type: "text" },
          { name: "acquisition_channel", type: "text" },
          { name: "country", type: "text" },
        ],
        users,
      ),
      table(
        "app_events",
        [
          { name: "id", type: "pk" },
          { name: "user_id", type: "int" },
          { name: "name", type: "text" },
          { name: "at", type: "timestamp" },
          { name: "props", type: "json" },
        ],
        events,
      ),
    ],
  };
}
