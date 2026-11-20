import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in"; val: unknown };
type Op = "select" | "insert" | "update" | "delete" | "upsert";
type DbError = { code: string; message: string };

export type QueryLog = { table: string; op: Op; filters: Filter[]; payload: Row[] };

export const TENANT_USERS = "tenant_users";
export const PGRST_MAX_ROWS = 1000;
export const BUCKET = "tenant-documents";
export const PUBLIC_BASE = "https://api.test.zavi";

export type FakeState = {
  tables: Record<string, Row[]>;
  queries: QueryLog[];
  objects: Map<string, { body: Buffer; contentType?: string }>;
  uploads: Array<{ bucket: string; path: string; contentType?: string; upsert?: boolean }>;
  removes: Array<{ bucket: string; paths: string[] }>;
  downloads: string[];
  uploadCalls: number;
  failUploadOnCall: number | null;
  failIndexWrite: { message: string } | "throw" | null;
  failDownload: { message: string; statusCode?: string } | "throw" | null;
  staleIndexReads: boolean;
  priorIndex: Map<string, Buffer | null>;
  beforeIndexWrite: (() => void | Promise<void>) | null;
  failNext: Array<{ table: string; op: Op; code?: string; message?: string }>;
  failRemove: { message: string } | "throw" | null;
  beforeQuery: ((q: { table: string; op: Op }) => void) | null;
  clock: number;
};

function freshState(): FakeState {
  return {
    tables: { [TENANT_USERS]: [] },
    queries: [],
    objects: new Map(),
    uploads: [],
    removes: [],
    downloads: [],
    uploadCalls: 0,
    failUploadOnCall: null,
    failIndexWrite: null,
    failDownload: null,
    staleIndexReads: false,
    priorIndex: new Map(),
    beforeIndexWrite: null,
    failNext: [],
    failRemove: null,
    beforeQuery: null,
    clock: 0,
  };
}


class Query implements PromiseLike<{ data: unknown; error: DbError | null; count?: number | null }> {
  private op: Op | null = null;
  private columns = "*";
  private returning = false;
  private countOnly = false;
  private filters: Filter[] = [];
  private payload: Row[] = [];
  private patch: Row = {};
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private window: { from: number; to: number } | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private onConflict: string[] = [];
  private ignoreDuplicates = false;

  constructor(
    private readonly s: FakeState,
    private readonly table: string,
  ) {}

  select(columns?: string, opts?: { count?: string; head?: boolean }): this {
    if (this.op === null) {
      this.op = "select";
      this.countOnly = !!opts?.head;
    } else {
      this.returning = true;
    }
    this.columns = columns ?? "*";
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.op = "insert";
    this.payload = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
    return this;
  }

  update(values: Row): this {
    this.op = "update";
    this.patch = { ...values };
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.payload = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
    this.onConflict = (opts?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    this.ignoreDuplicates = !!opts?.ignoreDuplicates;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: "eq", val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push({ col, op: "in", val: [...vals] });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }

  range(from: number, to: number): this {
    this.window = { from, to };
    return this;
  }

  single(): this {
    this.mode = "single";
    return this;
  }

  maybeSingle(): this {
    this.mode = "maybe";
    return this;
  }

  then<A = { data: unknown; error: DbError | null }, B = never>(
    onFulfilled?: ((v: { data: unknown; error: DbError | null; count?: number | null }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.exec())
      .then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) =>
      f.op === "eq" ? row[f.col] === f.val : (f.val as unknown[]).includes(row[f.col]),
    );
  }

  private project(row: Row): Row {
    if (this.columns === "*" || !this.columns) return { ...row };
    const out: Row = {};
    for (const c of this.columns.split(",").map((x) => x.trim())) out[c] = row[c];
    return out;
  }

  private finish(rows: Row[]): { data: unknown; error: DbError | null } {
    const projected = rows.map((r) => this.project(r));
    if (this.mode === "single") {
      return projected.length === 1
        ? { data: projected[0], error: null }
        : { data: null, error: { code: "PGRST116", message: "expected one row" } };
    }
    if (this.mode === "maybe") {
      if (projected.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: projected[0] ?? null, error: null };
    }
    return { data: projected, error: null };
  }

  private rows(): Row[] {
    return this.s.tables[this.table] ?? (this.s.tables[this.table] = []);
  }

  private withDefaults(r: Row): Row {
    return { ...r };
  }

  private violates(_candidate: Row, _existing: Row[]): DbError | null {
    return null;
  }

  private cascade(_removed: Row[]): void {}

