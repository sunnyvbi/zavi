import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getCompanyFacts, type CompanyFacts } from "@/services/company/facts";
import { stripItemIds } from "./item-ids";

export const KEYWORD_TYPES = [
  "brand",
  "product",
  "problem",
  "competitor",
  "category",
  "comparison",
  "industry",
] as const;
export const KEYWORD_STATUSES = ["suggested", "tracking", "paused", "dismissed"] as const;
export const RULES_VERDICTS = ["allowed", "unclear", "banned"] as const;

export type KeywordType = (typeof KEYWORD_TYPES)[number];

export type RedditKeyword = {
  id: string;
  term: string;
  type: (typeof KEYWORD_TYPES)[number];
  origin: "suggested" | "custom";
  status: (typeof KEYWORD_STATUSES)[number];
  why: string | null;
  created_at?: string;
};

export const DEFAULT_TRACKED_COMPETITORS = 3;

export const COMPETITOR_STATUSES = ["suggested", "tracking", "paused", "dismissed"] as const;

export type RedditCompetitor = {
  id: string;
  name: string;
  domain: string | null;
  origin: "suggested" | "custom";
  status: (typeof COMPETITOR_STATUSES)[number];
  why: string | null;
  created_at?: string;
};

export type RedditCommunity = {
  id: string;
  name: string;
  selected: boolean;
  rules_verdict: (typeof RULES_VERDICTS)[number] | null;
  rules_verdict_at: string | null;
  created_at?: string;
};

