
type Row = Record<string, unknown>;

function readPath(row: Row, col: string): unknown {
  if (!col.includes("->")) return row[col];
  const parts = col.split(/->>?/);
  let v: unknown = row[parts[0]];
  for (const k of parts.slice(1)) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Row)[k];
  }
  return col.includes("->>") && v != null && typeof v !== "string" ? String(v) : v;
}

export type FakeSbOpts = {
  failUpdate?: (table: string, patch: Row) => boolean;
  failSelect?: (table: string) => boolean;
};

export function fakeSb(tables: Record<string, Row[]>, opts: FakeSbOpts = {}) {
  let seq = 0;
  const from = (table: string) => {
    tables[table] ??= [];
    const rows = tables[table];
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let patch: Row | null = null;
    let returning = false;
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;

    const run = () => {
      if (op === "insert") {
        const r = { id: `row-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...patch };
        rows.push(r);
        return { data: [r], error: null };
      }
      if (op === "select" && opts.failSelect?.(table)) {
        return { data: null, error: { message: "fake select failure" } };
      }
      if (op === "update" && patch && opts.failUpdate?.(table, patch)) {
        return { data: null, error: { message: "fake update failure" } };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, patch);
        return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (order) {
        const { col, asc } = order;
        hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (limit != null) hit = hit.slice(0, limit);
      return { data: hit.map((r) => ({ ...r })), error: null };
    };

    const b: Record<string, unknown> = {
      select: () => {
        if (op !== "select") returning = true;
        return b;
      },
      update: (p: Row) => {
        op = "update";
        patch = p;
        return b;
      },
      insert: (p: Row) => {
        op = "insert";
        patch = p;
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => readPath(r, col) === val);
        return b;
      },
      or: (expr: string) => {
        const clauses = expr.split(",").map((c) => {
          const m = /^(.+)\.(eq|neq|is)\.(.+)$/.exec(c);
          if (!m) throw new Error(`fakeSb: unsupported or clause ${c}`);
          return { col: m[1], op: m[2], val: m[3] };
        });
        filters.push((r) =>
          clauses.some(({ col, op, val }) => {
            const v = readPath(r, col);
            if (op === "is") return val === "null" ? v == null : String(v) === val;
            if (op === "eq") return v != null && String(v) === val;
            return v != null && String(v) !== val;
          }),
        );
        return b;
      },
      is: (col: string, val: unknown) => {
        filters.push((r) => (readPath(r, col) ?? null) === val);
        return b;
      },
      order: (col: string, o?: { ascending?: boolean }) => {
        order = { col, asc: o?.ascending !== false };
        return b;
      },
      limit: (n: number) => {
        limit = n;
        return b;
      },
      maybeSingle: async () => {
        const { data, error } = run();
        return { data: Array.isArray(data) ? (data[0] ?? null) : null, error: error ?? null };
      },
      single: async () => {
        const { data } = run();
        return { data: Array.isArray(data) ? (data[0] ?? null) : null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { from } as unknown as import("@supabase/supabase-js").SupabaseClient;
}
