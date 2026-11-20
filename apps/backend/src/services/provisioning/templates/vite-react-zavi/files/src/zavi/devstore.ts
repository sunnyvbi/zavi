
import { ZaviError } from "./errors";
import {
  DocError, V2_LIMITS, callableActions, isPgDate, isPgDateTime, jsonbText, principalMatch, recordBytes,
  sha256Hex, utf8Bytes, validateDoc,
  type ActionDef, type Collection, type IndexDef, type Manifest, type Member, type RecordsCollection,
} from "./manifest";

export type Caller = { sub: string | null; siteRole: string | null };
export const ANON: Caller = { sub: null, siteRole: null };

type Rec = {
  collection: string; id: string; owner: string | null; data: Record<string, unknown>;
  key: string | null; hash: string | null; created: number; updated: number; bytes: number;
  recipient?: string | null;
};
type MemberRow = { userId: string; role: string; status: "active" | "disabled" };
type Receipt = { action: string; key: string; caller: string; request: string; result: ActionResult };

export type ActionResult = { action: string; target_id: string; record_id: string; counter: number; replayed: boolean };
export type MemberView = { user_id: string; role: string; status: "active" | "disabled" };
type FileObj = { owner: string | null; contentType: string; size: number; created: number; body: unknown };

export type Quotas = { maxRecords: number; maxBytes: number; maxWritesPerMin: number; maxRecordBytes: number };
export const DEFAULT_QUOTAS: Quotas = { maxRecords: 10000, maxBytes: 52428800, maxWritesPerMin: 600, maxRecordBytes: 65536 };
export const FILE_SIZE_LIMIT = 10 * 1024 * 1024;