export type RedditWorkspace = {
  keywords: RedditKeyword[];
  competitors: RedditCompetitor[];
  communities: RedditCommunity[];
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export function normalizeSubreddit(input: string): string | null {
  let s = input.trim();
  const url = s.match(/reddit\.com\/r\/([^/?#\s]+)/i);
  if (url) s = url[1];
  s = s.replace(/^\/?r\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9_]{2,21}$/.test(s) ? s : null;
}

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

export function domainStem(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length >= 3 && labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3) {
    return labels[labels.length - 3];
  }
  return labels.length >= 2 ? labels[labels.length - 2] : (labels[0] ?? "");
}

export function inferKeywordType(
  term: string,
  ctx: { companyName: string | null; website: string | null; competitors: Array<{ name: string; domain: string | null }> },
): KeywordType {
  const k = collapse(term).toLowerCase();
  const variants = (name: string | null, domain: string | null) => {
    const out = new Set<string>();
    if (name && collapse(name)) out.add(collapse(name).toLowerCase());
    const d = normalizeDomain(domain);
    if (d) {
      out.add(d);
      const stem = domainStem(d);
      if (stem.length >= 2) out.add(stem);
    }
    return out;
  };
  if (variants(ctx.companyName, ctx.website).has(k)) return "brand";
  if (ctx.competitors.some((c) => variants(c.name, c.domain).has(k))) return "competitor";
  return "problem";
}

export const keywordCreateSchema = z.object({
  term: z.string().transform(collapse).pipe(z.string().min(2).max(80)),
  type: z.enum(KEYWORD_TYPES).optional(),
});

export const keywordUpdateSchema = z
  .object({
    status: z.enum(KEYWORD_STATUSES).optional(),
    type: z.enum(KEYWORD_TYPES).optional(),
  })
  .refine((v) => v.status !== undefined || v.type !== undefined, { message: "nothing to update" });

export const competitorCreateSchema = z
  .object({
    name: z.string().transform(collapse).pipe(z.string().min(2).max(80)),
    domain: z
      .string()
      .nullish()
      .transform((d, ctx) => {
        if (d === null || d === undefined || d.trim() === "") return null;
        const n = normalizeDomain(d);
        if (!n) ctx.addIssue({ code: "custom", message: "invalid domain" });
        return n;
      }),
  })
  .transform((v) => {
    if (v.domain || /\s/.test(v.name)) return v;
    const d = normalizeDomain(v.name);
    const stem = d ? domainStem(d) : "";
    if (!d || stem.length < 2) return v;
    return { name: stem.charAt(0).toUpperCase() + stem.slice(1), domain: d };
  });

export const competitorUpdateSchema = z.object({ status: z.enum(COMPETITOR_STATUSES) });

export const communityCreateSchema = z.object({
  name: z.string().transform((s, ctx) => {
    const n = normalizeSubreddit(s);
    if (!n) ctx.addIssue({ code: "custom", message: "invalid subreddit name" });
    return n ?? "";
  }),
  rules_verdict: z.enum(RULES_VERDICTS).nullish(),
  selected: z.boolean().optional(),
});

export const communityUpdateSchema = z
  .object({
    selected: z.boolean().optional(),
    rules_verdict: z.enum(RULES_VERDICTS).nullable().optional(),
  })
  .refine((v) => v.selected !== undefined || v.rules_verdict !== undefined, {
    message: "nothing to update",
  });

export const REDDIT_CHANNEL_SLUG = "reddit_organic";
export const REDDIT_FIELDS = {
  keywords: "keywords",
  competitors: "competitors",
  communities: "communities",
} as const;
export type RedditField = (typeof REDDIT_FIELDS)[keyof typeof REDDIT_FIELDS];

const SETTINGS = "channel_settings";
const SETTINGS_COLS =
  "id, field_id, item, item_type, status, position, note, origin, detail, updated_at, updated_by";

type SettingsRow = {
  id: string;
  field_id: string;
  item: string;
  item_type: string | null;
  status: string | null;
  position: number | null;
  note: string | null;
  origin: string | null;
  detail: string | null;
  updated_at: string;
  updated_by: string | null;
};

const originOf = (r: Pick<SettingsRow, "origin">): "suggested" | "custom" =>
  r.origin === "suggested" ? "suggested" : "custom";

const asKeywordStatus = (s: string | null): RedditKeyword["status"] =>
  (KEYWORD_STATUSES as readonly string[]).includes(s ?? "") ? (s as RedditKeyword["status"]) : "tracking";

const asVerdict = (s: string | null): RedditCommunity["rules_verdict"] =>
  (RULES_VERDICTS as readonly string[]).includes(s ?? "") ? (s as RedditCommunity["rules_verdict"]) : null;

function toKeyword(r: SettingsRow): RedditKeyword {
  return {
    id: r.id,
    term: r.item,
    type: ((KEYWORD_TYPES as readonly string[]).includes(r.item_type ?? "")
      ? r.item_type
      : "problem") as KeywordType,
    origin: originOf(r),
    status: asKeywordStatus(r.status),
    why: stripItemIds(r.note),
  };
}

function toCompetitor(r: SettingsRow): RedditCompetitor {
  return {
    id: r.id,
    name: r.item,
    domain: r.detail,
    origin: originOf(r),
    status: asKeywordStatus(r.status),
    why: stripItemIds(r.note),
  };
}

function toCommunity(r: SettingsRow): RedditCommunity {
  const verdict = asVerdict(r.item_type);
  return {
    id: r.id,
    name: r.item,
    selected: r.status === "tracking",
    rules_verdict: verdict,
    rules_verdict_at: verdict ? r.updated_at : null,
  };
}

const LOOKALIKES: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l",
  "ɡ": "g", "ɑ": "a", "ı": "i", "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p",
  "τ": "t", "χ": "x", "ϲ": "c", "ϳ": "j",
};

export function skeletonKey(s: string): string {
  return Array.from(s.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""))
    .map((ch) => LOOKALIKES[ch] ?? ch)
    .join("")
    .replace(/[\s\-_'.]/g, "");
}

export const competitorNameKey = (name: string): string => name.trim().toLowerCase();

export class WorkspaceConflictError extends Error {}

function throwIf(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (error.code === "23505") throw new WorkspaceConflictError("already exists");
  throw new Error(error.message ?? "database error");
}

function settingsSelect(sb: SupabaseClient, tenantId: string) {
  return sb
    .from(SETTINGS)
    .select(SETTINGS_COLS)
    .eq("tenant_id", tenantId)
    .eq("channel_slug", REDDIT_CHANNEL_SLUG);
}

type Filterable = { eq(column: string, value: unknown): Filterable };

function scopeRow<T>(q: T, tenantId: string, field: RedditField, id: string): T {
  return (q as unknown as Filterable)
    .eq("tenant_id", tenantId)
    .eq("channel_slug", REDDIT_CHANNEL_SLUG)
    .eq("field_id", field)
    .eq("id", id) as unknown as T;
}

export async function readRedditWorkspace(sb: SupabaseClient, tenantId: string): Promise<RedditWorkspace> {
  const { data, error } = await settingsSelect(sb, tenantId)
    .in("field_id", [REDDIT_FIELDS.keywords, REDDIT_FIELDS.competitors, REDDIT_FIELDS.communities])
    .order("position", { ascending: true })
    .order("updated_at", { ascending: true });
  throwIf(error);
  const rows = (data ?? []) as SettingsRow[];
  return {
    keywords: rows.filter((r) => r.field_id === REDDIT_FIELDS.keywords).map(toKeyword),
    competitors: rows.filter((r) => r.field_id === REDDIT_FIELDS.competitors).map(toCompetitor),
    communities: rows.filter((r) => r.field_id === REDDIT_FIELDS.communities).map(toCommunity),
  };
}

export async function seedCompetitorsFromRecord(
  sb: SupabaseClient,
  tenantId: string,
  deps: { companyFacts?: (t: string) => Promise<CompanyFacts> } = {},
): Promise<number> {
  const facts = await (deps.companyFacts ?? getCompanyFacts)(tenantId);
  if (facts.competitors.length === 0) return 0;

  const { data, error } = await settingsSelect(sb, tenantId).eq(
    "field_id",
    REDDIT_FIELDS.competitors,
  );
  if (error) return 0;

  const rows = (data ?? []) as SettingsRow[];
  let trackingBudget = Math.max(
    0,
    DEFAULT_TRACKED_COMPETITORS - rows.filter((r) => r.status === "tracking").length,
  );
  const byKey = new Map<string, { id: string; status: string | null }>(
    rows.map((r) => [competitorNameKey(r.item), { id: r.id, status: r.status }]),
  );

  let added = 0;
  for (const name of facts.competitors) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = competitorNameKey(trimmed);
    const existing = byKey.get(key);

    if (existing) {
      if (existing.status === "suggested" && trackingBudget > 0) {
        const { error: upErr } = await scopeRow(
          sb.from(SETTINGS).update({ status: "tracking", updated_at: new Date().toISOString() }),
          tenantId,
          REDDIT_FIELDS.competitors,
          existing.id,
        );
        if (!upErr) {
          added++;
          trackingBudget--;
        }
      }
      continue;
    }

    const status = trackingBudget > 0 ? "tracking" : "suggested";
    const { error: insErr } = await sb.from(SETTINGS).insert({
      tenant_id: tenantId,
      channel_slug: REDDIT_CHANNEL_SLUG,
      field_id: REDDIT_FIELDS.competitors,
      item: trimmed,
      status,
      origin: "custom",
    });
    if (!insErr) {
      added++;
      if (status === "tracking") trackingBudget--;
    } else if (insErr.code !== "23505") return added;
    byKey.set(key, { id: "", status });
  }
  return added;
}

export async function readCompetitorName(
  sb: SupabaseClient,
  tenantId: string,
  id: string,
): Promise<string | null> {
  const { data, error } = await settingsSelect(sb, tenantId)
    .eq("field_id", REDDIT_FIELDS.competitors)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`could not read the competitor: ${error.message}`);
  return (data as SettingsRow | null)?.item ?? null;
}

async function findByItemCi(
  sb: SupabaseClient,
  tenantId: string,
  field: RedditField,
  value: string,
): Promise<SettingsRow | null> {
  const want = value.trim();
  const { data, error } = await settingsSelect(sb, tenantId)
    .eq("field_id", field)
    .ilike("item", want.replace(/([\\%_])/g, "\\$1"))
    .limit(50);
  throwIf(error);
  const wantKey = want.toLowerCase();
  return ((data ?? []) as SettingsRow[]).find((r) => r.item.trim().toLowerCase() === wantKey) ?? null;
}

async function claimExisting(
  sb: SupabaseClient,
  tenantId: string,
  field: RedditField,
  value: string,
  extra: Record<string, unknown> = {},
): Promise<SettingsRow | null> {
  const hit = await findByItemCi(sb, tenantId, field, value);
  if (!hit) return null;
  if (hit.status !== "suggested" && hit.status !== "dismissed") {
    throw new WorkspaceConflictError("already exists");
  }
  const upd = await scopeRow(
    sb.from(SETTINGS).update({ ...extra, status: "tracking", updated_at: new Date().toISOString() }),
    tenantId,
    field,
    hit.id,
  )
    .select(SETTINGS_COLS)
    .maybeSingle();
  throwIf(upd.error);
  return (upd.data as SettingsRow | null) ?? null;
}

export async function insertZaviItem(
  sb: SupabaseClient,
  tenantId: string,
  field: RedditField,
  row: { item: string; item_type?: string | null; status: string; note?: string | null; detail?: string | null },
): Promise<"inserted" | "duplicate"> {
  const { error } = await sb.from(SETTINGS).insert({
    tenant_id: tenantId,
    channel_slug: REDDIT_CHANNEL_SLUG,
    field_id: field,
    item: row.item,
    item_type: row.item_type ?? null,
    status: row.status,
    origin: "suggested",
    note: row.note ?? null,
    detail: row.detail ?? null,
  });
  if (!error) return "inserted";
  if (error.code === "23505") return "duplicate";
  throw new Error(error.message ?? "database error");
}

export async function listKeywordBasics(
  sb: SupabaseClient,
  tenantId: string,
): Promise<Array<Pick<RedditKeyword, "id" | "term" | "status">>> {
  const { data, error } = await settingsSelect(sb, tenantId).eq("field_id", REDDIT_FIELDS.keywords);
  throwIf(error);
  return ((data ?? []) as SettingsRow[]).map((r) => ({
    id: r.id,
    term: r.item,
    status: asKeywordStatus(r.status),
  }));
}

export async function promoteSuggestedKeyword(
  sb: SupabaseClient,
  tenantId: string,
  id: string,
  type: KeywordType,
): Promise<void> {
  const { error } = await scopeRow(
    sb.from(SETTINGS).update({ status: "tracking", item_type: type, updated_at: new Date().toISOString() }),
    tenantId,
    REDDIT_FIELDS.keywords,
    id,
  ).eq("status", "suggested");
  if (error) throw new Error(error.message ?? "database error");
}

export async function trackedKeywordTerms(
  sb: SupabaseClient,
  tenantId: string,
  limit: number,
): Promise<string[]> {
  const { data, error } = await settingsSelect(sb, tenantId)
    .eq("field_id", REDDIT_FIELDS.keywords)
    .eq("status", "tracking")
    .order("position", { ascending: true })
    .order("updated_at", { ascending: true });
  if (error) throw new Error(`reddit google rank: keywords read failed: ${error.message}`);
  return ((data ?? []) as SettingsRow[])
    .filter((r) => r.item_type !== "brand")
    .slice(0, limit)
    .map((r) => r.item);
}

export async function listLiveRedditTenantIds(
  sb: SupabaseClient,
  page: number,
  maxRows: number,
): Promise<string[]> {
  const out = new Set<string>();
  for (let from = 0; from < maxRows; from += page) {
    const { data, error } = await sb
      .from(SETTINGS)
      .select("id, tenant_id")
      .eq("channel_slug", REDDIT_CHANNEL_SLUG)
      .eq("status", "tracking")
      .in("field_id", [REDDIT_FIELDS.keywords, REDDIT_FIELDS.competitors, REDDIT_FIELDS.communities])
      .order("id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`tenant list failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ tenant_id: string }>;
    for (const r of rows) out.add(r.tenant_id);
    if (rows.length < page) break;
  }
  return [...out].sort();
}

export async function inferKeywordTypeFor(
  sb: SupabaseClient,
  tenantId: string,
  term: string,
  companyFacts: (tenantId: string) => Promise<CompanyFacts> = getCompanyFacts,
): Promise<KeywordType> {
  const [facts, comps] = await Promise.all([
    companyFacts(tenantId).catch(() => null),
    settingsSelect(sb, tenantId)
      .eq("field_id", REDDIT_FIELDS.competitors)
      .in("status", ["tracking", "suggested"]),
  ]);
  throwIf(comps.error);
  return inferKeywordType(term, {
    companyName: facts && !facts.nameIsWorkspaceLabel ? facts.name : null,
    website: facts?.website ?? null,
    competitors: ((comps.data ?? []) as SettingsRow[]).map((r) => ({ name: r.item, domain: r.detail })),
  });
}

export async function createKeyword(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  input: z.infer<typeof keywordCreateSchema>,
  deps: { companyFacts?: (tenantId: string) => Promise<CompanyFacts> } = {},
): Promise<RedditKeyword> {
  const promoted = await claimExisting(
    sb,
    tenantId,
    REDDIT_FIELDS.keywords,
    input.term,
    input.type ? { item_type: input.type } : {},
  );
  if (promoted) return toKeyword(promoted);
  const type = input.type ?? (await inferKeywordTypeFor(sb, tenantId, input.term, deps.companyFacts));
  const { data, error } = await sb
    .from(SETTINGS)
    .insert({
      tenant_id: tenantId,
      channel_slug: REDDIT_CHANNEL_SLUG,
      field_id: REDDIT_FIELDS.keywords,
      item: input.term,
      item_type: type,
      status: "tracking",
      origin: "custom",
      updated_by: userId,
    })
    .select(SETTINGS_COLS)
    .single();
  throwIf(error);
  return toKeyword(data as SettingsRow);
}

export async function updateKeyword(
  sb: SupabaseClient,
  tenantId: string,
  id: string,
  patch: z.infer<typeof keywordUpdateSchema>,
): Promise<RedditKeyword | null> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.type !== undefined) row.item_type = patch.type;
  const { data, error } = await scopeRow(
    sb.from(SETTINGS).update(row),
    tenantId,
    REDDIT_FIELDS.keywords,
    id,
  )
    .select(SETTINGS_COLS)
    .maybeSingle();
  throwIf(error);
  return data ? toKeyword(data as SettingsRow) : null;
}

