
import { createHash } from "node:crypto";
import { fromAnthropicName } from "@/services/mcp/types";
import { parseDeclaredToolMatchers, toolMatchesDeclared } from "@/services/mcp/declared-tool-match";

export const SEARCH_TOOLS_NAME = "search_tools";

export const TOOL_SEARCH_START_CAP = 40;

export const TOOL_SEARCH_MAX_TOOLS = 50;
export const TOOL_SEARCH_MAX_DEF_CHARS = 60_000;

export const SEARCH_DEFAULT_K = 8;

export const TOOL_SEARCH_EMBED_DEADLINE_MS = 4000;
export const SEARCH_MAX_K = 15;

export const TOOL_SEARCH_PROMPT_SUFFIX =
  "More tools exist than are shown. Call search_tools with what you need before concluding a tool is unavailable.";

export type ToolSearchHints = {
  declaredTools: readonly string[];
  injectedToolNames: readonly string[];
  record?: boolean;
};

export type IndexedTool = {
  name: string;
  registeredName: string;
  serverId: string;
  description: string;
  schemaText: string;
  defChars?: number;
};

export type EmbedFn = (texts: string[], inputType: "document" | "query") => Promise<number[][]>;

function expandDeclared(entry: string, names: readonly string[]): string[] {
  const m = parseDeclaredToolMatchers([entry]);
  return names.filter((n) => toolMatchesDeclared(n, m));
}

export function computeStartingSet(
  names: readonly string[],
  hints: ToolSearchHints | undefined,
  cap: number = TOOL_SEARCH_START_CAP,
): string[] {
  if (!hints) return names.slice(0, cap);
  const present = new Set(names);
  const injected: string[] = [];
  const injectedSet = new Set<string>();
  for (const n of hints.injectedToolNames) {
    if (present.has(n) && !injectedSet.has(n)) {
      injected.push(n);
      injectedSet.add(n);
    }
  }
  const injectedKept = injected.slice(0, cap);
  const declaredBudget = cap - injectedKept.length;
  const declared: string[] = [];
  const seen = new Set<string>(injectedSet);
  for (const entry of hints.declaredTools) {
    if (declared.length >= declaredBudget) break;
    for (const n of expandDeclared(entry, names)) {
      if (seen.has(n)) continue;
      seen.add(n);
      declared.push(n);
      if (declared.length >= declaredBudget) break;
    }
  }
  return [...declared, ...injectedKept];
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "get", "i",
  "in", "is", "it", "me", "my", "need", "of", "on", "or", "our", "that", "the", "this", "to",
  "tool", "tools", "use", "want", "we", "with", "you", "your",
]);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

type KeywordDoc = { name: Set<string>; server: Set<string>; desc: Set<string> };

function keywordDoc(t: IndexedTool): KeywordDoc {
  const parts = fromAnthropicName(t.name);
  return {
    name: new Set(tokenize(parts?.tool_name ?? t.name)),
    server: new Set(tokenize(t.serverId)),
    desc: new Set(tokenize(t.description)),
  };
}

function keywordScore(d: KeywordDoc, q: readonly string[]): number {
  let s = 0;
  for (const tok of q) {
    if (d.name.has(tok)) s += 3;
    else if (d.server.has(tok)) s += 2;
    else if (d.desc.has(tok)) s += 1;
  }
  return s;
}

