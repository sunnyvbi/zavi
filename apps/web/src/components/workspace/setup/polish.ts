
export type CompanyForm = { company_name: string; domain: string; what_we_sell: string; competitors: string[] };
export const EMPTY_FORM: CompanyForm = { company_name: "", domain: "", what_we_sell: "", competitors: [] };

export function formFromFacts(facts: ReadonlyArray<{ key: string; value_text: string | null }>): CompanyForm {
  const get = (k: string) => (facts.find((f) => f.key === k)?.value_text ?? "").trim();
  return {
    company_name: get("company_name"),
    domain: get("domain"),
    what_we_sell: get("what_we_sell"),
    competitors: get("competitors").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export function displayedFacts(after: CompanyForm, before?: CompanyForm): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const join = (l: string[]) => l.map((s) => s.trim()).filter(Boolean).join(", ");
  const values: Array<[string, string, string]> = [
    ["company_name", after.company_name.trim(), before?.company_name.trim() ?? ""],
    ["domain", after.domain.trim(), before?.domain.trim() ?? ""],
    ["what_we_sell", after.what_we_sell.trim(), before?.what_we_sell.trim() ?? ""],
    ["competitors", join(after.competitors), before ? join(before.competitors) : ""],
  ];
  for (const [key, value, was] of values) {
    if (value || was) out.push({ key, value });
  }
  return out;
}

export type Slot = "primary" | "accent" | "bg" | "text";
export const SLOT_LABEL: Record<Slot, string> = { primary: "Main", accent: "Accent", bg: "Background", text: "Text" };
export type Slots = Record<Slot, string | null>;
const ORDER: Slot[] = ["primary", "accent", "bg", "text"];

export function kitToSlots(k: { primary: string; accent: string | null; bg: string | null; text: string | null }): Slots {
  return { primary: k.primary, accent: k.accent, bg: k.bg, text: k.text };
}
export function addColour(s: Slots, hex: string): Slots {
  const free = ORDER.find((slot) => !s[slot]);
  return free ? { ...s, [free]: hex } : s;
}
export function removeColour(s: Slots, slot: Slot): Slots {
  if (!canRemoveColour(s)) return s;
  if (slot !== "primary") return { ...s, [slot]: null };
  const next = ORDER.slice(1).find((k) => s[k]);
  return next ? { ...s, primary: s[next], [next]: null } : s;
}
export const canRemoveColour = (s: Slots) => ORDER.filter((k) => s[k]).length > 1;
export function slotsToBody(s: Slots): Slots {
  return { primary: s.primary, accent: s.accent ?? null, bg: s.bg ?? null, text: s.text ?? null };
}
export const DEFAULT_NEW_COLOUR = "#46658a";
