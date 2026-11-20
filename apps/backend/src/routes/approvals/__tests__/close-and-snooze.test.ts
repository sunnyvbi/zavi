import { describe, it, expect } from "vitest";
import { pendingSource } from "@/routes/approvals/list";
import {
  archiveErrorStatus,
  snoozeErrorStatus,
  snoozeUntilValid,
  MAX_SNOOZE_MS,
} from "@/routes/approvals/close";

describe("pendingSource — one predicate, not five copies", () => {
  it("the pending list reads the shared view, never the base table", () => {
    expect(pendingSource("proposed")).toBe("customer_visible_pending_decisions");
  });

  it("terminal statuses read the base table — they have no snooze meaning", () => {
    for (const s of ["approved", "rejected", "acted", "dispatching", "failed", "dispatch_failed"]) {
      expect(pendingSource(s)).toBe("decisions");
    }
  });
});

describe("archiveErrorStatus — the class guard must read as 'not allowed', not 'try again'", () => {
  it("a class outside the founder_managed allowlist is 403", () => {
    expect(
      archiveErrorStatus("archive_decision: class meta_ads.set_budget is not founder_managed"),
    ).toBe(403);
  });

  it("a cross-tenant reach is 403", () => {
    expect(
      archiveErrorStatus("archive_decision: decision abc belongs to tenant t1, not t2"),
    ).toBe(403);
  });

  it("anything else is ours, and is 500", () => {
    expect(archiveErrorStatus("could not serialize access due to concurrent update")).toBe(500);
  });
});

describe("snoozeErrorStatus — snooze is allowlisted too, not just archive", () => {
  it("cross-tenant reach is 403", () => {
    expect(snoozeErrorStatus("snooze_decision: decision abc belongs to tenant t1, not t2")).toBe(403);
  });

  it("a class outside the founder_managed allowlist is 403", () => {
    expect(
      snoozeErrorStatus("snooze_decision: class stripe.remit_to_tenant is not founder_managed"),
    ).toBe(403);
  });

  it("everything else is 500", () => {
    expect(snoozeErrorStatus("deadlock detected")).toBe(500);
  });
});

describe("snoozeUntilValid — a snooze is a deferral, not a delete", () => {
  const now = Date.parse("2026-09-02T00:00:00.000Z");

  it("accepts a normal next-cycle snooze", () => {
    expect(snoozeUntilValid("2026-09-03T00:00:00.000Z", now)).toBe(true);
  });

  it("rejects the past — a backdated snooze would resurface the row instantly", () => {
    expect(snoozeUntilValid("2026-09-01T23:59:59.000Z", now)).toBe(false);
  });

  it("rejects now exactly", () => {
    expect(snoozeUntilValid("2026-09-02T00:00:00.000Z", now)).toBe(false);
  });

  it("accepts the 14 day ceiling exactly", () => {
    expect(snoozeUntilValid(new Date(now + MAX_SNOOZE_MS).toISOString(), now)).toBe(true);
  });

  it("rejects beyond the ceiling — an indefinite snooze is a silent delete", () => {
    expect(snoozeUntilValid(new Date(now + MAX_SNOOZE_MS + 1000).toISOString(), now)).toBe(false);
  });

  it("rejects garbage", () => {
    expect(snoozeUntilValid("not-a-date", now)).toBe(false);
  });
});
