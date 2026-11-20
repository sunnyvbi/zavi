export function formatDate(
  value: string | null | undefined,
  locale: string,
  timeZone: string,
  format: "date" | "short" | "dateTime" = "date",
): string {
  if (!value) return "-";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(format === "date" ? { year: "numeric" as const } : {}),
    ...(format === "dateTime" ? { hour: "numeric" as const, minute: "2-digit" as const } : {}),
    timeZone,
  }).format(date);
}
