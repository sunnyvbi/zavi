
export type SettingItem = {
  id?: string;
  item: string;
  item_type?: string | null;
  status?: string | null;
  position?: number | null;
  note?: string | null;
  origin?: string | null;
  detail?: string | null;
};

export type ChoiceField = { kind: "choice"; id: string; label: string; help: string; options: Array<{ value: string; label: string }> };

export type ListField = {
  kind: "list";
  id: string;
  label: string;
  help: string;
  itemTypes?: string[];
  itemTypeOptions?: { unsetLabel: string; label: (item: string) => string; options: Array<{ value: string; label: string }> };
  suggest?: string;
};

export type ToggleField = { kind: "toggle"; id: string; label: string; help: string; on: string; off: string };

export type ChannelSettingField = ChoiceField | ListField | ToggleField;

export const firstItem = (items: SettingItem[] | undefined): string | null => (items && items.length ? items[0].item : null);

export function addItem(items: SettingItem[], text: string, field: ListField): SettingItem[] {
  const t = text.trim().slice(0, 300);
  if (!t) return items;
  const i = items.findIndex((x) => x.item === t);
  if (i >= 0) return items.map((x, j) => (j === i ? { ...x, status: "tracking" } : x));
  return [...items, { item: t, item_type: field.itemTypes?.[0] ?? null, status: "tracking", origin: "custom" }];
}

export function visibleItems(items: SettingItem[], field: ListField, fresh: boolean): SettingItem[] {
  if (!field.suggest || fresh) return items;
  return items.filter((x) => x.status !== "suggested");
}

export function emptyListText(items: SettingItem[], visible: SettingItem[]): string | null {
  if (visible.length) return null;
  if (!items.length) return "Nothing here yet. Zavi uses the whole channel until you narrow it.";
  const n = items.length;
  return `${n} ${n === 1 ? "suggestion" : "suggestions"} from an earlier run ${n === 1 ? "is" : "are"} hidden, because a suggestion goes stale. Press Suggest for a fresh set, or type a term to track it directly.`;
}

export function putItems(items: SettingItem[]): SettingItem[] {
  return items.map(({ id: _id, ...rest }) => {
    const out: SettingItem = { item: rest.item };
    for (const k of ["item_type", "status", "position", "note", "origin", "detail"] as const) {
      const v = rest[k];
      if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  });
}

export const toggleOn = (items: SettingItem[] | undefined) => items?.[0]?.item === "on";

export const OWNER_ADMIN_ONLY = "Only an owner or an admin can change this.";

export function canEditSettings(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function saveNote(failedStatuses: Array<number | null>, total: number): string {
  if (failedStatuses.length === 0) return "Saved. Applies on the next run.";
  if (failedStatuses.includes(403)) return OWNER_ADMIN_ONLY;
  return `${failedStatuses.length} of ${total} didn't save. Your changes are still here — press Save to try again.`;
}