  private exec(): { data: unknown; error: DbError | null; count?: number | null } {
    const op = this.op ?? "select";
    this.s.beforeQuery?.({ table: this.table, op });
    this.s.queries.push({
      table: this.table,
      op,
      filters: this.filters.map((f) => ({ ...f })),
      payload: op === "update" ? [{ ...this.patch }] : this.payload.map((r) => ({ ...r })),
    });
    const failIdx = this.s.failNext.findIndex((f) => f.table === this.table && f.op === op);
    if (failIdx >= 0) {
      const [hit] = this.s.failNext.splice(failIdx, 1);
      return { data: null, error: { code: hit?.code ?? "XX000", message: hit?.message ?? "injected failure" } };
    }

    const table = this.rows();
    if (op === "select") {
      let rows = table.filter((r) => this.matches(r));
      if (this.orderBy.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const { col, asc } of this.orderBy) {
            const x = String(a[col]);
            const y = String(b[col]);
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      if (this.countOnly) return { data: null, error: null, count: rows.length };
      const start = this.window?.from ?? 0;
      const end = this.window ? this.window.to + 1 : rows.length;
      return this.finish(rows.slice(start, Math.min(end, start + PGRST_MAX_ROWS)));
    }

    if (op === "insert") {
      const staged: Row[] = [];
      for (const raw of this.payload) {
        const row = this.withDefaults(raw);
        const err = this.violates(row, [...table, ...staged]);
        if (err) return { data: null, error: err };
        staged.push(row);
      }
      table.push(...staged);
      return this.returning ? this.finish(staged) : { data: null, error: null };
    }

    if (op === "upsert") {
      const staged: Row[] = [];
      for (const raw of this.payload) {
        const row = this.withDefaults(raw);
        const hit = [...table, ...staged].find((e) => this.onConflict.every((c) => e[c] === row[c]));
        if (hit) {
          if (this.ignoreDuplicates) continue;
          Object.assign(hit, row);
          continue;
        }
        const err = this.violates(row, [...table, ...staged]);
        if (err) return { data: null, error: err };
        staged.push(row);
      }
      table.push(...staged);
      return this.returning ? this.finish(staged) : { data: null, error: null };
    }

    if (op === "update") {
      const targets = table.filter((r) => this.matches(r));
      for (const t of targets) {
        const next = { ...t, ...this.patch };
        const err = this.violates(next, table.filter((r) => r !== t));
        if (err) return { data: null, error: err };
      }
      for (const t of targets) Object.assign(t, this.patch);
      return this.returning ? this.finish(targets) : { data: null, error: null };
    }

    const removed = table.filter((r) => this.matches(r));
    this.s.tables[this.table] = table.filter((r) => !this.matches(r));
    this.cascade(removed);
    return this.returning ? this.finish(removed) : { data: null, error: null };
  }
}

export function indexKey(tenantId: string): string {
  return `${BUCKET}/${tenantId}/workspace-files/index.json`;
}

type IndexShape = {
  version: 1;
  files: Array<Record<string, unknown>>;
  collections: Array<{ id: string; name: string; created_at: string; file_ids: string[] }>;
};

export function createFakeSupabase() {
  const state = freshState();

  function reset(): void {
    Object.assign(state, freshState());
  }

  function client() {
    return {
      from: (table: string) => new Query(state, table),
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, body: Buffer, opts?: { contentType?: string; upsert?: boolean }) => {
            const key = `${bucket}/${path}`;
            const isIndex = path.endsWith("/workspace-files/index.json");
            if (isIndex) {
              await state.beforeIndexWrite?.();
              if (state.failIndexWrite === "throw") throw new Error("storage socket hang up");
              if (state.failIndexWrite) return { data: null, error: { message: state.failIndexWrite.message } };
            } else {
              state.uploadCalls += 1;
              if (state.failUploadOnCall === state.uploadCalls) {
                return { data: null, error: { message: "storage unavailable" } };
              }
            }
            if (state.objects.has(key) && !opts?.upsert) {
              return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
            }
            if (isIndex) state.priorIndex.set(key, state.objects.get(key)?.body ?? null);
            state.objects.set(key, { body: Buffer.from(body), contentType: opts?.contentType });
            state.uploads.push({ bucket, path, contentType: opts?.contentType, upsert: opts?.upsert });
            return { data: { path }, error: null };
          },
          download: async (path: string) => {
            state.downloads.push(`${bucket}/${path}`);
            if (state.failDownload === "throw") throw new Error("storage socket hang up");
            if (state.failDownload) return { data: null, error: { ...state.failDownload } };
            const key = `${bucket}/${path}`;
            if (state.staleIndexReads && state.priorIndex.has(key)) {
              const prior = state.priorIndex.get(key);
              if (!prior) return { data: null, error: { message: "Object not found", statusCode: "404" } };
              return { data: new Blob([prior], { type: "application/json" }), error: null };
            }
            const hit = state.objects.get(key);
            if (!hit) return { data: null, error: { message: "Object not found", statusCode: "404" } };
            return { data: new Blob([hit.body], { type: hit.contentType ?? "" }), error: null };
          },
          remove: async (paths: string[]) => {
            state.removes.push({ bucket, paths: [...paths] });
            if (state.failRemove === "throw") throw new Error("storage socket hang up");
            if (state.failRemove) return { data: null, error: { message: state.failRemove.message } };
            for (const p of paths) state.objects.delete(`${bucket}/${p}`);
            return { data: paths.map((name) => ({ name })), error: null };
          },
        }),
      },
    };
  }

  return { state, reset, client };
}

