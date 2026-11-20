
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StaleRevisionError } from "@/services/tenant-client";
import {
  editSecretList,
  SecretListError,
  validateSeatNote,
  type SecretListDeps,
} from "../index";

const KEY = "anthropic_oauth_token_pool";
const T1 = "sk-ant-oat01-aaaaaaaaaaaaaaaa1111";
const T2 = "sk-ant-oat01-bbbbbbbbbbbbbbbb2222";
const T3 = "sk-ant-oat01-cccccccccccccccc3333";
const seatOf = (t: string) => `seat_${Buffer.from(t).toString("hex").slice(-12)}`;

function fakeStore(initial: string | undefined, notes: Record<string, string> = {}) {
  const db = {
    value: initial as string | undefined,
    revision: initial === undefined ? null : ("r0" as string | null),
    notes: new Map(Object.entries(notes)),
    writes: 0,
    n: 0,
  };
  const apply = vi.fn(async (args: Parameters<SecretListDeps["apply"]>[0]): Promise<string> => {
    if (args.expectedRevision !== db.revision) throw new StaleRevisionError();
    db.value = args.value;
    for (const s of args.noteDeletes) db.notes.delete(s);
    for (const u of args.noteUpserts) db.notes.set(u.seat, u.note);
    db.revision = `r${++db.n}`;
    db.writes++;
    return db.revision;
  });
  const deps: SecretListDeps = {
    readSnapshot: async () => ({ value: db.value, revision: db.revision }),
    readNotes: async (seats) => new Map(seats.filter((s) => db.notes.has(s)).map((s) => [s, db.notes.get(s)!])),
    apply,
    seatOf,
    notesEnabled: () => true,
  };
  return { db, deps, apply };
}

