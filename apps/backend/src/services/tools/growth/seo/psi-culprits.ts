
import { z } from "zod";

export type PsiCulpritKind =
  | "script"
  | "stylesheet"
  | "image"
  | "element"
  | "third_party"
  | "other";

export type PsiCulpritOwner = "founder" | "developer";

export type PsiCulprit = {
  kind: PsiCulpritKind;
  label: string;
  detail: string;
  owner: PsiCulpritOwner;
  bytes: number | null;
  wastedBytes: number | null;
};

export const MAX_CULPRITS = 4;

const TAG_HOSTS: readonly string[] = [
  "googletagmanager.com",
  "google-analytics.com",
  "googleadservices.com",
  "googlesyndication.com",
  "doubleclick.net",
  "connect.facebook.net",
  "snap.licdn.com",
  "static.ads-twitter.com",
  "analytics.tiktok.com",
  "clarity.ms",
  "hotjar.com",
  "cdn.segment.com",
];

const itemSchema = z
  .object({
    url: z.string().optional().catch(undefined),
    node: z
      .object({
        selector: z.string().optional().catch(undefined),
        snippet: z.string().optional().catch(undefined),
        nodeLabel: z.string().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    totalBytes: z.number().optional().catch(undefined),
    transferSize: z.number().optional().catch(undefined),
    wastedBytes: z.number().optional().catch(undefined),
    wastedMs: z.number().optional().catch(undefined),
    total: z.number().optional().catch(undefined),
    scripting: z.number().optional().catch(undefined),
    cacheLifetimeMs: z.number().optional().catch(undefined),
    score: z.number().optional().catch(undefined),
    subItems: z
      .object({
        items: z
          .array(z.object({ reason: z.string().optional().catch(undefined) }).catch({}))
          .optional()
          .catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});

type Item = z.infer<typeof itemSchema>;

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function ms(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} ms`;
}

export function isTagHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return TAG_HOSTS.some((t) => h === t || h.endsWith(`.${t}`));
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const EXTENSION_KINDS: ReadonlyArray<readonly [RegExp, PsiCulpritKind]> = [
  [/\.(?:js|mjs|cjs)$/i, "script"],
  [/\.css$/i, "stylesheet"],
  [/\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i, "image"],
];

function fileNameOf(url: URL): string {
  const direct = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (/\.[a-z0-9]{1,5}$/i.test(direct)) return direct;
  for (const value of url.searchParams.values()) {
    if (!/^https?:\/\//i.test(value)) continue;
    const inner = parseUrl(value);
    const nested = inner?.pathname.split("/").filter(Boolean).pop() ?? "";
    if (/\.[a-z0-9]{1,5}$/i.test(nested)) return nested;
  }
  return direct;
}

function kindOfUrl(url: URL): PsiCulpritKind {
  if (isTagHost(url.hostname)) return "third_party";
  const name = fileNameOf(url);
  for (const [pattern, kind] of EXTENSION_KINDS) if (pattern.test(name)) return kind;
  return "other";
}

function labelOfUrl(url: URL): string {
  const name = fileNameOf(url);
  if (name && /\.[a-z0-9]{1,5}$/i.test(name)) return name;
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.hostname}${path}` || url.hostname;
}

function labelOfNode(node: NonNullable<Item["node"]>): string {
  const selector = node.selector?.trim();
  if (selector) {
    const last = selector.split(">").pop()?.trim();
    if (last) return last;
    return selector;
  }
  const label = node.nodeLabel?.trim().split("\n")[0]?.trim();
  if (label) return label;
  return "an element on the page";
}

function detailOf(item: Item, selfBytes: number | null, wasted: number | null): string {
  const reason = item.subItems?.items?.find((s) => s.reason)?.reason?.trim();
  const clauses: string[] = [];

  if (selfBytes !== null) clauses.push(kb(selfBytes));
  if (wasted !== null && wasted > 0) {
    clauses.push(
      selfBytes !== null && selfBytes > 0
        ? `${kb(wasted)} of it wasted (${Math.round((wasted / selfBytes) * 100)}%)`
        : `${kb(wasted)} wasted`,
    );
  }
  if (typeof item.total === "number" && item.total > 0) {
    clauses.push(
      typeof item.scripting === "number" && item.scripting > 0
        ? `${ms(item.total)} of main-thread time, ${ms(item.scripting)} of it running JavaScript`
        : `${ms(item.total)} of main-thread time`,
    );
  }
  if (typeof item.wastedMs === "number" && item.wastedMs > 0) {
    clauses.push(`holds up the first render by ${ms(item.wastedMs)}`);
  }
  if (typeof item.cacheLifetimeMs === "number" && item.cacheLifetimeMs === 0) {
    clauses.push("no cache lifetime set, so returning visitors download it again");
  }
  if (typeof item.score === "number" && item.score > 0 && item.node) {
    clauses.push(`moved the page by ${item.score.toFixed(3)} of layout shift`);
  }

  const sentences: string[] = [];
  if (clauses.length > 0) {
    const s = clauses.join(", ");
    sentences.push(`${s.charAt(0).toUpperCase()}${s.slice(1)}`);
  }
  if (reason) sentences.push(reason.replace(/\s+/g, " "));
  if (sentences.length === 0) return "Lighthouse flagged this, without a measured cost.";
  const joined = sentences.map((x) => x.replace(/[.!?]+$/, "")).join(". ");
  return `${joined}.`;
}

function weightOf(item: Item): number {
  return (
    item.wastedBytes ??
    item.totalBytes ??
    item.transferSize ??
    item.wastedMs ??
    item.total ??
    item.score ??
    0
  );
}

type TagIdentity = { host: string; id: string; viaTagManager: boolean };

function tagIdentityOf(url: URL): TagIdentity | null {
  if (!isTagHost(url.hostname)) return null;
  const id = url.searchParams.get("id");
  if (!id) return null;
  return {
    host: url.hostname.toLowerCase(),
    id,
    viaTagManager: url.searchParams.has("gtm") || url.searchParams.has("cx"),
  };
}

function tagProductName(id: string): string {
  if (/^G-/i.test(id)) return "Google Analytics (GA4)";
  if (/^AW-/i.test(id)) return "Google Ads";
  if (/^GTM-/i.test(id)) return "Google Tag Manager";
  if (/^UA-/i.test(id)) return "Universal Analytics";
  return "A tag";
}

type Candidate = { culprit: PsiCulprit; weight: number; tag: TagIdentity | null };

function foldDuplicateTags(candidates: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.tag) continue;
    const key = `${c.tag.host}|${c.tag.id}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  const folded: Candidate[] = [];
  const consumed = new Set<Candidate>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!group.some((c) => c.tag?.viaTagManager)) continue;

    const tag = group[0].tag as TagIdentity;
    const bytes = sumOrNull(group.map((c) => c.culprit.bytes));
    const wasted = sumOrNull(group.map((c) => c.culprit.wastedBytes));
    const each = group[0].culprit.bytes;

    const size =
      each !== null && bytes !== null
        ? ` ${kb(each)} each, ${kb(bytes)} in total${wasted !== null && wasted > 0 ? `, of which ${kb(wasted)} goes unused` : ""}.`
        : "";

    for (const c of group) consumed.add(c);
    folded.push({
      culprit: {
        kind: "third_party",
        label: `${tagProductName(tag.id)} ${tag.id}`,
        detail:
          `Loaded ${group.length === 2 ? "twice" : `${group.length} times`} on the same page — ` +
          `${group.length === 2 ? "once directly and once through a tag manager" : "directly and through a tag manager"}.` +
          `${size} The same id arriving more than once is a duplicate install; which copies stay is a change in the tag console, not in the code.`,
        owner: "founder",
        bytes,
        wastedBytes: wasted,
      },
      weight: bytes ?? 0,
      tag: null,
    });
  }

  if (folded.length === 0) return candidates;
  return [...candidates.filter((c) => !consumed.has(c)), ...folded];
}

function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

export function extractCulprits(rawItems: unknown, max = MAX_CULPRITS): PsiCulprit[] {
  if (!Array.isArray(rawItems)) return [];

  const candidates: Candidate[] = [];
  for (const raw of rawItems) {
    let item: Item;
    try {
      item = itemSchema.parse(raw);
    } catch {
      continue;
    }

    const bytes = item.totalBytes ?? item.transferSize ?? null;
    const wasted = item.wastedBytes ?? null;

    if (item.url) {
      const url = parseUrl(item.url);
      if (!url) continue;
      const tag = tagIdentityOf(url);
      candidates.push({
        culprit: {
          kind: kindOfUrl(url),
          label: tag ? `${tagProductName(tag.id)} ${tag.id}` : labelOfUrl(url),
          detail: detailOf(item, bytes, wasted),
          owner: isTagHost(url.hostname) ? "founder" : "developer",
          bytes,
          wastedBytes: wasted,
        },
        weight: weightOf(item),
        tag,
      });
      continue;
    }

    if (item.node) {
      candidates.push({
        culprit: {
          kind: "element",
          label: labelOfNode(item.node),
          detail: detailOf(item, bytes, wasted),
          owner: "developer",
          bytes,
          wastedBytes: wasted,
        },
        weight: weightOf(item),
        tag: null,
      });
      continue;
    }

  }

  return foldDuplicateTags(candidates)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map((c) => c.culprit);
}
