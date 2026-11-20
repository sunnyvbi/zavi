
export const RUNTIME_MODULE = "__zavi_runtime.js";
export const ENTRY_MODULE = "__zavi_entry.js";

export const RUNTIME_JS = String.raw`
const DATA_ORIGIN = "https://data.zavi.internal";
const INVOCATION_HEADER = "x-zavi-invocation";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export class DataError extends Error {
  constructor(status, code) {
    super(code || ("data_error_" + status));
    this.name = "DataError";
    this.status = status;
    this.code = code || null;
    this.reason = this.code;
  }
}

function idempotencyFactory(invocationId) {
  const base = String(invocationId || "inv").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  let n = 0;
  return () => {
    n += 1;
    let k = base + "-" + n;
    while (k.length < 16) k += "0";
    return k;
  };
}

export function createDataApi(invocationId, fetchFn) {
  const nextKey = idempotencyFactory(invocationId);
  const enc = encodeURIComponent;
  async function call(method, path, body, headers) {
    const init = { method, headers: Object.assign({ accept: "application/json" }, headers || {}) };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchFn(DATA_ORIGIN + path, init);
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res.ok) throw new DataError(res.status, j && j.error && j.error.code);
    return j ? j.data : null;
  }
  function collection(name) {
    const base = "/api/data/" + enc(name);
    return {
      list(q) {
        q = q || {};
        const p = new URLSearchParams();
        if (q.filter) p.set("filter", JSON.stringify(q.filter));
        const order = q.order || q.sort;
        if (order) p.set("sort", String(order));
        if (q.limit) p.set("limit", String(q.limit));
        if (q.cursor) p.set("cursor", String(q.cursor));
        const s = p.toString();
        return call("GET", base + (s ? "?" + s : ""));
      },
      async get(id) {
        try { return await call("GET", base + "/" + enc(id)); }
        catch (e) { if (e && e.status === 404) return null; throw e; }
      },
      create(data, o) { return call("POST", base, { data }, { "idempotency-key": (o && o.idempotencyKey) || nextKey() }); },
      update(id, patch) { return call("PATCH", base + "/" + enc(id), { patch }); },
      async delete(id) { await call("DELETE", base + "/" + enc(id)); },
      // expect / set make it one compare-and-set in the kernel (shard 0013); a lost race is
      // DataError code "transition_conflict" (409).
      transition(id, to, o) {
        const body = { to };
        if (o && o.expect !== undefined) body.expect = o.expect;
        if (o && o.set !== undefined) body.set = o.set;
        return call("POST", base + "/" + enc(id) + "/transition", body);
      },
    };
  }
  return {
    collection,
    action(name, body, o) { return call("POST", "/api/actions/" + enc(name), body || {}, { "idempotency-key": (o && o.idempotencyKey) || nextKey() }); },
    aggregate(name, filter) { return call("POST", "/api/aggregates/" + enc(name), filter ? { filter } : {}); },
  };
}

function logger(meta) {
  // log.info(message, fields?) per the SDK; extra args are stringified too.
  const line = (level, args) => {
    const msg = args.filter((a) => a !== undefined).map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(" ");
    const out = "[" + meta.function + "] " + msg;
    if (level === "error") console.error(out); else if (level === "warn") console.warn(out); else console.log(out);
  };
  return { info: (...a) => line("info", a), warn: (...a) => line("warn", a), error: (...a) => line("error", a) };
}

export async function serve(request, env, ctx, FUNCTIONS, SECRETS) {
  let meta = null;
  try { meta = JSON.parse(request.headers.get(INVOCATION_HEADER) || ""); } catch (e) { meta = null; }
  if (!meta || meta.v !== 1 || typeof meta.function !== "string") return json(400, { error: { code: "invalid_invocation" } });
  const mod = Object.prototype.hasOwnProperty.call(FUNCTIONS, meta.function) ? FUNCTIONS[meta.function] : null;
  const def = mod && mod.default;
  if (!def || def.zaviFunction !== 1 || typeof def.invoke !== "function") {
    console.error("[" + meta.function + "] functions/" + meta.function + ".ts must default-export a Zavi function (zaviFunction: 1, invoke)");
    return json(500, { error: { code: "function_invalid_export" } });
  }
  // The manifest's kind decides how the platform calls it: a webhook endpoint whose file
  // exports defineFunction (no signature check) never runs.
  if (def.kind !== meta.kind) {
    console.error("[" + meta.function + "] functions/" + meta.function + ".ts is a " + String(def.kind) + " function but zavi-site.json declares it as " + String(meta.kind));
    return json(500, { error: { code: "function_kind_mismatch" } });
  }
  const headers = new Headers(request.headers);
  headers.delete(INVOCATION_HEADER);
  const clean = new Request(request, { headers });
  const inv = meta.type === "schedule"
    ? { type: "schedule", scheduled_time: meta.scheduled_time, idempotency_key: meta.idempotency_key, attempt: meta.attempt }
    : { type: "request", request: clean, user: meta.user ? { id: meta.user.id, email: null, role: meta.user.role } : null };
  const declared = new Set(SECRETS);
  const platform = {
    site_id: meta.site_id,
    site_origin: typeof meta.site_origin === "string" ? meta.site_origin : new URL(request.url).origin,
    function_name: meta.function,
    invocation_id: meta.invocation_id,
    data: createDataApi(meta.invocation_id, (u, i) => fetch(u, i)),
    secrets: { get: async (n) => (declared.has(n) && typeof env[n] === "string" ? env[n] : null) },
    log: logger(meta),
    fetch: (u, i) => fetch(u, i),
    now: () => Date.now(),
  };
  try {
    const res = await def.invoke(inv, platform);
    if (!(res instanceof Response)) {
      console.error("[" + meta.function + "] invoke() must return a Response");
      return json(500, { error: { code: "function_bad_response" } });
    }
    return res;
  } catch (e) {
    console.error("[" + meta.function + "] " + ((e && e.name) || "Error") + ": " + ((e && e.message) || String(e)));
    return json(500, { error: { code: "function_threw" } });
  }
}
`;

export function entrySource(modules: Array<{ name: string; module: string }>, secrets: readonly string[]): string {
  const imports = modules.map((m, i) => `import * as f${i} from ${JSON.stringify(`./${m.module}`)};`).join("\n");
  const table = modules.map((m, i) => `${JSON.stringify(m.name)}: f${i}`).join(", ");
  return [
    `import { serve } from "./${RUNTIME_MODULE}";`,
    imports,
    `const FUNCTIONS = Object.freeze({ ${table} });`,
    `const SECRETS = Object.freeze(${JSON.stringify([...secrets])});`,
    `export default { fetch(request, env, ctx) { return serve(request, env, ctx, FUNCTIONS, SECRETS); } };`,
    "",
  ].join("\n");
}
