
import { MODELS } from "@/services/llm/models";

export type ExtractedEntity = {
  entity_type: string;
  canonical_name: string;
  attrs: Record<string, unknown>;
};

export type ExtractResult = {
  entities: ExtractedEntity[];
};

const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;
const AMOUNT_RE = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b|\$\s?\d+(?:\.\d{1,2})?\b/g;
const HANDLE_RE = /(?:^|\s|\()@([A-Za-z0-9_]{2,30})\b/g;
const PHONE_US_RE = /\b(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g;

function dedupe(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();
  for (const e of entities) {
    const key = `${e.entity_type}::${e.canonical_name}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

export function extractEntities(text: string): ExtractResult {
  if (!text || typeof text !== "string") return { entities: [] };
  const entities: ExtractedEntity[] = [];

  for (const m of text.matchAll(EMAIL_RE)) {
    entities.push({ entity_type: "email", canonical_name: m[0].toLowerCase(), attrs: {} });
  }
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(/[).,!?:;]+$/, "");
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      entities.push({
        entity_type: "url",
        canonical_name: url,
        attrs: { host },
      });
      entities.push({ entity_type: "domain", canonical_name: host, attrs: {} });
    } catch {
    }
  }
  for (const m of text.matchAll(AMOUNT_RE)) {
    const raw = m[0].replace(/[\s,]/g, "");
    const numStr = raw.replace(/^\$/, "");
    const value = Number(numStr);
    if (Number.isFinite(value)) {
      entities.push({
        entity_type: "amount",
        canonical_name: raw,
        attrs: { value, currency: "USD" },
      });
    }
  }
  for (const m of text.matchAll(HANDLE_RE)) {
    entities.push({ entity_type: "handle", canonical_name: `@${m[1]}`, attrs: {} });
  }
  for (const m of text.matchAll(PHONE_US_RE)) {
    const e164 = `+1${m[1]}${m[2]}${m[3]}`;
    entities.push({
      entity_type: "phone",
      canonical_name: e164,
      attrs: { display: `(${m[1]}) ${m[2]}-${m[3]}` },
    });
  }

  return { entities: dedupe(entities) };
}

export type EntityHint = {
  entity_type: string;
  canonical_name: string;
};

export function extractEntitiesWithHints(text: string, hints: EntityHint[]): ExtractResult {
  const base = extractEntities(text);
  if (!hints || hints.length === 0) return base;
  const lower = text.toLowerCase();
  const hits: ExtractedEntity[] = [];
  for (const h of hints) {
    if (!h.canonical_name || h.canonical_name.length < 2) continue;
    const needle = h.canonical_name.toLowerCase();
    if (lower.includes(needle)) {
      hits.push({ entity_type: h.entity_type, canonical_name: h.canonical_name, attrs: {} });
    }
  }
  return { entities: dedupe([...base.entities, ...hits]) };
}

export const TYPED_ENTITY_KINDS = ["person", "company", "deal"] as const;
export type TypedEntityKind = (typeof TYPED_ENTITY_KINDS)[number];

export type TypedEntity = {
  canonical: string;
  type: TypedEntityKind;
};

export type TypedRelation = {
  from: string;
  to: string;
  type: string;
};

export type TypedGraphResult = {
  entities: TypedEntity[];
  relations: TypedRelation[];
};

const EMPTY_GRAPH: TypedGraphResult = { entities: [], relations: [] };

export const TYPED_EXTRACT_MODEL = MODELS.anthropic.haiku;
const TYPED_EXTRACT_MAX_TOKENS = 1024;
const MAX_TYPED_ENTITIES = 32;
const MAX_TYPED_RELATIONS = 64;
const MAX_CANONICAL_CHARS = 200;
const MAX_RELATION_TYPE_CHARS = 40;
const MAX_INPUT_CHARS = 12_000;

export const TYPED_EXTRACT_SYSTEM_PROMPT = `You extract a typed entity-relationship graph from a short business note.

Identify only entities of these THREE types:
- person: a named human (e.g. "Jane Doe", "Ravi Ramadasu"). NOT a role/title alone.
- company: a named organization (e.g. "Acme Corp", "Stripe", "SendGrid").
- deal: a named contract, account, or transaction (e.g. "Acme renewal", "Q3 Stripe Connect deal").

Then identify RELATIONS between those entities. Use a short lowercase verb for
relation type, preferring: works_at, owns, paid, messaged, signed, related_to.
Both endpoints of every relation MUST be entities you listed.

Rules:
- canonical name = the cleanest full form of the name as it appears (keep "Acme Corp", not "Acme"; "Jane Doe", not "Jane").
- DEFAULT TO EMPTY. If the note names no people/companies/deals, return {"entities":[],"relations":[]}.
- Do NOT invent entities or relations not grounded in the text.
- Do NOT emit generic entities (emails, dollar amounts, URLs) — those are handled elsewhere.

Output STRICT JSON, no prose, no code fences:
{"entities":[{"canonical":"<name>","type":"person"|"company"|"deal"}],"relations":[{"from":"<canonical>","to":"<canonical>","type":"<verb>"}]}`;

function isTypedEntity(x: unknown): x is TypedEntity {
  if (!x || typeof x !== "object") return false;
  const e = x as Partial<TypedEntity>;
  return (
    typeof e.canonical === "string" &&
    e.canonical.trim().length > 0 &&
    typeof e.type === "string" &&
    (TYPED_ENTITY_KINDS as readonly string[]).includes(e.type)
  );
}

function isTypedRelation(x: unknown): x is TypedRelation {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<TypedRelation>;
  return (
    typeof r.from === "string" &&
    r.from.trim().length > 0 &&
    typeof r.to === "string" &&
    r.to.trim().length > 0 &&
    typeof r.type === "string" &&
    r.type.trim().length > 0
  );
}

export function parseTypedGraph(raw: string): TypedGraphResult {
  if (!raw || typeof raw !== "string") return EMPTY_GRAPH;
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return EMPTY_GRAPH;
  }
  if (!parsed || typeof parsed !== "object") return EMPTY_GRAPH;
  const obj = parsed as { entities?: unknown; relations?: unknown };

  const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
  const seenEntity = new Map<string, TypedEntity>();
  for (const e of rawEntities) {
    if (!isTypedEntity(e)) continue;
    const canonical = e.canonical.trim().slice(0, MAX_CANONICAL_CHARS);
    if (canonical.length < 2) continue;
    const key = `${e.type}::${canonical.toLowerCase()}`;
    if (!seenEntity.has(key)) {
      seenEntity.set(key, { canonical, type: e.type });
    }
    if (seenEntity.size >= MAX_TYPED_ENTITIES) break;
  }
  const entities = [...seenEntity.values()];

  const canonByLower = new Map<string, string>();
  for (const ent of entities) canonByLower.set(ent.canonical.toLowerCase(), ent.canonical);

  const rawRelations = Array.isArray(obj.relations) ? obj.relations : [];
  const seenRel = new Set<string>();
  const relations: TypedRelation[] = [];
  for (const r of rawRelations) {
    if (!isTypedRelation(r)) continue;
    const fromCanon = canonByLower.get(r.from.trim().toLowerCase());
    const toCanon = canonByLower.get(r.to.trim().toLowerCase());
    if (!fromCanon || !toCanon || fromCanon === toCanon) continue;
    const relType = r.type.trim().slice(0, MAX_RELATION_TYPE_CHARS);
    if (relType.length === 0) continue;
    const dedupKey = `${fromCanon}|${toCanon}|${relType}`.toLowerCase();
    if (seenRel.has(dedupKey)) continue;
    seenRel.add(dedupKey);
    relations.push({ from: fromCanon, to: toCanon, type: relType });
    if (relations.length >= MAX_TYPED_RELATIONS) break;
  }

  return { entities, relations };
}

export type TypedExtractClient = {
  messages: {
    create: (
      args: {
        model: string;
        max_tokens: number;
        system: string;
        messages: Array<{ role: "user"; content: string }>;
      },
      options?: { headers?: Record<string, string>; maxRetries?: number; timeout?: number },
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
};

export type ExtractEntitiesAndRelationsOpts = {
  model?: string;
  client?: TypedExtractClient;
  onError?: (info: { http_status?: number; error_class?: string }) => void;
};

export async function extractEntitiesAndRelations(
  artifactText: string,
  _tenant_id: string,
  opts: ExtractEntitiesAndRelationsOpts = {},
): Promise<TypedGraphResult> {
  if (!artifactText || typeof artifactText !== "string" || artifactText.trim().length === 0) {
    return EMPTY_GRAPH;
  }
  const text = artifactText.slice(0, MAX_INPUT_CHARS);
  const model = opts.model ?? TYPED_EXTRACT_MODEL;

  const reportError = (info: { http_status?: number; error_class?: string }): void => {
    try {
      opts.onError?.(info);
    } catch {
    }
  };

  let client = opts.client;
  if (!client) {
    try {
      const { getAnthropic } = await import("@/services/anthropic");
      client = getAnthropic() as unknown as TypedExtractClient;
    } catch (e) {
      console.warn(
        `[extract] typed-graph: anthropic client unavailable for tenant ${_tenant_id}: ${(e as Error)?.message ?? e}`,
      );
      reportError({ error_class: (e as Error)?.constructor?.name });
      return EMPTY_GRAPH;
    }
  }

  try {
    const heliconeHeaders: Record<string, string> = _tenant_id
      ? { "Helicone-Property-Tenant-Id": _tenant_id }
      : {};
    const { withProviderRetry } = await import("@/services/llm/retry");
    const resp = await withProviderRetry(
      () =>
        client.messages.create(
          {
            model,
            max_tokens: TYPED_EXTRACT_MAX_TOKENS,
            system: TYPED_EXTRACT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: text }],
          },
          { headers: heliconeHeaders, maxRetries: 0, timeout: 30_000 },
        ),
      { label: "memory.extract", attempts: 3, maxDelayMs: 2_000 },
    );
    const block = Array.isArray(resp?.content)
      ? resp.content.find((c) => c?.type === "text")
      : undefined;
    const rawText = block && typeof block.text === "string" ? block.text : "";
    return parseTypedGraph(rawText);
  } catch (e) {
    console.warn(
      `[extract] typed-graph: extraction failed for tenant ${_tenant_id}: ${(e as Error)?.message ?? e}`,
    );
    const status =
      (e as { status?: number; response?: { status?: number } })?.status ??
      (e as { response?: { status?: number } })?.response?.status;
    reportError({
      http_status: typeof status === "number" ? status : undefined,
      error_class: (e as Error)?.constructor?.name,
    });
    return EMPTY_GRAPH;
  }
}
