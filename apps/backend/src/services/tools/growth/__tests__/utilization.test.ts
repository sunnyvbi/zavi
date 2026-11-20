import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { confirmationCode, runConfirmUtilizationMap, runUtilizationByLocation, type SavedConfig, type UtilizationDeps } from "../utilization";
import type { ToolContext } from "@/services/tools/types";
import { GatewayRefusal } from "@/services/data-gateway/types";
import { DataChangedDuringReadError, MAX_LOCATIONS, TooManyLocationsError, type UtilizationResult } from "@/services/growth/booking-metrics/utilization";

const col = (name: string, type: string) => ({ name, type, nullable: true });
const CATALOG = {
  dialect: "mongodb",
  catalog: {
    tables: [
      { name: "units", rowEstimate: 5, columns: [col("_id", "ObjectId"), col("area", "String"), col("zone", "String"), col("state", "String")] },
      {
        name: "stays",
        rowEstimate: 9,
        columns: [col("unitRef", "String"), col("from", "Date"), col("to", "Date"), col("note", "String"), col("status", "String"), col("tags", "Array")],
      },
    ],
  },
  hints: { listings: { table: "units", id_field: "_id", geo_field: "area" }, bookings: { table: "stays", listing_ref_field: "unitRef" } },
  coverage: { tables_total: 2, tables_indexed: 2, skipped_unsafe_names: 0, deadline_hit: false, listing_truncated: false },
} as never;

const MAPPED = {
  supply_table: "units",
  supply_key_field: "_id",
  location_fields: ["area", "zone"],
  active_field: "state",
  active_values: ["live"],
  occupancy_table: "stays",
  occupancy_unit_field: "unitRef",
  occupancy_start_field: "from",
  occupancy_end_field: "to",
  occupancy_status_field: "status",
  occupying_values: ["ok"],
};
const SAVED: SavedConfig = { ...MAPPED, source_epoch: 3, updated_at: "2026-10-10T00:00:00.1+00:00", confirmed_at: "2026-10-10T00:00:00Z" };
const RESULT: UtilizationResult = {
  window: { since: "x", until: "y", days: 28 },
  locations: [],
  location_count: 0,
  totals: { units: 4, capacity_unit_days: 112, booked_unit_days: 50, occupancy: 0.446, double_booked_unit_days: 0 },
  coverage: {
    units_without_location: 0,
    booked_unit_days_without_location: 0,
    duplicate_unit_keys: 0,
    units_without_key: 0,
    rows_on_units_not_active_today: 0,
    unit_days_on_units_not_active_today: 0,
    rows_without_unit: 0,
    rows_end_not_after_start: 0,
    rows_without_dates: 0,
  },
};
const CHAT: ToolContext = { tenant_id: "t1", run_id: "run-1", log: () => undefined, run_trigger: "chat", actor: { actor_user_id: "u1" } as ToolContext["actor"] };
const NEXT_TURN: ToolContext = { ...CHAT, run_id: "run-2" };
beforeAll(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-server-key";
});

function deps(over: Partial<UtilizationDeps> = {}): UtilizationDeps {
  return {
    getConfig: vi.fn(async () => SAVED),
    getSourceEpoch: vi.fn(async () => 3),
    getCatalog: vi.fn(async () => CATALOG),
    getBookingHint: vi.fn(async () => ({ table: "stays", status_field: "status" })),
    compute: vi.fn(async () => RESULT),
    isOwnerOrAdmin: vi.fn(async () => true),
    confirm: vi.fn(async () => undefined),
    now: () => new Date("2026-10-15T00:00:00Z"),
    ...over,
  };
}

