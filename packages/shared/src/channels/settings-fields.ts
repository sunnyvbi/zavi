export const WRITES_ELSEWHERE_FIELD_IDS = [
  "budget",
  "cadence",
  "autonomy",
  "email_test_lists",
] as const;

export type WritesElsewhereFieldId = (typeof WRITES_ELSEWHERE_FIELD_IDS)[number];

export function writesElsewhere(fieldId: string): boolean {
  return (WRITES_ELSEWHERE_FIELD_IDS as readonly string[]).includes(fieldId);
}

export const RETIRED_SETTING_KEYS = ["ugc:production_route", "email_marketing:esp"] as const;

const RETIRED_SETTING_SET: ReadonlySet<string> = new Set(RETIRED_SETTING_KEYS);

export function isRetiredSetting(slug: string, fieldId: string): boolean {
  return RETIRED_SETTING_SET.has(`${slug}:${fieldId}`);
}