export async function trackedCompetitorMatching(
  sb: SupabaseClient,
  tenantId: string,
  name: string,
): Promise<boolean> {
  const want = skeletonKey(name);
  const { data, error } = await settingsSelect(sb, tenantId)
    .eq("field_id", REDDIT_FIELDS.competitors)
    .eq("status", "tracking")
    .limit(200);
  throwIf(error);
  return ((data ?? []) as SettingsRow[]).some((r) => skeletonKey(r.item) === want);
}

export async function createCompetitor(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  input: z.infer<typeof competitorCreateSchema>,
): Promise<RedditCompetitor> {
  const promoted = await claimExisting(
    sb,
    tenantId,
    REDDIT_FIELDS.competitors,
    input.name,
    input.domain ? { detail: input.domain } : {},
  );
  if (promoted) return toCompetitor(promoted);
  const { data, error } = await sb
    .from(SETTINGS)
    .insert({
      tenant_id: tenantId,
      channel_slug: REDDIT_CHANNEL_SLUG,
      field_id: REDDIT_FIELDS.competitors,
      item: input.name,
      detail: input.domain,
      status: "tracking",
      origin: "custom",
      updated_by: userId,
    })
    .select(SETTINGS_COLS)
    .single();
  throwIf(error);
  return toCompetitor(data as SettingsRow);
}

