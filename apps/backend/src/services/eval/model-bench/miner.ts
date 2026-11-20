
import { parsePromptSnapshot } from "@/services/eval/shadow-harness";
import { assertBenchTenant } from "./tenants";
import type { BenchCohort } from "./fixtures";

export const DISABLED_AGENTS: ReadonlySet<string> = new Set([
  "growth-lead",
  "performance-marketer",
  "seo-geo",
]);

export const NOT_MEASURABLE: ReadonlyMap<string, string> = new Map([
  ["qa", "needs a qa sandbox (v2)"],
  ["browser-operator", "needs a safe browser mode (v2)"],
  ["generated_video", "video tasks not built yet (v2)"],
]);

export const PARTIAL_READ_CHANNELS: ReadonlyMap<string, string> = new Map([
  ["reddit_organic", "some platform reads not allowlisted"],
  ["x_organic", "some platform reads not allowlisted"],
  ["youtube_organic", "some platform reads not allowlisted"],
]);

export const REQUIRED_ROLE_UNITS: readonly string[] = [
  "advisor",
  "browser-operator",
  "cgo",
  "chief-of-staff",
  "content-design",
  "dispute-response",
  "engineer",
  "fundraising",
  "generated_video",
  "onboarding-discovery",
  "operator",
  "pm",
  "qa",
  "research",
  "supply-demand-balancer",
  "support-lead",
];

export const REQUIRED_CHANNEL_UNITS: readonly string[] = [
  "blog",
  "chatgpt_ads",
  "email_marketing",
  "geo",
  "google_ads",
  "instagram_organic",
  "linkedin_ads",
  "linkedin_organic",
  "meta_ads",
  "pinterest_organic",
  "reddit_ads",
  "reddit_organic",
  "seo",
  "sms",
  "tiktok_ads",
  "tiktok_organic",
  "ugc",
  "x_organic",
  "youtube_ads",
  "youtube_organic",
];

export function measurableUnits(): Array<{ unit: string; cohort: BenchCohort }> {
  return [
    ...REQUIRED_ROLE_UNITS.filter((u) => !NOT_MEASURABLE.has(u)).map((unit) => ({ unit, cohort: "role" as const })),
    ...REQUIRED_CHANNEL_UNITS.map((unit) => ({ unit, cohort: "channel" as const })),
  ];
}

export const UNIT_SCAN_LIMIT = 50;

const RETRY_OPENER = /^(try again|retry)\b/i;
const BARE_GO_AHEAD = /^(again|continue|go( ahead)?|ok(ay)?|yes|yep|sure)(\s+(do it|please))?[\s.!]*$/i;
const PAYLOAD_REQUEST_KEYS = [
  "idea",
  "message",
  "question",
  "user_message",
  "current_user_text_raw",
  "task_description",
  "current_message",
  "prompt",
  "query",
  "request",
  "text",
] as const;

export function requestText(row: Pick<SourceRunRow, "payload" | "prompt_snapshot" | "trigger">): string {
  const p = row.payload;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    for (const k of PAYLOAD_REQUEST_KEYS) {
      if (typeof o[k] === "string" && (o[k] as string).trim()) return o[k] as string;
    }
    for (const k of ["messages", "history"]) {
      const arr = o[k];
      if (!Array.isArray(arr)) continue;
      const lastUser = [...arr]
        .reverse()
        .find((m) => m && typeof m === "object" && (m as { role?: unknown }).role === "user");
      const c = (lastUser as { content?: unknown } | undefined)?.content;
      if (typeof c === "string" && c.trim()) return c;
    }
  }
  return parsePromptSnapshot(row.prompt_snapshot, row.trigger === "chat")?.initial_user ?? "";
}

export function isTrivialRequest(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && (RETRY_OPENER.test(t) || BARE_GO_AHEAD.test(t));
}

const parses = (r: SourceRunRow) => parsePromptSnapshot(r.prompt_snapshot, r.trigger === "chat") !== null;

export function validRowsForUnit(rows: ReadonlyArray<SourceRunRow>, perUnit: number): SourceRunRow[] {
  return rows.filter((r) => usable(r) && !isTrivialRequest(requestText(r))).slice(0, Math.max(0, perUnit));
}

const usable = (r: SourceRunRow) => parses(r) && requestText(r).trim().length > 0;

export function onlyTrivialRuns(rows: ReadonlyArray<SourceRunRow>): boolean {
  const u = rows.filter(usable);
  return u.length > 0 && u.every((r) => isTrivialRequest(requestText(r)));
}

export function missingUnits(
  company: string,
  covered: ReadonlyArray<{ company: string; unit: string }>,
): string[] {
  const have = new Set(covered.filter((c) => c.company === company).map((c) => c.unit));
  return measurableUnits()
    .map((u) => u.unit)
    .filter((u) => !have.has(u));
}

export type SourceRunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  payload: unknown;
  prompt_snapshot: string | null;
  enqueued_at: string;
  raw_response_text?: string | null;
  output_text?: string | null;
};

export type TaskSeed = {
  task_id: string;
  tenant_id: string;
  company: string;
  agent_slug: string;
  unit: string;
  cohort: BenchCohort;
  source_run_id: string;
  input: {
    trigger: string;
    payload: unknown;
    prompt: { system: string; initial_user: string };
  };
};

function unitOf(row: SourceRunRow): { unit: string; cohort: BenchCohort } {
  if (row.trigger === "channel_recipe" && row.payload && typeof row.payload === "object") {
    const ch = (row.payload as { channel_slug?: unknown }).channel_slug;
    if (typeof ch === "string" && ch) return { unit: ch, cohort: "channel" };
  }
  return { unit: row.agent_slug, cohort: "role" };
}

export function selectTaskSeeds(rows: ReadonlyArray<SourceRunRow>, perUnit = 1): TaskSeed[] {
  const sorted = [...rows].sort((a, b) => (a.enqueued_at < b.enqueued_at ? 1 : -1));
  const taken = new Map<string, number>();
  const out: TaskSeed[] = [];
  for (const row of sorted) {
    const tenant = assertBenchTenant(row.tenant_id);
    if (DISABLED_AGENTS.has(row.agent_slug) || NOT_MEASURABLE.has(row.agent_slug)) continue;
    const { unit, cohort } = unitOf(row);
    if (NOT_MEASURABLE.has(unit)) continue;
    const key = `${tenant.company}|${unit}`;
    if ((taken.get(key) ?? 0) >= perUnit) continue;
    const prompt = parsePromptSnapshot(row.prompt_snapshot, row.trigger === "chat");
    if (!prompt) continue;
    const ask = requestText(row);
    if (!ask.trim() || isTrivialRequest(ask)) continue;
    taken.set(key, (taken.get(key) ?? 0) + 1);
    out.push({
      task_id: `${tenant.company}.${unit}.${row.id.slice(0, 8)}`,
      tenant_id: row.tenant_id,
      company: tenant.company,
      agent_slug: row.agent_slug,
      unit,
      cohort,
      source_run_id: row.id,
      input: { trigger: row.trigger, payload: row.payload ?? null, prompt: prompt.initial_user.trim() ? prompt : { ...prompt, initial_user: ask } },
    });
  }
  return out;
}