describe("utilization_by_location", () => {
  it("not set up: the questions, suggestions from what is already known, and the revisions a save needs", async () => {
    const out = (await runUtilizationByLocation(CHAT, {}, deps({ getConfig: vi.fn(async () => null) }))) as Record<string, any>;
    expect(out.status).toBe("not_set_up");
    expect(out.questions.length).toBeGreaterThanOrEqual(4);
    expect(out.suggestions).toMatchObject({ occupancy_table: "stays", supply_table: "units", location_field: "area", occupancy_unit_field: "unitRef" });
    expect(out).toMatchObject({ config_revision: null, database_revision: 3 });
    expect(out).not.toHaveProperty("locations");
  });

  it("confirmed: computes over [now - days, now) with the supply key's family and states its limits", async () => {
    const d = deps();
    const out = (await runUtilizationByLocation(CHAT, { days: 14 }, d)) as Record<string, any>;
    expect(out.status).toBe("ok");
    expect(out.limits).toMatch(/shortage unproven/);
    expect(out.config_revision).toBe(SAVED.updated_at);
    const [, engine, , family, w] = (d.compute as any).mock.calls[0];
    expect(engine).toBe("mongodb");
    expect(family).toBe("objectId");
    expect(w.until.getTime() - w.since.getTime()).toBe(14 * 86_400_000);
  });

  it("refuses to run old choices against a different database (source epoch moved)", async () => {
    const d = deps({ getSourceEpoch: vi.fn(async () => 4) });
    const out = (await runUtilizationByLocation(CHAT, {}, d)) as Record<string, any>;
    expect(out).toMatchObject({ status: "reconfirm", reason: "database_changed" });
    expect(d.compute).not.toHaveBeenCalled();
  });

  it("a mapped field gone from a COMPLETE catalog asks to re-confirm; a partial catalog is not evidence", async () => {
    const gone = { ...(CATALOG as any), catalog: { tables: [{ ...(CATALOG as any).catalog.tables[0], columns: [col("_id", "ObjectId"), col("state", "String")] }, (CATALOG as any).catalog.tables[1]] } };
    expect(((await runUtilizationByLocation(CHAT, {}, deps({ getCatalog: vi.fn(async () => gone) }))) as any).status).toBe("reconfirm");
    const partial = { ...gone, coverage: { ...gone.coverage, deadline_hit: true } };
    expect(((await runUtilizationByLocation(CHAT, {}, deps({ getCatalog: vi.fn(async () => partial) }))) as any).status).toBe("ok");
  });

  it.each([
    ["too_many_locations", new TooManyLocationsError()],
    ["refused_by_data_settings", new GatewayRefusal("field is hidden", "zavi")],
    ["calculation_too_large", Object.assign(new Error("operation exceeded time limit"), { code: 50 })],
    ["data_changed_during_read", new DataChangedDuringReadError()],
    ["read_failed", new Error("boom")],
  ])("a failed read is a typed %s, never a number", async (status, err) => {
    const out = (await runUtilizationByLocation(CHAT, {}, deps({ compute: vi.fn(async () => Promise.reject(err)) }))) as Record<string, any>;
    expect(out.status).toBe(status);
    expect(out).not.toHaveProperty("locations");
  });

  it("duplicate or missing unit ids withhold the number", async () => {
    const bad = { ...RESULT, coverage: { ...RESULT.coverage, duplicate_unit_keys: 2 } };
    const out = (await runUtilizationByLocation(CHAT, {}, deps({ compute: vi.fn(async () => bad) }))) as any;
    expect(out.status).toBe("unit_ids_not_unique");
    expect(out).not.toHaveProperty("locations");
    expect(out).not.toHaveProperty("totals");
  });

  it("rows that cannot be placed make booked time a stated lower bound", async () => {
    const out = (await runUtilizationByLocation(CHAT, {}, deps({ compute: vi.fn(async () => ({ ...RESULT, coverage: { ...RESULT.coverage, rows_without_unit: 3, rows_without_dates: null } })) }))) as any;
    expect(out).toMatchObject({ status: "ok", exact: false });
    expect(out.why_not_exact).toMatch(/lower bound.*3 occupying rows/);
    const clean = (await runUtilizationByLocation(CHAT, {}, deps())) as any;
    expect(clean).toMatchObject({ status: "ok", exact: true });
    expect(clean).not.toHaveProperty("why_not_exact");
  });

  it("more located places than the cap is refused at exactly cap + 1", async () => {
    const out = (await runUtilizationByLocation(CHAT, {}, deps({ compute: vi.fn(async () => ({ ...RESULT, location_count: MAX_LOCATIONS + 1 })) }))) as any;
    expect(out.status).toBe("too_many_locations");
    const ok = (await runUtilizationByLocation(CHAT, {}, deps({ compute: vi.fn(async () => ({ ...RESULT, location_count: MAX_LOCATIONS })) }))) as any;
    expect(ok.status).toBe("ok");
  });

  it("a mapped date that became text asks to re-confirm instead of reading zero", async () => {
    const cat = JSON.parse(JSON.stringify(CATALOG));
    cat.catalog.tables[1].columns.find((c: any) => c.name === "from").type = "String";
    const d = deps({ getCatalog: vi.fn(async () => cat) });
    const out = (await runUtilizationByLocation(CHAT, {}, d)) as any;
    expect(out).toMatchObject({ status: "reconfirm", reason: "type_changed" });
    expect(d.compute).not.toHaveBeenCalled();
  });

  it("a partial catalog that cannot vouch for the types is catalog_incomplete, not reconfirm", async () => {
    const cat = { ...(CATALOG as any), catalog: { tables: [(CATALOG as any).catalog.tables[0]] }, coverage: { ...(CATALOG as any).coverage, deadline_hit: true } };
    const d = deps({ getCatalog: vi.fn(async () => cat) });
    expect(((await runUtilizationByLocation(CHAT, {}, d)) as any).status).toBe("catalog_incomplete");
    expect(d.compute).not.toHaveBeenCalled();
  });

  it("zero active units is said, not ranked", async () => {
    const out = (await runUtilizationByLocation(CHAT, {}, deps({ compute: vi.fn(async () => ({ ...RESULT, totals: { ...RESULT.totals, units: 0 } })) }))) as any;
    expect(out.status).toBe("no_active_units");
  });

  it("an unsupported engine says so", async () => {
    const out = (await runUtilizationByLocation(CHAT, {}, deps({ getCatalog: vi.fn(async () => ({ ...(CATALOG as any), dialect: "mysql" })) }))) as any;
    expect(out.status).toBe("unsupported_engine");
  });
});

