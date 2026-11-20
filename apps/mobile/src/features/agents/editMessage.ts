
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MessageLike = {
  id: string;
  sender_role: string;
  attachments?: readonly unknown[] | null;
};

export function editableMessageIds(
  messages: readonly MessageLike[],
  hasVideo: (id: string) => boolean,
): Set<string> {
  const ids = new Set<string>();
  let nextIsUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender_role === "system") continue;
    const isUser = m.sender_role === "user";
    if (isUser && !nextIsUser && UUID.test(m.id) && !m.attachments?.length && !hasVideo(m.id)) {
      ids.add(m.id);
    }
    nextIsUser = isUser;
  }
  return ids;
}

export function rowsFromMessage(messages: readonly { id: string }[], messageId: string): string[] {
  const start = messages.findIndex((m) => m.id === messageId);
  return start < 0 ? [] : messages.slice(start).map((m) => m.id);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function messageMenuTime(iso: string, now: Date = new Date()): string | null {
  const sent = new Date(iso);
  if (Number.isNaN(sent.getTime())) return null;
  const hour = sent.getHours();
  const time = `${hour % 12 || 12}:${String(sent.getMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(sent)) / 86400000);
  if (daysAgo < 7) return `${WEEKDAYS[sent.getDay()]}, ${time}`;
  const year = sent.getFullYear() === now.getFullYear() ? "" : `, ${sent.getFullYear()}`;
  return `${MONTHS[sent.getMonth()]} ${sent.getDate()}${year}, ${time}`;
}
