
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpCallResult } from "@/services/mcp/types";
import { readDbGeneration } from "@/services/data-gateway";

const SHARED_READ_SERVERS: ReadonlySet<string> = new Set([
  "meta_ads", "google_ads", "tiktok_ads", "linkedin_ads", "reddit_ads", "x_ads",
  "microsoft_ads", "snapchat_ads", "pinterest_ads", "spotify_ads", "apple_ads", "chatgpt_ads",
  "google_analytics", "google_search_console", "posthog", "operator_db", "github",
]);

type Cache = Map<string, Promise<McpCallResult>>;
const store = new AsyncLocalStorage<Cache>();

export const LAB_READ_RETRY = { ms: 4000 };
const failed = (r: McpCallResult): boolean => r.is_error === true || r.ok === false;
const lanes = new Map<string, Promise<unknown>>();
export const LAB_LANE_LIMIT = { ms: 120_000 };
function inLane(key: string, fn: () => Promise<McpCallResult>): Promise<McpCallResult> {
  const bounded = () => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      fn(),
      new Promise<McpCallResult>((resolve) => {
        t = setTimeout(
          () => resolve({ ok: false, is_error: true, content: JSON.stringify({ error: "lab_read_timeout", message: `no answer in ${Math.round(LAB_LANE_LIMIT.ms / 1000)}s` }), ms: LAB_LANE_LIMIT.ms }),
          LAB_LANE_LIMIT.ms,
        );
      }),
    ]).finally(() => clearTimeout(t));
  };
  const next = (lanes.get(key) ?? Promise.resolve()).then(bounded, bounded);
  lanes.set(key, next.catch(() => undefined));
  return next;
}

export function newLabReadCache(): Cache {
  return new Map();
}

export function withLabReadCache<T>(cache: Cache, fn: () => Promise<T>): Promise<T> {
  return store.run(cache, fn);
}

export function labCaseActive(): boolean {
  return store.getStore() !== undefined;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export async function labSharedRead(
  tenant_id: string,
  server_id: string,
  tool_name: string,
  args: unknown,
  call: () => Promise<McpCallResult>,
): Promise<McpCallResult> {
  const cache = store.getStore();
  if (!cache || !SHARED_READ_SERVERS.has(server_id)) return call();
  let fence = "";
  if (server_id === "operator_db") {
    const gen = await Promise.resolve()
      .then(() => readDbGeneration(tenant_id))
      .catch(() => null);
    if (gen === null) return inLane(`${tenant_id}|${server_id}`, call);
    fence = `|g${gen}`;
  }
  const key = `${tenant_id}|${server_id}__${tool_name}|${stable(args)}${fence}`;
  const hit = cache.get(key);
  if (hit) return hit.then((r) => (failed(r) ? r : { ...r, ms: 0 }));
  const once = () => inLane(`${tenant_id}|${server_id}`, call);
  const p = once()
    .then(async (r) => {
      if (!failed(r)) return r;
      await new Promise((res) => setTimeout(res, LAB_READ_RETRY.ms));
      return once();
    })
    .then(
      (r) => {
        if (failed(r)) cache.delete(key);
        return r;
      },
      (e) => {
        cache.delete(key);
        throw e;
      },
    );
  cache.set(key, p);
  return p;
}
