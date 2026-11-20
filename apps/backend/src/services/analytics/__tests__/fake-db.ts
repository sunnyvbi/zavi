
export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

type Filter = (r: Row) => boolean;

function orFilter(expr: string): Filter {
  const parts = expr.split(",").map((p) => {
    const [col, op, ...rest] = p.split(".");
    const val = rest.join(".");
    if (op === "is" && val === "null") return (r: Row) => r[col] == null;
    if (op === "eq") return (r: Row) => String(r[col]) === val;
    throw new Error(`fake-db: unsupported or() term ${p}`);
  });
  return (r) => parts.some((f) => f(r));
}

export function makeDb(tables: Tables) {
  let seq = 0;
  function builder(table: string, mode: "select" | "insert" | "update", payload?: unknown) {
    const filters: Filter[] = [];
    let order: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    const rowsNow = () => {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      return limitN == null ? rows : rows.slice(0, limitN);
    };
    const settle = (): { data: Row[] | null; error: { message: string } | null } => {
      if (mode === "insert") {
        const rows = (payload as Row[]).map((r) => ({
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          created_at: new Date(Date.UTC(2026, 8, 28, 10, seq)).toISOString(),
          active: true,
          ...r,
        }));
        tables[table] = [...(tables[table] ?? []), ...rows];
        return { data: rows, error: null };
      }
      if (mode === "update") {
        const rows = rowsNow();
        for (const r of rows) Object.assign(r, payload as Row);
        return { data: rows, error: null };
      }
      return { data: rowsNow(), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      or: (expr: string) => (filters.push(orFilter(expr)), b),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limitN = n), b),
      single: async () => {
        const res = settle();
        const row = res.data?.[0];
        return row ? { data: row, error: null } : { data: null, error: { message: "no row" } };
      },
      maybeSingle: async () => {
        const res = settle();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(settle()).then(ok, bad),
    };
    return b;
  }
  return {
    tables,
    client: {
      from: (table: string) => ({
        select: () => builder(table, "select"),
        insert: (rows: Row | Row[]) => builder(table, "insert", Array.isArray(rows) ? rows : [rows]),
        update: (values: Row) => builder(table, "update", values),
        delete: () => builder(table, "select"),
      }),
    },
  };
}
