type Row = Record<string, unknown>;

export const fakeDb = {
  tables: {} as Record<string, Row[]>,
  errors: {} as Record<string, { message: string } | undefined>,
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
  reset(): void {
    this.tables = {};
    this.errors = {};
    this.reads = [];
  },
};

function query(table: string): unknown {
  const filters: Array<[string, string, unknown]> = [];
  let limit = Infinity;
  let order: [string, boolean] | null = null;
  fakeDb.reads.push({ table, filters });
  const rows = (): Row[] => {
    let out = (fakeDb.tables[table] ?? []).filter((r) =>
      filters.every(([op, col, v]) => (op === "eq" ? r[col] === v : op === "in" ? (v as unknown[]).includes(r[col]) : true)),
    );
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    return out.slice(0, limit);
  };
  const result = () => ({ data: fakeDb.errors[table] ? null : rows(), error: fakeDb.errors[table] ?? null });
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
      if (prop === "eq") return (c: string, v: unknown) => (filters.push(["eq", c, v]), proxy);
      if (prop === "in") return (c: string, v: unknown[]) => (filters.push(["in", c, v]), proxy);
      if (prop === "limit") return (n: number) => ((limit = n), proxy);
      if (prop === "order") return (c: string, o?: { ascending?: boolean }) => ((order = [c, o?.ascending !== false]), proxy);
      if (prop === "maybeSingle" || prop === "single")
        return async () => ({ data: fakeDb.errors[table] ? null : (rows()[0] ?? null), error: fakeDb.errors[table] ?? null });
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

export function fakeServiceClient(): unknown {
  return {
    from: (table: string) => query(table),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => query("__storage") },
  };
}
