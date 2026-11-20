import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: async () => ({ data: stored.rows, error: null }),
  };
  return { ...real, asTenantId: (t: string) => t, tenantClient: () => chain };
});

import { emailChannelMetrics, readEmailChannelMetrics } from "../channel-metrics";
import { listChannelMetrics } from "@/services/channels/channel-actions";
import type { SentEmailRow } from "../view";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-19T12:00:00Z");

const cell = (value: number | null) => ({ value, why: null });
const row = (o: { sent: number | null; finished_at: string | null; opens?: number | null; clicks?: number | null }): SentEmailRow =>
  ({
    finished_at: o.finished_at,
    people: { sent: o.sent, total: o.sent, stopped: false },
    opens: cell(o.opens ?? null),
    clicks: cell(o.clicks ?? null),
  }) as unknown as SentEmailRow;

describe("the email channel's People emailed tile", () => {
  it("is the sum of people sent across finished sends in the window, from the same rows as the results API", () => {
    const out = emailChannelMetrics(
      [
        row({ sent: 1, finished_at: "2026-10-19T09:00:00Z", opens: 1 }),
        row({ sent: 1, finished_at: "2026-10-18T09:00:00Z" }),
        row({ sent: 40, finished_at: null }),
        row({ sent: 500, finished_at: "2026-07-01T09:00:00Z", opens: 90 }),
      ],
      NOW,
    );
    expect(out.find((m) => m.key === "recipients")).toMatchObject({ value: 2, grounded: true, day: "2026-10-19", window_kind: "point" });
    expect(out.find((m) => m.key === "opens")).toMatchObject({ value: 1 });
    expect(out.find((m) => m.key === "clicks")).toBeUndefined();
  });

  it("no finished send: no tile is invented", () => {
    expect(emailChannelMetrics([row({ sent: 3, finished_at: null })], NOW)).toEqual([]);
  });

  it("reads the Sent emails rows the results API serves", async () => {
    const list = vi.fn(async () => [row({ sent: 2, finished_at: "2026-10-19T09:00:00Z" })]);
    expect(await readEmailChannelMetrics(T, NOW, list as never)).toEqual([expect.objectContaining({ key: "recipients", value: 2 })]);
    expect(list).toHaveBeenCalledWith(T, 200);
  });

  it("the channel metrics read puts the real count in place of a missing or model-written one, for email only", async () => {
    stored.rows = [
      { metric_key: "recipients", value: 7, unit: null, window_kind: "point", day: "2026-10-17", grounded: false },
      { metric_key: "open_rate", value: 0.4, unit: "ratio", window_kind: "point", day: "2026-10-17", grounded: false },
    ];
    const real = async () => emailChannelMetrics([row({ sent: 1, finished_at: "2026-10-19T09:00:00Z" }), row({ sent: 1, finished_at: "2026-10-18T09:00:00Z" })], NOW);
    const email = await listChannelMetrics(T, "email_marketing", NOW, real);
    expect(email.filter((m) => m.key === "recipients")).toEqual([expect.objectContaining({ value: 2, grounded: true })]);
    expect(email.find((m) => m.key === "open_rate")).toMatchObject({ value: 0.4 });

    stored.rows = [];
    expect((await listChannelMetrics(T, "email_marketing", NOW, real)).map((m) => [m.key, m.value])).toEqual([["recipients", 2]]);

    const other = vi.fn(real);
    stored.rows = [{ metric_key: "recipients", value: 7, unit: null, window_kind: "point", day: "2026-10-17", grounded: false }];
    expect((await listChannelMetrics(T, "sms", NOW, other)).map((m) => [m.key, m.value])).toEqual([["recipients", 7]]);
    expect(other).not.toHaveBeenCalled();
  });

  it("a results read that fails leaves the stored tiles as they were", async () => {
    stored.rows = [{ metric_key: "recipients", value: 7, unit: null, window_kind: "point", day: "2026-10-17", grounded: false }];
    const down = async () => {
      throw new Error("down");
    };
    expect((await listChannelMetrics(T, "email_marketing", NOW, down)).map((m) => [m.key, m.value])).toEqual([["recipients", 7]]);
  });
});
