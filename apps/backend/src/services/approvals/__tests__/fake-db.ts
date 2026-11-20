export type Row = Record<string, unknown>;
export type RpcHandler = (args: Record<string, unknown>) => unknown;

export function makeFakeDb() {
  const tables: Record<string, Row[]> = {};
  const rpcs: Record<string, RpcHandler> = {};
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const preds: Array<(r: Row) => boolean> = [];
    let lim: number | undefined;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v) && preds.every((p) => p(r)));
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      neq: (k: string, v: unknown) => (preds.push((r) => r[k] !== v), b),
      gte: (k: string, v: string | number) => (preds.push((r) => (r[k] as string | number) >= v), b),
      in: (k: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[k])), b),
      order: () => b,
      limit: (n: number) => ((lim = n), b),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => {
        const r = rows()[0];
        return r ? { data: r, error: null } : { data: null, error: { message: "no rows" } };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows().slice(0, lim), error: null }).then(res, rej),
      insert: (input: Row | Row[]) => {
        const arr = Array.isArray(input) ? input : [input];
        (tables[table] ??= []).push(...arr.map((r) => ({ ...r })));
        const done = { data: arr, error: null };
        return Object.assign(Promise.resolve(done), { select: () => ({ single: async () => ({ data: arr[0], error: null }), maybeSingle: async () => ({ data: arr[0], error: null }) }) });
      },
      update: (vals: Row) => {
        const u: Record<string, unknown> = {};
        Object.assign(u, {
          eq: (k: string, v: unknown) => (filters.push([k, v]), u),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
            for (const r of rows()) Object.assign(r, vals);
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          },
        });
        return u;
      },
      delete: () => {
        const d: Record<string, unknown> = {};
        Object.assign(d, {
          eq: (k: string, v: unknown) => (filters.push([k, v]), d),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
            const gone = new Set(rows());
            if (tables[table]) tables[table] = tables[table].filter((r) => !gone.has(r));
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          },
        });
        return d;
      },
    });
    return b;
  }

  const client = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      const h = rpcs[fn];
      if (!h) return { data: null, error: { message: `rpc ${fn} not stubbed` } };
      try {
        return { data: await h(args), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };

  return {
    tables,
    rpcs,
    rpcCalls,
    client,
    put(table: string, row: Row) {
      (tables[table] ??= []).push(row);
      return row;
    },
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      for (const k of Object.keys(rpcs)) delete rpcs[k];
      rpcCalls.length = 0;
    },
  };
}

export const sharedDb = makeFakeDb();
