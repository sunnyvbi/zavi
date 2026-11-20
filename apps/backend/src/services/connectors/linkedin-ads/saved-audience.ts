import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LINKEDIN_AUDIENCE_URNS } from "@zavi/shared";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { isAudienceList } from "@/services/channels/audience-list";
import { ExpectedToolError } from "@/services/tools/types";
import { isLinkedInAdsWriteEnabled, LINKEDIN_ADS_WRITES_OFF_MESSAGE } from "@/services/tools/linkedin-ads/write/_flag-check";
import { linkedinAdsToken, listLinkedInAdAccounts } from "./client";
import { LINKEDIN_ADS_UNREADABLE, linkedinAdsGet, linkedinAdsPost, logLinkedInRefusal } from "./http";
import { listLinkedInSavedAudiencesWithToken, sponsoredAccountUrn } from "./account-reads";
import { linkedinAccountOpen } from "./account-list-cache";
import { linkedinAccountInUse, linkedinBindingsInUse } from "./own-accounts";
import { resolveLinkedinLocationNames, verifyLinkedinAudience, verifyLinkedinLocations } from "./targeting";

export const AUDIENCE_SAVED_PREFIX = "Saved to LinkedIn";
export const AUDIENCE_NO_OWN_ACCOUNT =
  "Zavi saves audiences to your own LinkedIn ad account, and this workspace has none chosen. Choose one in Ad account and shared wallet, then press Create audience again. Nothing was saved.";
export const AUDIENCE_ACCOUNT_NOT_YOURS =
  "The LinkedIn ad account chosen for this workspace is not one Zavi can save audiences to from here. Choose your own account in Ad account and shared wallet, then press Create audience again. Nothing was saved.";
export const AUDIENCE_ACCOUNT_HIDDEN =
  "The LinkedIn login connected now cannot open the ad account chosen for this workspace. Reconnect LinkedIn Ads in Connectors with the login that manages it, then press Create audience again. Nothing was saved.";
export const AUDIENCE_CARD_CHANGED = "This card changed. Refresh Next steps.";

const MAX_PER_FACET = 20;
const NOTE_MAX = 1000;
const NAME_MAX = 100;
const LOCALE = "urn:li:locale:en_US";

type Facet = "titles" | "seniorities" | "industries" | "staffCountRanges" | "jobFunctions";
const FACETS: readonly Facet[] = ["titles", "seniorities", "industries", "staffCountRanges", "jobFunctions"];
const FACET_URNS: Record<Facet, RegExp> = { ...LINKEDIN_AUDIENCE_URNS, jobFunctions: /^urn:li:function:\d+$/ };
const FACET_LABELS: Record<Facet, string> = {
  titles: "Job titles",
  seniorities: "Job seniorities",
  industries: "Industries",
  staffCountRanges: "Company size",
  jobFunctions: "Job functions",
};
const TYPEAHEAD: ReadonlySet<Facet> = new Set<Facet>(["titles", "industries"]);
const SIZE_ALIASES: Record<string, string> = {
  "self employed": "urn:li:staffCountRange:(1,1)",
  "myself only": "urn:li:staffCountRange:(1,1)",
  "just me": "urn:li:staffCountRange:(1,1)",
  solo: "urn:li:staffCountRange:(1,1)",
  "1": "urn:li:staffCountRange:(1,1)",
};
const MAX_TYPEAHEAD_RUN = 3;
const KEY_FACET: Record<string, Facet | "locations"> = {
  locations: "locations",
  location: "locations",
  "company size": "staffCountRanges",
  "company sizes": "staffCountRanges",
  industries: "industries",
  industry: "industries",
  "job functions": "jobFunctions",
  "job function": "jobFunctions",
  functions: "jobFunctions",
  "job seniorities": "seniorities",
  "job seniority": "seniorities",
  seniorities: "seniorities",
  seniority: "seniorities",
  "job titles": "titles",
  "job title": "titles",
  titles: "titles",
};
const SETTING_KEYS = new Set(["audience expansion", "linkedin audience network"]);
const INFO_KEYS = new Set(["size"]);
const MATCHED_KEYS = new Set(["source", "window"]);
const EXCLUDE_KEYS = new Set(["exclude", "excludes", "exclusions"]);
const OPEN_VALUE = /^(any|all|none|open|leave open|not restricted|no restriction|n\/a|-)$/i;