export function keywordRank(tools: readonly IndexedTool[], query: string, docs?: readonly KeywordDoc[]): number[] {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return [];
  const ds = docs ?? tools.map(keywordDoc);
  const scored: Array<{ i: number; s: number }> = [];
  ds.forEach((d, i) => {
    const s = keywordScore(d, q);
    if (s > 0) scored.push({ i, s });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.i);
}

const VECTOR_CACHE = new Map<string, number[]>();
const VECTOR_CACHE_MAX = 5000;

export function toolTextHash(t: Pick<IndexedTool, "name" | "description" | "schemaText">): string {
  return createHash("sha256").update(`${t.name}\u0000${t.description}\u0000${t.schemaText}`).digest("hex");
}

function toolEmbedText(t: IndexedTool): string {
  return `${t.name}: ${t.description}`.slice(0, 2000);
}

function cachePut(key: string, v: number[]): void {
  if (VECTOR_CACHE.size >= VECTOR_CACHE_MAX) {
    const oldest = VECTOR_CACHE.keys().next().value;
    if (oldest !== undefined) VECTOR_CACHE.delete(oldest);
  }
  VECTOR_CACHE.set(key, v);
}

export function _clearToolVectorCacheForTests(): void {
  VECTOR_CACHE.clear();
}
export function _toolVectorCacheSizeForTests(): number {
  return VECTOR_CACHE.size;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function fuseRanks(lists: ReadonlyArray<readonly number[]>, k = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((idx, rank) => score.set(idx, (score.get(idx) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i);
}

export type ToolSearchRecord = {
  surfaced: Set<string>;
  searches: Array<{ query: string; returned: string[] }>;
};

const RECORDS = new Map<string, ToolSearchRecord>();

export function takeToolSearchRecord(runId: string): ToolSearchRecord | undefined {
  const r = RECORDS.get(runId);
  RECORDS.delete(runId);
  return r;
}

export type ToolSearchState = {
  readonly loaded: ReadonlySet<string>;
  isLoaded(engineName: string): boolean;
  engineNameFor(registeredName: string): string | undefined;
  search(query: unknown, k: unknown): Promise<string>;
  readonly record: ToolSearchRecord;
};

export type CreateToolSearchArgs = {
  tools: readonly IndexedTool[];
  startingSet: readonly string[];
  maxTools?: number;
  maxDefChars?: number;
  pinned?: readonly string[];
  embed?: EmbedFn;
  runId?: string;
  recordForBench?: boolean;
  log?: (event: Record<string, unknown>) => void;
  embedDeadlineMs?: number;
};

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`tool search embedding exceeded ${ms}ms`);
      e.name = "ToolSearchEmbedTimeout";
      reject(e);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function oneLine(desc: string): string {
  const first = (desc ?? "").split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

function clampK(k: unknown): number {
  const n = typeof k === "number" && Number.isFinite(k) ? Math.floor(k) : SEARCH_DEFAULT_K;
  return Math.max(1, Math.min(SEARCH_MAX_K, n));
}

export function createToolSearch(a: CreateToolSearchArgs): ToolSearchState {
  const tools = a.tools;
  const maxTools = a.maxTools ?? TOOL_SEARCH_MAX_TOOLS;
  const maxChars = a.maxDefChars ?? TOOL_SEARCH_MAX_DEF_CHARS;
  const sizeOf = (t: IndexedTool) =>
    t.defChars ?? t.name.length + t.description.length + t.schemaText.length + 40;
  const log = a.log ?? ((e) => console.warn(JSON.stringify(e)));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const byRegistered = new Map(tools.map((t) => [t.registeredName, t.name]));
  const docs = tools.map(keywordDoc);

  const loaded = new Set<string>();
  let usedChars = SEARCH_TOOLS_DEF_CHARS;
  const tryLoad = (t: IndexedTool): boolean => {
    const c = sizeOf(t);
    if (loaded.size + 2 > maxTools || usedChars + c > maxChars) return false;
    loaded.add(t.name);
    usedChars += c;
    return true;
  };
  const pinned = new Set((a.pinned ?? []).filter((n) => a.startingSet.includes(n)));
  for (const n of pinned) {
    const t = byName.get(n);
    if (t) tryLoad(t);
  }
  for (const n of a.startingSet) {
    if (pinned.has(n) || loaded.has(n)) continue;
    const t = byName.get(n);
    if (t && !tryLoad(t)) break;
  }

  const record: ToolSearchRecord = { surfaced: new Set(loaded), searches: [] };
  if (a.recordForBench && a.runId) RECORDS.set(a.runId, record);

  let embedDisabled = !a.embed;
  let docVectorsP: Promise<number[][]> | null = null;
  const docVectors = (): Promise<number[][]> => {
    if (!docVectorsP) {
      docVectorsP = (async () => {
        const keys = tools.map(toolTextHash);
        const missing = tools.filter((_, i) => !VECTOR_CACHE.has(keys[i]));
        if (missing.length > 0) {
          const vs = await a.embed!(missing.map(toolEmbedText), "document");
          if (vs.length !== missing.length) throw new Error(`embed returned ${vs.length} vectors for ${missing.length} tools`);
          missing.forEach((t, i) => cachePut(toolTextHash(t), vs[i]));
        }
        return keys.map((k) => VECTOR_CACHE.get(k) ?? []);
      })();
    }
    return docVectorsP;
  };

  const rank = async (query: string): Promise<number[]> => {
    const kw = keywordRank(tools, query, docs);
    if (embedDisabled) return kw;
    try {
      const [dv, [qv]] = await withDeadline(
        Promise.all([docVectors(), a.embed!([query], "query")]),
        a.embedDeadlineMs ?? TOOL_SEARCH_EMBED_DEADLINE_MS,
      );
      const byEmbed = dv
        .map((v, i) => ({ i, s: v.length ? cosine(v, qv) : -Infinity }))
        .filter((x) => Number.isFinite(x.s))
        .sort((x, y) => y.s - x.s || x.i - y.i)
        .map((x) => x.i);
      return fuseRanks([kw, byEmbed]);
    } catch (e) {
      embedDisabled = true;
      docVectorsP = null;
      log({
        event: "tool_search_embed_fallback",
        error: e instanceof Error ? e.name : "unknown",
        message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
      return kw;
    }
  };

  const search = async (queryIn: unknown, kIn: unknown): Promise<string> => {
    const query = typeof queryIn === "string" ? queryIn.trim().slice(0, 500) : "";
    if (!query) return "Provide a query describing the capability you need, e.g. \"read ad campaign performance\".";
    const k = clampK(kIn);
    const ranked = await rank(query);
    const added: IndexedTool[] = [];
    const already: IndexedTool[] = [];
    const overCap: IndexedTool[] = [];
    for (const i of ranked) {
      if (added.length + overCap.length >= k) break;
      const t = tools[i];
      if (loaded.has(t.name)) {
        if (already.length < k) already.push(t);
      } else if (tryLoad(t)) {
        added.push(t);
      } else overCap.push(t);
    }
    const top = [...added, ...already, ...overCap];
    for (const t of top) record.surfaced.add(t.name);
    record.searches.push({ query, returned: top.map((t) => t.name) });

    if (top.length === 0) return `No tools match "${query}". Try other words for the capability you need.`;
    const fmt = (t: IndexedTool) => `- ${t.registeredName}: ${oneLine(t.description)}`;
    const out: string[] = [];
    if (added.length) out.push("Loaded (callable from your next step):", ...added.map(fmt));
    if (already.length) out.push("Already loaded:", ...already.map(fmt));
    if (overCap.length) {
      out.push(
        "Tool limit reached; use what is loaded. Not loaded:",
        ...overCap.map(fmt),
      );
    }
    return out.join("\n");
  };

  return {
    loaded,
    isLoaded: (n) => loaded.has(n),
    engineNameFor: (r) => byRegistered.get(r),
    search,
    record,
  };
}

export function toolNotFoundMessage(state: ToolSearchState, toolName: string): string {
  const engineName = state.engineNameFor(toolName);
  if (engineName) {
    return state.isLoaded(engineName)
      ? `Tool '${toolName}' was not loaded when you called it, so it did not run. It is loaded now: call it again.`
      : `Tool '${toolName}' is not loaded yet, so it did not run. Call ${SEARCH_TOOLS_NAME} to load it, then call it again.`;
  }
  return `Tool '${toolName}' is not available. Call ${SEARCH_TOOLS_NAME} to find a tool for what you need.`;
}

export const SEARCH_TOOLS_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "What you need to do, in plain words (e.g. \"list open GitHub pull requests\").",
    },
    k: {
      type: ["integer", "null"],
      description: `How many tools to return (default ${SEARCH_DEFAULT_K}, max ${SEARCH_MAX_K}).`,
    },
  },
  required: ["query", "k"],
  additionalProperties: false,
} as const;

export const SEARCH_TOOLS_DESCRIPTION =
  "Find and load more tools for this task. Returns matching tool names with a one-line description; " +
  "the tools become callable from your next step. Use it before concluding a tool is unavailable.";

const SEARCH_TOOLS_DEF_CHARS = JSON.stringify({
  name: SEARCH_TOOLS_NAME,
  description: SEARCH_TOOLS_DESCRIPTION,
  parameters: SEARCH_TOOLS_PARAMETERS,
}).length;