export async function updateCompetitor(
  sb: SupabaseClient,
  tenantId: string,
  id: string,
  patch: z.infer<typeof competitorUpdateSchema>,
): Promise<RedditCompetitor | null> {
  const { data, error } = await scopeRow(
    sb.from(SETTINGS).update({ status: patch.status, updated_at: new Date().toISOString() }),
    tenantId,
    REDDIT_FIELDS.competitors,
    id,
  )
    .select(SETTINGS_COLS)
    .maybeSingle();
  throwIf(error);
  return data ? toCompetitor(data as SettingsRow) : null;
}

export async function createCommunity(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  input: z.infer<typeof communityCreateSchema>,
): Promise<RedditCommunity> {
  if (await findByItemCi(sb, tenantId, REDDIT_FIELDS.communities, input.name)) {
    throw new WorkspaceConflictError("already exists");
  }
  const { data, error } = await sb
    .from(SETTINGS)
    .insert({
      tenant_id: tenantId,
      channel_slug: REDDIT_CHANNEL_SLUG,
      field_id: REDDIT_FIELDS.communities,
      item: input.name,
      status: input.selected === false ? "paused" : "tracking",
      item_type: input.rules_verdict ?? null,
      origin: "custom",
      updated_by: userId,
    })
    .select(SETTINGS_COLS)
    .single();
  throwIf(error);
  return toCommunity(data as SettingsRow);
}

