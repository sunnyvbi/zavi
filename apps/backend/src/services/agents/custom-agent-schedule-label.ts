
const ZONE_LABELS: Record<string, string> = {
  "America/Los_Angeles": "PT",
  "America/Vancouver": "PT",
  "America/Denver": "MT",
  "America/Phoenix": "MT",
  "America/Chicago": "CT",
  "America/New_York": "ET",
  "America/Toronto": "ET",
  "Asia/Kolkata": "IST",
  "Asia/Calcutta": "IST",
  "Europe/London": "UK",
  UTC: "UTC",
  "Etc/UTC": "UTC",
  GMT: "UTC",
};

export function zoneLabel(tz: string): string {
  if (ZONE_LABELS[tz]) return ZONE_LABELS[tz];
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function dayPhrase(dow: string): string | null {
  if (dow === "*") return "Every day";
  if (dow === "1-5") return "Weekdays";
  if (dow === "0,6" || dow === "6,0" || dow === "6,7" || dow === "6-7") return "Weekends";
  if (!/^[0-7](,[0-7])*$/.test(dow)) return null;
  const days = [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `Every ${joinAnd(days.map((d) => DAY_NAMES[d]))}`;
}

function intervalPhrase(min: string, hour: string, dom: string, mon: string, dow: string): string | null {
  if (dom !== "*" || mon !== "*" || dow !== "*") return null;
  const every = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  const minStep = min.match(/^\*\/(\d{1,2})$/);
  if (minStep && hour === "*") return every(Number(minStep[1]), "minute");
  if (/^\d{1,2}$/.test(min) && Number(min) === 0) {
    if (hour === "*") return every(1, "hour");
    const hourStep = hour.match(/^\*\/(\d{1,2})$/);
    if (hourStep) return every(Number(hourStep[1]), "hour");
  }
  return null;
}

export function scheduleLabel(cron: string, tz?: string): string {
  const fields = cron.trim().split(/\s+/);
  const fallback = `Custom schedule (${cron.trim()})`;
  if (fields.length !== 5) return fallback;
  const [min, hour, dom, mon, dow] = fields;
  const interval = intervalPhrase(min, hour, dom, mon, dow);
  if (interval) return interval;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== "*" || mon !== "*") return fallback;
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return fallback;
  const days = dayPhrase(dow);
  if (!days) return fallback;
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return `${days} at ${time}${tz ? ` (${zoneLabel(tz)})` : ""}`;
}

