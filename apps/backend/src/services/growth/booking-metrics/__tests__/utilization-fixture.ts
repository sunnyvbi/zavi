import type { UtilizationMap } from "../utilization";

export const W_SINCE = new Date("2026-10-01T00:00:00Z");
export const W_UNTIL = new Date("2026-10-11T00:00:00Z");
export const day = (n: number) => new Date(W_SINCE.getTime() + n * 86_400_000);

export const UNITS: Array<{ id: string; city: string | null; region: string | null; state: string }> = [
  { id: "u1", city: "North", region: "East", state: "live" },
  { id: "u2", city: "north", region: "east", state: "live" },
  { id: "u3", city: "South", region: "East", state: "live" },
  { id: "u4", city: "North", region: "East", state: "paused" },
  { id: "u5", city: null, region: null, state: "live" },
  { id: "u6", city: "  NORTH ", region: "East", state: "live" },
];

export const ROWS: Array<{ unit: string; s: number; e: number; status: string }> = [
  { unit: "u1", s: 0, e: 4, status: "ok" },
  { unit: "u1", s: 2, e: 6, status: "ok" },
  { unit: "u1", s: 8, e: 12, status: "ok" },
  { unit: "u2", s: 1, e: 3, status: "cancelled" },
  { unit: "u3", s: -5, e: 20, status: "ok" },
  { unit: "u4", s: 0, e: 3, status: "ok" },
  { unit: "u5", s: 0, e: 5, status: "ok" },
  { unit: "u9", s: 0, e: 1, status: "ok" },
  { unit: "u2", s: 5, e: 4, status: "ok" },
];

export const MAP: UtilizationMap = {
  supply_table: "units",
  supply_key_field: "id",
  location_fields: ["city", "region"],
  active_field: "state",
  active_values: ["live"],
  occupancy_table: "stays",
  occupancy_unit_field: "unit_id",
  occupancy_start_field: "starts_at",
  occupancy_end_field: "ends_at",
  occupancy_status_field: "status",
  occupying_values: ["ok"],
};

export const EXPECT = {
  north: { units: 3, capacity_unit_days: 30, booked_unit_days: 8, occupancy: 0.267, double_booked_unit_days: 2, occupying_rows: 3 },
  south: { units: 1, capacity_unit_days: 10, booked_unit_days: 10, occupancy: 1, double_booked_unit_days: 0, occupying_rows: 1 },
  totals: { units: 5, capacity_unit_days: 50, booked_unit_days: 23, occupancy: 0.46, double_booked_unit_days: 2 },
  coverage: {
    units_without_location: 1,
    booked_unit_days_without_location: 5,
    duplicate_unit_keys: 0,
    units_without_key: 0,
    rows_on_units_not_active_today: 2,
    unit_days_on_units_not_active_today: 4,
    rows_without_unit: 0,
    rows_end_not_after_start: 1,
  },
};
