
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDb, type Tables } from "./fake-db";

const h = vi.hoisted(() => ({ db: null as null | { client: unknown } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => h.db!.client }));
vi.mock("@/services/memory/embed", () => ({ EMBED_DIM: 1024, VoyageDimError: class extends Error {}, embedOne: () => Promise.reject(new Error("no network in tests")) }));

import { dataNoteCaveats, deactivateDataNote, listActiveDataNotes, recordDataNote } from "../data-notes";
import { findSimilarVerifiedQueries, saveVerifiedQuery, wordOverlap } from "../verified-queries";
import { recordDataNoteTool, saveVerifiedQueryTool, recordDataNoteInputSchema } from "@/services/tools/analytics/record_data_note";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let tables: Tables;
beforeEach(() => {
  tables = {
    tenant_data_notes: [],
    tenant_verified_queries: [],
    tenant_users: [
      { tenant_id: A, user_id: "owner-a", role: "owner" },
      { tenant_id: A, user_id: "member-a", role: "member" },
    ],
  };
  h.db = makeDb(tables);
});

function vec(topic: number): number[] {
  const v = new Array(1024).fill(0);
  v[topic] = 1;
  return v;
}
const embedByTopic = (text: string) => Promise.resolve(vec(/refund/i.test(text) ? 1 : /revenue/i.test(text) ? 2 : 3));
const deps = { embed: embedByTopic };

describe("data notes", () => {
  it("tenant B cannot read tenant A's notes", async () => {
    await recordDataNote(A, { metric_id: "net_revenue", note_text: "Revenue excludes test orders", created_by: null });
    expect(await listActiveDataNotes(A)).toHaveLength(1);
    expect(await listActiveDataNotes(B)).toEqual([]);
    expect(await listActiveDataNotes(B, "net_revenue")).toEqual([]);
    expect(tables.tenant_data_notes[0].tenant_id).toBe(A);
  });

  it("tenant B cannot deactivate tenant A's note", async () => {
    const note = await recordDataNote(A, { metric_id: null, note_text: "Test orders are not revenue", created_by: null });
    expect(await deactivateDataNote(B, note.id, null)).toBe(false);
    expect(await listActiveDataNotes(A)).toHaveLength(1);
    expect(await deactivateDataNote(A, note.id, null)).toBe(true);
    expect(await listActiveDataNotes(A)).toEqual([]);
    expect(await deactivateDataNote(A, note.id, null)).toBe(false);
  });

  it("a metric read gets its own notes plus tenant-wide ones, never another metric's, and never inactive ones", async () => {
    await recordDataNote(A, { metric_id: "net_revenue", note_text: "excludes test orders", created_by: null });
    await recordDataNote(A, { metric_id: null, note_text: "store opened 2026-03", created_by: null });
    await recordDataNote(A, { metric_id: "sessions", note_text: "bots filtered", created_by: null });
    const old = await recordDataNote(A, { metric_id: "net_revenue", note_text: "old wrong note", created_by: null });
    await deactivateDataNote(A, old.id, null);
    const texts = (await listActiveDataNotes(A, "net_revenue")).map((n) => n.note_text).sort();
    expect(texts).toEqual(["excludes test orders", "store opened 2026-03"]);
  });

  it("refuses an unknown metric id", async () => {
    await expect(recordDataNote(A, { metric_id: "made_up", note_text: "x y z", created_by: null })).rejects.toThrow();
    expect(await listActiveDataNotes(A, "made_up")).toEqual([]);
  });

  it("caveats are dated and say the figure does not apply the note", () => {
    const [c] = dataNoteCaveats([
      { id: "n", metric_id: "net_revenue", note_text: "excludes test orders", created_by: null, created_at: "2026-09-28T10:00:00Z" },
    ]);
    expect(c).toContain("2026-09-28");
    expect(c).toContain('"excludes test orders"');
    expect(c).toContain("does not apply the note");
  });
});

