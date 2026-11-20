
export function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

export function shouldShowDayDivider(
  prevIso: string | undefined,
  curIso: string,
): boolean {
  if (!prevIso) return true;
  try {
    return dayKey(prevIso) !== dayKey(curIso);
  } catch {
    return false;
  }
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";

  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function shouldShowChatDayDivider(prevIso: string | undefined, curIso: string): boolean {
  if (!prevIso) return dayLabel(curIso) !== "Today";
  return shouldShowDayDivider(prevIso, curIso);
}

export const TIME_STAMP_GAP_MS = 60 * 60 * 1000;

export function shouldShowTimeStamp(prevIso: string | undefined, curIso: string): boolean {
  if (shouldShowDayDivider(prevIso, curIso)) return true;
  const gap = Date.parse(curIso) - Date.parse(prevIso ?? "");
  return Number.isFinite(gap) && gap >= TIME_STAMP_GAP_MS;
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function fullTimestamp(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  try {
    return new Date(iso).toLocaleString([], {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return undefined;
  }
}
