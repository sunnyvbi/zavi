
import { settingsFieldRole, settingsFieldUnit, type SettingsFieldRole, type SettingsFieldUnit } from "@zavi/shared";

type SettingsItem = {
  item?: unknown;
  item_type?: unknown;
  status?: unknown;
  note?: unknown;
  detail?: unknown;
  origin?: unknown;
};

const MAX_ITEMS_PER_FIELD = 12;
const MAX_ITEM_CHARS = 200;
const MAX_ITEM_TYPE_CHARS = 40;

function sanitize(raw: string, max: number): { text: string; cut: boolean } {
  const collapsed = raw.replace(/[\s\u0085]+/g, " ").trim();
  if (collapsed.length <= max) return { text: collapsed, cut: false };
  return { text: `${collapsed.slice(0, max - 1)}…`, cut: true };
}

function quoted(text: string): string {
  return JSON.stringify(text);
}

function itemsOf(rows: unknown): { values: string[]; dropped: number; cut: number } {
  if (!Array.isArray(rows)) return { values: [], dropped: 0, cut: 0 };
  const out: string[] = [];
  let dropped = 0;
  let cut = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = (row as SettingsItem).item;
    if (typeof item !== "string") continue;
    const value = sanitize(item, MAX_ITEM_CHARS);
    if (!value.text) continue;
    if (out.length >= MAX_ITEMS_PER_FIELD) {
      dropped += 1;
      continue;
    }
    if (value.cut) cut += 1;
    const rawKind = (row as SettingsItem).item_type;
    const kind = typeof rawKind === "string" ? sanitize(rawKind, MAX_ITEM_TYPE_CHARS) : null;
    out.push(
      kind && kind.text
        ? `${quoted(value.text)} (${quoted(kind.text)})`
        : quoted(value.text),
    );
  }
  return { values: out, dropped, cut };
}

function clauseFor(role: SettingsFieldRole | null): string | null {
  switch (role) {
    case "own_account":
      return "this company's OWN account on this channel, named by the founder";
    case "other_accounts":
      return "OTHER people's accounts the founder chose for you to work with. Never this company's own";
    case "target":
      return "a figure the founder is aiming AT. Their target, not a measurement of what happened";
    case "ceiling":
      return "the MOST the founder will go to. Stay at or under it. Not a figure to aim at";
    case "floor":
      return "the LEAST the founder will accept. Stay at or above it. Not a figure to aim at";
    case "worth":
      return "what the founder says this is worth to them. A figure to divide by, never one to spend toward, and not a measured result";
    case "destination":
      return "a URL the founder gave for this channel";
    default:
      return null;
  }
}

const UNIT_CLAUSE: Record<SettingsFieldUnit, string> = {
  USD: "in US dollars. Ad platforms report spend in the ad account's own currency, so convert to the same currency before comparing the two, and if you cannot, say the figures are in different currencies instead of comparing them",
};

function line(
  role: SettingsFieldRole | null,
  fieldId: string,
  values: string[],
  dropped: number,
  cut: number,
  unit: SettingsFieldUnit | null = null,
): string {
  const clause = [clauseFor(role), unit ? UNIT_CLAUSE[unit] : null].filter(Boolean).join(", ") || null;
  const head = clause ? `- ${fieldId} (${clause}):` : `- ${fieldId}:`;
  const caveats: string[] = [];
  if (dropped > 0) {
    caveats.push(`showing ${values.length} of ${values.length + dropped}`);
  }
  if (cut > 0) {
    caveats.push(cut === 1 ? "1 value shown shortened" : `${cut} values shown shortened`);
  }
  const suffix =
    caveats.length > 0 ? ` (${caveats.join("; ")}; the full text is in the settings above)` : "";
  return `${head} ${values.join(", ")}${suffix}`;
}

const HEADER =
  "Saved by this company in this channel's Settings tab, which is where they answer these " +
  "questions directly. Each line names the field, says what that kind of value is, then " +
  "gives the saved values in quotes:";

export function buildChannelSettingsNote(
  channelSlug: string,
  channelSettings: unknown,
): string | null {
  if (!channelSettings || typeof channelSettings !== "object" || Array.isArray(channelSettings)) {
    return null;
  }
  const lines: string[] = [];
  for (const [fieldId, rows] of Object.entries(channelSettings as Record<string, unknown>)) {
    const { values, dropped, cut } = itemsOf(rows);
    if (values.length === 0) continue;
    lines.push(
      line(settingsFieldRole(channelSlug, fieldId), fieldId, values, dropped, cut, settingsFieldUnit(channelSlug, fieldId)),
    );
  }
  if (lines.length === 0) return null;
  return [HEADER, ...lines].join("\n");
}

export function withChannelSettingsNote(
  block: string,
  channelSlug: string,
  channelSettings: unknown,
): string {
  const note = buildChannelSettingsNote(channelSlug, channelSettings);
  if (!note) return block;
  if (block.endsWith(note)) return block;
  return `${block}\n\n${note}`;
}
