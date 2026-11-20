
export type TimeZoneOption = { value: string; label: string };

export const COMMON_TIME_ZONES: TimeZoneOption[] = [
  { value: "America/Los_Angeles", label: "Los Angeles (PT)" },
  { value: "America/Denver", label: "Denver (MT)" },
  { value: "America/Phoenix", label: "Phoenix (MST)" },
  { value: "America/Chicago", label: "Chicago (CT)" },
  { value: "America/New_York", label: "New York (ET)" },
  { value: "America/Toronto", label: "Toronto (ET)" },
  { value: "America/Mexico_City", label: "Mexico City (CST)" },
  { value: "America/Sao_Paulo", label: "Sao Paulo (BRT)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Dublin", label: "Dublin (GMT/IST)" },
  { value: "Europe/Paris", label: "Paris (CET)" },
  { value: "Europe/Berlin", label: "Berlin (CET)" },
  { value: "Europe/Madrid", label: "Madrid (CET)" },
  { value: "Europe/Amsterdam", label: "Amsterdam (CET)" },
  { value: "Europe/Warsaw", label: "Warsaw (CET)" },
  { value: "Africa/Lagos", label: "Lagos (WAT)" },
  { value: "Africa/Johannesburg", label: "Johannesburg (SAST)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Singapore", label: "Singapore (SGT)" },
  { value: "Asia/Hong_Kong", label: "Hong Kong (HKT)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Asia/Seoul", label: "Seoul (KST)" },
  { value: "Australia/Sydney", label: "Sydney (AET)" },
  { value: "Pacific/Auckland", label: "Auckland (NZT)" },
  { value: "UTC", label: "UTC" },
];

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timeZoneLabel(tz: string): string {
  const known = COMMON_TIME_ZONES.find((z) => z.value === tz);
  if (known) return known.label;
  const city = (tz.split("/").pop() ?? tz).replace(/_/g, " ");
  try {
    const short = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return short ? `${city} (${short})` : city;
  } catch {
    return city;
  }
}

export function timeZoneOptions(extra?: string | null): TimeZoneOption[] {
  const list = [...COMMON_TIME_ZONES];
  const add = (tz: string | null | undefined) => {
    if (!tz) return;
    if (list.some((z) => z.value === tz)) return;
    list.push({ value: tz, label: timeZoneLabel(tz) });
  };
  add(browserTimeZone());
  add(extra);
  return list;
}

export function formatInZone(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toUTCString();
  }
}

export function formatTimeOfDay(value: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const hour = Number(m[1]);
  const minute = m[2];
  const hour12 = ((hour + 11) % 12) + 1;
  return `${hour12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}