describe("verified queries", () => {
  it("rejects a write statement at save time", async () => {
    await expect(
      saveVerifiedQuery(A, { question: "delete the test orders", sql_reads: ["DELETE FROM orders"], created_by: null }, deps),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    await expect(
      saveVerifiedQuery(A, { question: "sneaky", sql_reads: ["WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x"], created_by: null }, deps),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(tables.tenant_verified_queries).toEqual([]);
  });

  it("similar-question retrieval returns only the same tenant's queries", async () => {
    await saveVerifiedQuery(A, { question: "refunds last month by product", sql_reads: ["SELECT 'a'"], created_by: null }, deps);
    await saveVerifiedQuery(B, { question: "refunds last month by product", sql_reads: ["SELECT 'b'"], created_by: null }, deps);
    const forA = await findSimilarVerifiedQueries(A, "how many refunds did we have", {}, deps);
    expect(forA.map((q) => q.sql_reads)).toEqual([["SELECT 'a'"]]);
    const forB = await findSimilarVerifiedQueries(B, "how many refunds did we have", {}, deps);
    expect(forB.map((q) => q.sql_reads)).toEqual([["SELECT 'b'"]]);
  });

  it("does not offer a dissimilar query", async () => {
    await saveVerifiedQuery(A, { question: "refunds by product", sql_reads: ["SELECT 1"], created_by: null }, deps);
    expect(await findSimilarVerifiedQueries(A, "revenue by week", {}, deps)).toEqual([]);
  });

  it("re-validates saved SQL before offering it: a stored write is never offered", async () => {
    tables.tenant_verified_queries.push({
      id: "bad",
      tenant_id: A,
      question: "refunds by product",
      sql_reads: ["DELETE FROM refunds"],
      question_embedding: vec(1),
      created_at: "2026-09-28T09:00:00Z",
      active: true,
    });
    await saveVerifiedQuery(A, { question: "refunds by product", sql_reads: ["SELECT 2"], created_by: null }, deps);
    const got = await findSimilarVerifiedQueries(A, "refunds by product", {}, deps);
    expect(got.map((q) => q.id)).not.toContain("bad");
    expect(got.map((q) => q.sql_reads)).toEqual([["SELECT 2"]]);
  });

  it("falls back to word overlap when the embed fails", async () => {
    const failing = { embed: () => Promise.reject(new Error("voyage down")) };
    const saved = await saveVerifiedQuery(A, { question: "refunds by product last month", sql_reads: ["SELECT 3"], created_by: null }, failing);
    expect(saved.embedded).toBe(false);
    const got = await findSimilarVerifiedQueries(A, "refunds by product", {}, failing);
    expect(got).toHaveLength(1);
    expect(wordOverlap("refunds by product", "weekly signups")).toBe(0);
  });
});

describe("founder-chat tools", () => {
  const chat = (tenant_id: string, extra: Partial<ToolContext> = {}): ToolContext => ({
    tenant_id,
    run_id: "run-1",
    run_trigger: "chat",
    actor: { actor_user_id: "owner-a", actor_source: "chat", resolved_tenant_member: true, provenance_label: "signed-in user" },
    log: () => undefined,
    ...extra,
  });

  it("record_data_note writes to the ctx tenant only", async () => {
    const out = (await recordDataNoteTool.execute(chat(A), { metric_id: "net_revenue", note_text: "Revenue excludes test orders" })) as {
      saved: boolean;
    };
    expect(out.saved).toBe(true);
    expect(tables.tenant_data_notes.map((r) => r.tenant_id)).toEqual([A]);
  });

  it("save_verified_query saves to the ctx tenant and rejects write SQL", async () => {
    const out = (await saveVerifiedQueryTool.execute(chat(A), { question: "refunds by product", sql_reads: ["SELECT 1"] })) as { saved: boolean };
    expect(out.saved).toBe(true);
    expect(tables.tenant_verified_queries.map((r) => r.tenant_id)).toEqual([A]);
    await expect(
      saveVerifiedQueryTool.execute(chat(A), { question: "clean up", sql_reads: ["UPDATE orders SET x = 1"] }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(tables.tenant_verified_queries).toHaveLength(1);
  });

  it("the input schema rejects a tenant_id argument", () => {
    expect(() => recordDataNoteInputSchema.parse({ note_text: "abc def", tenant_id: B })).toThrow();
  });

  it("refuses outside a human-authored chat turn", async () => {
    for (const ctx of [
      chat(A, { run_trigger: "cron" }),
      chat(A, { run_trigger: "email" }),
      chat(A, { untrusted_context: true }),
      chat(A, { captured_page_context: true }),
      chat(A, { actor: { actor_user_id: "member-a", actor_source: "chat", resolved_tenant_member: true, provenance_label: "signed-in user" } }),
      chat(B),
    ]) {
      await expect(recordDataNoteTool.execute(ctx, { note_text: "Revenue excludes test orders" })).rejects.toBeInstanceOf(ExpectedToolError);
      await expect(saveVerifiedQueryTool.execute(ctx, { question: "refunds", sql_reads: ["SELECT 1"] })).rejects.toBeInstanceOf(
        ExpectedToolError,
      );
    }
    expect(tables.tenant_data_notes).toEqual([]);
    expect(tables.tenant_verified_queries).toEqual([]);
  });
});