export async function updateCommunity(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  id: string,
  patch: z.infer<typeof communityUpdateSchema>,
): Promise<RedditCommunity | null> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId };
  if (patch.selected !== undefined) row.status = patch.selected ? "tracking" : "paused";
  if (patch.rules_verdict !== undefined) row.item_type = patch.rules_verdict;
  const { data, error } = await scopeRow(
    sb.from(SETTINGS).update(row),
    tenantId,
    REDDIT_FIELDS.communities,
    id,
  )
    .select(SETTINGS_COLS)
    .maybeSingle();
  throwIf(error);
  return data ? toCommunity(data as SettingsRow) : null;
}

export async function deleteRow(
  sb: SupabaseClient,
  tenantId: string,
  field: RedditField,
  id: string,
): Promise<boolean> {
  if (field === REDDIT_FIELDS.keywords) {
    const upd = await scopeRow(
      sb.from(SETTINGS).update({ status: "dismissed", updated_at: new Date().toISOString() }),
      tenantId,
      field,
      id,
    )
      .eq("item_type", "brand")
      .select("id");
    throwIf(upd.error);
    if (Array.isArray(upd.data) && upd.data.length > 0) return true;
  }
  const { data, error } = await scopeRow(sb.from(SETTINGS).delete(), tenantId, field, id).select("id");
  throwIf(error);
  return Array.isArray(data) && data.length > 0;
}

