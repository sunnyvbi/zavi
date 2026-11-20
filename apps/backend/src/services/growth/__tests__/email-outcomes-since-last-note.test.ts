import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: { cgo_notes: [] as Row[], email_send_outcomes: [] as Row[] } as Record<string, Row[]>,
  fail: null as string | null,
  clock: 0,
  reads: [] as Array<{ table: string; tenant: string; filters: string[] }>,
}));

vi.mock("@/../workers/client", () => ({ inngest: { createFunction: () => ({}), send: vi.fn() } }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/tenant-client", () => {
  const empty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && Object.keys(v as object).length === 0);
  const orMatch = (row: Row, filter: string) =>
    filter.split(",").some((part) => {
      const [col, op, ...rest] = part.split(".");
      const arg = rest.join(".");
      if (op === "not" && arg === "is.null") return row[col] !== null && row[col] !== undefined;
      if (op === "neq" && arg === "{}") return !empty(row[col]);
      throw new Error(`fake db: unsupported filter ${part}`);
    });
  function builder(tenant: string, table: string) {
    const preds: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
    const filters: string[] = [];
    let mode: "select" | "delete" = "select";
    let order: { col: string; asc: boolean } | null = null;
    let limit = Infinity;
    const run = () => {
      if (db.fail === table) return { data: null, error: { message: `${table} unavailable` } };
      const rows = db.tables[table];
      if (mode === "delete") {
        db.tables[table] = rows.filter((r) => !preds.every((p) => p(r)));
        return { data: null, error: null };
      }
      db.reads.push({ table, tenant, filters });
      let out = rows.filter((r) => preds.every((p) => p(r)));
      if (order) {
        const { col, asc } = order;
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      const picked = cols ? out.map((r) => Object.fromEntries((cols ?? []).map((c) => [c, r[c]]))) : out;
      return { data: picked.slice(0, limit), error: null };
    };
    let cols: string[] | null = null;
    const q = {
      select: (s?: string) => ((cols = s && s !== "*" ? s.split(",").map((c) => c.trim()) : null), q),
      delete: () => ((mode = "delete"), q),
      eq: (c: string, v: unknown) => (filters.push(`eq:${c}`), preds.push((r) => (r[c] ?? "") === v), q),
      neq: (c: string, v: unknown) => (filters.push(`neq:${c}`), preds.push((r) => (r[c] ?? "") !== v), q),
      gt: (c: string, v: string) => (filters.push(`gt:${c}`), preds.push((r) => String(r[c]) > v), q),
      or: (f: string) => (filters.push(`or:${f}`), preds.push((r) => orMatch(r, f)), q),
      order: (c: string, o?: { ascending?: boolean }) => ((order = { col: c, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: async () => {
        const r = run();
        return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  }
  return {
    asTenantId: (t: string) => t,
    tenantClient: (t: string) => ({ from: (table: string) => builder(t, table) }),
    opsRpc: vi.fn(),
    tenantRpc: async (t: string, name: string, args: Record<string, unknown>) => {
      if (!["claim_email_send_outcome_tell", "keep_email_send_outcome_line", "release_email_send_outcome"].includes(name)) throw new Error(`fake db: unexpected rpc ${name}`);
      if (db.fail === "email_send_outcomes") return { data: null, error: { message: "down" } };
      const kind = (args.p_kind as string | undefined) ?? "";
      const rows = db.tables.email_send_outcomes;
      const row = rows.find((r) => r.rail === args.p_rail && r.card_id === args.p_card_id && r.outcome === args.p_outcome && r.kind === kind);
      if (name === "release_email_send_outcome") {
        const held = !!row && row.tenant_id === t && row.claimed === true;
        if (held) row.claimed = false;
        return { data: held, error: null };
      }
      if (row) {
        if (name === "keep_email_send_outcome_line" || row.tenant_id !== t || row.claimed) return { data: name === "keep_email_send_outcome_line" ? false : "taken", error: null };
        row.claimed = true;
        row.line = args.p_line;
        return { data: "reclaimed", error: null };
      }
      db.clock += 1;
      const claimed = name === "claim_email_send_outcome_tell";
      rows.push({ tenant_id: t, rail: args.p_rail, card_id: args.p_card_id, outcome: args.p_outcome, kind, line: args.p_line, created_at: at(db.clock), claimed });
      return { data: claimed ? "claimed" : true, error: null };
    },
  };
});

function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 28, 9, 0, 0) + minute * 60_000).toISOString();
}

import { readEmailOutcomesSinceLastNote } from "../goal-owner";
import { keepEmailSendOutcomeLine, notifyEmailSendOutcomeOrThrow, readEmailOutcomesSince, type OutcomeDeps, type SendOutcome } from "@/services/email-cards/outcome";
import { tellEmailSendOutcomeOrQueue } from "@/services/email-cards/outcome-tell";
import { rebuildSendOutcome } from "@/services/email-cards/outcome-rebuild";
import { runEmailSendOutcomeTell, type TellStep } from "@/../workers/functions/email-send-outcome-tell";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const NOW = new Date(at(600));

const note = (minute: number, over: Row = {}): Row => ({ tenant_id: T, created_at: at(minute), alarm_keys: [], items: [{ text: "x" }], changed: [], need: [], would_change: [], ...over });
const outcome = (minute: number, o: string, line: string, over: Row = {}): Row => ({ tenant_id: T, rail: "decisions", card_id: `card-${minute}`, outcome: o, kind: "", line, created_at: at(minute), ...over });

const card: Partial<OutcomeDeps> = {
  readCard: async () => ({ body: { variants: [{ content: { subject: "Spring sale" } }], chosen_variant: 1, list_name: "Members" }, approved_by: "u-admin", approved_by_source: null }),
  emailOf: async () => "admin@northwind.test",
  ownerEmail: async () => "owner@northwind.test",
  send: async () => {
    throw new Error("SendGrid 503");
  },
  startResults: async () => undefined,
};

function retryingStep(retries: number): TellStep {
  return {
    run: async <R,>(_id: string, fn: () => Promise<R>): Promise<R> => {
      let last: unknown;
      for (let i = 0; i <= retries; i += 1) {
        try {
          return await fn();
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },
  };
}

beforeEach(() => {
  db.tables = { cgo_notes: [], email_send_outcomes: [] };
  db.fail = null;
  db.clock = 100;
  db.reads = [];
});

describe("readEmailOutcomesSince", () => {
  it("eleven sends since the last note: the oldest failure still shows, and an unknown one too, ahead of newer plain sends", async () => {
    db.tables.email_send_outcomes = [
      outcome(1, "failed", "oldest failure"),
      outcome(2, "unknown", "may have gone out"),
      ...Array.from({ length: 9 }, (_, i) => outcome(3 + i, "sent", `sent ${3 + i}`)),
    ];
    const lines = await readEmailOutcomesSince(T, at(0));
    expect(lines.map((r) => r.line)).toEqual(["sent 11", "sent 10", "sent 9", "sent 8", "sent 7", "sent 6", "sent 5", "sent 4", "may have gone out", "oldest failure"]);
    db.tables.cgo_notes = [note(0)];
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items.filter((i) => i.section === "needs_you").map((i) => i.text).sort()).toEqual(["may have gone out", "oldest failure"]);
  });

  it("nothing failed: the newest ten sends, newest first, with no field added to a row", async () => {
    db.tables.email_send_outcomes = Array.from({ length: 12 }, (_, i) => outcome(i + 1, "sent", `sent ${i + 1}`));
    const lines = await readEmailOutcomesSince(T, at(0));
    expect(lines.map((r) => r.line)).toEqual(Array.from({ length: 10 }, (_, i) => `sent ${12 - i}`));
    expect(Object.keys(lines[0]).sort()).toEqual(["card_id", "line", "outcome"]);
  });

  it("returns only rows after the given time, newest first, at most the limit", async () => {
    db.tables.email_send_outcomes.push(outcome(10, "sent", "old"), outcome(30, "sent", "newer"), outcome(20, "failed", "middle"), outcome(5, "sent", "before"));
    expect(await readEmailOutcomesSince(T, at(10))).toEqual([
      { outcome: "sent", line: "newer", card_id: "card-30" },
      { outcome: "failed", line: "middle", card_id: "card-20" },
    ]);
    expect(await readEmailOutcomesSince(T, at(0), 2)).toHaveLength(2);
    for (let i = 0; i < 12; i += 1) db.tables.email_send_outcomes.push(outcome(40 + i, "sent", `l${i}`));
    expect(await readEmailOutcomesSince(T, at(0))).toHaveLength(10);
  });

  it("throws on a read error so the caller decides", async () => {
    db.fail = "email_send_outcomes";
    await expect(readEmailOutcomesSince(T, at(0))).rejects.toThrow(/email_send_outcomes read failed/);
  });
});

describe("readEmailOutcomesSinceLastNote", () => {
  it("reads the window since the last note the founder was shown: rows before it are out, rows after it are in", async () => {
    db.tables.cgo_notes.push(note(10), note(50));
    db.tables.email_send_outcomes.push(outcome(20, "sent", "told in the 10 o'clock note"), outcome(49, "failed", "also before"), outcome(51, "sent", "after the last note"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["after the last note"]);
  });

  it("a note that showed nothing, or a blocker alert, does not move the window", async () => {
    db.tables.cgo_notes.push(
      note(10),
      note(40, { items: null, changed: [], need: [], would_change: [] }),
      note(45, { alarm_keys: ["cgo_blockers"], items: [{ text: "blocked" }] }),
    );
    db.tables.email_send_outcomes.push(outcome(5, "sent", "before"), outcome(30, "sent", "after the shown note"), outcome(44, "failed", "after the blank note"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["after the blank note", "after the shown note"]);
  });

  it("with no shown note it reads the last 14 days", async () => {
    db.tables.email_send_outcomes.push(outcome(600 - 15 * 1440, "sent", "15 days ago"), outcome(600 - 13 * 1440, "sent", "13 days ago"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["13 days ago"]);
  });

  it("a send goes under What I changed; a failed or unclear one under Needs you", async () => {
    db.tables.email_send_outcomes.push(outcome(1, "sent", "Sent to 40"), outcome(2, "failed", "Not sent"), outcome(3, "unknown", "May have gone out"));
    expect(await readEmailOutcomesSinceLastNote(T, NOW)).toEqual([
      { section: "needs_you", text: "May have gone out", channel_slug: "email_marketing" },
      { section: "needs_you", text: "Not sent", channel_slug: "email_marketing" },
      { section: "changed", text: "Sent to 40", channel_slug: "email_marketing" },
    ]);
  });

  it("reads only the caller's tenant's notes", async () => {
    db.tables.cgo_notes.push(note(50, { tenant_id: OTHER }));
    db.tables.email_send_outcomes.push(outcome(20, "sent", "mine"));
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.text)).toEqual(["mine"]);
    const notesRead = db.reads.find((r) => r.table === "cgo_notes")!;
    expect(notesRead.filters).toContain("eq:tenant_id");
  });

  it("a read error on either table costs these lines, never the note", async () => {
    db.tables.cgo_notes.push(note(10));
    db.tables.email_send_outcomes.push(outcome(20, "sent", "line"));
    for (const table of ["cgo_notes", "email_send_outcomes"]) {
      db.fail = table;
      await expect(readEmailOutcomesSinceLastNote(T, NOW)).resolves.toEqual([]);
    }
  });
});

describe("a notice that never goes out still reaches the next Growth note", () => {
  const CARD = "22222222-2222-4222-8222-222222222222";
  const o: SendOutcome = { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 120, total: 400, reason: "You stopped it." };
  const attempts: string[] = [];
  const failing: Partial<OutcomeDeps> = {
    ...card,
    send: async (to) => {
      attempts.push(to);
      throw new Error("SendGrid 503");
    },
  };
  const claimRows = () => db.tables.email_send_outcomes.filter((r) => r.card_id === CARD);

  beforeEach(() => {
    attempts.length = 0;
  });

  it("the tell worker gives up after its retries, gives the claim back each time, and the kept line shows in the next note", async () => {
    db.tables.cgo_notes.push(note(50));
    const atKeep: number[] = [];
    const run = await runEmailSendOutcomeTell({ tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed" }, retryingStep(2), {
      rebuild: async () => ({ o }),
      tell: (x) => notifyEmailSendOutcomeOrThrow(x, failing),
      keep: (x) => (atKeep.push(claimRows().length), keepEmailSendOutcomeLine(x, failing)),
    });
    expect(run).toEqual({ told: false });
    expect(attempts).toEqual(["admin@northwind.test", "admin@northwind.test", "admin@northwind.test"]);
    expect(atKeep).toEqual([1]);
    expect(claimRows()).toEqual([expect.objectContaining({ claimed: false })]);
    const items = await readEmailOutcomesSinceLastNote(T, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ section: "needs_you", channel_slug: "email_marketing" });
    expect(items[0].text).toMatch(/Spring sale/);
  });

  it("with the real rebuild over the card's own rows, the words come from the row and the line is kept under the row's outcome", async () => {
    db.tables.cgo_notes.push(note(50));
    db.tables.decisions = [{ id: CARD, tenant_id: T, decision_class: "email_campaign.create_and_send", status: "dispatch_failed", dispatch_error: "Mailchimp refused the send." }];
    db.tables.email_bulk_sends = [];
    const told: SendOutcome[] = [];
    const run = await runEmailSendOutcomeTell({ tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed" }, retryingStep(2), {
      rebuild: (t, ref) => rebuildSendOutcome(t, ref),
      tell: (x) => (told.push(x), notifyEmailSendOutcomeOrThrow(x, failing)),
      keep: (x) => keepEmailSendOutcomeLine(x, failing),
    });
    expect(run).toEqual({ told: false });
    expect(attempts).toHaveLength(3);
    expect(told[0]).toEqual({ tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 0, reason: "Mailchimp refused the send." });
    expect(claimRows()).toEqual([expect.objectContaining({ tenant_id: T, outcome: "failed", kind: "" })]);
    expect(db.reads.filter((r) => r.table === "decisions").every((r) => r.tenant === T)).toBe(true);
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.section)).toEqual(["needs_you"]);
  });

  it("a caller whose retry cannot be queued keeps the line, and the next note shows it once", async () => {
    db.tables.cgo_notes.push(note(50));
    const r = await tellEmailSendOutcomeOrQueue(o, {
      tell: (x) => import("@/services/email-cards/outcome").then((m) => m.tellEmailSendOutcome(x, failing)),
      rebuild: async () => ({ o }),
      enqueue: async () => {
        throw new Error("inngest down");
      },
      keep: (x) => keepEmailSendOutcomeLine(x, failing),
    });
    expect(r).toBe("kept");
    expect(attempts).toHaveLength(1);
    expect((await readEmailOutcomesSinceLastNote(T, NOW)).map((i) => i.section)).toEqual(["needs_you"]);
    db.tables.cgo_notes.push(note(db.clock + 1));
    expect(await readEmailOutcomesSinceLastNote(T, NOW)).toEqual([]);
  });
});
