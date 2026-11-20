
type Row = Record<string, unknown>;

type Filter =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "in"; col: string; vals: unknown[] }
  | { kind: "lt"; col: string; val: unknown }
  | { kind: "gt"; col: string; val: unknown }
  | { kind: "is_null"; col: string };

function getPath(row: Row, col: string): unknown {
  if (col.includes("->")) {
    const parts = col.split(/->>?/).map((p) => p.trim());
    let cur: unknown = row;
    for (const p of parts) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[p];
      else return undefined;
    }
    return cur;
  }
  return row[col];
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = getPath(row, f.col);
    if (f.kind === "eq" && v !== f.val) return false;
    if (f.kind === "in" && !f.vals.includes(v)) return false;
    if (f.kind === "lt" && !(typeof v === "string" && typeof f.val === "string" && v < f.val)) return false;
    if (f.kind === "gt" && !(typeof v === "string" && typeof f.val === "string" && v > f.val)) return false;
    if (f.kind === "is_null" && v != null) return false;
  }
  return true;
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {
    ad_set_strategist_reviews: [],
    decisions: [],
    agent_runs: [],
  };

  private seq = 0;
  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  seedReview(r: Partial<Row> & { pending_decision_id: string; tenant_id: string }): void {
    this.tables.ad_set_strategist_reviews.push({
      status: "pending",
      attempts: 0,
      review_run_id: null,
      final_decision_id: null,
      bounce_reason: null,
      claimed_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      ...r,
    });
  }
  seedDecision(r: Partial<Row> & { id: string; tenant_id: string; decision_class: string }): void {
    this.tables.decisions.push({ status: "acted", body: {}, agent_run_id: null, ...r });
  }
  seedAgentRun(r: Partial<Row> & { id: string; status: string; tenant_id: string }): void {
    this.tables.agent_runs.push(r);
  }

  reviews(): Row[] {
    return this.tables.ad_set_strategist_reviews;
  }
  decisions(): Row[] {
    return this.tables.decisions;
  }

  from(table: string): Builder {
    return new Builder(this, table);
  }

  failRpc = false;

  async rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
    if (this.failRpc) return { data: null, error: { message: "rpc down" } };
    if (name === "emit_decision") {
      const cls = args.p_decision_class as string;
      const body = (args.p_body ?? {}) as Record<string, unknown>;
      const origin = (body as { strategist_gate?: { origin_pending_decision_id?: string } }).strategist_gate?.origin_pending_decision_id;
      if (cls === "meta_ads.create_ad_set" && origin) {
        const dup = this.tables.decisions.some(
          (d) =>
            d.decision_class === "meta_ads.create_ad_set" &&
            (d.body as { strategist_gate?: { origin_pending_decision_id?: string } })?.strategist_gate?.origin_pending_decision_id === origin,
        );
        if (dup) {
          return {
            data: null,
            error: { message: 'duplicate key value violates unique constraint "decisions_strategist_origin_uq" (23505)' },
          };
        }
      }
      const id = this.nextId("dec");
      this.tables.decisions.push({
        id,
        tenant_id: args.p_tenant_id,
        agent_run_id: args.p_agent_run_id ?? null,
        decision_class: cls,
        body,
        status: "proposed",
      });
      return { data: id, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  }
}

class Builder {
  private op: "select" | "update" | "upsert" | null = null;
  private patch: Row = {};
  private filters: Filter[] = [];
  private wantSelect = false;
  private single = false;
  private limitN: number | null = null;
  private upsertRows: Row[] = [];
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};

  constructor(private db: FakeSupabase, private table: string) {}

  select(_cols?: string): this {
    if (this.op === null) this.op = "select";
    this.wantSelect = true;
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  upsert(row: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.op = "upsert";
    this.upsertRows = Array.isArray(row) ? row : [row];
    this.upsertOpts = opts;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push({ kind: "in", col, vals });
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push({ kind: "lt", col, val });
    return this;
  }
  gt(col: string, val: unknown): this {
    this.filters.push({ kind: "gt", col, val });
    return this;
  }
  is(col: string, val: null): this {
    if (val === null) this.filters.push({ kind: "is_null", col });
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }

  private rows(): Row[] {
    return this.db.tables[this.table] ?? (this.db.tables[this.table] = []);
  }

  private exec(): { data: unknown; error: { message: string } | null } {
    const rows = this.rows();
    if (this.op === "upsert" && this.upsertRows.length) {
      const conflictCols = (this.upsertOpts.onConflict ?? "pending_decision_id")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const row of this.upsertRows) {
        const existing = rows.find((r) => conflictCols.every((col) => r[col] === row[col]));
        if (existing) {
          if (!this.upsertOpts.ignoreDuplicates) Object.assign(existing, row);
        } else {
          rows.push({ ...row });
        }
      }
      return { data: null, error: null };
    }
    if (this.op === "update") {
      const matched = rows.filter((r) => matches(r, this.filters));
      for (const r of matched) Object.assign(r, this.patch);
      if (this.wantSelect) {
        const out = matched.map((r) => ({ ...r }));
        return { data: this.single ? out[0] ?? null : out, error: null };
      }
      return { data: null, error: null };
    }
    let matched = rows.filter((r) => matches(r, this.filters));
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    const out = matched.map((r) => ({ ...r }));
    return { data: this.single ? out[0] ?? null : out, error: null };
  }

  then<T>(resolve: (v: { data: unknown; error: { message: string } | null }) => T): T {
    return resolve(this.exec());
  }
}