export const fake = createFakeSupabase();

export function readIndexOf(tenantId: string): IndexShape {
  const hit = fake.state.objects.get(indexKey(tenantId));
  if (!hit) return { version: 1, files: [], collections: [] };
  return JSON.parse(hit.body.toString("utf8")) as IndexShape;
}

function writeIndexOf(tenantId: string, index: IndexShape): void {
  fake.state.objects.set(indexKey(tenantId), { body: Buffer.from(JSON.stringify(index)), contentType: "application/json" });
}

export function filesOf(tenantId: string): Array<Record<string, unknown>> {
  return readIndexOf(tenantId).files;
}

export function collectionsOf(tenantId: string): IndexShape["collections"] {
  return readIndexOf(tenantId).collections;
}

export function itemsOf(tenantId: string): Array<{ collection_id: string; file_id: string }> {
  return collectionsOf(tenantId).flatMap((c) => c.file_ids.map((file_id) => ({ collection_id: c.id, file_id })));
}

export function nextCreatedAt(): string {
  return new Date(Date.UTC(2026, 8, 1, 0, 0, fake.state.clock++)).toISOString();
}

export type SeededFile = { id: string; name: string; mime: string; size: number; path: string; created_at: string };

export function seedFile(tenantId: string, over: Partial<SeededFile> = {}): SeededFile {
  const id = over.id ?? randomUUID();
  const row: SeededFile = {
    id,
    name: "seed.png",
    mime: "image/png",
    size: 12,
    path: `${tenantId}/workspace-files/${id}/seed.png`,
    created_at: nextCreatedAt(),
    ...over,
  };
  const index = readIndexOf(tenantId);
  index.files.push({ ...row, uploaded_by: null });
  writeIndexOf(tenantId, index);
  fake.state.objects.set(`${BUCKET}/${row.path}`, { body: Buffer.from("seed"), contentType: row.mime });
  return row;
}

export function seedRole(tenantId: string, userId: string, role: string): void {
  fake.state.tables[TENANT_USERS].push({ tenant_id: tenantId, user_id: userId, role });
}

export function seedCollection(tenantId: string, name: string): { id: string; name: string; created_at: string } {
  const row = { id: randomUUID(), name, created_at: nextCreatedAt() };
  const index = readIndexOf(tenantId);
  index.collections.push({ ...row, file_ids: [] });
  writeIndexOf(tenantId, index);
  return row;
}

export function seedItem(tenantId: string, collectionId: string, fileId: string): void {
  const index = readIndexOf(tenantId);
  const col = index.collections.find((c) => c.id === collectionId);
  if (!col) throw new Error(`seedItem: no collection ${collectionId} in ${tenantId}`);
  col.file_ids.push(fileId);
  writeIndexOf(tenantId, index);
}

export function seedRawIndex(tenantId: string, raw: string): void {
  fake.state.objects.set(indexKey(tenantId), { body: Buffer.from(raw), contentType: "application/json" });
}

export function objectKeysOutside(tenantId: string): string[] {
  return fake.state.uploads
    .filter((u) => !u.path.startsWith(`${tenantId}/workspace-files/`))
    .map((u) => u.path)
    .concat(fake.state.removes.flatMap((r) => r.paths).filter((p) => !p.startsWith(`${tenantId}/workspace-files/`)))
    .concat(fake.state.downloads.filter((d) => !d.startsWith(`${BUCKET}/${tenantId}/workspace-files/`)));
}

export const BYTES = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-png-body")]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-jpeg-body")]),
  gif: Buffer.from("GIF89a-gif-body"),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 body")]),
  avif: Buffer.concat([
    Buffer.from([0, 0, 0, 0x1c]),
    Buffer.from("ftypavif"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("avifmif1miaf"),
    Buffer.from("rest"),
  ]),
  avifCompat: Buffer.concat([
    Buffer.from([0, 0, 0, 0x1c]),
    Buffer.from("ftypmif1"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1avifmiaf"),
    Buffer.from("rest"),
  ]),
  heic: Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypheic"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1heic"),
    Buffer.from("rest"),
  ]),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'),
};
