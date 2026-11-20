
import { codeForReason } from "../../files/src/zavi/errors";
import { CALLERS, STEPS, type Step } from "./scenarios";
import type { KernelStep } from "./scenarios-v2";

export type Caller = { sub: string | null; siteRole: string | null };
export interface Engine {
  create(caller: Caller, c: string, data: unknown, key: string | null): Promise<unknown>;
  get(caller: Caller, c: string, id: string): Promise<unknown>;
  list(caller: Caller, c: string, filter: unknown, limit: number | null, cursor: string | null, sort: string | null): Promise<unknown>;
  update(caller: Caller, c: string, id: string, patch: unknown): Promise<unknown>;
  delete(caller: Caller, c: string, id: string): Promise<unknown>;
  transition?(caller: Caller, c: string, id: string, to: string): Promise<unknown>;
  action?(caller: Caller, name: string, targetId: string | null, recordId: string | null, data: unknown, key: string | null): Promise<unknown>;
  aggregate?(caller: Caller, name: string, filter: unknown): Promise<unknown>;
}

export type Outcome = { ok: true; value: unknown } | { ok: false; code: string; reason: string };

export function normalizeReason(msg: string): string {
  const m = msg.replace(/^ERROR:\s+/, "").trim();
  if (/new row violates row-level security policy/.test(m)) return "rls";
  if (/records_idempotency_key_check/.test(m)) return "idempotency_key_invalid";
  return m;
}

export async function replay(
  engine: Engine,
  steps: ReadonlyArray<Step | KernelStep> = STEPS,
  callers: Record<string, Caller> = CALLERS,
): Promise<Outcome[]> {
  const saved = new Map<string, string>();
  const refs = new Map<string, string>();
  const cursors = new Map<string, string>();
  const ref = (id: unknown) => refs.get(String(id)) ?? "?";
  const val = (v: string | undefined) => (v && v.startsWith("$") ? saved.get(v.slice(1)) ?? v : v);
  const refsIn = (v: unknown): unknown =>
    typeof v === "string" && refs.has(v) ? refs.get(v)
      : Array.isArray(v) ? v.map(refsIn)
        : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, refsIn(x)])) : v;
  const item = (r: { id: string; data: unknown; mine: boolean }) => ({ ref: ref(r.id), data: refsIn(r.data), mine: r.mine });

  const out: Outcome[] = [];
  const deep = (v: unknown): unknown =>
    typeof v === "string" && v.startsWith("$") && saved.has(v.slice(1)) ? saved.get(v.slice(1))
      : Array.isArray(v) ? v.map(deep)
        : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  const learn = (id: unknown, i: number) => { if (typeof id === "string" && !refs.has(id)) refs.set(id, `#${i}`); };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const caller = callers[s.as];
    try {
      let value: unknown;
      if (s.op === "create") {
        const r = (await engine.create(caller, s.c, deep(s.data), s.key ?? null)) as { id: string; replayed: boolean };
        if (!refs.has(r.id)) refs.set(r.id, `#${i}`);
        if (s.save) saved.set(s.save, r.id);
        value = { ref: ref(r.id), replayed: r.replayed };
      } else if (s.op === "get") {
        const r = (await engine.get(caller, s.c, val(s.id) as string)) as { id: string; data: unknown; mine: boolean } | null;
        value = r ? item(r) : null;
      } else if (s.op === "list") {
        const cursor = s.cursor === undefined ? null : s.cursor.startsWith("$") ? cursors.get(s.cursor.slice(1)) ?? null : s.cursor;
        const r = (await engine.list(caller, s.c, s.filter ?? {}, s.limit ?? null, cursor, s.sort ?? null)) as {
          items: Array<{ id: string; data: unknown; mine: boolean }>; next_cursor: string | null;
        };
        if (s.saveCursor && r.next_cursor) cursors.set(s.saveCursor, r.next_cursor);
        value = { items: r.items.map(item), has_next: r.next_cursor !== null };
      } else if (s.op === "transition") {
        const r = (await engine.transition!(caller, s.c, val(s.id) as string, s.to)) as { id: string; from: string; to: string; transitioned: boolean };
        value = { ref: ref(r.id), from: r.from, to: r.to, transitioned: r.transitioned };
      } else if (s.op === "action") {
        const r = (await engine.action!(caller, s.name, val(s.target) ?? null, val(s.record) ?? null, deep(s.data ?? {}), s.key ?? null)) as {
          action: string; target_id: string; record_id: string; counter: number; replayed: boolean;
        };
        learn(r.record_id, i);
        if (s.save) saved.set(s.save, r.record_id);
        value = { action: r.action, target: ref(r.target_id), record: ref(r.record_id), counter: r.counter, replayed: r.replayed };
      } else if (s.op === "aggregate") {
        value = await engine.aggregate!(caller, s.name, deep(s.filter ?? {}));
      } else if (s.op === "update") {
        const r = (await engine.update(caller, s.c, val(s.id) as string, deep(s.patch))) as { updated: boolean };
        value = { updated: r.updated };
      } else {
        const r = (await engine.delete(caller, s.c, val(s.id) as string)) as { deleted: boolean };
        value = { deleted: r.deleted };
      }
      out.push({ ok: true, value });
    } catch (e) {
      const reason = normalizeReason(String((e as Error)?.message ?? e));
      out.push({ ok: false, code: codeForReason(reason.split(":")[0]), reason });
    }
  }
  return out;
}
