import { writesElsewhere } from "@zavi/shared";
import { actionText, type ActionItem, type SettingsField } from "./types";

export type AskableSetting = Extract<SettingsField, { kind: "number" } | { kind: "text" }>;

const QUOTES = /[“”"]/g;

const flat = (s: string) => s.replace(QUOTES, '"').replace(/\s+/g, " ").toLowerCase();

export function settingAskOf(a: ActionItem, settings: readonly SettingsField[] | undefined): AskableSetting | null {
  if (a.executable || a.status !== "pending" || !settings?.length) return null;
  const text = flat([...(a.how_to ?? []), actionText(a) ?? "", a.title ?? ""].join("\n"));
  if (!/\bsettings\b/.test(text)) return null;
  for (const f of settings) {
    if (f.kind !== "number" && f.kind !== "text") continue;
    if (f.writesTo || writesElsewhere(f.id)) continue;
    if (text.includes(`"${flat(f.label)}"`)) return f;
  }
  return null;
}

export function settingAskValue(field: AskableSetting, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Type a value first." };
  if (field.kind === "text") return { ok: true, value };
  const n = Number(value.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return { ok: false, error: "Type a number, digits only." };
  if (field.min !== undefined && n < field.min) return { ok: false, error: `Use ${field.min} or more.` };
  if (field.max !== undefined && n > field.max) return { ok: false, error: `Use ${field.max} or less.` };
  return { ok: true, value: String(n) };
}