describe("editSecretList: list edits", () => {
  it("append keeps existing tokens and adds the new one", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`);
    const r = await editSecretList(KEY, { op: "append", tokens: T3 }, "ravi@upcar.ai", deps);
    expect(db.value).toBe(`${T1},${T2},${T3}`);
    expect(r).toMatchObject({ count: 3, changed: 1, revision: "r1" });
  });

  it("append onto an empty pool, several at once, newline or comma separated, skipping duplicates", async () => {
    const { db, deps } = fakeStore(undefined);
    const r = await editSecretList(KEY, { op: "append", tokens: `${T1}, ${T2}\n${T1}` }, "r", deps);
    expect(db.value).toBe(`${T1},${T2}`);
    expect(r.count).toBe(2);
  });

  it("append of an already-stored token writes nothing", async () => {
    const { db, deps } = fakeStore(T1);
    const r = await editSecretList(KEY, { op: "append", tokens: T1 }, "r", deps);
    expect(r).toMatchObject({ count: 1, changed: 0 });
    expect(db.writes).toBe(0);
  });

  it("append refuses the redaction placeholder, masked hints and non-token text", async () => {
    const { db, deps } = fakeStore(T1);
    await expect(editSecretList(KEY, { op: "append", tokens: "••• set (hidden)" }, "r", deps)).rejects.toThrow(/placeholder/);
    await expect(editSecretList(KEY, { op: "append", tokens: "…1111" }, "r", deps)).rejects.toThrow(/placeholder/);
    await expect(editSecretList(KEY, { op: "append", tokens: "short" }, "r", deps)).rejects.toMatchObject({ code: "invalid_token" });
    expect(db.writes).toBe(0);
  });

  it("an overlapping write makes append re-read and merge, so no token is lost", async () => {
    const { db, deps } = fakeStore(T1);
    const realRead = deps.readSnapshot;
    let first = true;
    deps.readSnapshot = async (k) => {
      const snap = await realRead(k);
      if (first) {
        first = false;
        db.value = `${T1},${T2}`;
        db.revision = "other";
      }
      return snap;
    };
    await editSecretList(KEY, { op: "append", tokens: T3 }, "r", deps);
    expect(db.value).toBe(`${T1},${T2},${T3}`);
  });

  it("set with a stale revision is a 409 and writes nothing", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`);
    await expect(editSecretList(KEY, { op: "set", tokens: T3, expectedRevision: "old" }, "r", deps)).rejects.toMatchObject({
      code: "stale_revision",
      status: 409,
    });
    expect(db.value).toBe(`${T1},${T2}`);
  });

  it("set replaces the list and deletes notes only for the entries it removed", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`, {
      [seatOf(T1)]: "keep me",
      [seatOf(T2)]: "drop me",
      seat_000000000000: "orphan from an old salt",
    });
    await editSecretList(KEY, { op: "set", tokens: `${T1},${T3}`, expectedRevision: "r0" }, "r", deps);
    expect(db.value).toBe(`${T1},${T3}`);
    expect([...db.notes.keys()].sort()).toEqual([seatOf(T1), "seat_000000000000"].sort());
  });

  it('set "" clears the list and its notes', async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`, { [seatOf(T1)]: "a", [seatOf(T2)]: "b" });
    const r = await editSecretList(KEY, { op: "set", tokens: "", expectedRevision: "r0" }, "r", deps);
    expect(db.value).toBe("");
    expect(db.notes.size).toBe(0);
    expect(r.count).toBe(0);
  });

  it("remove by hint drops exactly that entry and its note", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`, { [seatOf(T2)]: "b" });
    const r = await editSecretList(KEY, { op: "remove", target: "…2222" }, "r", deps);
    expect(db.value).toBe(T1);
    expect(db.notes.has(seatOf(T2))).toBe(false);
    expect(r).toMatchObject({ count: 1, changed: 1, seat: seatOf(T2) });
  });

  it("remove refuses an ambiguous or unknown hint; by seat it is unambiguous and retry-safe", async () => {
    const a = "sk-ant-oat01-aaaaaaaaaaaaaaaa1111";
    const b = "sk-ant-oat01-bbbbbbbbbbbbbbbb1111";
    const { db, deps } = fakeStore(`${a},${b}`);
    await expect(editSecretList(KEY, { op: "remove", target: "…1111" }, "r", deps)).rejects.toMatchObject({ code: "ambiguous_hint" });
    await expect(editSecretList(KEY, { op: "remove", target: "…9999" }, "r", deps)).rejects.toMatchObject({ status: 404 });
    await editSecretList(KEY, { op: "remove", target: seatOf(b) }, "r", deps);
    expect(db.value).toBe(a);
    const again = await editSecretList(KEY, { op: "remove", target: seatOf(b) }, "r", deps);
    expect(again.changed).toBe(0);
  });

  it("a target that is not a seat label or hint is refused without echoing it (a token pasted in the wrong field)", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`);
    for (const edit of [
      { op: "remove" as const, target: T2 },
      { op: "note" as const, target: T2, note: "x", expectedRevision: "r0" },
      { op: "replace" as const, target: T3, token: T2, expectedRevision: "r0" },
    ]) {
      const err = await editSecretList(KEY, edit, "r", deps).catch((e: SecretListError) => e);
      expect(err).toMatchObject({ code: "invalid_target", status: 400 });
      expect(String((err as Error).message)).not.toContain("sk-ant");
    }
    expect(db.writes).toBe(0);
  });

  it("without a seat salt, seat targets are refused (labels differ per process) and hints still work", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`);
    deps.notesEnabled = () => false;
    await expect(editSecretList(KEY, { op: "remove", target: seatOf(T2) }, "r", deps)).rejects.toMatchObject({
      code: "seat_labels_unstable",
    });
    await editSecretList(KEY, { op: "remove", target: "\u20262222" }, "r", deps);
    expect(db.value).toBe(T1);
  });

  it("refuses a non-credential key", async () => {
    const { deps } = fakeStore(T1);
    await expect(editSecretList("memory_reranker_enabled", { op: "append", tokens: T1 }, "r", deps)).rejects.toMatchObject({
      code: "not_a_credential_list",
    });
  });
});

describe("editSecretList: notes", () => {
  it("note sets, then clears, the note on one seat", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`);
    await editSecretList(
      KEY,
      { op: "note", target: seatOf(T2), note: "  Ravi's Max seat, renews 11-03 ", expectedRevision: "r0" },
      "r",
      deps,
    );
    expect(db.notes.get(seatOf(T2))).toBe("Ravi's Max seat, renews 11-03");
    await editSecretList(KEY, { op: "note", target: seatOf(T2), note: "", expectedRevision: "r1" }, "r", deps);
    expect(db.notes.has(seatOf(T2))).toBe(false);
  });

  it("note edits move the revision, so a second stale note edit is a 409", async () => {
    const { deps } = fakeStore(T1);
    await editSecretList(KEY, { op: "note", target: seatOf(T1), note: "first", expectedRevision: "r0" }, "r", deps);
    await expect(
      editSecretList(KEY, { op: "note", target: seatOf(T1), note: "second", expectedRevision: "r0" }, "r", deps),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("note on a seat that is not in the pool is a 404", async () => {
    const { deps } = fakeStore(T1);
    await expect(
      editSecretList(KEY, { op: "note", target: "seat_aaaaaaaaaaaa", note: "x", expectedRevision: "r0" }, "r", deps),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("append with a note saves both in one write, and re-saves the note when the token is already stored", async () => {
    const { db, deps, apply } = fakeStore(T1);
    await editSecretList(KEY, { op: "append", tokens: T2, note: "Tarun's seat" }, "r", deps);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(db.value).toBe(`${T1},${T2}`);
    expect(db.notes.get(seatOf(T2))).toBe("Tarun's seat");
    await editSecretList(KEY, { op: "append", tokens: T2, note: "Tarun's seat (team)" }, "r", deps);
    expect(db.value).toBe(`${T1},${T2}`);
    expect(db.notes.get(seatOf(T2))).toBe("Tarun's seat (team)");
  });

  it("append with a note needs exactly one token", async () => {
    const { deps } = fakeStore(undefined);
    await expect(editSecretList(KEY, { op: "append", tokens: `${T1},${T2}`, note: "x" }, "r", deps)).rejects.toMatchObject({
      code: "note_needs_one_token",
    });
  });

  it("replace swaps a refreshed token in place and carries its note over", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`, { [seatOf(T1)]: "Ravi's Max" });
    const r = await editSecretList(KEY, { op: "replace", target: seatOf(T1), token: T3, expectedRevision: "r0" }, "r", deps);
    expect(db.value).toBe(`${T3},${T2}`);
    expect(db.notes.get(seatOf(T3))).toBe("Ravi's Max");
    expect(db.notes.has(seatOf(T1))).toBe(false);
    expect(r.seat).toBe(seatOf(T3));
  });

  it("notes are refused when the server has no seat salt (labels would change on restart)", async () => {
    const { db, deps } = fakeStore(T1);
    deps.notesEnabled = () => false;
    await expect(
      editSecretList(KEY, { op: "note", target: seatOf(T1), note: "x", expectedRevision: "r0" }, "r", deps),
    ).rejects.toMatchObject({ code: "notes_unavailable", status: 503 });
    await expect(editSecretList(KEY, { op: "append", tokens: T2, note: "x" }, "r", deps)).rejects.toMatchObject({
      code: "notes_unavailable",
    });
    await editSecretList(KEY, { op: "append", tokens: T2 }, "r", deps);
    expect(db.value).toBe(`${T1},${T2}`);
  });

  it("a note that contains a pool token is refused and nothing is written", async () => {
    const { db, deps } = fakeStore(`${T1},${T2}`);
    await expect(
      editSecretList(KEY, { op: "note", target: seatOf(T1), note: `backup is ${T2}`, expectedRevision: "r0" }, "r", deps),
    ).rejects.toMatchObject({ code: "note_contains_credential" });
    await expect(editSecretList(KEY, { op: "append", tokens: T3, note: `this is ${T3}` }, "r", deps)).rejects.toMatchObject({
      code: "note_contains_credential",
    });
    expect(db.writes).toBe(0);
  });
});

describe("validateSeatNote", () => {
  it("trims, allows plain text, and returns '' for a blank note", () => {
    expect(validateSeatNote("  Ravi's Max, renews 11-03  ", [])).toBe("Ravi's Max, renews 11-03");
    expect(validateSeatNote("   ", [])).toBe("");
  });

  it("rejects long notes, control or invisible characters, and token-shaped text", () => {
    expect(() => validateSeatNote("x".repeat(281), [])).toThrow(SecretListError);
    expect(() => validateSeatNote("two\nlines", [])).toThrow(/control or invisible/);
    expect(() => validateSeatNote("a‮b", [])).toThrow(/control or invisible/);
    expect(() => validateSeatNote("key sk-ant-api03-abcdefghijklmnopqrstuv", [])).toThrow(/contains a token/);
  });
});

describe("listSettings: credential list view", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function mockSettingsTables(appRows: unknown[] | null, error: { message: string } | null = null) {
    vi.doMock("@/services/supabase", () => ({
      serviceClient: () => ({
        from: (n: string) => ({
          select: () => Promise.resolve({ data: error ? null : n === "app_setting" ? appRows : [], error }),
        }),
      }),
    }));
  }

  function mockNotes(result: (seats: string[]) => { data: unknown; error: { message: string } | null }) {
    vi.doMock("@/services/tenant-client", async () => {
      const actual = await vi.importActual<typeof import("@/services/tenant-client")>("@/services/tenant-client");
      return {
        ...actual,
        globalClient: () => ({
          from: () => ({ select: () => ({ in: (_c: string, seats: string[]) => Promise.resolve(result(seats)) }) }),
        }),
      };
    });
  }

  async function withSalt<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.SEAT_LABEL_SALT;
    process.env.SEAT_LABEL_SALT = "test-salt";
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.SEAT_LABEL_SALT;
      else process.env.SEAT_LABEL_SALT = prev;
    }
  }

  it("exposes hint + seat + note per token and the revision, never the token", async () => {
    mockSettingsTables([{ key: KEY, value: `${T1},${T2}`, updated_at: "2026-10-21T17:30:00.123456+00:00" }]);
    mockNotes((seats) => ({
      data: [{ seat: seats[1], note: "Tarun's seat", updated_by: "ravi@upcar.ai", updated_at: "2026-10-21T18:00:00+00:00" }],
      error: null,
    }));
    await withSalt(async () => {
      const { listSettings } = await import("../index");
      const rows = await listSettings();
      const row = rows.find((r) => r.key === KEY)!;
      expect(row.secretItems).toEqual(["…1111", "…2222"]);
      expect(row.secretRevision).toBe("2026-10-21T17:30:00.123456+00:00");
      expect(row.notesAvailable).toBe(true);
      expect(row.secretEntries!.map((e) => [e.hint, e.note])).toEqual([
        ["…1111", null],
        ["…2222", "Tarun's seat"],
      ]);
      expect(row.secretEntries![0].seat).toMatch(/^seat_[0-9a-f]{12}$/);
      expect(JSON.stringify(rows)).not.toContain("sk-ant-oat01");
      expect(rows.find((r) => r.key === "memory_reranker_enabled")!.secretEntries).toBeUndefined();
    });
  });

  it("without a seat salt, entries carry no seat label and notes are off", async () => {
    mockSettingsTables([{ key: KEY, value: T1, updated_at: "r" }]);
    mockNotes(() => ({ data: [], error: null }));
    const prev = process.env.SEAT_LABEL_SALT;
    delete process.env.SEAT_LABEL_SALT;
    try {
      const { listSettings } = await import("../index");
      const row = (await listSettings()).find((r) => r.key === KEY)!;
      expect(row.notesAvailable).toBe(false);
      expect(row.secretEntries![0]).toMatchObject({ hint: "\u20261111", seat: null });
    } finally {
      if (prev !== undefined) process.env.SEAT_LABEL_SALT = prev;
    }
  });

  it("a failed notes read lists the tokens with notesAvailable:false instead of failing the page", async () => {
    mockSettingsTables([{ key: KEY, value: T1, updated_at: "r" }]);
    mockNotes(() => ({ data: null, error: { message: "relation does not exist" } }));
    await withSalt(async () => {
      const { listSettings } = await import("../index");
      const row = (await listSettings()).find((r) => r.key === KEY)!;
      expect(row.notesAvailable).toBe(false);
      expect(row.secretEntries).toHaveLength(1);
      expect(row.secretEntries![0].note).toBeNull();
    });
  });

  it("a failed app_setting read throws instead of listing every setting at its default", async () => {
    mockSettingsTables(null, { message: "timeout" });
    const { listSettings } = await import("../index");
    await expect(listSettings()).rejects.toThrow(/app_setting read failed/);
  });
});