const INPUT = { ...MAPPED, config_revision: SAVED.updated_at, database_revision: 3, confirmation_code: null as string | null };

describe("confirm_utilization_map", () => {
  it("is refused outside a founder-typed chat turn and for non-admins", async () => {
    await expect(runConfirmUtilizationMap({ ...CHAT, run_trigger: "schedule" }, INPUT, deps())).rejects.toThrow(/live chat/);
    await expect(runConfirmUtilizationMap({ ...CHAT, untrusted_context: true } as ToolContext, INPUT, deps())).rejects.toThrow(/live chat/);
    await expect(runConfirmUtilizationMap(CHAT, INPUT, deps({ isOwnerOrAdmin: vi.fn(async () => false) }))).rejects.toThrow(/owner or admin/);
  });

  it("previews in plain words with a code; only a LATER turn with those exact choices and that code saves", async () => {
    const d = deps();
    const preview = (await runConfirmUtilizationMap(CHAT, INPUT, d)) as Record<string, any>;
    expect(preview).toMatchObject({ status: "preview", saved: false });
    expect(preview.map.location).toMatch(/"area" \+ "zone"/);
    expect(d.confirm).not.toHaveBeenCalled();

    await expect(runConfirmUtilizationMap(CHAT, { ...INPUT, confirmation_code: preview.confirmation_code }, d)).rejects.toThrow(/same turn/);
    await expect(runConfirmUtilizationMap(NEXT_TURN, { ...INPUT, location_fields: ["area"], confirmation_code: preview.confirmation_code }, d)).rejects.toThrow(/differ from the preview/);
    const forged = String(preview.confirmation_code).replace(".run-1", ".run-0");
    await expect(runConfirmUtilizationMap(NEXT_TURN, { ...INPUT, confirmation_code: forged }, d)).rejects.toThrow(/differ from the preview/);
    expect(d.confirm).not.toHaveBeenCalled();

    const saved = (await runConfirmUtilizationMap(NEXT_TURN, { ...INPUT, confirmation_code: preview.confirmation_code }, d)) as Record<string, any>;
    expect(saved.status).toBe("saved");
    expect(d.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "t1", confirmed_by: "u1", expected_updated_at: SAVED.updated_at, source_epoch: 3, map: expect.objectContaining({ location_fields: ["area", "zone"] }) }),
    );
  });

  it("refuses a turn with no run id (the confirmation cannot be tied to a preview)", async () => {
    await expect(runConfirmUtilizationMap({ ...CHAT, run_id: undefined }, INPUT, deps())).rejects.toThrow(/no run id/);
  });

  it("the code is a server-keyed HMAC bound to tenant, person, revisions, choices and preview run", () => {
    const a = confirmationCode("t1", "u1", 3, null, MAPPED, "run-1");
    const mac = (c: string) => c.split(".")[0];
    expect(mac(confirmationCode("t2", "u1", 3, null, MAPPED, "run-1"))).not.toBe(mac(a));
    expect(mac(confirmationCode("t1", "u2", 3, null, MAPPED, "run-1"))).not.toBe(mac(a));
    expect(mac(confirmationCode("t1", "u1", 4, null, MAPPED, "run-1"))).not.toBe(mac(a));
    expect(mac(confirmationCode("t1", "u1", 3, "r", MAPPED, "run-1"))).not.toBe(mac(a));
    expect(mac(confirmationCode("t1", "u1", 3, null, MAPPED, "run-9"))).not.toBe(mac(a));
    const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "another-key";
    expect(mac(confirmationCode("t1", "u1", 3, null, MAPPED, "run-1"))).not.toBe(mac(a));
    process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  });

  it("rejects forged codes: an unkeyed hash of every input, a made-up code, another admin's preview, and a replay after saving", async () => {
    const d = deps();
    const canonical = JSON.stringify(["utilization-map-confirm:v1", "t1", "u1", 3, SAVED.updated_at, "run-1", ...Object.values(MAPPED)]);
    for (const forged of [`${createHash("sha256").update(canonical).digest("base64url")}.run-1`, "aaaaaaaaaaaaaaaa.run-1", "run-1"]) {
      await expect(runConfirmUtilizationMap(NEXT_TURN, { ...INPUT, confirmation_code: forged }, d)).rejects.toThrow(/not one Zavi issued/);
    }
    const theirs = (await runConfirmUtilizationMap({ ...CHAT, actor: { actor_user_id: "u7" } as ToolContext["actor"] }, INPUT, d)) as Record<string, any>;
    await expect(runConfirmUtilizationMap(NEXT_TURN, { ...INPUT, confirmation_code: theirs.confirmation_code }, d)).rejects.toThrow(/not one Zavi issued/);
    expect(d.confirm).not.toHaveBeenCalled();
    const mine = (await runConfirmUtilizationMap(CHAT, INPUT, d)) as Record<string, any>;
    await runConfirmUtilizationMap(NEXT_TURN, { ...INPUT, confirmation_code: mine.confirmation_code }, d);
    const moved = deps({ getConfig: vi.fn(async () => ({ ...SAVED, updated_at: "2026-10-16T00:00:00Z" })) });
    await expect(
      runConfirmUtilizationMap({ ...CHAT, run_id: "run-3" }, { ...INPUT, config_revision: "2026-10-16T00:00:00Z", confirmation_code: mine.confirmation_code }, moved),
    ).rejects.toThrow(/not one Zavi issued/);
    expect(moved.confirm).not.toHaveBeenCalled();
  });

  it("refuses when the saved map or the database moved after it was read", async () => {
    await expect(runConfirmUtilizationMap(CHAT, { ...INPUT, config_revision: null }, deps())).rejects.toThrow(/changed after it was read/);
    await expect(runConfirmUtilizationMap(CHAT, INPUT, deps({ getSourceEpoch: vi.fn(async () => 9) }))).rejects.toThrow(/changed after it was read/);
  });

  it.each([
    ["an unknown table", { occupancy_table: "nope" }, /not in the discovered database catalog/],
    ["an unknown field", { location_fields: ["area", "nope"] }, /not a field of "units"/],
    ["text dates", { occupancy_start_field: "note" }, /real date-time field/],
    ["a list as the unit reference", { occupancy_unit_field: "tags" }, /cannot be matched/],
    ["start == end", { occupancy_end_field: "from" }, /two different fields/],
    ["an active field with no values", { active_values: null }, /go together/],
    ["a status field with no values", { occupying_values: null }, /go together/],
  ])("refuses %s", async (_l, patch, msg) => {
    await expect(runConfirmUtilizationMap(CHAT, { ...INPUT, ...patch }, deps())).rejects.toThrow(msg);
  });

  it("refuses a strict-schema violation (unknown key) before any read", async () => {
    const d = deps();
    await expect(runConfirmUtilizationMap(CHAT, { ...INPUT, tenant_id: "other" }, d)).rejects.toThrow(/Not saved/);
    expect(d.getConfig).not.toHaveBeenCalled();
  });
});
