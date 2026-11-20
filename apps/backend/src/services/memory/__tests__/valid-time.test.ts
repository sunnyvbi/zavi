import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseValidTime,
  factHoldsAtValidTime,
  closeValidInterval,
  maybeExtractValidTime,
  type ValidTimeDeps,
} from "../valid-time";

const TENANT = "11111111-1111-1111-1111-111111111111";

describe("maybeExtractValidTime — flag gate (a) + no-guess (c)", () => {
  it("(a) flag OFF → null after ONLY the cached flag read; extract NEVER called", async () => {
    const extract = vi.fn(async () => ({ valid_from: "2024-01-01", valid_to: null }));
    const deps: ValidTimeDeps = { extract };
    const flagCheck = vi.fn(async () => false);

    const r = await maybeExtractValidTime(TENANT, "t", "Upcar expanded to Texas in March 2024.", deps, flagCheck);

    expect(r).toBeNull();
    expect(flagCheck).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
  });

  it("flag-store error → null (fail safe to OFF); extract NEVER called", async () => {
    const extract = vi.fn(async () => ({ valid_from: "2024-01-01", valid_to: null }));
    const flagCheck = vi.fn(async () => {
      throw new Error("settings down");
    });
    const r = await maybeExtractValidTime(TENANT, "t", "body", { extract }, flagCheck);
    expect(r).toBeNull();
    expect(extract).not.toHaveBeenCalled();
  });

  it("(b-extract) flag ON + extractable date → stamps {valid_from, valid_to}", async () => {
    const extract = vi.fn(async () => ({
      valid_from: "2024-03-01T00:00:00.000Z",
      valid_to: "2025-06-01T00:00:00.000Z",
    }));
    const r = await maybeExtractValidTime(TENANT, "t", "Operated in TX Mar 2024–Jun 2025.", { extract }, async () => true);
    expect(r).toEqual({
      valid_from: "2024-03-01T00:00:00.000Z",
      valid_to: "2025-06-01T00:00:00.000Z",
    });
  });

  it("(c) flag ON + NO extractable date → {null,null} (never guessed)", async () => {
    const extract = vi.fn(async () => ({ valid_from: null, valid_to: null }));
    const r = await maybeExtractValidTime(TENANT, "t", "Upcar is a marketplace.", { extract }, async () => true);
    expect(r).toEqual({ valid_from: null, valid_to: null });
  });

  it("flag ON but empty title+body → {null,null} WITHOUT calling extract (no wasted LLM)", async () => {
    const extract = vi.fn(async () => ({ valid_from: "2024-01-01", valid_to: null }));
    const r = await maybeExtractValidTime(TENANT, "  ", "   ", { extract }, async () => true);
    expect(r).toEqual({ valid_from: null, valid_to: null });
    expect(extract).not.toHaveBeenCalled();
  });

  it("extraction throws → {null,null} (NON-FATAL — never blocks a write)", async () => {
    const extract = vi.fn(async () => {
      throw new Error("LLM 500");
    });
    const r = await maybeExtractValidTime(TENANT, "t", "body", { extract }, async () => true);
    expect(r).toEqual({ valid_from: null, valid_to: null });
  });
});

describe("parseValidTime", () => {
  it("bare JSON with both dates", () => {
    expect(parseValidTime('{"valid_from":"2024-03-01","valid_to":"2025-06-01"}')).toEqual({
      valid_from: new Date("2024-03-01").toISOString(),
      valid_to: new Date("2025-06-01").toISOString(),
    });
  });
  it("fenced JSON + trailing prose (Haiku habit) still parses", () => {
    const text = '```json\n{"valid_from":"2024-03-01","valid_to":null}\n```\nThe fact began in March 2024.';
    expect(parseValidTime(text)).toEqual({ valid_from: new Date("2024-03-01").toISOString(), valid_to: null });
  });
  it("both null → both null (the common, correct answer)", () => {
    expect(parseValidTime('{"valid_from":null,"valid_to":null}')).toEqual({ valid_from: null, valid_to: null });
  });
  it("garbage / unparseable date → null (never a guess)", () => {
    expect(parseValidTime('{"valid_from":"recently","valid_to":"sometime"}')).toEqual({
      valid_from: null,
      valid_to: null,
    });
  });
  it("no JSON at all → both null", () => {
    expect(parseValidTime("I could not find a date.")).toEqual({ valid_from: null, valid_to: null });
  });
});

