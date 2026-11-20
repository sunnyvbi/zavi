
const round2 = (n: number) => Math.round(n * 100) / 100;

export const MAKE_ROOM_FLOOR_USD = 5;

export function freedDailyUsd(h: { held_daily_usd: number; base_usd: number }, from: number, to: number): number {
  const at = (b: number) => Math.min(h.held_daily_usd, Math.max(0, b - h.base_usd));
  return round2(Math.max(0, at(from) - at(to)));
}

export function roomOfDaily(daily: number, days_left: number, margin: number): number {
  return Math.floor(daily * Math.max(1, days_left) * Math.max(1, margin) * 100) / 100;
}

export type MakeRoomSizing = {
  from_usd: number;
  hold_daily_usd: number;
  base_usd: number;
  need_daily_usd: number;
  step: number;
  floor_usd: number;
};

export function makeRoomTo(p: MakeRoomSizing): number {
  const cur = Math.min(p.hold_daily_usd, Math.max(0, p.from_usd - p.base_usd));
  const exact = p.base_usd + Math.max(0, cur - p.need_daily_usd);
  return Math.ceil(Math.max(exact, p.from_usd * (1 - p.step), p.floor_usd) * 100) / 100;
}
