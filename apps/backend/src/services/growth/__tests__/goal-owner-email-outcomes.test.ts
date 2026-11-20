import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Read = { table: string; eq: Array<[string, unknown]>; neq: Array<[string, unknown]>; gt: Array<[string, unknown]> };

const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  reads: [] as Read[],
  failRead: null as null | ((r: Read) => "error" | "throw" | null),
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  clock: "",
}));

vi.mock("@/../workers/client", () => ({ inngest: { createFunction: () => ({}), send: vi.fn() } }));
vi.mock("@/services/logging/logEvent", async (orig) => ({ ...((await orig()) as object), logEvent: async () => undefined }));
vi.mock("../cgo-hypotheses", async (orig) => ({
  ...((await orig()) as object),
  prepareHypotheses: async () => ({ rows: [], gate: undefined as never, refused: [], dropped: 0 }),
  refreshHypotheses: async () => [],
}));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: async () => new Set(["email_marketing", "cgo"]) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => false }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn() }));

vi.mock("@/services/supabase", () => {
  const instant = (v: unknown) => {
    const m = /^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(String(v));
    if (!m) throw new Error(`fake db: not a timestamp: ${String(v)}`);
    return BigInt(Date.parse(`${m[1]}${m[3]}`)) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0").slice(0, 6));
  };
  const emptyish = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  class Query {
    private preds: Array<(r: Row) => boolean> = [];
    private read: Read;
    private op: "select" | "insert" | "update" = "select";
    private patch: Row = {};
    private single = false;
    private head = false;
    private sort: { col: string; asc: boolean } | null = null;
    private lim = Infinity;
    constructor(private table: string) {
      this.read = { table, eq: [], neq: [], gt: [] };
    }
    select(_c?: string, o?: { head?: boolean }) {
      if (o?.head) this.head = true;
      return this;
    }
    insert(row: Row | Row[]) {
      this.op = "insert";
      this.patch = Array.isArray(row) ? row[0] : row;
      return this;
    }
    update(p: Row) {
      this.op = "update";
      this.patch = p;
      return this;
    }
    upsert(row: Row | Row[]) {
      return this.insert(row);
    }
    eq(c: string, v: unknown) {
      this.read.eq.push([c, v]);
      this.preds.push((r) => r[c] === v);
      return this;
    }
    neq(c: string, v: unknown) {
      this.read.neq.push([c, v]);
      this.preds.push((r) => r[c] != null && r[c] !== v);
      return this;
    }
    gt(c: string, v: string) {
      this.read.gt.push([c, v]);
      this.preds.push((r) => r[c] != null && instant(r[c]) > instant(v));
      return this;
    }
    gte(c: string, v: string) {
      this.preds.push((r) => r[c] != null && String(r[c]) >= v);
      return this;
    }
    lte(c: string, v: string) {
      this.preds.push((r) => r[c] != null && String(r[c]) <= v);
      return this;
    }
    lt(c: string, v: string) {
      this.preds.push((r) => r[c] != null && String(r[c]) < v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.preds.push((r) => vs.includes(r[c]));
      return this;
    }
    is(c: string, v: unknown) {
      this.preds.push((r) => (r[c] ?? null) === v);
      return this;
    }
    not(c: string, _o: string, v: unknown) {
      this.preds.push((r) => (r[c] ?? null) !== v);
      return this;
    }
    like() {
      return this;
    }
    filter() {
      return this;
    }
    or(expr: string) {
      const parts = expr.split(",").map((p) => p.split("."));
      this.preds.push((r) =>
        parts.some(([c, op, ...rest]) => {
          const arg = rest.join(".");
          if (op === "not" && arg === "is.null") return (r[c] ?? null) !== null;
          if (op === "neq" && arg === "{}") return !emptyish(r[c]);
          return false;
        }),
      );
      return this;
    }
    order(c: string, o?: { ascending?: boolean }) {
      this.sort = { col: c, asc: o?.ascending !== false };
      return this;
    }
    limit(n: number) {
      this.lim = n;
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    then<A, B>(ok?: ((v: never) => A) | null, bad?: ((e: unknown) => B) | null) {
      return Promise.resolve()
        .then(() => this.run())
        .then(ok as never, bad);
    }
    private run() {
      if (this.op === "insert") {
        const row = { id: `${this.table}-${(state.db[this.table] ?? []).length + 1}`, created_at: state.clock, ...this.patch };
        (state.db[this.table] ??= []).push(row);
        return { data: this.single ? row : [row], error: null };
      }
      const rows = (state.db[this.table] ?? []).filter((r) => this.preds.every((p) => p(r)));
      if (this.op === "update") {
        for (const r of rows) Object.assign(r, this.patch);
        return { data: rows, error: null };
      }
      state.reads.push(this.read);
      const failure = state.failRead?.(this.read) ?? null;
      if (failure === "throw") throw new Error(`${this.table} connection reset`);
      if (failure === "error") return { data: null, error: { message: `${this.table} unavailable` } };
      if (this.sort) {
        const { col, asc } = this.sort;
        rows.sort((a, b) => (instant(a[col]) < instant(b[col]) ? -1 : instant(a[col]) > instant(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      const out = rows.slice(0, this.lim);
      return { data: this.head ? null : this.single ? (out[0] ?? null) : out, error: null, count: rows.length };
    }
  }
  return {
    serviceClient: () => ({
      from: (t: string) => new Query(t),
      rpc: async (fn: string, args: Row) => {
        state.rpcCalls.push({ fn, args });
        return { data: null, error: null };
      },
    }),
  };
});

import { applyGoalMoves, readEmailOutcomesSinceLastNote, type GoalMoves } from "../goal-owner";
import { buildNoteItems, type NoteItem } from "../cgo-note-items";
import { emailNoteSections } from "@/email/templates/cgo-note";
import { emailSendOutcomeLine } from "@/email/templates/email-send-outcome";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-10-28T12:00:00.000Z");
const iso = (minutesBeforeNow: number) => new Date(NOW.getTime() - minutesBeforeNow * 60_000).toISOString();

const line = (outcome: "sent" | "failed" | "unknown", subject: string, over: { sent?: number | null; total?: number | null; reason?: string | null } = {}) =>
  emailSendOutcomeLine({ outcome, subject, listName: "Members", sent: over.sent ?? (outcome === "sent" ? 40 : 0), total: over.total ?? null, reason: over.reason ?? null });

let seq = 0;
function row(created_at: string, outcome: "sent" | "failed" | "unknown", text: string, tenant_id = T): Row {
  seq += 1;
  return { tenant_id, rail: "decisions", card_id: `card-${seq}`, outcome, kind: "", line: text, created_at };
}
const shownNote = (created_at: string, over: Row = {}): Row => ({ tenant_id: T, created_at, alarm_keys: [], items: [{ section: "changed", text: "x" }], changed: [], need: [], would_change: [], ...over });

const founderReads = (items: NoteItem[]) => {
  const sections = emailNoteSections({ tenantId: T, growthUrl: "https://zavi.test/growth", items: buildNoteItems(items), wouldChange: [] } as never, null);
  return Object.fromEntries(sections.map((s) => [s.key, s.rows.map((r) => r.line)]));
};
const outcomeReads = () => state.reads.filter((r) => r.table === "email_send_outcomes");
const review = (extra: Partial<GoalMoves> = {}): GoalMoves => ({ goals: [], goal_changes: [], channel_changes: [], ...extra });
const deps = (now: Date) => ({ emitDecision: vi.fn(async () => "d-1"), resolveRepo: async () => null, now, meta: { kind: "scheduled" as const, alarm_keys: [], autopilot: true } });
const storedItems = (i: number) => (state.db.cgo_notes[i].items ?? []) as NoteItem[];

beforeEach(() => {
  state.db = { cgo_notes: [], email_send_outcomes: [], tenant_subscriptions: [{ tenant_id: T, tier: "pro", status: "active", comp_expires_at: null }] };
  state.reads = [];
  state.failRead = null;
  state.rpcCalls = [];
  state.clock = NOW.toISOString();
  seq = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the window starts at the last note the founder was shown", () => {
  it("a row stamped exactly at the note is out, one microsecond later is in, in the database's own timestamp form", async () => {
    const stamp = "2026-10-28T09:50:00.123456+00:00";
    state.db.cgo_notes.push(shownNote(stamp));
    state.db.email_send_outcomes.push(
      row(stamp, "sent", "exactly at the note"),
      row("2026-10-28T09:50:00.123455+00:00", "failed", "a microsecond before"),
      row("2026-10-28T09:50:00.123457+00:00", "sent", "a microsecond after"),
    );
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items.map((i) => i.text)).toEqual(["a microsecond after"]);
    expect(outcomeReads()[0].gt).toEqual([["created_at", stamp]]);
  });

  it("the newest of several shown notes sets the window, whatever order they were written in", async () => {
    state.db.cgo_notes.push(shownNote(iso(60)), shownNote(iso(600)), shownNote(iso(300)));
    state.db.email_send_outcomes.push(row(iso(90), "failed", "already told at 300"), row(iso(30), "sent", "new"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["new"]);
  });

  it("a note written but never shown does not move the window, so its row still reaches the founder", async () => {
    state.db.cgo_notes.push(
      shownNote(iso(600)),
      shownNote(iso(200), { items: null, changed: [], need: [], would_change: [] }),
      shownNote(iso(100), { items: null, changed: [], need: [], would_change: [] }),
    );
    state.db.email_send_outcomes.push(row(iso(300), "failed", "before the quiet notes"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["before the quiet notes"]);
  });

  it("a blocker alert is shown but is not the note, so it does not move the window either", async () => {
    state.db.cgo_notes.push(shownNote(iso(600)), shownNote(iso(100), { alarm_keys: ["cgo_blockers", "urgent"], items: [{ section: "needs_you", text: "Reconnect" }] }));
    state.db.email_send_outcomes.push(row(iso(300), "sent", "before the alert"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["before the alert"]);
  });

  it("a legacy note with lines and no items moves the window like any shown note", async () => {
    state.db.cgo_notes.push(shownNote(iso(100), { items: null, need: ["Left for you: a card"] }));
    state.db.email_send_outcomes.push(row(iso(300), "sent", "before"), row(iso(50), "sent", "after"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["after"]);
  });

  it("no prior note: fourteen days back from now, and a row exactly fourteen days old is out", async () => {
    const fourteenDays = 14 * 1440;
    state.db.email_send_outcomes.push(row(iso(fourteenDays), "failed", "exactly 14 days"), row(iso(fourteenDays - 1), "sent", "a minute inside"), row(iso(fourteenDays + 1), "sent", "a minute outside"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["a minute inside"]);
    expect(outcomeReads()[0].gt).toEqual([["created_at", iso(fourteenDays)]]);
  });

  it("only hidden notes on the account: the same fourteen days, not the hidden note's time", async () => {
    state.db.cgo_notes.push(shownNote(iso(10), { items: null }));
    state.db.email_send_outcomes.push(row(iso(13 * 1440), "sent", "thirteen days ago"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["thirteen days ago"]);
  });
});

describe("another workspace's rows", () => {
  it("every read carries this tenant's filter, and a newer row and a newer note of another tenant change nothing", async () => {
    state.db.cgo_notes.push(shownNote(iso(100)), shownNote(iso(5), { tenant_id: OTHER }));
    state.db.email_send_outcomes.push(row(iso(50), "sent", "mine"), row(iso(10), "failed", "their failed send", OTHER), row(iso(9), "sent", "their send", OTHER));
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items.map((i) => i.text)).toEqual(["mine"]);
    expect(outcomeReads()).toHaveLength(2);
    for (const r of [...outcomeReads(), ...state.reads.filter((x) => x.table === "cgo_notes")]) {
      expect(r.eq.filter(([c]) => c === "tenant_id")).toContainEqual(["tenant_id", T]);
      expect(r.eq.some(([, v]) => v === OTHER)).toBe(false);
    }
  });

  it("another tenant's newest rows never push this tenant's out of the ten", async () => {
    for (let i = 0; i < 12; i += 1) state.db.email_send_outcomes.push(row(iso(20 - i), "failed", `theirs ${i}`, OTHER));
    state.db.email_send_outcomes.push(row(iso(500), "failed", "my only failure"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["my only failure"]);
  });
});

describe("at most ten lines, and the ones that need the founder survive", () => {
  it("eleven sends: exactly the ten newest, the oldest is the one dropped", async () => {
    for (let i = 1; i <= 11; i += 1) state.db.email_send_outcomes.push(row(iso(100 - i), "sent", `sent ${i}`));
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items.map((i) => i.text)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((n) => `sent ${n}`));
  });

  it("a failure older than eleven newer sends still shows, and the sends fill only what is left", async () => {
    state.db.email_send_outcomes.push(row(iso(900), "failed", "oldest failure"), row(iso(899), "unknown", "may have gone out"));
    for (let i = 1; i <= 11; i += 1) state.db.email_send_outcomes.push(row(iso(100 - i), "sent", `sent ${i}`));
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items).toHaveLength(10);
    expect(items.slice(-2).map((i) => [i.section, i.text])).toEqual([
      ["needs_you", "may have gone out"],
      ["needs_you", "oldest failure"],
    ]);
    expect(items.slice(0, 8).map((i) => i.text)).toEqual([11, 10, 9, 8, 7, 6, 5, 4].map((n) => `sent ${n}`));
  });

  it("twelve failures and a send: the ten newest failures, and no send pushes one out", async () => {
    state.db.email_send_outcomes.push(row(iso(1), "sent", "newest of all"));
    for (let i = 1; i <= 12; i += 1) state.db.email_send_outcomes.push(row(iso(100 - i), "failed", `failed ${i}`));
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items.map((i) => i.text)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `failed ${n}`));
    expect(new Set(items.map((i) => i.section))).toEqual(new Set(["needs_you"]));
  });

  it("exactly ten is not cut", async () => {
    for (let i = 1; i <= 5; i += 1) state.db.email_send_outcomes.push(row(iso(100 - i), "failed", `f${i}`), row(iso(200 - i), "sent", `s${i}`));
    expect(await readEmailOutcomesSinceLastNote(T, NOW)).toHaveLength(10);
  });
});

describe("what the founder reads", () => {
  it("sent under What I changed; not sent, stopped part way and unconfirmed under Needs you, in the real line's words", async () => {
    const sent = line("sent", "Spring sale", { sent: 40 });
    const notSent = line("failed", "Summer sale", { reason: "Mailchimp refused the send." });
    const stopped = line("failed", "Autumn sale", { sent: 120, total: 400, reason: "You stopped it." });
    const unknown = line("unknown", "Winter sale");
    state.db.email_send_outcomes.push(row(iso(40), "sent", sent), row(iso(30), "failed", notSent), row(iso(20), "failed", stopped), row(iso(10), "unknown", unknown));
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items.every((i) => i.channel_slug === "email_marketing")).toBe(true);
    const read = founderReads(items);
    expect(read.changed).toEqual(['Your email "Spring sale" was sent to 40 people on "Members".']);
    expect([...read.needs_you].sort()).toEqual(
      [
        'Your email "Summer sale" to "Members" was not sent. Mailchimp refused the send.',
        'Your email "Autumn sale" stopped after 120 of 400 people on "Members". You stopped it.',
        unknown,
      ].sort(),
    );
    expect(read.needs_you.join(" ")).not.toContain("was sent to");
  });

  it("a send that partly went out is never filed as a change, though people did get it", async () => {
    state.db.email_send_outcomes.push(row(iso(10), "failed", line("failed", "Autumn sale", { sent: 399, total: 400 })));
    expect(await readEmailOutcomesSinceLastNote(T, NOW)).toEqual([{ section: "needs_you", text: 'Your email "Autumn sale" stopped after 399 of 400 people on "Members".', channel_slug: "email_marketing" }]);
  });

  it("nothing since the last note adds no line at all", async () => {
    state.db.cgo_notes.push(shownNote(iso(10)));
    state.db.email_send_outcomes.push(row(iso(20), "sent", "older"));
    expect(await readEmailOutcomesSinceLastNote(T, NOW)).toEqual([]);
  });
});

describe("a read that fails", () => {
  const withRows = () => {
    state.db.cgo_notes.push(shownNote(iso(600)));
    state.db.email_send_outcomes.push(row(iso(30), "failed", "a failure"), row(iso(20), "sent", "a send"));
  };

  it.each([
    ["the notes read returns an error", (r: Read) => (r.table === "cgo_notes" ? ("error" as const) : null)],
    ["the notes read throws", (r: Read) => (r.table === "cgo_notes" ? ("throw" as const) : null)],
    ["both outcome reads return an error", (r: Read) => (r.table === "email_send_outcomes" ? ("error" as const) : null)],
    ["both outcome reads throw", (r: Read) => (r.table === "email_send_outcomes" ? ("throw" as const) : null)],
  ])("%s: no line, no throw, and the reason is logged", async (_n, fail) => {
    withRows();
    state.failRead = fail;
    await expect(readEmailOutcomesSinceLastNote(T, NOW)).resolves.toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`email outcomes skipped for ${T}`));
  });

  it("the failures read alone fails: the sends are not shown as the whole story", async () => {
    withRows();
    state.failRead = (r) => (r.table === "email_send_outcomes" && r.neq.length ? "error" : null);
    expect(await readEmailOutcomesSinceLastNote(T, NOW)).toEqual([]);
  });

  it("the sends read alone fails: the failures are dropped with them, and nothing claims the emails went out", async () => {
    withRows();
    state.failRead = (r) => (r.table === "email_send_outcomes" && r.eq.some(([c]) => c === "outcome") ? "error" : null);
    expect(await readEmailOutcomesSinceLastNote(T, NOW)).toEqual([]);
  });
});

describe("through a real review", () => {
  const asks = (ask: string) => review({ note: { need: [], questions: [{ topic: "approval", about: "offer", ask }] } } as Partial<GoalMoves>);

  it("the stored note carries each line once: the next review tells only what came after it", async () => {
    state.db.email_send_outcomes.push(row(iso(90), "sent", "Your first email"), row(iso(80), "failed", "Your second email"));
    const first = await applyGoalMoves(T, "run-1", review(), deps(NOW));
    expect(first.note_visible).toBe(true);
    const firstLines = Object.fromEntries(storedItems(0).map((i) => [i.text, i.section]));
    expect(firstLines).toEqual({ "Your first email": "changed", "Your second email": "needs_you" });

    const later = new Date(NOW.getTime() + 3_600_000);
    state.clock = later.toISOString();
    state.db.email_send_outcomes.push(row(new Date(NOW.getTime() + 60_000).toISOString(), "sent", "Your third email"));
    await applyGoalMoves(T, "run-2", review(), deps(later));
    expect(storedItems(1).map((i) => i.text)).toEqual(["Your third email"]);
  });

  it("a review with nothing to tell writes a hidden note, and the next one still reads from the last shown note", async () => {
    state.db.cgo_notes.push(shownNote(iso(600)));
    const first = await applyGoalMoves(T, "run-1", review(), deps(NOW));
    expect(first.note_visible).toBe(false);
    expect(state.db.cgo_notes[1].items).toBeNull();
    state.db.email_send_outcomes.push(row(iso(5), "failed", "Landed just before the quiet note"));
    const later = new Date(NOW.getTime() + 3_600_000);
    state.clock = later.toISOString();
    await applyGoalMoves(T, "run-2", review(), deps(later));
    expect(storedItems(2).map((i) => i.text)).toEqual(["Landed just before the quiet note"]);
  });

  it("the outcomes read fails: the note keeps its items and headline, no build failure is raised, and no line talks about sends", async () => {
    state.db.email_send_outcomes.push(row(iso(90), "sent", "Your first email"));
    state.failRead = (r) => (r.table === "email_send_outcomes" ? "error" : null);
    const res = await applyGoalMoves(T, "run-1", asks("Is the summer offer still on?"), deps(NOW));
    expect(res.note_visible).toBe(true);
    const items = storedItems(0);
    expect(items.map((i) => i.text).join(" ")).toContain("Is the summer offer still on?");
    expect(items.map((i) => i.text).join(" ")).not.toMatch(/email|sent|send/i);
    expect(state.db.cgo_notes[0].headline).not.toBeNull();
    expect(state.rpcCalls.filter((c) => c.fn === "enqueue_ops_alert")).toEqual([]);
  });
});
