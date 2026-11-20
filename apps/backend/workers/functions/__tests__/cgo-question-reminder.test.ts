import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let rows: Row[] = [];

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private patch: Row | null = null;
  select() {
    return this;
  }
  update(p: Row) {
    this.patch = p;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  lte(c: string, v: string) {
    this.filters.push((r) => String(r[c]) <= v);
    return this;
  }
  then<T>(ok: (v: { data: unknown; error: unknown }) => T) {
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.patch) for (const r of hit) Object.assign(r, this.patch);
    return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(ok);
  }
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => new Query() }),
}));
vi.mock("../../client", () => ({ inngest: { createFunction: vi.fn(() => ({ id: "fn" })), send: vi.fn() } }));
vi.mock("../cgo-goal-owner", () => ({
  loadOpenQuestions: async () => rows.filter((r) => r.status === "open").map((r) => ({ id: r.id, ask: r.ask, ordinal: r.ordinal })),
  sendQuestionReminder: vi.fn(),
}));

import { remindTenantQuestions } from "../cgo-daily-check";

const NOW = new Date("2026-09-30T14:00:00Z");

beforeEach(() => {
  rows = [
    { id: "old", tenant_id: "t1", status: "open", ask: "Should I plan for 24?", ordinal: 1, asked_at: "2026-09-28T08:00:00Z", reminded_at: null },
    { id: "new", tenant_id: "t1", status: "open", ask: "Should I pause Reddit?", ordinal: 2, asked_at: "2026-09-30T08:00:00Z", reminded_at: null },
    { id: "done", tenant_id: "t1", status: "answered", ask: "x", ordinal: 3, asked_at: "2026-09-27T08:00:00Z", reminded_at: null },
  ];
});

describe("remindTenantQuestions", () => {
  it("reminds once after 24h, never twice, and changes nothing but reminded_at", async () => {
    const send = vi.fn(async () => {});
    const before = rows.map((r) => ({ ...r }));
    expect(await remindTenantQuestions("t1", NOW, send)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown[])[1]).toEqual([expect.objectContaining({ id: "old" })]);
    expect(await remindTenantQuestions("t1", new Date(NOW.getTime() + 86_400_000), send)).toBe(1);
    expect((send.mock.calls[1] as unknown[])[1]).toEqual([expect.objectContaining({ id: "new" })]);
    expect(await remindTenantQuestions("t1", new Date(NOW.getTime() + 2 * 86_400_000), send)).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    rows.forEach((r, i) => {
      const { reminded_at: _a, ...rest } = r;
      const { reminded_at: _b, ...was } = before[i];
      expect(rest).toEqual(was);
    });
    expect(rows.find((r) => r.id === "done")!.reminded_at).toBeNull();
  });
});
