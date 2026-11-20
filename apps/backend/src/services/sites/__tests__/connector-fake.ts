
type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

const arrayLiteral = (v: unknown): string | null =>
  Array.isArray(v) ? `{${v.map((x) => `"${String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}` : null;

export function fakeConnectorClient(
  rows: Row[],
  opts: { beforeUpdate?: (n: number) => void } = {},
) {
  const updates: Row[] = [];
  const from = (table: string) => {
    if (table !== "connector_metadata") throw new Error(`unexpected table ${table}`);
    const preds: Pred[] = [];
    const filters: [string, unknown][] = [];
    let pending: Row | null = null;
    const match = () => rows.filter((r) => preds.every((p) => p(r)));
    const apply = () => {
      if (!pending) return [] as Row[];
      updates.push(pending);
      opts.beforeUpdate?.(updates.length);
      const hit = match();
      for (const r of hit) Object.assign(r, structuredClone(pending));
      return hit;
    };
    const q = {
      select: () => {
        if (!pending) return q;
        return { then: (resolve: (v: unknown) => void) => resolve({ data: apply().map((r) => ({ tenant_id: r.tenant_id })), error: null }) };
      },
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        preds.push((r) => r[k] === v);
        return q;
      },
      is: (k: string, v: null) => {
        preds.push((r) => (r[k] ?? null) === v);
        return q;
      },
      filter: (k: string, op: string, lit: string) => {
        if (op !== "eq") throw new Error(`unsupported op ${op}`);
        preds.push((r) => arrayLiteral(r[k]) === lit);
        return q;
      },
      maybeSingle: async () => {
        const m = match();
        return { data: m[0] ? structuredClone(m[0]) : null, error: null };
      },
      update: (values: Row) => {
        pending = values;
        return q;
      },
      then: (resolve: (v: { error: null }) => void) => {
        apply();
        resolve({ error: null });
      },
    };
    return q;
  };
  return { client: { from }, updates };
}
