import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    existing: Record<string, unknown> | null;
    inserted: { id: string } | null;
    insertErr: { message: string } | null;
    card: Record<string, unknown> | null;
    writeFails: boolean;
  } = { existing: null, inserted: { id: "card-1" }, insertErr: null, card: null, writeFails: false };

  const from = vi.fn((_table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = vi.fn(self);
    chain.eq = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.maybeSingle = vi.fn(async () => ({
      data: state.card !== null ? state.card : state.existing,
      error: null,
    }));
    chain.insert = vi.fn(() => ({
      select: vi.fn(() => ({ single: vi.fn(async () => ({ data: state.inserted, error: state.insertErr })) })),
    }));
    chain.update = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })) }));
    return chain;
  });
  const serviceClient = vi.fn(() => ({ from }));
  const writeNote = vi.fn(async () => {
    if (state.writeFails) throw new Error("brain write boom");
    return { note_id: "note-1", chunks: 1, entities: 0 };
  });
  const contentHash = vi.fn(() => "hash-x");
  return { state, from, serviceClient, writeNote, contentHash };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/memory", () => ({ writeNote: m.writeNote }));
vi.mock("@/services/memory/content-hash", () => ({ contentHash: m.contentHash }));

import { createCard, approveCard, ignoreCard } from "../../services/memory-cards/store";

beforeEach(() => {
  m.state.existing = null;
  m.state.inserted = { id: "card-1" };
  m.state.insertErr = null;
  m.state.card = null;
  m.state.writeFails = false;
  m.writeNote.mockClear();
});

describe("createCard", () => {
  it("inserts a new pending card", async () => {
    const r = await createCard({ tenant_id: "t1", source_kind: "slack", title: "a durable fact here" });
    expect(r).toMatchObject({ ok: true, card_id: "card-1", deduped: false });
  });
  it("dedupes onto an existing pending card with the same content hash", async () => {
    m.state.existing = { id: "card-dup" };
    const r = await createCard({ tenant_id: "t1", source_kind: "slack", title: "same fact" });
    expect(r).toMatchObject({ ok: true, card_id: "card-dup", deduped: true });
  });
});

describe("approveCard", () => {
  it("writes the fact to the brain and marks approved", async () => {
    m.state.card = { id: "card-1", tenant_id: "t1", status: "pending_review", source_kind: "slack", title: "T", body: "B", source_excerpt: "E" };
    const r = await approveCard({ tenant_id: "t1", card_id: "card-1", actor_user_id: "u1" });
    expect(r).toMatchObject({ ok: true, status: "approved", changed: true, memory_note_id: "note-1" });
    expect(m.writeNote).toHaveBeenCalledTimes(1);
    const call = m.writeNote.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1].source).toBe("memory_card_distill");
  });
  it("is idempotent on an already-approved card (no second write)", async () => {
    m.state.card = { id: "card-1", tenant_id: "t1", status: "approved" };
    const r = await approveCard({ tenant_id: "t1", card_id: "card-1", actor_user_id: "u1" });
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(m.writeNote).not.toHaveBeenCalled();
  });
  it("404s a missing / cross-tenant card", async () => {
    m.state.card = null;
    const r = await approveCard({ tenant_id: "t1", card_id: "nope", actor_user_id: "u1" });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });
  it("surfaces a brain-write failure without marking approved", async () => {
    m.state.card = { id: "card-1", tenant_id: "t1", status: "pending_review", title: "T", body: "", source_excerpt: "" };
    m.state.writeFails = true;
    const r = await approveCard({ tenant_id: "t1", card_id: "card-1", actor_user_id: "u1" });
    expect(r).toMatchObject({ ok: false, code: "write_failed" });
  });
});

describe("ignoreCard", () => {
  it("marks a pending card ignored", async () => {
    m.state.card = { id: "card-1", status: "pending_review" };
    const r = await ignoreCard({ tenant_id: "t1", card_id: "card-1", actor_user_id: "u1" });
    expect(r).toMatchObject({ ok: true, status: "ignored", changed: true });
  });
});
