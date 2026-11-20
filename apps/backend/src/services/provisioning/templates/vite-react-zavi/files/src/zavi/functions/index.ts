
export const FUNCTION_ABI = 1 as const;

export type FunctionKind = "http" | "webhook" | "schedule";

export type FunctionUser = { id: string; email: string | null; role: string | null };

export type FunctionRecord<T = Record<string, unknown>> = {
  id: string;
  data: T;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
};

export type FunctionListOptions = {
  filter?: Record<string, unknown>;
  order?: string;
  limit?: number;
  cursor?: string | null;
};

export interface FunctionCollection<T = Record<string, unknown>> {
  list(opts?: FunctionListOptions): Promise<{ items: FunctionRecord<T>[]; next_cursor: string | null }>;
  get(id: string): Promise<FunctionRecord<T> | null>;
  create(values: Partial<T>, opts?: { idempotencyKey?: string }): Promise<{ id: string; replayed: boolean }>;
  update(id: string, patch: Partial<Record<keyof T, unknown>>): Promise<{ id: string }>;
  transition(
    id: string,
    to: string,
    opts?: { expect?: Record<string, unknown>; set?: Record<string, unknown> },
  ): Promise<{ id: string; from: string; to: string; transitioned: boolean }>;
  delete(id: string): Promise<void>;
}

export interface FunctionDataApi {
  collection<T = Record<string, unknown>>(name: string): FunctionCollection<T>;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export interface FunctionLog {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type FetchFn = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export type PlatformBindings = {
  site_id: string;
  site_origin: string;
  function_name: string;
  invocation_id: string;
  data: FunctionDataApi;
  secrets: { get(name: string): Promise<string | null> };
  log: FunctionLog;
  fetch: FetchFn;
  now?: () => number;
};

export type Invocation =
  | { type: "request"; request: Request; user: FunctionUser | null }
  | { type: "schedule"; scheduled_time: string };

export type FunctionContext = {
  siteId: string;
  origin: string;
  name: string;
  invocationId: string;
  user: FunctionUser | null;
  data: FunctionDataApi;
  secrets: {
    get(name: string): Promise<string | null>;
    require(name: string): Promise<string>;
  };
  log: FunctionLog;
  fetch: FetchFn;
  now(): Date;
};

export type DefinedFunction = {
  readonly zaviFunction: typeof FUNCTION_ABI;
  readonly kind: FunctionKind;
  invoke(inv: Invocation, platform: PlatformBindings): Promise<Response>;
};

export class FunctionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "FunctionError";
  }
}

export const MAX_FUNCTION_BODY_BYTES = 1_048_576;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const errorBody = (code: string, message: string, request_id: string) => ({ error: { code, message, request_id } });

const MASK = "[secret]";

const MASKERS = new WeakMap<FunctionContext, (s: string) => string>();
const maskFor = (ctx: FunctionContext) => MASKERS.get(ctx) ?? ((s: string) => s);

function maskJson(v: unknown, mask: (s: string) => string): unknown {
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return mask(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x !== null && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(x as Record<string, unknown>)) o[mask(k)] = walk(y);
      return o;
    }
    return x;
  };
  const text = JSON.stringify(v);
  return text === undefined ? null : walk(JSON.parse(text));
}

export function createContext(platform: PlatformBindings, user: FunctionUser | null): FunctionContext {
  const seen = new Set<string>();
  const mask = (s: string): string => {
    let out = s;
    for (const v of [...seen].sort((a, b) => b.length - a.length)) {
      out = out.split(v).join(MASK);
      let esc = v;
      for (let i = 0; i < 3; i++) {
        const next = JSON.stringify(esc).slice(1, -1);
        if (next === esc) break;
        esc = next;
        out = out.split(esc).join(MASK);
      }
    }
    return out;
  };
  const maskFields = (f?: LogFields): LogFields | undefined => {
    if (!f) return f;
    const o: LogFields = {};
    for (const [k, v] of Object.entries(f)) o[k] = typeof v === "string" ? mask(v) : v;
    return o;
  };
  const log: FunctionLog = {
    info: (m, f) => platform.log.info(mask(String(m)), maskFields(f)),
    warn: (m, f) => platform.log.warn(mask(String(m)), maskFields(f)),
    error: (m, f) => platform.log.error(mask(String(m)), maskFields(f)),
  };
  const get = async (name: string): Promise<string | null> => {
    const v = await platform.secrets.get(name);
    if (typeof v === "string" && v) {
      seen.add(v);
      return v;
    }
    return null;
  };
  const ctx: FunctionContext = {
    siteId: platform.site_id,
    origin: platform.site_origin.replace(/\/+$/, ""),
    name: platform.function_name,
    invocationId: platform.invocation_id,
    user,
    data: platform.data,
    secrets: {
      get,
      async require(name) {
        const v = await get(name);
        if (v === null) {
          throw new FunctionError(503, "secret_missing", `This site is missing the secret ${name}. The site owner adds it in Settings > Secrets.`);
        }
        return v;
      },
    },
    log,
    fetch: platform.fetch,
    now: () => new Date(platform.now ? platform.now() : Date.now()),
  };
  MASKERS.set(ctx, mask);
  return ctx;
}

