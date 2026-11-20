import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  budgets: [] as Array<Record<string, unknown>>,
  connectors: [] as Array<Record<string, unknown>>,
  connectorsError: null as { message: string } | null,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) q[m] = () => q;
      q.then = (res: (v: unknown) => unknown) =>
        res(table === "ad_budgets" ? { data: db.budgets, error: null } : { data: db.connectorsError ? null : db.connectors, error: db.connectorsError });
      return q;
    },
  }),
}));

import { loginFailureFixed, readAdReadFailures, RECONNECT_RECHECK_MS } from "../ad-read-failures";

const NOW = Date.parse("2026-10-22T15:58:00Z");
const failing = (kind: string) => ({
  read_failed: { meta: "2026-10-22T15:00:00Z" },
  read_failure_kinds: { meta: kind },
});

beforeEach(() => {
  db.budgets = [];
  db.connectors = [];
  db.connectorsError = null;
});

describe("loginFailureFixed", () => {
  const AT = "2026-10-22T15:34:00Z";
  const soon = Date.parse("2026-10-22T15:58:00Z");
  it("older than the latest connect, and the hourly read has not had time to check: fixed", () => {
    expect(loginFailureFixed("2026-10-22T15:00:00Z", [AT], soon)).toBe(true);
  });
  it("began after the connect: still a problem", () => {
    expect(loginFailureFixed("2026-10-22T16:00:00Z", [AT], Date.parse("2026-10-22T16:10:00Z"))).toBe(false);
  });
  it("still flagged after the read had time to run (a read that worked would have cleared it): still a problem", () => {
    expect(loginFailureFixed("2026-10-22T15:00:00Z", [AT], Date.parse(AT) + RECONNECT_RECHECK_MS)).toBe(false);
  });
  it("no connect time (or an unreadable one): still a problem", () => {
    expect(loginFailureFixed("2026-10-22T15:00:00Z", [], soon)).toBe(false);
    expect(loginFailureFixed("2026-10-22T15:00:00Z", [null, undefined, "not a date"], soon)).toBe(false);
  });
  it("any of the platform's slugs reconnected counts (a Composio twin)", () => {
    expect(loginFailureFixed("2026-10-22T15:00:00Z", [undefined, AT], soon)).toBe(true);
  });
});

describe("readAdReadFailures", () => {
  it("drops a login failure older than the reconnect", async () => {
    db.budgets = [failing("auth")];
    db.connectors = [{ slug: "meta_ads", connected_at: "2026-10-22T15:34:00Z" }];
    const r = await readAdReadFailures("t1", NOW);
    expect(r.reconnect.size).toBe(0);
    expect(r.slow.size).toBe(0);
  });

  it("keeps a login failure newer than the connect", async () => {
    db.budgets = [{ ...failing("account_gone"), read_failed: { meta: "2026-10-22T15:50:00Z" } }];
    db.connectors = [{ slug: "meta_ads", connected_at: "2026-10-22T15:34:00Z" }];
    const r = await readAdReadFailures("t1", NOW);
    expect(r.reconnect.get("meta_ads")).toEqual({ since: "2026-10-22T15:50:00Z", kind: "account_gone" });
  });

  it("keeps it when there is no connector metadata, or it cannot be read", async () => {
    db.budgets = [failing("auth")];
    expect((await readAdReadFailures("t1", NOW)).reconnect.has("meta_ads")).toBe(true);
    db.connectors = [{ slug: "meta_ads", connected_at: "2026-10-22T15:34:00Z" }];
    db.connectorsError = { message: "down" };
    expect((await readAdReadFailures("t1", NOW)).reconnect.has("meta_ads")).toBe(true);
  });

  it("a slow read (not a login problem) is untouched by a reconnect", async () => {
    db.budgets = [{ read_failed: { meta: "2026-10-22T10:00:00Z" }, read_failure_kinds: { meta: "timeout" } }];
    db.connectors = [{ slug: "meta_ads", connected_at: "2026-10-22T15:34:00Z" }];
    expect((await readAdReadFailures("t1", NOW)).slow.get("meta_ads")).toBe("2026-10-22T10:00:00Z");
  });
});
