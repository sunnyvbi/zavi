import { describe, expect, it, vi } from "vitest";
import {
  autoConfirmManagedMapping,
  strictZaviMapping,
  type AutoConfirmDeps,
} from "../zavi-auto-confirm";
import type { CatalogTable } from "../types";

const TS = "timestamp with time zone";
const t = (name: string, cols: Array<[string, string]>): CatalogTable => ({
  name,
  columns: cols.map(([n, type]) => ({ name: n, type, nullable: false })),
  rowEstimate: null,
});

const USERS = t("users", [["id", "bigint"], ["email", "text"], ["created_at", TS]]);
const ORDERS = t("orders", [["id", "bigint"], ["user_id", "bigint"], ["created_at", TS]]);

const DECL = {
  signups: { table: "users", created_at: "created_at" },
  business_event: { table: "orders", created_at: "created_at" },
};

describe("strictZaviMapping", () => {
  it("confirms the declared signups and business-event tables", () => {
    const m = strictZaviMapping({ tables: [USERS, ORDERS, t("transactions", [["created_at", TS]])] }, DECL);
    expect(m.users).toMatchObject({ table: "users", created_at_field: "created_at", id_field: "id", source: "zavi-build" });
    expect(m.bookings).toMatchObject({ table: "orders", created_at_field: "created_at", source: "zavi-build" });
  });

  it("never guesses the business event from a table name", () => {
    const m = strictZaviMapping({ tables: [USERS, ORDERS] }, null);
    expect(m.bookings).toBeUndefined();
    expect(m.users).toMatchObject({ table: "users" });
  });

  it("confirms users alone when the app declares no business event", () => {
    const m = strictZaviMapping({ tables: [USERS, ORDERS] }, { signups: DECL.signups, business_event: null });
    expect(Object.keys(m)).toEqual(["users"]);
  });

  it("refuses a declared table the schema does not have", () => {
    const m = strictZaviMapping({ tables: [USERS] }, DECL);
    expect(m.bookings).toBeUndefined();
  });

  it("refuses a declared created-at that is not a timestamp", () => {
    const m = strictZaviMapping(
      { tables: [USERS, t("orders", [["created_at", "ARRAY"]])] },
      DECL,
    );
    expect(m.bookings).toBeUndefined();
  });

  it("does not fall back to `users` when the declared signups table does not check out", () => {
    const m = strictZaviMapping(
      { tables: [USERS] },
      { signups: { table: "members", created_at: "joined_at" }, business_event: null },
    );
    expect(m.users).toBeUndefined();
  });

  it("uses a declared non-template signups table", () => {
    const m = strictZaviMapping(
      { tables: [t("members", [["id", "uuid"], ["joined_at", "timestamp without time zone"]])] },
      { signups: { table: "members", created_at: "joined_at" }, business_event: null },
    );
    expect(m.users).toMatchObject({ table: "members", created_at_field: "joined_at" });
  });
});

function deps(over: Partial<AutoConfirmDeps> = {}): AutoConfirmDeps {
  return {
    isEnabled: vi.fn(async () => true),
    readManagedBy: vi.fn(async () => "zavi"),
    getCatalog: vi.fn(async () => ({
      dialect: "postgres" as const,
      catalog: { tables: [USERS] },
      hints: {},
      catalog_hash: "h1",
      coverage: null,
      discovery_error: null,
      updated_at: null,
    })),
    readDeclaration: vi.fn(async () => null),
    confirm: vi.fn(async () => true),
    ...over,
  };
}

describe("autoConfirmManagedMapping", () => {
  it("confirms against the current catalog hash", async () => {
    const d = deps();
    expect(await autoConfirmManagedMapping("t1", d)).toBe("confirmed");
    expect(d.confirm).toHaveBeenCalledWith("t1", "h1", expect.objectContaining({ users: expect.any(Object) }));
  });

  it("never touches a founder-connected database", async () => {
    const d = deps({ readManagedBy: vi.fn(async () => null) });
    expect(await autoConfirmManagedMapping("t1", d)).toBe("not_managed");
    expect(d.getCatalog).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("does nothing when the kill switch is off", async () => {
    const d = deps({ isEnabled: vi.fn(async () => false) });
    expect(await autoConfirmManagedMapping("t1", d)).toBe("disabled");
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("does nothing on a failed discovery", async () => {
    const d = deps({
      getCatalog: vi.fn(async () => ({
        dialect: "postgres" as const,
        catalog: { tables: [USERS] },
        hints: {},
        catalog_hash: "h1",
        coverage: null,
        discovery_error: "connect_failed",
        updated_at: null,
      })),
    });
    expect(await autoConfirmManagedMapping("t1", d)).toBe("no_catalog");
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("does not call the RPC when nothing is unambiguous", async () => {
    const d = deps({
      getCatalog: vi.fn(async () => ({
        dialect: "postgres" as const,
        catalog: { tables: [t("things", [["created_at", TS]])] },
        hints: {},
        catalog_hash: "h2",
        coverage: null,
        discovery_error: null,
        updated_at: null,
      })),
    });
    expect(await autoConfirmManagedMapping("t1", d)).toBe("nothing_unambiguous");
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("reports a DB refusal", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    expect(await autoConfirmManagedMapping("t1", d)).toBe("refused");
  });
});
