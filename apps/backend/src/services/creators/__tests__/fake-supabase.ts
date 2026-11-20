
export type FakeTables = Record<string, Array<Record<string, unknown>>>;

type Filter = (row: Record<string, unknown>) => boolean;

export type FakeDb = {
  client: {
    from: (table: string) => unknown;
    storage: {
      from: (bucket: string) => {
        createSignedUrl: (
          path: string,
          ttl: number,
        ) => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
      };
    };
  };
  tables: FakeTables;
  signedFor: Array<{ bucket: string; path: string; ttl: number }>;
  inserted: Array<{ table: string; rows: Array<Record<string, unknown>> }>;
  updated: Array<{ table: string; values: Record<string, unknown> }>;
};

export function makeFakeDb(
  tables: FakeTables,
  opts: { uniqueViolationOn?: (table: string, row: Record<string, unknown>) => boolean } = {},
): FakeDb {
  const signedFor: FakeDb["signedFor"] = [];
  const inserted: FakeDb["inserted"] = [];
  const updated: FakeDb["updated"] = [];

  function makeBuilder(table: string, mode: "select" | "insert" | "update" | "delete", payload?: unknown) {
    const filters: Filter[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null;

    const apply = (): Array<Record<string, unknown>> => {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[o.col] as string | number;
          const bv = b[o.col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (o.asc ? 1 : -1);
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    };

    const runWrite = (): { data: Array<Record<string, unknown>> | null; error: { code?: string; message: string } | null } => {
      if (mode === "insert") {
        const rows = (payload as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        for (const r of rows) {
          if (opts.uniqueViolationOn?.(table, r)) {
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
          if (!r.id) r.id = `row-${(tables[table] ?? []).length + 1}`;
          if (!r.utm_campaign) r.utm_campaign = `zavi-cr-generated${(tables[table] ?? []).length + 1}`;
          r.created_at = r.created_at ?? new Date().toISOString();
          r.updated_at = r.updated_at ?? new Date().toISOString();
          tables[table] = [...(tables[table] ?? []), r];
        }
        inserted.push({ table, rows });
        return { data: rows, error: null };
      }
      if (mode === "update") {
        const values = payload as Record<string, unknown>;
        const rows = apply();
        for (const r of rows) Object.assign(r, values);
        updated.push({ table, values });
        return { data: rows, error: null };
      }
      return { data: apply(), error: null };
    };

    const settle = () => (mode === "select" ? { data: apply(), error: null } : runWrite());

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        filters.push((r) => r[col] !== val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      not: (col: string, _op: string, _val: unknown) => {
        filters.push((r) => r[col] != null);
        return builder;
      },
      lte: (col: string, val: string) => {
        filters.push((r) => String(r[col]) <= val);
        return builder;
      },
      order: (col: string, o?: { ascending?: boolean }) => {
        orders.push({ col, asc: o?.ascending !== false });
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      maybeSingle: async () => {
        const res = settle();
        return { data: (res.data ?? [])[0] ?? null, error: res.error };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(settle()).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e);
        }
      },
    };
    return builder;
  }

  return {
    tables,
    signedFor,
    inserted,
    updated,
    client: {
      from: (table: string) => ({
        select: (_cols?: string, _opts?: unknown) => makeBuilder(table, "select"),
        insert: (rows: Record<string, unknown> | Array<Record<string, unknown>>) =>
          makeBuilder(table, "insert", Array.isArray(rows) ? rows : [rows]),
        update: (values: Record<string, unknown>) => makeBuilder(table, "update", values),
        delete: () => makeBuilder(table, "delete"),
        upsert: (rows: Record<string, unknown>) => makeBuilder(table, "insert", [rows]),
      }),
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: async (path: string, ttl: number) => {
            signedFor.push({ bucket, path, ttl });
            return { data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null };
          },
        }),
      },
    },
  };
}
