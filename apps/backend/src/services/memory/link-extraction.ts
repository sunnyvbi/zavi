

const MAX_KEYS = 32;
const MAX_ARRAY_LEN = 16;
const MAX_SCALAR_LEN = 256;
const MAX_TOTAL_BYTES = 8192;

export function assertBoundedFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): asserts frontmatter is Record<string, string | string[]> | undefined {
  if (frontmatter === undefined) return;
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error("frontmatter must be a plain object");
  }
  const keys = Object.keys(frontmatter);
  if (keys.length > MAX_KEYS) {
    throw new Error(`frontmatter has ${keys.length} keys; max ${MAX_KEYS}`);
  }
  for (const k of keys) {
    const v = (frontmatter as Record<string, unknown>)[k];
    if (typeof v === "string") {
      if (v.length > MAX_SCALAR_LEN) {
        throw new Error(`frontmatter.${k} string exceeds ${MAX_SCALAR_LEN} chars`);
      }
    } else if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY_LEN) {
        throw new Error(`frontmatter.${k} array has ${v.length} items; max ${MAX_ARRAY_LEN}`);
      }
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (typeof item !== "string") {
          throw new Error(`frontmatter.${k}[${i}] must be string`);
        }
        if (item.length > MAX_SCALAR_LEN) {
          throw new Error(`frontmatter.${k}[${i}] exceeds ${MAX_SCALAR_LEN} chars`);
        }
      }
    } else {
      throw new Error(`frontmatter.${k} must be string or string[] (got ${typeof v})`);
    }
  }
  const serialized = JSON.stringify(frontmatter);
  if (serialized.length > MAX_TOTAL_BYTES) {
    throw new Error(`frontmatter serialized size ${serialized.length}B exceeds ${MAX_TOTAL_BYTES}`);
  }
}

export type LinkCandidate = {
  fromCanonical: string;
  toCanonical: string;
  relationType: "mentions" | "related_to";
  linkSource: "frontmatter";
  originField: string;
  context: string | null;
};

type FrontmatterFieldHandler = (
  value: string | string[],
  fm: Record<string, string | string[]>,
) => Array<Omit<LinkCandidate, "linkSource">>;

const FRONTMATTER_LINK_MAP_V1: Record<string, FrontmatterFieldHandler> = {
  dispute_between: (value, _fm) => {
    const arr = Array.isArray(value) ? value : [];
    if (arr.length !== 2) return [];
    const [a, b] = arr;
    if (!a || !b || a === b) return [];
    return [
      { fromCanonical: a, toCanonical: b, relationType: "mentions", originField: "dispute_between", context: null },
      { fromCanonical: b, toCanonical: a, relationType: "mentions", originField: "dispute_between", context: null },
    ];
  },
  related_to_pair: (value, _fm) => {
    const arr = Array.isArray(value) ? value : [];
    if (arr.length !== 2) return [];
    const [a, b] = arr;
    if (!a || !b || a === b) return [];
    return [
      { fromCanonical: a, toCanonical: b, relationType: "related_to", originField: "related_to_pair", context: null },
      { fromCanonical: b, toCanonical: a, relationType: "related_to", originField: "related_to_pair", context: null },
    ];
  },
  mentions: (value, fm) => {
    const subj = fm.mentions_subject;
    if (typeof subj !== "string" || subj.length === 0) return [];
    const arr = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return arr
      .filter((to) => typeof to === "string" && to.length > 0 && to !== subj)
      .map((to) => ({
        fromCanonical: subj,
        toCanonical: to,
        relationType: "mentions" as const,
        originField: "mentions",
        context: null,
      }));
  },
};

export type CanonicalLookup = (canonical: string) => Promise<string | null>;

export type ResolvedLink = LinkCandidate & {
  fromEntityId: string;
  toEntityId: string;
};

export async function extractFrontmatterLinks(
  frontmatter: Record<string, string | string[]>,
  lookup: CanonicalLookup,
): Promise<{ resolved: ResolvedLink[]; unresolved: string[] }> {
  const candidates: LinkCandidate[] = [];
  for (const field of Object.keys(frontmatter)) {
    const handler = FRONTMATTER_LINK_MAP_V1[field];
    if (!handler) continue;
    const value = frontmatter[field];
    for (const c of handler(value, frontmatter)) {
      candidates.push({ ...c, linkSource: "frontmatter" });
    }
  }

  const resolved: ResolvedLink[] = [];
  const unresolved: string[] = [];
  const lookupCache = new Map<string, string | null>();
  const resolveOnce = async (name: string): Promise<string | null> => {
    if (lookupCache.has(name)) return lookupCache.get(name)!;
    const id = await lookup(name);
    lookupCache.set(name, id);
    return id;
  };

  const seen = new Set<string>();
  for (const c of candidates) {
    const fromId = await resolveOnce(c.fromCanonical);
    const toId = await resolveOnce(c.toCanonical);
    if (!fromId) {
      unresolved.push(c.fromCanonical);
      continue;
    }
    if (!toId) {
      unresolved.push(c.toCanonical);
      continue;
    }
    const dedupKey = `${fromId}|${toId}|${c.relationType}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    resolved.push({ ...c, fromEntityId: fromId, toEntityId: toId });
  }
  return { resolved, unresolved };
}

export const _FRONTMATTER_LINK_MAP_V1_FIELDS = Object.keys(FRONTMATTER_LINK_MAP_V1);
