
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;

export const db = {
  tables: {} as Record<string, Row[]>,
  offsetMs: 0,
  rpcCalls: [] as { name: string; args: Row }[],
  failUpdateOn: null as string | null,
  failUpdateIf: null as null | ((table: string, payload: Row) => boolean),
};

export const now = () => Date.now() + db.offsetMs;
export const advance = (ms: number) => {
  db.offsetMs += ms;
};
export const clock = { now, sleep: async (ms: number) => advance(ms) };

export function resetDb(): void {
  db.tables = { extension_panel_sessions: [], extension_browser_ops: [] };
  db.offsetMs = 0;
  db.rpcCalls = [];
  db.failUpdateOn = null;
  db.failUpdateIf = null;
}

const t = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
const iso = (ms: number) => new Date(ms).toISOString();

function withDefaults(table: string, r: Row): Row {
  const base: Row = { id: randomUUID(), created_at: iso(now()) };
  if (table === "extension_panel_sessions") {
    Object.assign(base, { attached_at: iso(now()), last_seen_at: iso(now()), ended_at: null });
  }
  if (table === "extension_browser_ops") {
    Object.assign(base, {
      status: "queued",
      execution_token: null,
      lease_until: null,
      result: null,
      idempotency_key: null,
    });
  }
  return { ...base, ...r };
}

function from(table: string) {
  const preds: ((r: Row) => boolean)[] = [];
  let mode: "select" | "insert" | "update" = "select";
  let payload: Row[] | Row | null = null;
  let returning = false;
  let countOnly = false;

  const run = (): { data: unknown; error: { message: string } | null; count?: number } => {
    if (mode === "update" && (db.failUpdateOn === table || db.failUpdateIf?.(table, payload as Row))) {
      return { data: null, error: { message: "db down" } };
    }
    const rows = (db.tables[table] ??= []);
    if (mode === "insert") {
      const added = (payload as Row[]).map((r) => withDefaults(table, r));
      rows.push(...added);
      return { data: returning ? added : null, error: null };
    }
    const hit = rows.filter((r) => preds.every((p) => p(r)));
    if (mode === "select" && countOnly) return { data: null, count: hit.length, error: null };
    if (mode === "update") {
      for (const r of hit) Object.assign(r, payload as Row);
      return { data: returning ? hit : null, error: null };
    }
    return { data: hit, error: null };
  };

  const chain: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => {
      if (mode !== "select") returning = true;
      if (opts?.head) countOnly = true;
      return chain;
    },
    insert: (rows: Row[]) => {
      mode = "insert";
      payload = rows;
      return chain;
    },
    update: (v: Row) => {
      mode = "update";
      payload = v;
      return chain;
    },
    eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), chain),
    is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), chain),
    gt: (c: string, v: string) => (preds.push((r) => t(r[c]) > t(v)), chain),
    gte: (c: string, v: string) => (preds.push((r) => t(r[c]) >= t(v)), chain),
    like: (c: string, pat: string) => {
      const re = new RegExp(`^${pat.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      preds.push((r) => typeof r[c] === "string" && re.test(r[c] as string));
      return chain;
    },
    in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), chain),
    maybeSingle: async () => ({ data: ((run().data as Row[]) ?? [])[0] ?? null, error: null }),
    single: async () => {
      const d = (run().data as Row[]) ?? [];
      return d.length === 1
        ? { data: d[0], error: null }
        : { data: null, error: { message: `single: ${d.length} rows` } };
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(run).then(res, rej),
  };
  return chain;
}

function liveSession(tenant: unknown, user: unknown, session: unknown): boolean {
  return db.tables.extension_panel_sessions.some(
    (s) =>
      s.id === session &&
      s.tenant_id === tenant &&
      s.user_id === user &&
      s.ended_at === null &&
      t(s.last_seen_at) > now() - 30_000,
  );
}

function claim(a: Row): Row[] {
  const { p_tenant_id: T, p_user_id: U, p_session_id: S } = a;
  if (!T || !U || !S) throw new Error("tenant_id, user_id and session_id are required");
  if (!liveSession(T, U, S)) return [];
  const mine = (o: Row) => o.tenant_id === T && o.user_id === U && o.panel_session_id === S;
  for (const o of db.tables.extension_browser_ops) {
    if (mine(o) && o.status === "delivered" && t(o.lease_until) <= now()) {
      o.status = o.is_write ? "unknown" : "lease_expired";
    }
  }
  const next = db.tables.extension_browser_ops
    .filter(
      (o) =>
        mine(o) &&
        (o.status === "queued" || o.status === "lease_expired") &&
        t(o.expires_at) > now(),
    )
    .sort((x, y) => t(x.created_at) - t(y.created_at) || (x.seq as number) - (y.seq as number))[0];
  if (!next) return [];
  Object.assign(next, {
    status: "delivered",
    execution_token: randomUUID(),
    lease_until: iso(now() + 15_000),
  });
  return [{ ...next }];
}

function complete(a: Row): boolean {
  if (a.p_status !== "done" && a.p_status !== "failed") throw new Error("status must be done or failed");
  const o = db.tables.extension_browser_ops.find(
    (o) =>
      o.id === a.p_op_id &&
      o.tenant_id === a.p_tenant_id &&
      o.user_id === a.p_user_id &&
      o.panel_session_id === a.p_session_id &&
      o.run_id === a.p_run_id &&
      o.execution_token === a.p_token &&
      o.status === "delivered" &&
      t(o.lease_until) > now() &&
      liveSession(a.p_tenant_id, a.p_user_id, a.p_session_id),
  );
  if (!o) return false;
  o.status = a.p_status;
  o.result = a.p_result;
  return true;
}

export const fakeServiceClient = {
  from,
  rpc: async (name: string, args: Row) => {
    db.rpcCalls.push({ name, args });
    try {
      if (name === "claim_extension_op") return { data: claim(args), error: null };
      if (name === "complete_extension_op") return { data: complete(args), error: null };
      return { data: null, error: { message: `unknown rpc ${name}` } };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
};

export function seedSession(r: Row): Row {
  const row = withDefaults("extension_panel_sessions", r);
  db.tables.extension_panel_sessions.push(row);
  return row;
}

export function seedOp(r: Row): Row {
  const row = withDefaults("extension_browser_ops", {
    expires_at: iso(now() + 30_000),
    op: { kind: "screenshot" },
    is_write: false,
    ...r,
  });
  db.tables.extension_browser_ops.push(row);
  return row;
}

export const opById = (id: unknown) => db.tables.extension_browser_ops.find((o) => o.id === id)!;
