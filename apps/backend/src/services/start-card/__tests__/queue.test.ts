
import { describe, it, expect, vi, type Mock } from "vitest";

vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
vi.mock("../store", () => ({
  attachQueueRowToCard: vi.fn(),
  claimCard: vi.fn(),
  findRecentCardForDomain: vi.fn(),
  listCardsAwaitingEmail: vi.fn(),
  listConfirmedQueueRows: vi.fn(),
  purgeStaleQueueRows: vi.fn(),
}));
vi.mock("../budget", () => ({ reserveCardBudget: vi.fn(), releaseCardBudget: vi.fn() }));
vi.mock("../pipeline", () => ({ cancelCard: vi.fn(), sendQueuedCardEmails: vi.fn() }));

import { createAndStartCard, drainQueue, type DrainDeps } from "../queue";

const RES = { day: "2026-10-01", amount: 1 };
const INPUT = { domain: "acme.com", ip_hash: null, referrer_card_id: null };

describe("createAndStartCard", () => {
  it("a failed insert releases the reservation", async () => {
    const deps = {
      claim: vi.fn(async () => {
        throw new Error("insert failed");
      }),
      enqueue: vi.fn(),
      release: vi.fn(async () => undefined),
      fail: vi.fn(),
    };
    await expect(createAndStartCard(INPUT, RES, deps)).rejects.toThrow("insert failed");
    expect(deps.release).toHaveBeenCalledWith("2026-10-01", 1);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("a failed enqueue fails the card (which releases), and does not double-release", async () => {
    const deps = {
      claim: vi.fn(async () => ({ outcome: "created" as const, id: "c1", public_id: "P", status: "running" as const })),
      enqueue: vi.fn(async () => {
        throw new Error("inngest down");
      }),
      release: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    await expect(createAndStartCard(INPUT, RES, deps)).rejects.toThrow("inngest down");
    expect(deps.fail).toHaveBeenCalledWith("c1", "enqueue_failed");
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("the claim is keyed by the domain and the 24h window, as a public card", async () => {
    const deps = {
      claim: vi.fn(async () => ({ outcome: "created" as const, id: "c1", public_id: "P", status: "running" as const })),
      enqueue: vi.fn(async () => undefined),
      release: vi.fn(),
      fail: vi.fn(),
    };
    const r = await createAndStartCard(INPUT, RES, deps, new Date("2026-10-02T12:00:00Z"));
    expect(r).toEqual({ id: "c1", public_id: "P", reused: false });
    expect(deps.claim).toHaveBeenCalledWith({
      domain: "acme.com",
      since_iso: "2026-10-01T12:00:00.000Z",
      funding: { kind: "public_budget", budget_day: "2026-10-01", reserved_usd: 1, ip_hash: null, referrer_card_id: null },
    });
    expect(deps.enqueue).toHaveBeenCalledWith("c1");
  });

  it("stores the visitor's country on the new card before its worker starts", async () => {
    const order: string[] = [];
    const deps = {
      claim: vi.fn(async () => ({ outcome: "created" as const, id: "c1", public_id: "P", status: "running" as const })),
      enqueue: vi.fn(async () => {
        order.push("enqueue");
      }),
      release: vi.fn(),
      fail: vi.fn(),
      locate: vi.fn(async () => {
        order.push("locate");
      }),
    };
    await createAndStartCard({ ...INPUT, visitor_country: "IN" }, RES, deps);
    expect(deps.locate).toHaveBeenCalledWith("c1", "IN");
    expect(order).toEqual(["locate", "enqueue"]);
  });

  it("a failed country write still starts the card, checked from the default", async () => {
    const deps = {
      claim: vi.fn(async () => ({ outcome: "created" as const, id: "c1", public_id: "P", status: "running" as const })),
      enqueue: vi.fn(async () => undefined),
      release: vi.fn(),
      fail: vi.fn(),
      locate: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    await expect(createAndStartCard({ ...INPUT, visitor_country: "IN" }, RES, deps)).resolves.toMatchObject({ reused: false });
    expect(deps.enqueue).toHaveBeenCalledWith("c1");
  });

  it("a reused card keeps its own country", async () => {
    const deps = {
      claim: vi.fn(async () => ({ outcome: "reused" as const, id: "other", public_id: "OTHER", status: "running" as const })),
      enqueue: vi.fn(),
      release: vi.fn(async () => undefined),
      fail: vi.fn(),
      locate: vi.fn(),
    };
    await createAndStartCard({ ...INPUT, visitor_country: "IN" }, RES, deps);
    expect(deps.locate).not.toHaveBeenCalled();
  });

  it("a parallel request that already made this domain's card wins: reused, reservation released, nothing enqueued", async () => {
    const deps = {
      claim: vi.fn(async () => ({ outcome: "reused" as const, id: "other", public_id: "OTHER", status: "running" as const })),
      enqueue: vi.fn(),
      release: vi.fn(async () => undefined),
      fail: vi.fn(),
    };
    const r = await createAndStartCard(INPUT, RES, deps);
    expect(r).toEqual({ id: "other", public_id: "OTHER", reused: true });
    expect(deps.release).toHaveBeenCalledWith("2026-10-01", 1);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});

type MockedDeps = DrainDeps & { [K in keyof DrainDeps]: Mock };

function mkDeps(over: Partial<Record<keyof DrainDeps, unknown>>): MockedDeps {
  return {
    listConfirmed: vi.fn(async () => []),
    listAwaitingEmail: vi.fn(async () => []),
    findRecent: vi.fn(async () => null),
    reserve: vi.fn(async () => ({ ok: true as const, ...RES })),
    start: vi.fn(async () => ({ id: "card", public_id: "P", reused: false })),
    attach: vi.fn(async () => undefined),
    sendForCard: vi.fn(async () => undefined),
    purge: vi.fn(async () => 0),
    ...over,
  } as never;
}

const row = (id: string, domain = `${id}.test`) => ({
  id,
  email: `${id}@x.test`,
  domain,
  confirm_token_hash: "h",
  ip_hash: null,
  confirmed_at: "2026-10-01T00:00:00Z",
  card_id: null,
  created_at: "2026-10-01T00:00:00Z",
});

describe("drainQueue", () => {
  it("stops at the first refused reserve: the queue drains only within budget", async () => {
    let left = 2;
    const deps = mkDeps({
      listConfirmed: vi.fn(async () => [row("a"), row("b"), row("c"), row("d")]),
      reserve: vi.fn(async () => (left-- > 0 ? { ok: true as const, ...RES } : { ok: false as const, reason: "full" as const })),
    });
    const r = await drainQueue(new Date("2026-10-02T00:00:00Z"), deps);
    expect(r).toMatchObject({ started: 2, stopped: "budget" });
    expect(deps.start).toHaveBeenCalledTimes(2);
    expect(deps.reserve).toHaveBeenCalledTimes(3);
  });

  it("attaches a row to its card only after the worker started, then tries the send", async () => {
    const deps = mkDeps({ listConfirmed: vi.fn(async () => [row("a")]) });
    await drainQueue(new Date(), deps);
    expect(deps.attach).toHaveBeenCalledWith("a", "card");
    expect(deps.start.mock.invocationCallOrder[0]).toBeLessThan(deps.attach.mock.invocationCallOrder[0]);
    expect(deps.sendForCard).toHaveBeenCalledWith("card");
  });

  it("a domain with a card from the last 24h reuses it at $0", async () => {
    const deps = mkDeps({
      listConfirmed: vi.fn(async () => [row("a")]),
      findRecent: vi.fn(async () => ({ id: "old-card", status: "done" }) as never),
    });
    const r = await drainQueue(new Date(), deps);
    expect(r).toMatchObject({ started: 0, reused: 1, stopped: "empty" });
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.attach).toHaveBeenCalledWith("a", "old-card");
  });

  it("purges queue rows older than 7 days on every run", async () => {
    const deps = mkDeps({});
    await drainQueue(new Date("2026-10-08T00:00:00Z"), deps);
    expect(deps.purge).toHaveBeenCalledWith("2026-10-01T00:00:00.000Z");
  });

  it("retries the email for a card already made whose first send failed", async () => {
    const deps = mkDeps({ listAwaitingEmail: vi.fn(async () => ["made-card"]) });
    await drainQueue(new Date("2026-10-08T00:00:00Z"), deps);
    expect(deps.sendForCard).toHaveBeenCalledWith("made-card");
    expect(deps.reserve).not.toHaveBeenCalled();
  });
});
