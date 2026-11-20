import { describe, it, expect, vi, beforeEach } from "vitest";
import { raiseOutage, clearOutageIfOpen, outageCardBody, __resetOutageCard, type OutageDeps } from "../direct/outage-card";

const SINCE = "2026-10-17T21:20:47Z";

function deps(over: Partial<OutageDeps> = {}): OutageDeps & { calls: string[] } {
  const calls: string[] = [];
  const d: OutageDeps = {
    claimOutage: vi.fn(async () => {
      calls.push("claim");
      return SINCE;
    }),
    rollbackClaim: vi.fn(async () => {
      calls.push("rollback");
    }),
    emitCard: vi.fn(async () => {
      calls.push("emit");
      return "dec-1";
    }),
    storeCardId: vi.fn(async () => {
      calls.push("store");
      return true;
    }),
    readOutage: vi.fn(async () => {
      calls.push("read");
      return { since: SINCE, decision_id: "dec-1" };
    }),
    supersedeCard: vi.fn(async () => {
      calls.push("supersede");
    }),
    releaseOutage: vi.fn(async () => {
      calls.push("release");
    }),
    supersedeOpenCards: vi.fn(async () => {
      calls.push("sweep");
    }),
    log: vi.fn(async () => undefined),
  };
  return Object.assign(d, over, { calls });
}

describe("raiseOutage", () => {
  beforeEach(() => __resetOutageCard());

  it("claims, retracts any leftover card, emits one card and stores its id against that outage", async () => {
    const d = deps();
    await raiseOutage("t1", "msg", d);
    expect(d.calls).toEqual(["claim", "sweep", "emit", "store"]);
    expect(d.supersedeOpenCards).toHaveBeenCalledWith("t1", SINCE);
    expect(d.storeCardId).toHaveBeenCalledWith("t1", "dec-1", SINCE);
  });

  it("does not emit a second card when retracting the leftover fails; frees the claim to retry", async () => {
    const d = deps({ supersedeOpenCards: vi.fn(async () => { throw new Error("transient"); }) });
    await raiseOutage("t1", "msg", d);
    expect(d.emitCard).not.toHaveBeenCalled();
    expect(d.rollbackClaim).toHaveBeenCalledWith("t1", SINCE);
  });

  it("emits nothing when the outage is already open (claim lost)", async () => {
    const d = deps({ claimOutage: vi.fn(async () => null) });
    await raiseOutage("t1", "msg", d);
    expect(d.emitCard).not.toHaveBeenCalled();
  });

  it("rolls the claim back when the card cannot be created, so the next failure retries", async () => {
    const d = deps({
      emitCard: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    await expect(raiseOutage("t1", "msg", d)).resolves.toBeUndefined();
    expect(d.rollbackClaim).toHaveBeenCalledWith("t1", SINCE);
  });

  it("rolls the claim back when the card comes back without an id", async () => {
    const d = deps({ emitCard: vi.fn(async () => null) });
    await raiseOutage("t1", "msg", d);
    expect(d.rollbackClaim).toHaveBeenCalledWith("t1", SINCE);
  });

  it("retracts the card and frees the claim when storing its id fails", async () => {
    const d = deps({
      storeCardId: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    await raiseOutage("t1", "msg", d);
    expect(d.supersedeCard).toHaveBeenCalledWith("t1", "dec-1");
    expect(d.rollbackClaim).toHaveBeenCalledWith("t1", SINCE);
  });

  it("supersedes the new card when the outage ended between claim and store", async () => {
    const d = deps({ storeCardId: vi.fn(async () => false) });
    await raiseOutage("t1", "msg", d);
    expect(d.supersedeCard).toHaveBeenCalledWith("t1", "dec-1");
    expect(d.rollbackClaim).not.toHaveBeenCalled();
  });

  it("never throws when the claim itself fails", async () => {
    const d = deps({
      claimOutage: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(raiseOutage("t1", "msg", d)).resolves.toBeUndefined();
    expect(d.emitCard).not.toHaveBeenCalled();
  });
});

describe("clearOutageIfOpen", () => {
  beforeEach(() => __resetOutageCard());

  it("supersedes the card FIRST, then releases that outage", async () => {
    const d = deps();
    await clearOutageIfOpen("t1", { sawFailure: true, now: 1 }, d);
    expect(d.calls).toEqual(["read", "supersede", "release"]);
    expect(d.releaseOutage).toHaveBeenCalledWith("t1", SINCE);
  });

  it("keeps the outage when superseding fails, so the next success retries", async () => {
    const d = deps({
      supersedeCard: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    await expect(clearOutageIfOpen("t1", { sawFailure: true, now: 1 }, d)).resolves.toBeUndefined();
    expect(d.releaseOutage).not.toHaveBeenCalled();
  });

  it("releases a claimed outage that has no card yet (raise still in flight)", async () => {
    const d = deps({ readOutage: vi.fn(async () => ({ since: SINCE, decision_id: null })) });
    await clearOutageIfOpen("t1", { sawFailure: true, now: 1 }, d);
    expect(d.supersedeCard).not.toHaveBeenCalled();
    expect(d.releaseOutage).toHaveBeenCalledWith("t1", SINCE);
  });

  it("with no outage open, retracts any stray card (e.g. the database was disconnected and reconnected)", async () => {
    const d = deps({ readOutage: vi.fn(async () => null) });
    await clearOutageIfOpen("t1", { sawFailure: true, now: 1 }, d);
    expect(d.supersedeOpenCards).toHaveBeenCalledWith("t1", expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(d.supersedeCard).not.toHaveBeenCalled();
    expect(d.releaseOutage).not.toHaveBeenCalled();
  });

  it("a failed clear is retried on the very next success, not 5 minutes later", async () => {
    const supersedeCard = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);
    const d = deps({ supersedeCard });
    await clearOutageIfOpen("t1", { sawFailure: true, now: 0 }, d);
    await clearOutageIfOpen("t1", { sawFailure: false, now: 1_000 }, d);
    expect(d.readOutage).toHaveBeenCalledTimes(2);
    expect(d.releaseOutage).toHaveBeenCalledTimes(1);
  });

  it("checks at most once per 5 minutes per tenant when this process saw no failure", async () => {
    const d = deps({ readOutage: vi.fn(async () => null) });
    await clearOutageIfOpen("t1", { sawFailure: false, now: 0 }, d);
    await clearOutageIfOpen("t1", { sawFailure: false, now: 60_000 }, d);
    await clearOutageIfOpen("t1", { sawFailure: false, now: 5 * 60_000 + 1 }, d);
    expect(d.readOutage).toHaveBeenCalledTimes(2);
  });

  it("always checks when this process saw the failure", async () => {
    const d = deps({ readOutage: vi.fn(async () => null) });
    await clearOutageIfOpen("t1", { sawFailure: false, now: 0 }, d);
    await clearOutageIfOpen("t1", { sawFailure: true, now: 1 }, d);
    expect(d.readOutage).toHaveBeenCalledTimes(2);
  });
});

describe("outageCardBody", () => {
  it("carries the outage start so a later outage is a different card", () => {
    const a = outageCardBody(SINCE, "msg");
    const b = outageCardBody("2026-10-25T09:00:00Z", "msg");
    expect(a.kind).toBe("operator_db_unreachable");
    expect(a.outage_started_at).not.toBe(b.outage_started_at);
    expect(a.rationale).toBe("Your database can't be reached");
    expect(a.rendered_markdown).toContain("Oct 17");
    expect(a.rendered_markdown).toContain("msg");
    expect(a.rendered_markdown).not.toContain("—");
  });
});
