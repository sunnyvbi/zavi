
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rpcMock = vi.fn(async () => ({ data: "note-1", error: null }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: (...a: unknown[]) => rpcMock(...(a as [])),
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "delete", "insert", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: null, error: null });
      return q;
    },
  }),
}));

import { upsertAnchor, upsertAnchorGuarded, COMPANY_PROJECTION_ERROR } from "../upsert-anchor";

const base = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  title: "company.md",
  body_markdown: "# Acme\n\nWe sell things.",
  source: "human" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ data: "note-1", error: null });
});

describe("the company anchor refuses every writer but the renderer", () => {
  it("throws on a direct write, and writes nothing", async () => {
    await expect(upsertAnchor({ ...base, slug: "company" })).rejects.toThrow(
      /projection of the company record/i,
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("the refusal tells the caller where to write instead", () => {
    expect(COMPANY_PROJECTION_ERROR).toMatch(/company_story/);
    expect(COMPANY_PROJECTION_ERROR).toMatch(/regenerateCompanyBrief/);
  });

  it("closes the guarded-variant back door too", async () => {
    await expect(
      upsertAnchorGuarded({ ...base, slug: "company" }, ["agent_write", "human"]),
    ).rejects.toThrow(/projection of the company record/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("lets the renderer through with its key", async () => {
    await expect(
      upsertAnchor({ ...base, slug: "company" }, { derivedFromCompanyRecord: true }),
    ).resolves.toBeTruthy();
    expect(rpcMock).toHaveBeenCalled();
  });

  it("does not touch the other anchors", async () => {
    for (const slug of ["ops", "policies", "disputes", "support"] as const) {
      rpcMock.mockClear();
      await expect(upsertAnchor({ ...base, slug })).resolves.toBeTruthy();
      expect(rpcMock).toHaveBeenCalled();
    }
  });
});

describe("the table-level projection trigger", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../../../../../supabase/migrations/20260913160000_company_anchor_projection_trigger.sql",
    ),
    "utf8",
  );

  it("fires before every insert and update, per row", () => {
    expect(sql).toMatch(/before insert or update on memory_note/i);
    expect(sql).toMatch(/for each row/i);
  });

  it("drops the row rather than raising, and says so", () => {
    expect(sql).toMatch(/return null/i);
    expect(sql).toMatch(/raise warning/i);
    expect(sql).not.toMatch(/raise exception/i);
  });

  it("pins search_path including pg_temp", () => {
    expect(sql).toMatch(/set search_path = public, pg_temp/i);
  });

  it("requires both the renderer's source and its derived_from marker", () => {
    expect(sql).toMatch(/agent_write/);
    expect(sql).toMatch(/derived_from/);
  });

  it("on UPDATE also requires a fresh rendered_at, which cannot be inherited", () => {
    expect(sql).toMatch(/rendered_at/);
    expect(sql).toMatch(/tg_op = 'INSERT'/);
    expect(sql).toMatch(/is distinct from old\.metadata/);
  });

  it("permits a retire that leaves the body byte-identical", () => {
    expect(sql).toMatch(/old\.superseded_by is null/);
    expect(sql).toMatch(/new\.body_markdown is not distinct from old\.body_markdown/);
  });
});
