import { describe, expect, it } from "vitest";
import { buildDatabaseReclaimed } from "../build-liveness";

const hosting = { resource_kind: "hosting", status: "ready", updated_at: "2026-09-01T00:00:00Z" };
const db = (status: string, updated_at = "2026-09-22T10:00:00Z") => ({
  resource_kind: "db",
  status,
  updated_at,
});

describe("buildDatabaseReclaimed", () => {
  it("retires a build whose database was reclaimed after it was built", () => {
    expect(
      buildDatabaseReclaimed([hosting, db("torn_down")], { created_at: "2026-09-10T00:00:00Z" }),
    ).toBe(true);
  });

  it("does not retire a new build started after the reclaim", () => {
    expect(
      buildDatabaseReclaimed([hosting, db("torn_down")], { created_at: "2026-09-25T00:00:00Z" }),
    ).toBe(false);
  });

  it("does not retire a build whose database is still there", () => {
    expect(
      buildDatabaseReclaimed([hosting, db("ready")], { created_at: "2026-09-10T00:00:00Z" }),
    ).toBe(false);
  });

  it("does not retire an app that never had a database", () => {
    expect(buildDatabaseReclaimed([hosting], { created_at: "2026-09-10T00:00:00Z" })).toBe(false);
  });

  it("retires when there is no fresh build at all", () => {
    expect(buildDatabaseReclaimed([hosting, db("torn_down")], null)).toBe(true);
  });

  it("reads an unparseable timestamp as not retired", () => {
    expect(
      buildDatabaseReclaimed([hosting, db("torn_down", "")], { created_at: "2026-09-10T00:00:00Z" }),
    ).toBe(false);
  });
});
