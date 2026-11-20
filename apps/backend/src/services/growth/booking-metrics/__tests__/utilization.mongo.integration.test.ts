import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));

import { effectivePolicy } from "@zavi/shared/db-guard";
import { openMongoSession } from "@/services/data-gateway/direct/mongo";
import { loggedSession } from "@/services/data-gateway/logged-session";
import { introspectMongo } from "@/services/data-gateway/discovery/mongo";
import { normalizeRawCatalog } from "@/services/tools/operator-db/discovery";
import type { DbAccess } from "@/services/data-gateway/resolve";
import type { ReadSession } from "@/services/data-gateway/session";
import { keyFamilyOf, readUtilization, type UtilizationMap } from "../utilization";
import { EXPECT, MAP, ROWS, UNITS, W_SINCE, W_UNTIL, day } from "./utilization-fixture";

const URL = process.env.UTILIZATION_LIVE_MONGO;
const MONGO_MAP: UtilizationMap = {
  ...MAP,
  supply_key_field: "_id",
  occupancy_unit_field: "unitRef",
  occupancy_start_field: "period.start",
  occupancy_end_field: "period.end",
};
let session: ReadSession;
let catalog: ReturnType<typeof normalizeRawCatalog>;

describe.skipIf(!URL)("occupancy by location on MongoDB (live)", () => {
  beforeAll(async () => {
    const client = new MongoClient(URL!);
    await client.connect();
    const db = client.db();
    await db.dropDatabase();
    const ids = new Map(UNITS.map((u) => [u.id, new ObjectId()]));
    ids.set("u9", new ObjectId());
    await db.collection("units").insertMany(
      UNITS.map((u) => ({ _id: ids.get(u.id)!, ...(u.city !== null ? { city: u.city } : {}), ...(u.region !== null ? { region: u.region } : {}), state: u.state })),
    );
    await db.collection("stays").insertMany([
      ...ROWS.map((r) => ({ unitRef: ids.get(r.unit)!.toHexString(), period: { start: day(r.s), end: day(r.e) }, status: r.status })),
      { unitRef: ids.get("u3")!.toHexString(), period: { start: "2026-10-02", end: "2026-10-03" }, status: "ok" },
      { unitRef: "not-an-id", period: { start: day(1), end: day(2) }, status: "ok" },
    ]);
    await client.close();
    catalog = normalizeRawCatalog(await introspectMongo(URL!));
    const access = {
      tenant_id: "live",
      mode: "direct",
      dialect: "mongodb",
      database: null,
      policy: effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb"),
    } as unknown as DbAccess;
    session = loggedSession(await openMongoSession(URL!), access, {
      tenant_id: "live",
      caller: { kind: "agent", agent_slug: "live", run_id: null, tool_name: "live" },
    });
  }, 60_000);
  afterAll(async () => {
    await session?.close();
  });

  it("the discovered unit id is an ObjectId", () => {
    const t = catalog.tables.find((x) => x.name === "units")!.columns.find((c) => c.name === "_id")!.type;
    expect(keyFamilyOf("mongodb", t)).toBe("objectId");
  });

  it("gives the same hand-computed occupancy, totals and coverage as Postgres", async () => {
    const out = await readUtilization(session, "mongodb", MONGO_MAP, "objectId", { since: W_SINCE, until: W_UNTIL, limit: 25 });
    expect(out.locations.map((l) => l.label)).toEqual(["south / east", "north / east"]);
    expect(out.locations[0]).toMatchObject(EXPECT.south);
    expect(out.locations[1]).toMatchObject(EXPECT.north);
    expect(out.totals).toMatchObject(EXPECT.totals);
    expect(out.coverage).toMatchObject({ ...EXPECT.coverage, rows_without_unit: 1, rows_without_dates: 1 });
  });
});
