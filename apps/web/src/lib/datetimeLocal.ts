export function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function datetimeLocalToFutureIso(
  value: string,
  now: () => number = Date.now,
): { iso: string } | { error: string } {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: "Invalid schedule time." };
  if (d.getTime() <= now()) return { error: "Schedule time must be in the future." };
  return { iso: d.toISOString() };
}
