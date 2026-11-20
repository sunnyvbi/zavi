import { budgetOn, type LiveUpcar } from "@/lib/marketing/liveUpcar";

const DAY_MS = 86400000;
const etKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
const sumOrNull = (xs: (number | null)[]) => (xs.length === 0 || xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0));

const addDays = (key: string, k: number) => new Date(Date.parse(`${key}T12:00:00Z`) + k * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
function ninePmEt(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  const hourEt = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(new Date(ms));
  const edt = Date.UTC(y, m - 1, d, 25);
  return hourEt(edt) === "21" ? edt : Date.UTC(y, m - 1, d, 26);
}

export function replayInstant(clock: LiveUpcar["clock"], n: number, realNowMs: number): number {
  return Math.min(realNowMs, ninePmEt(addDays(etKey(Date.parse(clock.start_at)), n - 1)));
}

export function parseDayParam(raw: string | undefined, clock: LiveUpcar["clock"], nowMs: number): number | null {
  if (!raw || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  const startKey = etKey(Date.parse(clock.start_at));
  const runDays = dayDiff(startKey, etKey(Date.parse(clock.end_at))) + 1;
  const today = dayDiff(startKey, etKey(nowMs)) + 1;
  if (n < 1 || n > Math.min(runDays, today)) return null;
  return replayInstant(clock, n, nowMs) >= Date.parse(clock.unlock_at) ? n : null;
}

export function asOfDay(d: LiveUpcar, n: number, realNowMs: number): { data: LiveUpcar; nowMs: number } {
  const nowMs = replayInstant(d.clock, n, realNowMs);
  const cutoff = addDays(etKey(Date.parse(d.clock.start_at)), n - 1);
  const nums = d.numbers;
  const budget = budgetOn(d, cutoff);
  let numbers: LiveUpcar["numbers"] = null;
  if (nums) {
    const by_day = [...nums.by_day].sort((a, b) => (a.day < b.day ? -1 : 1)).filter((r) => r.day <= cutoff);
    const sum = sumOrNull(by_day.map((r) => r.spent_usd));
    const spent = sum === null ? null : Math.round(sum * 100) / 100;
    const openDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(nowMs));
    const recent = by_day.filter((r) => r.day < openDay).slice(-5);
    const recentSum = sumOrNull(recent.map((r) => r.spent_usd));
    const perDay = recentSum === null ? null : Math.round(recentSum / recent.length);
    numbers = {
      ...nums,
      spent_usd: spent,
      spend_per_day_recent_usd: perDay,
      runs_out_day: perDay && spent !== null ? n + Math.ceil(Math.max(0, budget - spent) / perDay) : null,
      bookings: sumOrNull(by_day.map((r) => r.bookings)),
      hosts: sumOrNull(by_day.map((r) => r.hosts)),
      booking_value_usd: sumOrNull(by_day.map((r) => r.booking_value_usd)),
      by_day,
    };
  }
  return {
    nowMs,
    data: {
      ...d,
      budget_usd: budget,
      budget_raise: d.budget_raise && cutoff >= d.budget_raise.on ? d.budget_raise : null,
      numbers,
      days: d.days.filter((e) => e.day <= cutoff),
      now_line: { last_review_at: null, changes_today: 0, channels_today: [] },
    },
  };
}
