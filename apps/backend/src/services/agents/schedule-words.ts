
import { validateCronExpression } from "../../../workers/functions/cron-match";

export type ScheduleRefusal = "too_frequent" | "minutes";
export type ScheduleWords = { ok: true; cron: string } | { ok: false; reason?: ScheduleRefusal };

export const SCHEDULE_REFUSAL_MESSAGES: Record<ScheduleRefusal, string> = {
  too_frequent: "The shortest schedule is every 15 minutes.",
  minutes: "Minutes work as every 15, 20 or 30 minutes.",
};

const DAY_TOKENS: Record<string, number> = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6,
};
const ALL_DAYS = ["day", "days", "daily"];
const WEEKDAYS = ["weekday", "weekdays"];
const WEEKENDS = ["weekend", "weekends"];
const FILLER = new Set(["every", "each", "on", "run", "runs", "and", "at"]);

const HOUR_STEPS = new Set([1, 2, 3, 4, 6, 8, 12]);
const MINUTE_STEPS = new Set([15, 20, 30]);

const TIME_RE =
  /(?:\bat\s+)?\b(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(a\.m\.?|p\.m\.?|am|pm)?)(?=\s|,|$)/;

type Time = { h: number; m: number };

function takeTime(text: string): { time: Time | null | "bad"; rest: string } {
  const match = text.match(TIME_RE);
  if (!match) return { time: null, rest: text };
  const [whole, word, hh, mm, ampmRaw] = match;
  const hasAt = /^at\s/.test(whole);
  const rest = `${text.slice(0, match.index)} ${text.slice((match.index ?? 0) + whole.length)}`;
  if (word === "noon") return { time: { h: 12, m: 0 }, rest };
  if (word === "midnight") return { time: { h: 0, m: 0 }, rest };
  if (!hasAt && mm === undefined && !ampmRaw) return { time: null, rest: text };
  let h = Number(hh);
  const m = mm === undefined ? 0 : Number(mm);
  if (m > 59) return { time: "bad", rest };
  const ampm = ampmRaw?.replace(/\./g, "");
  if (ampm) {
    if (h < 1 || h > 12) return { time: "bad", rest };
    h = (h % 12) + (ampm === "pm" ? 12 : 0);
  } else if (h > 23) {
    return { time: "bad", rest };
  }
  return { time: { h, m }, rest };
}

function interval(text: string): string | ScheduleRefusal | null {
  if (text === "hourly" || /^(every|each) hour$/.test(text)) return "0 * * * *";
  if (/^(every|each) minute$/.test(text)) return "too_frequent";
  const n = text.match(/^(?:every|each) (\d{1,3}) ?(hours?|hrs?|minutes?|mins?)$/);
  if (!n) return null;
  const count = Number(n[1]);
  if (n[2].startsWith("h")) {
    if (!HOUR_STEPS.has(count)) return null;
    return count === 1 ? "0 * * * *" : `0 */${count} * * *`;
  }
  if (MINUTE_STEPS.has(count)) return `*/${count} * * * *`;
  return count < 15 ? "too_frequent" : "minutes";
}

function dayField(text: string): string | null {
  const words = text.split(/[\s,]+/).filter((w) => w && !FILLER.has(w));
  if (words.length === 0) return null;
  if (words.length === 1 && ALL_DAYS.includes(words[0])) return "*";
  if (words.length === 1 && WEEKDAYS.includes(words[0])) return "1-5";
  if (words.length === 1 && WEEKENDS.includes(words[0])) return "0,6";
  const days = new Set<number>();
  for (const w of words) {
    if (!(w in DAY_TOKENS)) return null;
    days.add(DAY_TOKENS[w]);
  }
  if (days.size === 7) return "*";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(",") === "1,2,3,4,5") return "1-5";
  return sorted.join(",");
}

export function parseScheduleWords(input: string): ScheduleWords {
  const text = (input ?? "")
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 200) return { ok: false };

  const iv = interval(text);
  if (iv === "too_frequent" || iv === "minutes") return { ok: false, reason: iv };
  if (iv) return validateCronExpression(iv) === null ? { ok: true, cron: iv } : { ok: false };

  const { time, rest } = takeTime(text);
  if (time === "bad") return { ok: false };
  const dow = dayField(rest.replace(/\s+/g, " ").trim());
  if (dow === null) return { ok: false };
  const { h, m } = time ?? { h: 9, m: 0 };
  const cron = `${m} ${h} * * ${dow}`;
  return validateCronExpression(cron) === null ? { ok: true, cron } : { ok: false };
}
