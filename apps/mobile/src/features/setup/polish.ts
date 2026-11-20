
export type CompanyForm = { company_name: string; domain: string; what_we_sell: string; competitors: string[] };
export const EMPTY_FORM: CompanyForm = { company_name: "", domain: "", what_we_sell: "", competitors: [] };

export const FILLABLE = ["company_name", "what_we_sell", "competitors"] as const;
export type Fillable = (typeof FILLABLE)[number];
export const isFillable = (k: string): k is Fillable => (FILLABLE as readonly string[]).includes(k);

export const FIELD_LABEL: Record<keyof CompanyForm, string> = {
  company_name: "company name",
  domain: "website",
  what_we_sell: "one-liner",
  competitors: "competitors",
};

export function splitCompetitors(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function formFromFacts(facts: ReadonlyArray<{ key: string; value_text: string | null }>): CompanyForm {
  const get = (k: string) => (facts.find((f) => f.key === k)?.value_text ?? "").trim();
  return {
    company_name: get("company_name"),
    domain: get("domain"),
    what_we_sell: get("what_we_sell"),
    competitors: splitCompetitors(get("competitors")),
  };
}

export function displayedFacts(after: CompanyForm, before?: CompanyForm): Array<{ key: keyof CompanyForm; value: string }> {
  const out: Array<{ key: keyof CompanyForm; value: string }> = [];
  const join = (l: string[]) => l.map((s) => s.trim()).filter(Boolean).join(", ");
  const values: Array<[keyof CompanyForm, string, string]> = [
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

export function addCompetitor(list: readonly string[], name: string): string[] {
  const v = name.trim();
  if (!v || list.some((c) => c.toLowerCase() === v.toLowerCase())) return [...list];
  return [...list, v];
}

export function withSuggested(list: readonly string[], names: readonly string[]): string[] {
  return names.reduce<string[]>((acc, n) => addCompetitor(acc, n), [...list]);
}

type Val = string | string[];
const same = (a: Val, b: Val) => JSON.stringify(a) === JSON.stringify(b);

export type FileTag = { file: string; guess: Val };
export type FileOffer = { file: string; value: Val };

export function mergeFileFacts(input: {
  next: CompanyForm;
  form: CompanyForm;
  before: CompanyForm;
  touched: ReadonlySet<string>;
  file: string;
  firstReadFailed: boolean;
}): { form: CompanyForm; before: CompanyForm; tags: Partial<Record<Fillable, FileTag>>; offers: Partial<Record<Fillable, FileOffer>> } {
  const { next, form, before, touched, file } = input;
  const nextBefore: CompanyForm = { ...before };
  const nextForm: CompanyForm = { ...form };
  const tags: Partial<Record<Fillable, FileTag>> = {};
  const offers: Partial<Record<Fillable, FileOffer>> = {};
  if (input.firstReadFailed && !touched.has("domain")) {
    nextBefore.domain = next.domain;
    nextForm.domain = next.domain;
  }
  for (const k of FILLABLE) {
    if (same(next[k], before[k])) continue;
    if (!touched.has(k)) {
      tags[k] = { file, guess: form[k] };
      (nextForm as Record<string, Val>)[k] = next[k];
    } else if (!same(form[k], next[k])) {
      offers[k] = { file, value: next[k] };
    }
    (nextBefore as Record<string, Val>)[k] = next[k];
  }
  return { form: nextForm, before: nextBefore, tags, offers };
}

export function leftToFile(input: {
  fileUnknown: boolean;
  touched: ReadonlySet<string>;
  tagged: ReadonlySet<string>;
}): Fillable[] {
  if (!input.fileUnknown) return [];
  return FILLABLE.filter((k) => !input.touched.has(k) && !input.tagged.has(k));
}