describe("factHoldsAtValidTime — (d) as_of read filter", () => {
  const asOf = (s: string) => Date.parse(s);

  it("both bounds null → holds at any as_of (every existing note behaves as today)", () => {
    expect(factHoldsAtValidTime(null, null, asOf("2024-06-01"))).toBe(true);
  });

  it("fact valid AT the as_of date (inside [from, to)) → kept", () => {
    expect(factHoldsAtValidTime("2024-03-01", "2025-06-01", asOf("2024-04-01"))).toBe(true);
  });

  it("as_of BEFORE valid_from (fact not yet true) → dropped", () => {
    expect(factHoldsAtValidTime("2024-03-01", null, asOf("2024-01-01"))).toBe(false);
  });

  it("as_of AT/AFTER valid_to (exclusive upper bound; fact no longer true) → dropped", () => {
    expect(factHoldsAtValidTime("2024-03-01", "2025-06-01", asOf("2025-06-01"))).toBe(false);
    expect(factHoldsAtValidTime("2024-03-01", "2025-06-01", asOf("2025-09-01"))).toBe(false);
  });

  it("open-ended (valid_to null) fact after valid_from → still holds", () => {
    expect(factHoldsAtValidTime("2024-03-01", null, asOf("2030-01-01"))).toBe(true);
  });

  it("time-travel: same two facts, different as_of returns the one valid then", () => {
    const a = { from: null as string | null, to: "2025-06-01" };
    const b = { from: "2025-06-01", to: null as string | null };
    expect(factHoldsAtValidTime(a.from, a.to, asOf("2024-04-01"))).toBe(true);
    expect(factHoldsAtValidTime(b.from, b.to, asOf("2024-04-01"))).toBe(false);
    expect(factHoldsAtValidTime(a.from, a.to, asOf("2025-08-01"))).toBe(false);
    expect(factHoldsAtValidTime(b.from, b.to, asOf("2025-08-01"))).toBe(true);
  });
});

describe("closeValidInterval", () => {
  function makeSb() {
    const calls: Array<{ table: string; arg: Record<string, unknown>; eqs: Array<[string, unknown]>; isNull: string[] }> = [];
    const from = vi.fn((table: string) => {
      const rec: { table: string; arg: Record<string, unknown>; eqs: Array<[string, unknown]>; isNull: string[] } = {
        table,
        arg: {},
        eqs: [],
        isNull: [],
      };
      const b: Record<string, unknown> = {};
      b.update = vi.fn((arg: Record<string, unknown>) => {
        rec.arg = arg;
        calls.push(rec);
        return b;
      });
      b.eq = vi.fn((k: string, v: unknown) => {
        rec.eqs.push([k, v]);
        return b;
      });
      b.is = vi.fn((k: string, _v: null) => {
        rec.isNull.push(k);
        return b;
      });
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ error: null });
      return b;
    });
    return { sb: { from } as never, calls };
  }

  it("newValidFrom null → NO-OP (no update issued)", async () => {
    const { sb, calls } = makeSb();
    await closeValidInterval(sb, TENANT, "old-note", null);
    expect(calls.length).toBe(0);
  });

  it("newValidFrom set → UPDATE valid_to, tenant-scoped + id-scoped + guarded `valid_to is null`", async () => {
    const { sb, calls } = makeSb();
    await closeValidInterval(sb, TENANT, "old-note", "2025-06-01T00:00:00.000Z");
    expect(calls.length).toBe(1);
    expect(calls[0].table).toBe("memory_note");
    expect(calls[0].arg).toEqual({ valid_to: "2025-06-01T00:00:00.000Z" });
    expect(calls[0].eqs).toEqual(
      expect.arrayContaining([
        ["id", "old-note"],
        ["tenant_id", TENANT],
      ]),
    );
    expect(calls[0].isNull).toContain("valid_to");
  });
});

describe("(e) safety floor: default recall RPCs carry NO valid-time predicate", () => {
  const migrationsDir = join(__dirname, "../../../../../../supabase/migrations");

  it("the bitemporal migration adds columns+index ONLY — never references a hybrid recall RPC", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.includes("memory_bitemporal_valid_time"));
    expect(files.length).toBe(1);
    const sql = readFileSync(join(migrationsDir, files[0]), "utf8");
    expect(sql).toMatch(/add column if not exists valid_from/i);
    expect(sql).toMatch(/add column if not exists valid_to/i);
    expect(sql).toMatch(/memory_note_valid_time_idx/);
    const code = sql
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(code).not.toMatch(/memory_search_hybrid/);
    expect(code).not.toMatch(/memory_search_lex_or/);
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });

  it("no hybrid recall RPC migration mentions valid_from/valid_to (default recall is unchanged)", () => {
    const hybridFiles = readdirSync(migrationsDir).filter(
      (f) =>
        f.includes("hybrid") || f.includes("lex_or") || f.includes("memory_search"),
    );
    expect(hybridFiles.length).toBeGreaterThan(0);
    for (const f of hybridFiles) {
      const sql = readFileSync(join(migrationsDir, f), "utf8");
      expect(sql, `${f} must not gate recall on valid-time`).not.toMatch(/valid_from|valid_to/);
    }
  });
});