function failure(e: unknown, ctx: FunctionContext): Response {
  if (e instanceof FunctionError) {
    if (e.status >= 500) ctx.log.error(`${e.code}: ${e.message}`);
    const mask = maskFor(ctx);
    return json(e.status, errorBody(mask(e.code), mask(e.message), ctx.invocationId));
  }
  ctx.log.error(`unhandled error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  return json(500, errorBody("server", "Something went wrong. Try again in a moment.", ctx.invocationId));
}

async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FUNCTION_BODY_BYTES) {
    throw new FunctionError(413, "payload_too_large", "The request is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_FUNCTION_BODY_BYTES) {
    throw new FunctionError(413, "payload_too_large", "The request is too large.");
  }
  return text;
}

function wrongInvocation(kind: FunctionKind, platform: PlatformBindings): Response {
  platform.log.error(`a ${kind} function was invoked the wrong way`);
  return json(500, errorBody("server", "This function cannot be called this way.", platform.invocation_id));
}

export function defineFunction<I = unknown, O = unknown>(handler: (input: I, ctx: FunctionContext) => Promise<O> | O): DefinedFunction {
  return {
    zaviFunction: FUNCTION_ABI,
    kind: "http",
    async invoke(inv, platform) {
      if (inv.type !== "request") return wrongInvocation("http", platform);
      const ctx = createContext(platform, inv.user);
      try {
        if (inv.request.method !== "POST") throw new FunctionError(405, "method_not_allowed", "Call this with POST.");
        const raw = await readBody(inv.request);
        let input: unknown = null;
        if (raw.trim()) {
          try {
            input = JSON.parse(raw);
          } catch {
            throw new FunctionError(400, "validation", "The request body must be JSON.");
          }
        }
        const out = await handler(input as I, ctx);
        return json(200, { data: maskJson(out === undefined ? null : out, maskFor(ctx)) });
      } catch (e) {
        return failure(e, ctx);
      }
    },
  };
}

export type WebhookRequest = { rawBody: string; headers: Headers; method: string; url: string };

export type WebhookVerifier<E> = (req: WebhookRequest, ctx: FunctionContext) => Promise<E>;

export function defineWebhook<E>(def: { verify: WebhookVerifier<E>; handle: (event: E, ctx: FunctionContext) => Promise<unknown> | unknown }): DefinedFunction {
  if (!def || typeof def.verify !== "function" || typeof def.handle !== "function") {
    throw new Error("defineWebhook needs { verify, handle }: a webhook must prove its sender before it does anything");
  }
  return {
    zaviFunction: FUNCTION_ABI,
    kind: "webhook",
    async invoke(inv, platform) {
      if (inv.type !== "request") return wrongInvocation("webhook", platform);
      const ctx = createContext(platform, null);
      try {
        if (inv.request.method !== "POST") throw new FunctionError(405, "method_not_allowed", "Webhooks are POST.");
        const rawBody = await readBody(inv.request);
        const event = await def.verify({ rawBody, headers: inv.request.headers, method: inv.request.method, url: inv.request.url }, ctx);
        const out = await def.handle(event, ctx);
        if (out instanceof Response) return out;
        return json(200, { received: true });
      } catch (e) {
        return failure(e, ctx);
      }
    },
  };
}

export function defineSchedule(handler: (ctx: FunctionContext & { scheduledTime: Date }) => Promise<void> | void): DefinedFunction {
  return {
    zaviFunction: FUNCTION_ABI,
    kind: "schedule",
    async invoke(inv, platform) {
      if (inv.type !== "schedule") return wrongInvocation("schedule", platform);
      const ctx = createContext(platform, null);
      const t = new Date(inv.scheduled_time);
      try {
        await handler({ ...ctx, scheduledTime: Number.isNaN(t.getTime()) ? ctx.now() : t });
        return json(200, { ok: true });
      } catch (e) {
        return failure(e, ctx);
      }
    },
  };
}

export function isDefinedFunction(v: unknown): v is DefinedFunction {
  const f = v as Partial<DefinedFunction> | null;
  return !!f && f.zaviFunction === FUNCTION_ABI && (f.kind === "http" || f.kind === "webhook" || f.kind === "schedule") && typeof f.invoke === "function";
}
