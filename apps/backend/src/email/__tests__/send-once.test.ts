
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ globalClient: () => { throw new Error("use the fake"); } }));

import { sendOnce, SendInFlightError, IN_FLIGHT_STALE_MS } from "../send-once";
import { EmailNotSentError } from "@/services/onboarding-emails/send-errors";

type Row = { dedupe_key: string; claimed_at: string; sent_at: string | null };

function fakeLedger() {
  const rows = new Map<string, Row>();
  const filtered = (onRun: (hit: Row[]) => void) => {
    const filters: Array<(r: Row) => boolean> = [];
    const b = {
      eq(c: keyof Row, v: string) { filters.push((r) => r[c] === v); return b; },
      is(c: keyof Row, v: null) { filters.push((r) => r[c] === v); return b; },
      then(res: (v: { error: null }) => void) {
        onRun([...rows.values()].filter((r) => filters.every((f) => f(r))));
        res({ error: null });
      },
    };
    return b;
  };
  const client = {
    from() {
      return {
        upsert(row: Row) {
          return {
            select: async () => {
              if (rows.has(row.dedupe_key)) return { data: [], error: null };
              rows.set(row.dedupe_key, { ...row });
              return { data: [{ dedupe_key: row.dedupe_key }], error: null };
            },
          };
        },
        select() {
          return {
            eq(_c: string, v: string) {
              return { maybeSingle: async () => ({ data: rows.get(v) ?? null, error: null }) };
            },
          };
        },
        update: (patch: Partial<Row>) => filtered((hit) => hit.forEach((r) => Object.assign(r, patch))),
        delete: () => filtered((hit) => hit.forEach((r) => rows.delete(r.dedupe_key))),
      };
    },
  };
  return { rows, client: client as never };
}

const sgRejection = () => Object.assign(new Error("Bad Request"), { code: 400, response: { body: {} } });

describe("sendOnce", () => {
  it("sends the first time and never again for the same key (Stripe retries the same invoice)", async () => {
    const { rows, client } = fakeLedger();
    const send = vi.fn(async () => {});
    expect(await sendOnce("payment_failed:in_1", send, { client })).toBe("sent");
    expect(await sendOnce("payment_failed:in_1", send, { client })).toBe("already_sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows.get("payment_failed:in_1")?.sent_at).toBeTruthy();
  });

  it("a different key is a different email", async () => {
    const { client } = fakeLedger();
    const send = vi.fn(async () => {});
    await sendOnce("payment_failed:in_1", send, { client });
    await sendOnce("payment_failed:in_2", send, { client });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a definite SendGrid rejection gives the claim back and rethrows, so the next trigger retries", async () => {
    const { rows, client } = fakeLedger();
    await expect(sendOnce("k", async () => { throw sgRejection(); }, { client })).rejects.toThrow("Bad Request");
    expect(rows.has("k")).toBe(false);
    const send = vi.fn(async () => {});
    expect(await sendOnce("k", send, { client })).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a failure before any network call (EmailNotSentError) is definite too", async () => {
    const { rows, client } = fakeLedger();
    await expect(sendOnce("k", async () => { throw new EmailNotSentError("render"); }, { client })).rejects.toThrow("render");
    expect(rows.has("k")).toBe(false);
  });

  it("a timeout is ambiguous: the claim is kept and nothing is ever sent twice", async () => {
    const { rows, client } = fakeLedger();
    const warn = vi.fn();
    expect(await sendOnce("k", async () => { throw new Error("ETIMEDOUT"); }, { client, warn })).toBe("uncertain");
    expect(rows.has("k")).toBe(true);
    expect(warn).toHaveBeenCalled();
    const send = vi.fn(async () => {});
    expect(await sendOnce("k", send, { client })).toBe("already_sent");
    expect(send).not.toHaveBeenCalled();
  });

  it("losing the claim to a send still in flight throws (a racing Stripe redelivery must not record the event)", async () => {
    const { rows, client } = fakeLedger();
    rows.set("k", { dedupe_key: "k", claimed_at: new Date().toISOString(), sent_at: null });
    const send = vi.fn(async () => {});
    await expect(sendOnce("k", send, { client })).rejects.toBeInstanceOf(SendInFlightError);
    expect(send).not.toHaveBeenCalled();
  });

  it("a claim left unsent past the stale window (dead worker) counts as sent", async () => {
    const { rows, client } = fakeLedger();
    const now = new Date("2026-11-01T12:00:00Z");
    rows.set("k", { dedupe_key: "k", claimed_at: new Date(now.getTime() - IN_FLIGHT_STALE_MS).toISOString(), sent_at: null });
    const send = vi.fn(async () => {});
    expect(await sendOnce("k", send, { client, now: () => now })).toBe("already_sent");
    expect(send).not.toHaveBeenCalled();
  });

  it("an ambiguous failure stamps sent_at, so later callers answer already_sent instead of waiting", async () => {
    const { rows, client } = fakeLedger();
    await sendOnce("k", async () => { throw new Error("ECONNRESET"); }, { client, warn: () => {} });
    expect(rows.get("k")?.sent_at).toBeTruthy();
  });

  it("releaseOnAnyError gives the claim back on a network error too (the ops page has its own guard)", async () => {
    const { rows, client } = fakeLedger();
    await expect(
      sendOnce("k", async () => { throw new Error("ECONNREFUSED"); }, { client, releaseOnAnyError: true }),
    ).rejects.toThrow("ECONNREFUSED");
    expect(rows.has("k")).toBe(false);
  });
});