const HEADER = /^\s*AUDIENCE\s+(\d+|[A-Z](?![A-Za-z]))\s*[:.-]\s*(.*)$/i;
const KEY = /^([A-Z][A-Za-z0-9 ()/&'-]{0,40}):\s*(.*)$/;
const NEXT_KEY = /\s{2,}(?=[A-Z][A-Za-z0-9 ()/&'-]{0,40}:\s)/;

export type SheetRow = { key: string; value: string };
export type SheetAudience = { n: string; who: string; rows: SheetRow[] };

function pairs(line: string): SheetRow[] | null {
  const head = KEY.exec(line.trim());
  if (!head) return null;
  const [first, ...more] = head[2].split(NEXT_KEY);
  const rows: SheetRow[] = [{ key: head[1].trim(), value: first.trim() }];
  for (const part of more) {
    const next = pairs(part);
    if (next) rows.push(...next);
    else rows[rows.length - 1].value = `${rows[rows.length - 1].value} ${part.trim()}`.trim();
  }
  return rows;
}

export function parseAudienceSheet(content: string): SheetAudience[] {
  const audiences: SheetAudience[] = [];
  let current: SheetAudience | null = null;
  for (const line of content.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      current = { n: header[1].toUpperCase(), who: header[2].trim(), rows: [] };
      audiences.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;
    const last = current.rows[current.rows.length - 1];
    if (line.trim().startsWith("|") && last) {
      last.value = `${last.value} ${line.trim()}`.trim();
      continue;
    }
    const found = pairs(line);
    if (found) current.rows.push(...found);
  }
  return audiences;
}

type Entity = { urn: string; name: string };
type Plan = {
  n: string;
  who: string;
  include: Record<Facet, Entity[]>;
  exclude: Record<Facet, Entity[]>;
  locations: Entity[];
  excludedLocations: Entity[];
  leftOut: string[];
  settings: string[];
  blockers: string[];
  renamed: string[];
  matched: boolean;
};

const entitySchema = z.object({ urn: z.string(), name: z.string().min(1).max(300), facetUrn: z.string(), isTargetable: z.boolean().optional() });
const emptyFacets = (): Record<Facet, Entity[]> => ({ titles: [], seniorities: [], industries: [], staffCountRanges: [], jobFunctions: [] });
const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ");
const norm = (s: string) => s.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
const sizeNorm = (s: string) => norm(s).replace(/employees?/g, "").replace(/[\s,]/g, "");
const clean = (s: string) => s.replace(/\(\s*zavi['’]s suggestion\s*\)/gi, "").replace(/\s+/g, " ").trim();
const withoutAside = (s: string) => s.replace(/\s*\([^()]*\)\s*$/, "").trim();
const hasBlank = (s: string) => /\[[^\]\n]*\]/.test(s);
const plain = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9+]+/g, " ").trim();
const pieces = (value: string) => clean(value).split(/\s*[;|]\s*/).map((v) => v.trim()).filter(Boolean);

async function facetEntities(token: string, facet: Facet, query?: string): Promise<Entity[]> {
  const typeahead = TYPEAHEAD.has(facet);
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adTargetingEntities", {
    q: typeahead ? "typeahead" : "adTargetingFacet",
    facet: `urn:li:adTargetingFacet:${facet}`,
    queryVersion: "QUERY_USES_URNS",
    locale: { language: "en", country: "US" },
    ...(typeahead && query ? { query } : {}),
  });
  if (!Array.isArray(response.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
  const out: Entity[] = [];
  for (const raw of response.elements) {
    const parsed = entitySchema.safeParse(raw);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.facetUrn !== `urn:li:adTargetingFacet:${facet}` || !FACET_URNS[facet].test(e.urn) || e.isTargetable === false) continue;
    if (!out.some((o) => o.urn === e.urn)) out.push({ urn: e.urn, name: e.name });
  }
  return out;
}

type Missed = { term: string; among: string[] };
type FacetMatch = { found: Entity[]; missed: Missed[]; renamed: string[] };

function pickFrom(facet: Facet, pool: Entity[], term: string): Entity | string[] {
  const size = facet === "staffCountRanges";
  const want = size ? sizeNorm(term) : plain(term);
  if (!want) return [];
  const exact = pool.filter((e) => (size ? sizeNorm(e.name) : plain(e.name)) === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact.map((e) => e.name);
  if (size) {
    const urn = SIZE_ALIASES[plain(term)];
    const alias = urn ? pool.filter((e) => e.urn === urn || SIZE_ALIASES[plain(e.name)] === urn) : [];
    return alias.length === 1 ? alias[0] : [];
  }
  if (TYPEAHEAD.has(facet)) return [];
  const within = pool.filter((e) => ` ${plain(e.name)} `.includes(` ${want} `));
  return within.length === 1 ? within[0] : within.map((e) => e.name);
}

async function resolveFacetNames(token: string, facet: Facet, value: string): Promise<FacetMatch> {
  const typeahead = TYPEAHEAD.has(facet);
  const listed = typeahead ? null : await facetEntities(token, facet);
  const size = facet === "staffCountRanges";
  const out: FacetMatch = { found: [], missed: [], renamed: [] };
  const lookup = async (term: string): Promise<Entity | string[]> => {
    for (const want of [...new Set([term, withoutAside(term)])]) {
      if (typeahead && want.length < 2) continue;
      const got = pickFrom(facet, listed ?? (await facetEntities(token, facet, want)), want);
      if (!Array.isArray(got) || got.length) return got;
    }
    return [];
  };
  for (const piece of pieces(value)) {
    const parts = piece.split(/,\s+/).map((p) => p.trim()).filter(Boolean);
    let i = 0;
    while (i < parts.length) {
      let taken = 0;
      let among: string[] = [];
      const longest = Math.min(parts.length, typeahead ? i + MAX_TYPEAHEAD_RUN : parts.length);
      for (let j = longest; j > i; j--) {
        const term = parts.slice(i, j).join(", ");
        const got = await lookup(term);
        if (!Array.isArray(got)) {
          if (!out.found.some((f) => f.urn === got.urn)) out.found.push(got);
          const same = size ? sizeNorm(got.name) === sizeNorm(term) : plain(got.name) === plain(term) || plain(got.name) === plain(withoutAside(term));
          if (!same) out.renamed.push(`${term} as "${got.name}"`);
          taken = j - i;
          break;
        }
        if (j === i + 1) among = got;
      }
      if (!taken) out.missed.push({ term: parts[i], among });
      i += taken || 1;
    }
  }
  return out;
}

async function resolvePlaces(token: string, value: string): Promise<{ found: Entity[]; missed: string[] }> {
  const lookup = async (names: string[]) => {
    const found: Entity[] = [];
    const missed: string[] = [];
    const unique = [...new Set(names)];
    for (let i = 0; i < unique.length; i += 10) {
      const chunk = unique.slice(i, i + 10);
      const usable = chunk.filter((n) => n.length >= 2);
      missed.push(...chunk.filter((n) => n.length < 2));
      const got = await resolveLinkedinLocationNames(token, usable);
      found.push(...got.found.map((f) => ({ urn: f.id, name: f.name })));
      missed.push(...got.missed);
    }
    return { found, missed };
  };
  const whole = clean(value).split(/\s*[;|]\s*/).map((v) => v.trim()).filter(Boolean);
  const first = await lookup(whole);
  const parts = first.missed.flatMap((m) => (m.includes(",") ? m.split(/,\s*/).map((p) => p.trim()).filter(Boolean) : []));
  const second = parts.length ? await lookup(parts) : { found: [], missed: [] };
  const found = [...first.found, ...second.found].filter((f, i, all) => all.findIndex((o) => o.urn === f.urn) === i);
  return { found, missed: [...first.missed.filter((m) => !m.includes(",")), ...second.missed] };
}

async function planAudience(token: string, audience: SheetAudience): Promise<Plan> {
  const plan: Plan = { n: audience.n, who: audience.who, include: emptyFacets(), exclude: emptyFacets(), locations: [], excludedLocations: [], leftOut: [], settings: [], blockers: [], renamed: [], matched: false };
  const noMatch = (label: string, missed: string[]) => plan.blockers.push(`${label}: LinkedIn has no match for ${quoted(missed)}.`);
  const take = async (target: Facet | "locations", label: string, value: string, into: "include" | "exclude") => {
    if (hasBlank(value)) {
      plan.blockers.push(`${label}: this still has a blank to fill in.`);
      return;
    }
    if (OPEN_VALUE.test(clean(value)) || !clean(value)) return;
    if (target === "locations") {
      const got = await resolvePlaces(token, value);
      (into === "include" ? plan.locations : plan.excludedLocations).push(...got.found);
      if (got.missed.length) noMatch(label, got.missed);
      return;
    }
    const got = await resolveFacetNames(token, target, value);
    const list = plan[into][target];
    for (const e of got.found) if (!list.some((o) => o.urn === e.urn)) list.push(e);
    plan.renamed.push(...got.renamed);
    const none = got.missed.filter((m) => !m.among.length).map((m) => m.term);
    if (none.length) noMatch(label, none);
    for (const m of got.missed.filter((x) => x.among.length)) {
      plan.blockers.push(`${label}: "${m.term}" fits more than one LinkedIn name (${m.among.slice(0, 6).join("; ")}). Write the full name with Edit.`);
    }
  };
  for (const row of audience.rows) {
    const key = norm(row.key);
    if (INFO_KEYS.has(key)) continue;
    if (MATCHED_KEYS.has(key)) {
      plan.matched = true;
      continue;
    }
    if (SETTING_KEYS.has(key)) {
      plan.settings.push(row.key);
      continue;
    }
    if (EXCLUDE_KEYS.has(key)) {
      for (const item of clean(row.value).split(/\s*\|\s*/).map((v) => v.trim()).filter(Boolean)) {
        const named = /^([A-Za-z ]{1,40}):\s*(.+)$/.exec(item);
        const target = named ? KEY_FACET[norm(named[1])] : undefined;
        if (named && target) await take(target, `Exclude ${named[1].trim().toLowerCase()}`, named[2], "exclude");
        else if (hasBlank(item)) plan.blockers.push("Exclude: this still has a blank to fill in.");
        else plan.leftOut.push(`Exclude: ${item}`);
      }
      continue;
    }
    const target = KEY_FACET[key];
    if (!target) {
      plan.blockers.push(`${row.key}: Zavi cannot save this field to a LinkedIn audience yet. Remove it with Edit, or add it in Campaign Manager.`);
      continue;
    }
    await take(target, target === "locations" ? "Locations" : FACET_LABELS[target], row.value, "include");
  }
  if (plan.matched) return plan;
  if (!plan.locations.length && !plan.blockers.some((b) => b.startsWith("Locations:"))) plan.blockers.push("Locations: LinkedIn needs at least one place for a saved audience.");
  if (plan.include.titles.length && plan.include.seniorities.length) plan.blockers.push("Job titles and job seniorities: LinkedIn does not allow both in one audience. Keep one with Edit.");
  if (!FACETS.some((f) => plan.include[f].length) && !plan.blockers.length) plan.blockers.push("It has no industry, job or company size LinkedIn can save.");
  for (const f of FACETS) {
    if (plan.include[f].length > MAX_PER_FACET || plan.exclude[f].length > MAX_PER_FACET) plan.blockers.push(`${FACET_LABELS[f]}: Zavi saves up to ${MAX_PER_FACET} values in one field.`);
  }
  return plan;
}

export function savedAudienceCriteria(plan: Pick<Plan, "include" | "exclude" | "locations" | "excludedLocations">) {
  const facet = (name: string) => `urn:li:adTargetingFacet:${name}`;
  const and: Array<{ or: Record<string, string[]> }> = [
    { or: { [facet("locations")]: plan.locations.map((l) => l.urn) } },
    { or: { [facet("interfaceLocales")]: [LOCALE] } },
  ];
  for (const f of FACETS) if (plan.include[f].length) and.push({ or: { [facet(f)]: plan.include[f].map((e) => e.urn) } });
  const or: Record<string, string[]> = {};
  if (plan.excludedLocations.length) or[facet("locations")] = plan.excludedLocations.map((l) => l.urn);
  for (const f of FACETS) if (plan.exclude[f].length) or[facet(f)] = plan.exclude[f].map((e) => e.urn);
  return Object.keys(or).length ? { include: { and }, exclude: { or } } : { include: { and } };
}

export const savedAudienceNamePrefix = (actionId: string, n: string) => `Zavi ${actionId.slice(0, 8)}-${n}:`;
export const savedAudienceRef = (actionId: string, n: string) => `Zavi ref ${actionId.slice(0, 8)}-${n}`;
const NAME_SHORT = 60;
const NAME_TAIL = /[\s,;:–—-]+(?:at|in|of|on|for|to|with|by|and|or|who|that|the|a|an)?$/i;
export function savedAudienceName(who: string, n: string): string {
  const said = withoutAside(who).replace(/\s+/g, " ").trim();
  const core = said.replace(/^[^:]{0,80}:\s*/, "").trim() || said;
  let name = core;
  if (name.length > NAME_SHORT) {
    const cut = name.slice(0, NAME_SHORT + 1);
    name = cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : NAME_SHORT);
    let before = "";
    while (before !== name) {
      before = name;
      name = name.replace(NAME_TAIL, "").trim();
    }
  }
  name = name.replace(/[\s.,;:]+$/, "");
  if (!name) return `Audience ${n}`;
  return (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, NAME_MAX);
}

type StoredCard = {
  title: string | null;
  status: string;
  note: string | null;
  exec_class: string | null;
  exec_status: string | null;
  body: { step?: { deliverable?: { kind?: string; content?: string; presentation?: { type?: string } } } } | null;
};

async function readCard(tenantId: string, actionId: string): Promise<StoredCard> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("channel_actions")
    .select("id, channel_slug, title, body, status, note, exec_class, exec_status")
    .eq("id", actionId)
    .eq("channel_slug", "linkedin_ads")
    .maybeSingle();
  if (error) throw new Error("Could not read audience card.");
  if (!data) throw new ExpectedToolError("linkedin_ads_not_found", "Action not found in this workspace.");
  return data as StoredCard;
}

export const createAudiencesInput = z.object({ content: z.string().min(1).max(20_000).optional() }).strict();

export type CreateAudiencesResult = {
  id: string;
  status: "done";
  line: string;
  replayed: boolean;
  created: Array<{ audience: string; name: string; id: string | null; existing: boolean }>;
  left_out: string[];
};

const stop = (code: string, message: string): never => {
  throw new ExpectedToolError(code, message);
};
const changed = () => stop("linkedin_ads_conflict", AUDIENCE_CARD_CHANGED);
const capped = (line: string) => (line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX - 1)}…` : line);
const sentence = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

async function createFromCard(tenantId: string, actionId: string, actorId: string, input: unknown): Promise<CreateAudiencesResult> {
  const value = createAudiencesInput.parse(input ?? {});
  if (!(await isLinkedInAdsWriteEnabled())) return stop("linkedin_ads_writes_off", `${LINKEDIN_ADS_WRITES_OFF_MESSAGE}, so no audience was saved. This card stays here.`);
  const row = await readCard(tenantId, actionId);
  if (row.status === "acted" && row.note?.startsWith(AUDIENCE_SAVED_PREFIX)) return { id: actionId, status: "done", line: row.note, replayed: true, created: [], left_out: [] };
  const deliverable = row.body?.step?.deliverable;
  const stored = deliverable?.content ?? "";
  if (row.status !== "pending" || row.exec_class || row.exec_status || deliverable?.kind !== "list" || deliverable?.presentation?.type === "campaign_draft" || !isAudienceList(stored)) return changed();
  const sheet = parseAudienceSheet(value.content ?? stored);
  const storedNumbers = parseAudienceSheet(stored).map((a) => a.n);
  if (!isAudienceList(value.content ?? stored) || sheet.length !== storedNumbers.length || sheet.some((a, i) => a.n !== storedNumbers[i]) || new Set(storedNumbers).size !== storedNumbers.length) return changed();

  const inUse = await linkedinBindingsInUse(tenantId);
  if (!inUse.own) return stop("linkedin_ads_account_not_in_use", AUDIENCE_NO_OWN_ACCOUNT);
  const accountId = inUse.own.providerAccountId;
  if (!/^\d{1,20}$/.test(accountId) || !(await linkedinAccountInUse(tenantId, accountId))) return stop("linkedin_ads_account_not_in_use", AUDIENCE_ACCOUNT_NOT_YOURS);
  const account = (await listLinkedInAdAccounts(tenantId, true)).find((a) => a.id === accountId && linkedinAccountOpen(a.status));
  if (!account) return stop("linkedin_ads_account_not_in_use", AUDIENCE_ACCOUNT_HIDDEN);
  const token = await linkedinAdsToken(tenantId);

  const plans: Plan[] = [];
  for (const audience of sheet) plans.push(await planAudience(token, audience));
  const creatable = plans.filter((p) => !p.matched);
  const matched = plans.filter((p) => p.matched);
  const matchedLine = matched.length
    ? `Audience ${sentence(matched.map((p) => p.n))} ${matched.length === 1 ? "is a retargeting audience" : "are retargeting audiences"}, which LinkedIn builds from the Insight Tag or an uploaded list in Campaign Manager, so Zavi did not save ${matched.length === 1 ? "it" : "them"}.`
    : "";
  const blocked = creatable.filter((p) => p.blockers.length);
  if (blocked.length) {
    return stop(
      "linkedin_ads_audience_unresolved",
      `Nothing was saved to LinkedIn yet. ${blocked.map((p) => `Audience ${p.n}: ${p.blockers.join(" ")}`).join(" ")} Fix the card with Edit, then press Create audience again.`,
    );
  }
  if (!creatable.length) return stop("linkedin_ads_audience_unresolved", `Nothing was saved to LinkedIn. ${matchedLine}`);
  for (const p of creatable) {
    await verifyLinkedinAudience(token, { titles: p.include.titles.map((e) => e.urn), seniorities: p.include.seniorities.map((e) => e.urn), industries: p.include.industries.map((e) => e.urn), staffCountRanges: p.include.staffCountRanges.map((e) => e.urn) });
    await verifyLinkedinLocations(token, [...p.locations, ...p.excludedLocations].map((l) => l.urn));
  }

  const existing = await listLinkedInSavedAudiencesWithToken(token, accountId);
  const created: CreateAudiencesResult["created"] = [];
  const savedNames = () => sentence(created.map((c) => `"${c.name}"`));
  for (const p of creatable) {
    const prefix = savedAudienceNamePrefix(actionId, p.n);
    const ref = savedAudienceRef(actionId, p.n);
    const short = savedAudienceName(p.who, p.n);
    const already = existing.find((t) => (typeof t.name === "string" && t.name.startsWith(prefix)) || (typeof t.description === "string" && t.description.includes(ref)));
    const taken = existing.some((t) => typeof t.name === "string" && t.name.trim().toLowerCase() === short.toLowerCase());
    const name = taken ? `${short} (Zavi)` : short;
    if (already) {
      created.push({ audience: p.n, name: already.name as string, id: already.id === undefined ? null : String(already.id), existing: true });
      continue;
    }
    try {
      const { id } = await linkedinAdsPost(token, "adTargetTemplates", "CREATE", {
        account: sponsoredAccountUrn(accountId),
        name,
        description: `Saved by Zavi from the card "${(row.title ?? "LinkedIn audiences").slice(0, 120)}". ${ref}.`,
        targetingCriteria: savedAudienceCriteria(p),
      }, "saved audience");
      if (!id) throw new ExpectedToolError("linkedin_ads_bad_response", "LinkedIn did not confirm that it saved this audience.");
      created.push({ audience: p.n, name, id, existing: false });
    } catch (e) {
      await logLinkedInRefusal(e, { tenantId, objectId: actionId, stage: "change" }).catch(() => undefined);
      const said = e instanceof ExpectedToolError ? e.message : "LinkedIn Ads is not responding right now.";
      const before = created.length ? `${AUDIENCE_SAVED_PREFIX} on ${account.name}: ${savedNames()}. ` : "";
      throw new ExpectedToolError(
        e instanceof ExpectedToolError ? e.code : "linkedin_ads_http_error",
        `${before}Audience ${p.n} was not saved. ${said} This card stays here. Press Create audience again to retry${created.length ? "; what is already saved is not saved twice" : ""}.`,
        e instanceof ExpectedToolError ? e.meta : undefined,
      );
    }
  }

  const leftOut = creatable.flatMap((p) => p.leftOut.map((l) => `Audience ${p.n}, ${l}`));
  const settings = [...new Set(creatable.flatMap((p) => p.settings))];
  const renamed = [...new Set(creatable.flatMap((p) => p.renamed))];
  const line = capped([
    `${AUDIENCE_SAVED_PREFIX} on ${account.name}: ${savedNames()}.`,
    renamed.length ? `Saved under LinkedIn's own names: ${renamed.join("; ")}.` : "",
    leftOut.length ? `Not saved, because a LinkedIn saved audience cannot hold them: ${leftOut.join("; ")}. Add them in Campaign Manager.` : "",
    settings.length ? `${sentence(settings)} ${settings.length === 1 ? "is a campaign setting" : "are campaign settings"}, so set ${settings.length === 1 ? "it" : "them"} when you create the campaign.` : "",
    matchedLine,
  ].filter(Boolean).join(" "));

  const { data, error } = await tenantRpc(asTenantId(tenantId), "set_channel_action", {
    p_action_id: actionId,
    p_status: "acted",
    p_note: line,
    p_snoozed_until: null,
    p_event_key: `linkedin-audiences:${randomUUID()}`,
    p_actor_user_id: actorId,
  });
  const closed = !error && (data as { ok?: boolean } | null)?.ok === true;
  if (!closed) {
    const now = await readCard(tenantId, actionId).catch(() => null);
    if (!(now?.status === "acted" && now.note?.startsWith(AUDIENCE_SAVED_PREFIX))) {
      return stop("linkedin_ads_audience_card_open", `${line} Zavi could not close this card, though. Press Create audience again; nothing is saved twice.`);
    }
  }
  return { id: actionId, status: "done", line, replayed: false, created, left_out: leftOut };
}

const inFlight = new Map<string, Promise<CreateAudiencesResult>>();

export function createLinkedInAudiencesFromCard(tenantId: string, actionId: string, actorId: string, input: unknown): Promise<CreateAudiencesResult> {
  z.string().uuid().parse(actionId);
  const key = `${tenantId}:${actionId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = createFromCard(tenantId, actionId, actorId, input).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}