export function mergedTrackedCompetitors(
  ws: RedditWorkspace,
  recordNames: readonly string[] = [],
): Array<{ name: string; domain: string | null }> {
  const rowByKey = new Map(ws.competitors.map((c) => [competitorNameKey(c.name), c]));
  const seen = new Set<string>();
  const out: Array<{ name: string; domain: string | null }> = [];

  for (const c of ws.competitors) {
    if (c.status !== "tracking") continue;
    const key = competitorNameKey(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: c.name, domain: c.domain });
  }
  for (const name of recordNames) {
    const key = competitorNameKey(name);
    if (!key || seen.has(key)) continue;
    if (rowByKey.has(key)) continue;
    seen.add(key);
    out.push({ name: name.trim(), domain: null });
  }
  return out;
}

export function workspaceRunContext(ws: RedditWorkspace, recordNames: readonly string[] = []) {
  return {
    tracked_keywords: ws.keywords
      .filter((k) => k.status === "tracking")
      .map((k) => ({ term: k.term, type: k.type })),
    tracked_competitors: mergedTrackedCompetitors(ws, recordNames),
    selected_communities: ws.communities
      .filter((c) => c.selected || c.rules_verdict === "banned")
      .map((c) => ({ name: c.name, selected: c.selected, rules_verdict: c.rules_verdict })),
    note:
      "Saved by the founder. Start buyer_queries from tracked_keywords, add tracked_competitors to " +
      "mention_sweep and answer_ownership, and prefer selected_communities. " +
      "rules_verdict is the founder's own reading of the rules page, never Zavi's check: " +
      "'banned' means do not target that community; 'unclear' means draft only the no-product version; " +
      "null means not checked yet.",
  };
}