export type StoredRecord = { id: string; data: Record<string, unknown>; mine: boolean; created_at: string; updated_at: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEM_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const FILE_PATH = /^[a-z][a-z0-9_]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const notAllowed = (reason: string) => new ZaviError("not_allowed", reason, { reason });
const invalid = (reason: string) => new ZaviError("validation", reason, { reason });
const notFound = () => new ZaviError("not_found", "not_found", { reason: "not_found" });
const quota = (reason = "quota_exceeded") => new ZaviError("quota", reason, { reason });
const conflict = (reason: string) => new ZaviError("conflict", reason, { reason });
const invalidRef = () => invalid("invalid_reference");

function own<T>(o: Record<string, T>, k: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (micros: number) => new Date(Math.floor(micros / 1000)).toISOString();

const RANGE_OPS = ["gt", "gte", "lt", "lte"];
type SlotValue = string | number;

function slotValue(type: IndexDef["type"], v: unknown): SlotValue | null {
  if (type === "text") return typeof v === "string" ? v : typeof v === "boolean" ? String(v) : null;
  if (type === "number") return typeof v === "number" && Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isPgDate(v) ? Date.parse(`${v}T00:00:00Z`) : null;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(v)) { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

function filterValue(type: IndexDef["type"], v: unknown): SlotValue {
  if (type === "text" && (typeof v === "string" || typeof v === "boolean")) return slotValue(type, v) as string;
  if (type === "number" && typeof v === "number" && Number.isFinite(v)) return v;
  if (type === "timestamp" && typeof v === "string" && (isPgDate(v) || isPgDateTime(v))) {
    const t = slotValue(type, v);
    if (t !== null) return t;
  }
  throw invalid("invalid_filter");
}

function compare(a: SlotValue, b: SlotValue): number {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const x = utf8Bytes(String(a)), y = utf8Bytes(String(b));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function toBase64(s: string): string {
  const bytes = utf8Bytes(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromBase64(s: string): string {
  const bin = atob(s.replace(/\s+/g, ""));
  return decodeURIComponent(Array.from(bin, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
}

export type DevStoreOptions = {
  manifest: Manifest;
  quotas?: Partial<Quotas>;
  now?: () => number;
  uuid?: () => string;
};

export class DevStore {
  readonly manifest: Manifest;
  private quotas: Quotas;
  private now: () => number;
  private uuid: () => string;
  private clock = 0;
  records = new Map<string, Rec>();
  members = new Map<string, MemberRow>();
  files = new Map<string, FileObj>();
  receipts = new Map<string, Receipt>();
  private usage = { records: 0, bytes: 0, windowStart: -1, windowWrites: 0 };
  private recipientWindow = new Map<string, { minute: number; n: number }>();

  constructor(opts: DevStoreOptions) {
    this.manifest = opts.manifest;
    this.quotas = { ...DEFAULT_QUOTAS, ...(opts.quotas ?? {}) };
    this.now = opts.now ?? (() => Date.now());
    this.uuid = opts.uuid ?? (() => globalThis.crypto.randomUUID());
  }

  member(caller: Caller): Member {
    if (!caller.sub) return null;
    const m = this.members.get(caller.sub);
    if (!m || m.status !== "active") return null;
    return { userId: m.userId, role: m.role };
  }

  private records_(name: string): RecordsCollection | null {
    const c: Collection | undefined = own(this.manifest.collections, name);
    return c && c.kind === "records" ? c : null;
  }

  private permits(c: RecordsCollection, op: "list" | "get" | "create" | "update" | "delete", m: Member, r: Rec | null, owner: string | null = r?.owner ?? null): boolean {
    return principalMatch(c.rules[op], m, owner, r?.recipient ?? null);
  }
  private stateReadable(c: RecordsCollection, m: Member, r: Rec): boolean {
    const read = c.states?.read;
    if (!read) return true;
    const st = r.data[c.states!.field];
    if (typeof st !== "string") return true;
    return principalMatch(own(read, st), m, r.owner, r.recipient ?? null);
  }
  private visible(c: RecordsCollection, op: "list" | "get", m: Member, r: Rec): boolean {
    return this.permits(c, op, m, r) && this.stateReadable(c, m, r);
  }
  private readable(c: RecordsCollection, m: Member, r: Rec): boolean {
    return this.visible(c, "get", m, r) || this.visible(c, "list", m, r);
  }

  private project(c: RecordsCollection, m: Member, r: Rec): StoredRecord {
    const data: Record<string, unknown> = Object.fromEntries(Object.entries(r.data).filter(([k]) => {
      const mask = own(c.fields, k);
      return !mask || mask.read === undefined || principalMatch(mask.read, m, r.owner, r.recipient ?? null);
    }));
    return { id: r.id, data, mine: r.owner !== null && m !== null && r.owner === m.userId, created_at: iso(r.created), updated_at: iso(r.updated) };
  }

  private tick(): number {
    this.clock = Math.max(this.clock + 1, Math.floor(this.now() * 1000));
    return this.clock;
  }

  private txn<T>(fn: () => T): T {
    const records = new Map([...this.records].map(([k, r]) => [k, { ...r }]));
    const usage = { ...this.usage };
    const window = new Map(this.recipientWindow);
    const clock = this.clock;
    try {
      return fn();
    } catch (e) {
      this.records = records;
      this.usage = usage;
      this.recipientWindow = window;
      this.clock = clock;
      throw e;
    }
  }

  private rowsOf(collection: string): Rec[] {
    return [...this.records.values()].filter((r) => r.collection === collection);
  }

  list(caller: Caller, collection: string, opts: { filter?: unknown; sort?: string | null; limit?: number | null; cursor?: string | null } = {}) {
    const c = this.records_(collection);
    if (!c) throw notAllowed("unknown_collection");
    const m = this.member(caller);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const visibleField = (field: string) => {
      const mask = own(c.fields, field);
      return !mask || mask.read === undefined || principalMatch(mask.read, m, null);
    };

    const filter = opts.filter ?? {};
    if (!isObj(filter)) throw invalid("invalid_filter");
    const preds: Array<(r: Rec) => boolean> = [];
    let nFields = 0;
    for (const [field, raw] of Object.entries(filter)) {
      if (++nFields > 4) throw invalid("invalid_filter");
      const idx: IndexDef | undefined = own(c.indexes, field);
      if (!idx || !visibleField(field)) throw invalid("filter_not_allowed");
      const ops: Record<string, unknown> = isObj(raw) ? raw : { eq: raw };
      for (const [op, v] of Object.entries(ops)) {
        const declared = RANGE_OPS.includes(op) ? "range" : op;
        if (!(idx.ops as string[]).includes(declared)) throw invalid("filter_not_allowed");
        if (op === "in") {
          if (!Array.isArray(v) || v.length < 1 || v.length > 50) throw invalid("invalid_filter");
        } else if (op === "prefix") {
          if (typeof v !== "string" || v.length < 1) throw invalid("invalid_filter");
        } else if (op !== "eq" && !RANGE_OPS.includes(op)) {
          throw invalid("filter_not_allowed");
        }
        const wanted = (op === "in" ? (v as unknown[]) : [v]).map((x) => filterValue(idx.type, x));
        preds.push((r) => {
          const sv = slotValue(idx.type, own(r.data, field));
          if (sv === null) return false;
          const w = wanted[0];
          switch (op) {
            case "in": return wanted.some((x) => compare(sv, x) === 0);
            case "eq": return compare(sv, w) === 0;
            case "gt": return compare(sv, w) > 0;
            case "gte": return compare(sv, w) >= 0;
            case "lt": return compare(sv, w) < 0;
            case "lte": return compare(sv, w) <= 0;
            default: return compare(sv, w) >= 0 && String(sv).startsWith(String(w));
          }
        });
      }
    }

    let sortField: string | null = null;
    let desc = false;
    const sort = opts.sort ?? null;
    if (sort !== null) {
      desc = sort.startsWith("-");
      const f = desc ? sort.slice(1) : sort;
      const idx = own(c.indexes, f);
      if (!idx || idx.sort !== true || !visibleField(f)) throw invalid("sort_not_allowed");
      sortField = f;
    }
    const sortIdx = sortField ? (own(c.indexes, sortField) as IndexDef) : null;
    const sv = (r: Rec) => (sortField && sortIdx ? slotValue(sortIdx.type, own(r.data, sortField)) : null);
    const tie = (a: Rec, b: Rec) => (a.created !== b.created ? b.created - a.created : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const cmp = (a: Rec, b: Rec): number => {
      if (!sortField) return tie(a, b);
      const d = compare(sv(a) as SlotValue, sv(b) as SlotValue);
      if (d !== 0) return desc ? -d : d;
      return desc ? -tie(a, b) : tie(a, b);
    };

    let after: ((r: Rec) => boolean) | null = null;
    if (opts.cursor !== undefined && opts.cursor !== null) {
      let cur: Record<string, unknown>;
      try {
        cur = JSON.parse(fromBase64(opts.cursor)) as Record<string, unknown>;
      } catch {
        throw invalid("invalid_cursor");
      }
      if (!isObj(cur) || (cur.k ?? null) !== sort || typeof cur.t !== "string" || !/^[0-9]{1,19}$/.test(cur.t)
          || typeof cur.i !== "string" || !UUID.test(cur.i)) throw invalid("invalid_cursor");
      const probe = { created: Number(cur.t), id: cur.i } as Rec;
      let s: SlotValue | null = null;
      if (sortIdx) {
        if (sortIdx.type === "text" && typeof cur.s === "string") s = cur.s;
        else if (sortIdx.type === "number" && typeof cur.s === "number") s = cur.s;
        else if (sortIdx.type === "timestamp" && typeof cur.s === "string" && /^[0-9]{1,19}$/.test(cur.s)) s = Number(cur.s) / 1000;
        else throw invalid("invalid_cursor");
      }
      after = (r) => {
        if (!sortIdx || s === null) return tie(r, probe) > 0;
        const d = compare(sv(r) as SlotValue, s);
        if (d !== 0) return desc ? d < 0 : d > 0;
        return desc ? tie(r, probe) < 0 : tie(r, probe) > 0;
      };
    }

    const rows = this.rowsOf(collection)
      .filter((r) => this.visible(c, "list", m, r))
      .filter((r) => preds.every((p) => p(r)))
      .filter((r) => !sortField || sv(r) !== null)
      .filter((r) => !after || after(r))
      .sort(cmp);
    const page = rows.slice(0, limit);
    let next: string | null = null;
    if (rows.length > limit) {
      const last = page[page.length - 1];
      const lastSort = sv(last);
      const s = sortIdx?.type === "timestamp" ? String(Math.round((lastSort as number) * 1000)) : lastSort;
      next = toBase64(jsonbText({ i: last.id, k: sort, s, t: String(last.created) }));
    }
    return { items: page.map((r) => this.project(c, m, r)), next_cursor: next };
  }

  get(caller: Caller, collection: string, id: string): StoredRecord | null {
    const c = this.records_(collection);
    if (!c || !UUID.test(id)) return null;
    const r = this.records.get(`${collection}/${id}`);
    const m = this.member(caller);
    if (!r || !this.visible(c, "get", m, r)) return null;
    return this.project(c, m, r);
  }

  private target(collection: string, id: unknown, m: Member): Rec | null {
    const tc = this.records_(collection);
    if (!tc || typeof id !== "string") return null;
    const r = this.records.get(`${collection}/${id.toLowerCase()}`);
    return r && this.readable(tc, m, r) ? r : null;
  }

  private beforeWrite(
    collection: string, c: RecordsCollection, prev: Rec | null, input: Record<string, unknown>, m: Member, writer: "user" | "kernel",
  ): { doc: Record<string, unknown>; recipient: string | null; commit: () => void } {
    const insert = prev === null;
    const user = writer === "user";
    const doc: Record<string, unknown> = Object.fromEntries(Object.entries(input));
    const changed = (k: string) => insert || jsonbText(own(doc, k) ?? null) !== jsonbText(own(prev!.data, k) ?? null);
    let recipient = insert ? null : prev!.recipient ?? null;

    for (const [k, ref] of Object.entries(c.references)) {
      const source = c.recipient?.reference === k;
      if (!insert && user && source && changed(k)) throw notAllowed(`field_not_writable: ${k}`);
      const v = own(doc, k);
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" || !UUID.test(v.toLowerCase())) throw invalidRef();
      if (insert || changed(k) || (source && recipient === null)) {
        const t = this.target(ref.collection, v, m);
        if (!t) throw invalidRef();
        if (source) {
          if (t.owner === null) throw invalidRef();
          recipient = t.owner;
        }
      }
    }

    if (user) {
      const owner = insert ? m?.userId ?? null : prev!.owner;
      for (const [k, mask] of Object.entries(c.fields)) {
        if (mask.write === undefined) continue;
        const touched = insert ? own(doc, k) !== undefined : changed(k);
        if (touched && !principalMatch(mask.write, m, owner, recipient)) throw notAllowed(`field_not_writable: ${k}`);
      }
    }

    if (c.states) {
      const sf = c.states.field;
      if (insert) {
        if (own(doc, sf) !== undefined) {
          if (user && doc[sf] !== c.states.initial) throw notAllowed(`field_not_writable: ${sf}`);
        } else doc[sf] = c.states.initial;
      } else {
        if (user && changed(sf)) throw notAllowed(`field_not_writable: ${sf}`);
        if (own(doc, sf) === undefined) doc[sf] = c.states.initial;
      }
    }

    for (const a of Object.values(this.manifest.actions)) {
      if (a.target.collection !== collection) continue;
      const cf = a.target.counter;
      if (insert) {
        if (own(doc, cf) !== undefined) {
          if (doc[cf] !== a.initial) throw notAllowed(`field_not_writable: ${cf}`);
        } else doc[cf] = a.initial;
      } else {
        if (user && changed(cf)) throw notAllowed(`field_not_writable: ${cf}`);
        if (own(doc, cf) === undefined) doc[cf] = a.initial;
      }
      const cur = doc[cf];
      if (typeof cur === "number") {
        const b = a.bounds as { min: number; max?: number; maxField?: string };
        const mf = b.maxField !== undefined ? doc[b.maxField] : undefined;
        const max = b.max !== undefined ? b.max : typeof mf === "number" ? mf : null;
        if (cur < b.min || (max !== null && cur > max)) throw conflict("action_bound");
      }
    }

    if (insert || jsonbText(doc) !== jsonbText(prev!.data)) this.validate(c, doc);
    const commit = insert ? this.chargeRecipient(collection, recipient) : () => undefined;
    return { doc, recipient, commit };
  }

  private uniqueKeys(c: RecordsCollection, data: Record<string, unknown>): Array<string | null> {
    return c.unique.map((u) => {
      const parts = u.fields.map((f) => own(data, f) ?? null);
      if (u.nulls === "distinct" && parts.some((p) => p === null)) return null;
      return jsonbText(parts);
    });
  }
  private checkUnique(collection: string, c: RecordsCollection, data: Record<string, unknown>, selfId: string | null): void {
    if (!c.unique.length) return;
    const mine = this.uniqueKeys(c, data);
    for (const r of this.rowsOf(collection)) {
      if (r.id === selfId) continue;
      const theirs = this.uniqueKeys(c, r.data);
      if (mine.some((k, i) => k !== null && k === theirs[i])) throw conflict("unique_conflict");
    }
  }

  private chargeRecipient(collection: string, recipient: string | null): () => void {
    if (recipient === null) return () => undefined;
    const minute = Math.floor(this.now() / 60000);
    const k = `${collection}/${recipient}`;
    const w = this.recipientWindow.get(k);
    const n = w && w.minute === minute ? w.n : 0;
    if (n >= V2_LIMITS.recipientCreatesPerMinute) throw new ZaviError("rate_limited", "recipient_rate_limited", { reason: "recipient_rate_limited" });
    return () => this.recipientWindow.set(k, { minute, n: n + 1 });
  }

  create(caller: Caller, collection: string, data: unknown, key: string | null): { id: string; replayed: boolean } {
    const m = this.member(caller);
    const me = m?.userId ?? null;
    if (me === null && key === null) throw invalid("idempotency_key_required");
    if (!this.records_(collection)) throw notAllowed("unknown_collection");
    let hash: string | null = null;
    if (key !== null) {
      hash = sha256Hex(`${me ?? "anon"}:${collection}:${data === undefined ? "null" : jsonbText(data)}`);
      for (const r of this.records.values()) {
        if (r.collection === collection && r.key === key) {
          if (r.hash !== hash) throw conflict("idempotency_conflict");
          return { id: r.id, replayed: true };
        }
      }
    }
    const c = this.records_(collection);
    if (!c) throw notAllowed("unknown_collection");
    if (!isObj(data)) throw invalid("schema_violation: document must be an object");
    const { doc, recipient, commit } = this.beforeWrite(collection, c, null, data, m, "user");
    if (!this.permits(c, "create", m, null, me)) throw notAllowed("rls");
    if (key !== null && !IDEM_KEY.test(key)) throw invalid("idempotency_key_invalid");
    this.checkUnique(collection, c, doc, null);
    const bytes = recordBytes(doc);
    this.charge(1, bytes, bytes);
    commit();
    const at = this.tick();
    const id = this.uuid();
    this.records.set(`${collection}/${id}`, { collection, id, owner: me, data: doc, key, hash, created: at, updated: at, bytes, recipient });
    return { id, replayed: false };
  }

  update(caller: Caller, collection: string, id: string, patch: unknown): { id: string; updated: true } {
    if (!caller.sub) throw notAllowed("anonymous_write_forbidden");
    if (!isObj(patch)) throw invalid("invalid_patch");
    const c = this.records_(collection);
    const m = this.member(caller);
    const r = UUID.test(id) ? this.records.get(`${collection}/${id}`) : undefined;
    if (!c || !r || !this.readable(c, m, r) || !this.permits(c, "update", m, r)) throw notFound();
    const merged: Record<string, unknown> = Object.fromEntries(Object.entries({ ...r.data, ...patch }).filter(([, v]) => v !== null));
    const { doc } = this.beforeWrite(collection, c, r, merged, m, "user");
    if (jsonbText(doc) === jsonbText(r.data)) return { id: r.id, updated: true };
    this.checkUnique(collection, c, doc, r.id);
    const bytes = recordBytes(doc);
    this.charge(0, bytes - r.bytes, bytes);
    r.data = doc;
    r.bytes = bytes;
    r.updated = this.tick();
    return { id: r.id, updated: true };
  }

  delete(caller: Caller, collection: string, id: string): { id: string; deleted: true } {
    if (!caller.sub) throw notAllowed("anonymous_write_forbidden");
    const c = this.records_(collection);
    const m = this.member(caller);
    const r = UUID.test(id) ? this.records.get(`${collection}/${id}`) : undefined;
    if (!c || !r || !this.readable(c, m, r) || !this.permits(c, "delete", m, r)) throw notFound();
    const { deletes, nullify } = this.deletePlan(r);
    return this.txn(() => {
      this.charge(-1, -r.bytes, 0);
      for (const d of deletes) {
        if (d !== r) { this.usage.records -= 1; this.usage.bytes -= d.bytes; }
        this.records.delete(`${d.collection}/${d.id}`);
      }
      for (const [rec, fields] of nullify) {
        const live = this.records.get(`${rec.collection}/${rec.id}`);
        if (!live) continue;
        const next = Object.fromEntries(Object.entries(live.data).filter(([k]) => !fields.has(k)));
        this.checkUnique(live.collection, this.records_(live.collection) as RecordsCollection, next, live.id);
        const bytes = recordBytes(next);
        this.usage.bytes += bytes - live.bytes;
        live.data = next;
        live.bytes = bytes;
        live.updated = this.tick();
      }
      return { id: r.id, deleted: true as const };
    });
  }

  private deletePlan(root: Rec, platform = false): { deletes: Rec[]; nullify: Map<Rec, Set<string>> } {
    const deletes: Rec[] = [root];
    const gone = new Set<string>([`${root.collection}/${root.id}`]);
    const nullify = new Map<Rec, Set<string>>();
    let affected = 0;
    const bump = () => { if (++affected > V2_LIMITS.deleteFanout && !platform) throw new ZaviError("validation", "cascade_too_large", { reason: "cascade_too_large", status: 422 }); };
    for (let i = 0; i < deletes.length; i++) {
      const parent = deletes[i];
      for (const [name, def] of Object.entries(this.manifest.collections)) {
        if (def.kind !== "records") continue;
        for (const [f, ref] of Object.entries(def.references)) {
          if (ref.collection !== parent.collection) continue;
          for (const child of this.rowsOf(name)) {
            const v = own(child.data, f);
            if (typeof v !== "string" || v.toLowerCase() !== parent.id || gone.has(`${name}/${child.id}`)) continue;
            if (ref.on_delete === "restrict" && !platform) throw conflict("reference_restricted");
            bump();
            if (ref.on_delete !== "nullify") {
              gone.add(`${name}/${child.id}`);
              deletes.push(child);
            } else {
              const set = nullify.get(child) ?? new Set<string>();
              set.add(f);
              nullify.set(child, set);
            }
          }
        }
      }
    }
    return { deletes, nullify };
  }

  transition(
    caller: Caller, collection: string, id: string, to: string,
    cas: { expect?: Record<string, unknown>; set?: Record<string, unknown> } = {},
  ): { id: string; from: string; to: string; transitioned: boolean } {
    if (!caller.sub) throw notAllowed("anonymous_write_forbidden");
    const m = this.member(caller);
    if (!m) throw notFound();
    const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0;
    if ((cas.expect !== undefined && !isObj(cas.expect)) || (cas.set !== undefined && (!isObj(cas.set) || Object.values(cas.set).some((v) => v === null)))) {
      throw invalid("invalid_transition");
    }
    const c = this.records_(collection);
    const r = c && c.states && typeof id === "string" && UUID.test(id) ? this.records.get(`${collection}/${id}`) : undefined;
    if (!c || !c.states || !r || !this.readable(c, m, r)) throw notFound();
    const from = String(r.data[c.states.field]);
    const rcpt = r.recipient ?? null;
    const inverseEdge = (from: string, edgeTo: string) =>
      Object.values(this.manifest.actions).some(
        (a) => a.creates.collection === collection && a.inverse?.transition.from === from && a.inverse?.transition.to === edgeTo,
      );
    const mine = c.states.transitions.filter((t) => t.to === to && principalMatch(t.principals, m, r.owner, rcpt) && !inverseEdge(t.from, t.to));
    if (mine.length === 0) throw notFound();
    const isCas = cas.expect !== undefined || cas.set !== undefined;
    const props = (c.schema as { properties: Record<string, unknown> }).properties;
    for (const k of Object.keys(cas.expect ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) throw invalid("invalid_transition");
      const read = c.fields[k]?.read;
      if (read !== undefined && !principalMatch(read, m, r.owner, rcpt)) throw notAllowed(`field_not_readable: ${k}`);
    }
    if (cas.set !== undefined) {
      if (!principalMatch(c.rules.update, m, r.owner, rcpt)) throw notAllowed("forbidden");
      for (const k of Object.keys(cas.set)) {
        const counterOrTarget = Object.values(this.manifest.actions).some(
          (a) => (a.target.collection === collection && a.target.counter === k) || (a.creates.collection === collection && a.creates.targetField === k),
        );
        if (!Object.prototype.hasOwnProperty.call(props, k) || k === c.states.field || own(c.references, k) !== undefined || counterOrTarget) {
          throw notAllowed(`field_not_writable: ${k}`);
        }
        const write = c.fields[k]?.write;
        if (write !== undefined && !principalMatch(write, m, r.owner, rcpt)) throw notAllowed(`field_not_writable: ${k}`);
      }
    }
    if (from === to) {
      if (isCas) throw conflict("transition_conflict");
      return { id: r.id, from, to, transitioned: false };
    }
    if (!mine.some((t) => t.from === from)) throw conflict("transition_conflict");
    for (const [k, v] of Object.entries(cas.expect ?? {})) {
      const cur = own(r.data, k);
      if (jsonbText(cur === undefined ? null : cur) !== jsonbText(v === undefined ? null : v)) throw conflict("transition_conflict");
    }
    return this.txn(() => {
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cas.set ?? {})) fields[k] = v;
      fields[c.states!.field] = to;
      this.kernelUpdate(collection, c, r, fields, m);
      return { id: r.id, from, to, transitioned: true };
    });
  }

  private kernelUpdate(collection: string, c: RecordsCollection, r: Rec, fields: Record<string, unknown>, m: Member): void {
    const { doc } = this.beforeWrite(collection, c, r, { ...r.data, ...fields }, m, "kernel");
    this.checkUnique(collection, c, doc, r.id);
    const bytes = recordBytes(doc);
    this.charge(0, bytes - r.bytes, bytes);
    r.data = doc;
    r.bytes = bytes;
    r.updated = this.tick();
  }

  runAction(
    caller: Caller, name: string,
    req: { targetId?: string | null; recordId?: string | null; data?: unknown },
    key: string | null,
  ): ActionResult {
    const m = this.member(caller);
    const uid = m?.userId ?? null;
    const entry = own(callableActions(this.manifest), name);
    if (!entry) throw notAllowed("action_not_allowed");
    const a: ActionDef = this.manifest.actions[entry.action];
    const principals = entry.inverse ? a.inverse!.principals : a.principals;
    if (uid === null && !principals.includes("anyone")) throw notAllowed("action_not_allowed");
    if (key === null) throw invalid("idempotency_key_required");
    if (!IDEM_KEY.test(key)) throw invalid("invalid_idempotency_key");
    const data = req.data ?? {};
    const targetId = req.targetId ?? null;
    const recordId = req.recordId ?? null;
    if (!isObj(data)
      || (!entry.inverse && (targetId === null || recordId !== null))
      || (entry.inverse && (recordId === null || targetId !== null || Object.keys(data).length > 0))) {
      throw invalid("invalid_action_input");
    }

    const callerHash = sha256Hex(uid ?? "anon");
    const requestHash = sha256Hex(jsonbText([name, targetId, recordId, data]));
    const prior = this.receipts.get(`${name}/${key}`);
    if (prior) {
      if (prior.caller !== callerHash || prior.request !== requestHash) throw conflict("idempotency_conflict");
      return { ...prior.result, replayed: true };
    }
    return this.txn(() => {
      const result = this.applyAction(m, name, entry.inverse, a, principals, targetId, recordId, data as Record<string, unknown>);
      this.receipts.set(`${name}/${key}`, { action: name, key, caller: callerHash, request: requestHash, result });
      return result;
    });
  }

  private applyAction(
    m: Member, name: string, inverse: boolean, a: ActionDef, principals: string[],
    targetId: string | null, recordId: string | null, data: Record<string, unknown>,
  ): ActionResult {
    const uid = m?.userId ?? null;
    const tc = this.records_(a.target.collection);
    const cc = this.records_(a.creates.collection);
    if (!tc || !cc) throw notFound();
    const tf = a.creates.targetField;
    let target: Rec | undefined;
    let rec: Rec | undefined;
    let doc: Record<string, unknown> | null = null;
    if (!inverse) {
      target = UUID.test(String(targetId)) ? this.records.get(`${a.target.collection}/${targetId}`) : undefined;
      if (!target || !this.readable(tc, m, target)) throw notFound();
      if (!principalMatch(principals, m, target.owner, target.recipient ?? null)) throw notAllowed("action_not_allowed");
      if (own(data, tf) !== undefined && String(data[tf]).toLowerCase() !== target.id) throw invalid("invalid_action_input");
      if (cc.states && own(data, cc.states.field) !== undefined) throw notAllowed(`field_not_writable: ${cc.states.field}`);
      for (const x of Object.values(this.manifest.actions)) {
        if (x.target.collection === a.creates.collection && own(data, x.target.counter) !== undefined) throw notAllowed(`field_not_writable: ${x.target.counter}`);
      }
      for (const [k, mask] of Object.entries(cc.fields)) {
        if (mask.write !== undefined && own(data, k) !== undefined && !principalMatch(mask.write, m, uid)) throw notAllowed(`field_not_writable: ${k}`);
      }
      for (const [k, ref] of Object.entries(cc.references)) {
        if (k === tf || own(data, k) === undefined) continue;
        const v = data[k];
        if (typeof v !== "string" || !UUID.test(v.toLowerCase()) || !this.target(ref.collection, v, m)) throw invalidRef();
      }
      doc = { ...data, [tf]: target.id };
    } else {
      rec = recordId !== null && UUID.test(recordId) ? this.records.get(`${a.creates.collection}/${recordId}`) : undefined;
      if (!rec || !this.readable(cc, m, rec)) throw notFound();
      if (!principalMatch(principals, m, rec.owner, rec.recipient ?? null)) throw notAllowed("action_not_allowed");
      if (rec.data[cc.states!.field] !== a.inverse!.transition.from) throw conflict("transition_conflict");
      const tid = String(rec.data[tf] ?? "").toLowerCase();
      target = UUID.test(tid) ? this.records.get(`${a.target.collection}/${tid}`) : undefined;
      if (!target) throw notFound();
    }

    const cur = typeof target.data[a.target.counter] === "number" ? (target.data[a.target.counter] as number) : a.initial;
    const counter = cur + (inverse ? a.inverse!.delta : a.delta);
    const b = a.bounds as { min: number; max?: number; maxField?: string };
    const mf = b.maxField !== undefined ? target.data[b.maxField] : undefined;
    const max = b.max !== undefined ? b.max : typeof mf === "number" ? mf : null;
    if (counter < b.min || max === null || counter > max) throw conflict("action_bound");

    this.kernelUpdate(a.target.collection, tc, target, { [a.target.counter]: counter }, m);
    if (!inverse) {
      const w = this.beforeWrite(a.creates.collection, cc, null, doc!, m, "kernel");
      this.checkUnique(a.creates.collection, cc, w.doc, null);
      const bytes = recordBytes(w.doc);
      this.charge(1, bytes, bytes);
      w.commit();
      const at = this.tick();
      const id = this.uuid();
      this.records.set(`${a.creates.collection}/${id}`, {
        collection: a.creates.collection, id, owner: uid, data: w.doc, key: null, hash: null, created: at, updated: at, bytes, recipient: w.recipient,
      });
      return { action: name, target_id: target.id, record_id: id, counter, replayed: false };
    }
    this.kernelUpdate(a.creates.collection, cc, rec!, { [cc.states!.field]: a.inverse!.transition.to }, m);
    return { action: name, target_id: target.id, record_id: rec!.id, counter, replayed: false };
  }

  aggregate(caller: Caller, name: string, filter: unknown): { value: number | null } {
    const m = this.member(caller);
    const g = own(this.manifest.aggregates, name);
    const notAgg = () => notAllowed("aggregate_not_allowed");
    if (!caller.sub || !m || !g || !principalMatch(g.principals, m, null)) throw notAgg();
    const c = this.records_(g.collection);
    if (!c || !principalMatch(c.rules.list, m, null)) throw notAgg();
    const readsField = (f: string) => { const mask = own(c.fields, f); return !mask || mask.read === undefined || principalMatch(mask.read, m, null); };
    if (g.field !== undefined && (own(c.indexes, g.field)?.type !== "number" || !readsField(g.field))) throw notAgg();
    const f = filter ?? {};
    if (!isObj(f)) throw invalid("invalid_filter");
    const preds: Array<(r: Rec) => boolean> = [];
    for (const [field, v] of Object.entries(f)) {
      if (!g.filters.includes(field) || !readsField(field)) throw invalid("filter_not_allowed");
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw invalid("invalid_filter");
      if (c.states && field === c.states.field) {
        if (typeof v !== "string") throw invalid("invalid_filter");
        preds.push((r) => r.data[field] === v);
        continue;
      }
      const idx = own(c.indexes, field);
      if (!idx) throw invalid("filter_not_allowed");
      const want = filterValue(idx.type, v);
      preds.push((r) => { const s = slotValue(idx.type, own(r.data, field)); return s !== null && compare(s, want) === 0; });
    }
    const rows = this.rowsOf(g.collection).filter((r) => this.visible(c, "list", m, r) && preds.every((p) => p(r)));
    if (rows.length > V2_LIMITS.aggregateScanRows) throw new ZaviError("validation", "aggregate_too_large", { reason: "aggregate_too_large", status: 422 });
    if (g.fn === "count") return { value: rows.length };
    const nums = rows.map((r) => slotValue("number", r.data[g.field as string])).filter((x): x is number => typeof x === "number");
    const sum = nums.reduce((s, x) => s + x, 0);
    return { value: g.fn === "sum" ? sum : nums.length ? sum / nums.length : null };
  }

  private requireAdmin(actor: Caller): void {
    if (this.member(actor)?.role !== "admin") throw notAllowed("member_admin_required");
  }
  private roleAllowed(role: unknown): role is string {
    return role === "admin" || role === "user" || (typeof role === "string" && this.manifest.roles.includes(role));
  }
  private memberRow(userId: string): MemberRow {
    const row = typeof userId === "string" ? this.members.get(userId) : undefined;
    if (!row) throw new ZaviError("not_found", "member_not_found", { reason: "member_not_found" });
    return row;
  }
  private keepAnAdmin(row: MemberRow, after: MemberRow | null): void {
    const wasAdmin = row.status === "active" && row.role === "admin";
    const staysAdmin = after !== null && after.status === "active" && after.role === "admin";
    if (!wasAdmin || staysAdmin) return;
    const others = [...this.members.values()].filter((x) => x.userId !== row.userId && x.status === "active" && x.role === "admin");
    if (others.length === 0) throw conflict("last_admin");
  }
  private view(row: MemberRow): MemberView {
    return { user_id: row.userId, role: row.role, status: row.status };
  }
  memberList(actor: Caller, opts: { limit?: number | null; cursor?: string | null }): { items: MemberView[]; next_cursor: string | null } {
    this.requireAdmin(actor);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    if (opts.cursor != null && !UUID.test(opts.cursor)) throw invalid("invalid_cursor");
    const rows = [...this.members.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1)).filter((r) => opts.cursor == null || r.userId > opts.cursor);
    const page = rows.slice(0, limit);
    return { items: page.map((r) => this.view(r)), next_cursor: rows.length > limit ? page[page.length - 1].userId : null };
  }
  memberInvite(actor: Caller, userId: string, role: string): MemberView {
    this.requireAdmin(actor);
    if (!this.roleAllowed(role)) throw invalid("invalid_role");
    const existing = this.members.get(userId);
    if (existing) return this.view(existing);
    const row: MemberRow = { userId, role, status: "active" };
    this.members.set(userId, row);
    return this.view(row);
  }
  memberSetRole(actor: Caller, userId: string, role: string): MemberView {
    this.requireAdmin(actor);
    if (!this.roleAllowed(role)) throw invalid("invalid_role");
    const row = this.memberRow(userId);
    this.keepAnAdmin(row, { ...row, role });
    row.role = role;
    return this.view(row);
  }
  memberDisable(actor: Caller, userId: string): MemberView {
    this.requireAdmin(actor);
    const row = this.memberRow(userId);
    this.keepAnAdmin(row, { ...row, status: "disabled" });
    row.status = "disabled";
    return this.view(row);
  }
  memberReenable(actor: Caller, userId: string): MemberView {
    this.requireAdmin(actor);
    const row = this.memberRow(userId);
    row.status = "active";
    return this.view(row);
  }
  reassignOwner(actor: Caller, collection: string, id: string, toUserId: string): { id: string; owner_id: string } {
    this.requireAdmin(actor);
    const target = typeof toUserId === "string" ? this.members.get(toUserId) : undefined;
    if (!target || target.status !== "active") throw new ZaviError("not_found", "member_not_found", { reason: "member_not_found" });
    const r = this.records_(collection) && typeof id === "string" && UUID.test(id) ? this.records.get(`${collection}/${id}`) : undefined;
    if (!r) throw notFound();
    r.owner = toUserId;
    r.updated = this.tick();
    return { id: r.id, owner_id: toUserId };
  }
  deleteUserData(actor: Caller, userId: string, confirm: unknown): { user_id: string; records: number; files: number } {
    this.requireAdmin(actor);
    if (confirm !== true) throw invalid("invalid_member_body");
    if (typeof userId !== "string" || !UUID.test(userId)) throw invalid("invalid_member_body");
    return this.txn(() => {
      let records = 0;
      for (const r of [...this.records.values()]) {
        if (r.owner !== userId || !this.records.has(`${r.collection}/${r.id}`)) continue;
        const { deletes, nullify } = this.deletePlan(r, true);
        for (const d of deletes) {
          if (!this.records.delete(`${d.collection}/${d.id}`)) continue;
          this.usage.records -= 1;
          this.usage.bytes -= d.bytes;
          records++;
        }
        for (const [rec, fields] of nullify) {
          const live = this.records.get(`${rec.collection}/${rec.id}`);
          if (!live) continue;
          const next = Object.fromEntries(Object.entries(live.data).filter(([k]) => !fields.has(k)));
          this.checkUnique(live.collection, this.records_(live.collection) as RecordsCollection, next, live.id);
          const bytes = recordBytes(next);
          this.usage.bytes += bytes - live.bytes;
          live.data = next;
          live.bytes = bytes;
          live.updated = this.tick();
        }
      }
      let files = 0;
      for (const [k, f] of [...this.files]) if (f.owner === userId) { this.files.delete(k); files++; }
      return { user_id: userId, records, files };
    });
  }
  memberRemove(actor: Caller, userId: string): { user_id: string; removed: true } {
    this.requireAdmin(actor);
    const row = this.memberRow(userId);
    this.keepAnAdmin(row, null);
    this.members.delete(userId);
    return { user_id: userId, removed: true };
  }

  private validate(c: RecordsCollection, doc: Record<string, unknown>): void {
    try {
      validateDoc(c.schema, doc);
    } catch (e) {
      if (e instanceof DocError) throw invalid(e.reason);
      throw e;
    }
  }

  private charge(dRecords: number, dBytes: number, size: number): void {
    const q = this.quotas;
    const minute = Math.floor(this.now() / 60000);
    const fresh = this.usage.windowStart < minute;
    if (dRecords > 0 && this.usage.records + dRecords > q.maxRecords) throw quota();
    if (dBytes > 0 && this.usage.bytes + dBytes > q.maxBytes) throw quota();
    if (size > q.maxRecordBytes) throw quota();
    if (!fresh && this.usage.windowWrites >= q.maxWritesPerMin) throw quota();
    this.usage.records += dRecords;
    this.usage.bytes += dBytes;
    this.usage.windowStart = fresh ? minute : this.usage.windowStart;
    this.usage.windowWrites = fresh ? 1 : this.usage.windowWrites + 1;
  }

  setMember(userId: string, role = "user", status: "active" | "disabled" = "active"): void {
    this.members.set(userId, { userId, role, status });
  }
  removeMember(userId: string): void {
    this.members.delete(userId);
  }

  seedRecord(collection: string, data: Record<string, unknown>, owner: string | null = null): string {
    const c = this.records_(collection);
    if (!c) throw new Error(`seed: unknown records collection "${collection}"`);
    try { validateDoc(c.schema, data); } catch (e) { throw new Error(`seed: ${collection}: ${(e as Error).message}`); }
    const ref = c.recipient ? this.records.get(`${c.references[c.recipient.reference].collection}/${String(data[c.recipient.reference])}`) : null;
    if (c.recipient && (!ref || ref.owner === null)) throw new Error(`seed: ${collection}: ${c.recipient.reference} must name an owned record`);
    const at = this.tick();
    const id = this.uuid();
    const bytes = recordBytes(data);
    this.usage.records++;
    this.usage.bytes += bytes;
    this.records.set(`${collection}/${id}`, { collection, id, owner, data: { ...data }, key: null, hash: null, created: at, updated: at, bytes, recipient: ref?.owner ?? null });
    return id;
  }

  private area(name: string): Collection | null {
    const c = own(this.manifest.collections, name);
    return c && c.kind === "files" ? c : null;
  }
  private filePermits(area: string, op: "list" | "get" | "create" | "update" | "delete", m: Member, owner: string | null): boolean {
    const c = this.area(area);
    return !!c && principalMatch(c.rules[op], m, owner);
  }

  authorizeUpload(caller: Caller, area: string, name: string, size: number, upsert: boolean): string | null {
    const path = `${area}/${name}`;
    if (!FILE_PATH.test(path)) throw invalid("invalid_file_name");
    if (size > FILE_SIZE_LIMIT) throw quota("file_too_large");
    const m = this.member(caller);
    const owner = caller.sub;
    const existing = this.files.get(path);
    if (existing) {
      if (!upsert) throw new ZaviError("conflict", "already_exists", { reason: "already_exists" });
      if (!caller.sub || !this.fileReadable(area, m, existing.owner) || !this.filePermits(area, "update", m, existing.owner)) throw notAllowed("rls");
      return existing.owner;
    }
    if (!this.filePermits(area, "create", m, owner) || (owner ?? null) !== (m?.userId ?? null)) throw notAllowed("rls");
    return owner;
  }
  putFile(area: string, name: string, owner: string | null, contentType: string, size: number, body: unknown): void {
    this.files.set(`${area}/${name}`, { owner, contentType, size, created: this.now(), body });
  }
  private fileReadable(area: string, m: Member, owner: string | null): boolean {
    return this.filePermits(area, "get", m, owner) || this.filePermits(area, "list", m, owner);
  }
  listFiles(caller: Caller, area: string) {
    const m = this.member(caller);
    return [...this.files.entries()]
      .filter(([p, f]) => p.startsWith(`${area}/`) && this.fileReadable(area, m, f.owner))
      .map(([p, f]) => ({ name: p.slice(area.length + 1), size: f.size, content_type: f.contentType, created_at: new Date(f.created).toISOString() }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  readFile(caller: Caller, area: string, name: string): FileObj {
    const f = this.files.get(`${area}/${name}`);
    if (!f || !this.fileReadable(area, this.member(caller), f.owner)) throw notFound();
    return f;
  }
  removeFile(caller: Caller, area: string, name: string): void {
    if (!caller.sub) throw notAllowed("anonymous_write_forbidden");
    const m = this.member(caller);
    const f = this.files.get(`${area}/${name}`);
    if (!f || !this.fileReadable(area, m, f.owner) || !this.filePermits(area, "delete", m, f.owner)) throw notFound();
    this.files.delete(`${area}/${name}`);
  }

  snapshot(): string {
    return JSON.stringify({ v: 1, clock: this.clock, records: [...this.records.values()], members: [...this.members.values()], receipts: [...this.receipts.values()] });
  }
  restore(raw: string): void {
    const s = JSON.parse(raw) as { v?: number; clock?: number; records?: Rec[]; members?: MemberRow[]; receipts?: Receipt[] };
    if (s.v !== 1) return;
    this.records.clear();
    this.members.clear();
    this.receipts.clear();
    for (const r of s.receipts ?? []) this.receipts.set(`${r.action}/${r.key}`, r);
    this.usage = { records: 0, bytes: 0, windowStart: -1, windowWrites: 0 };
    for (const r of s.records ?? []) {
      this.records.set(`${r.collection}/${r.id}`, r);
      this.usage.records++;
      this.usage.bytes += r.bytes;
    }
    for (const m of s.members ?? []) this.members.set(m.userId, m);
    this.clock = Math.max(this.clock, s.clock ?? 0);
  }
}
