
import { isSentinelRegion } from "./regions";

export type BalanceLabel =
  | "demand_heavy"
  | "supply_heavy"
  | "balanced"
  | "insufficient_data"
  | "supply_unknown"
  | "not_enough_locations"
  | "not_compared";

export const BALANCE_MIN_SUPPLY = 3;
export const BALANCE_MIN_EXPECTED = 5;
export const BALANCE_MIN_COMPARABLE = 3;
export const BALANCE_HIGH_INDEX = 1.5;
export const BALANCE_LOW_INDEX = 0.67;
export const BALANCE_MIN_Z = 2;

export type BalanceInput = { key: string; demand: number; supply: number | null };
export type BalanceResult = { label: BalanceLabel; demand_index: number | null };

export function relativeBalance(
  inputs: BalanceInput[],
  opts: { min_demand?: number } = {},
): Map<string, BalanceResult> {
  const min_demand = opts.min_demand ?? 0;
  const out = new Map<string, BalanceResult>();
  const candidates: BalanceInput[] = [];
  for (const input of inputs) {
    if (isSentinelRegion(input.key)) {
      out.set(input.key, { label: "not_compared", demand_index: null });
    } else if (input.supply == null) {
      out.set(input.key, { label: "supply_unknown", demand_index: null });
    } else if (input.supply < BALANCE_MIN_SUPPLY || input.demand < min_demand) {
      out.set(input.key, { label: "insufficient_data", demand_index: null });
    } else {
      candidates.push(input);
    }
  }

  const D = candidates.reduce((sum, c) => sum + Math.max(0, c.demand), 0);
  const S = candidates.reduce((sum, c) => sum + Math.max(0, c.supply ?? 0), 0);
  const scored: Array<{ key: string; index: number; z: number } | { key: string; index: null }> = [];
  for (const c of candidates) {
    const d = Math.max(0, c.demand);
    const s = Math.max(0, c.supply ?? 0);
    const otherSupply = S - s;
    const expected = otherSupply > 0 ? (s * (D - d)) / otherSupply : 0;
    if (!(expected >= BALANCE_MIN_EXPECTED)) {
      scored.push({ key: c.key, index: null });
      continue;
    }
    scored.push({ key: c.key, index: d / expected, z: (d - expected) / Math.sqrt(expected) });
  }

  const comparable = scored.filter((s) => s.index != null).length;
  for (const s of scored) {
    if (comparable < BALANCE_MIN_COMPARABLE) {
      out.set(s.key, { label: "not_enough_locations", demand_index: null });
      continue;
    }
    if (s.index == null) {
      out.set(s.key, { label: "insufficient_data", demand_index: null });
      continue;
    }
    const { index, z } = s as { index: number; z: number };
    const label: BalanceLabel =
      index >= BALANCE_HIGH_INDEX && z >= BALANCE_MIN_Z
        ? "demand_heavy"
        : index <= BALANCE_LOW_INDEX && z <= -BALANCE_MIN_Z
          ? "supply_heavy"
          : "balanced";
    out.set(s.key, { label, demand_index: Math.round(index * 100) / 100 });
  }
  return out;
}
