import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tenants: [] as string[],
  filters: [] as Array<[string, unknown]>,
  rows: [] as Array<{ extraction: unknown; created_at: string }>,
  error: null as null | { message: string },
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (t: string) => {
    h.tenants.push(t);
    return {
      from: () => {
        const q: Record<string, any> = {
          select: () => q,
          eq: (c: string, v: unknown) => { h.filters.push([c, v]); return q; },
          or: (v: string) => { h.filters.push(["or", v]); return q; },
          order: async () => (h.error ? { data: null, error: h.error } : { data: h.rows, error: null }),
        };
        return q;
      },
    };
  },
}));
vi.mock("@/services/memory", () => ({ deleteNote: vi.fn() }));
vi.mock("@/services/personalization/documents", () => ({}));
vi.mock("../read", () => ({ readImportedFile: vi.fn() }));
vi.mock("../ask-conflict", () => ({ askNextConflict: vi.fn() }));
vi.mock("@/services/company/facts", () => ({ removeMachineFactsFromSource: vi.fn() }));

import { anyImportReadOpen, importReadIsOpen, IMPORT_READ_WAIT_MS } from "../run-read";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

beforeEach(() => {
  h.tenants = [];
  h.filters = [];
  h.rows = [];
  h.error = null;
});

describe("importReadIsOpen", () => {
  it("open: no result yet, reading, or being taken back", () => {
    expect(importReadIsOpen({ extraction: null, created_at: at(1000) }, NOW)).toBe(true);
    expect(importReadIsOpen({ extraction: { state: "reading" }, created_at: at(1000) }, NOW)).toBe(true);
    expect(importReadIsOpen({ extraction: { state: "compensating" }, created_at: at(1000) }, NOW)).toBe(true);
  });
  it("settled: read, stored image, unreadable", () => {
    for (const state of ["read", "stored", "unreadable"]) {
      expect(importReadIsOpen({ extraction: { state }, created_at: at(1000) }, NOW)).toBe(false);
    }
  });
  it("no result: open only while the file is under 10 minutes old", () => {
    expect(importReadIsOpen({ extraction: null, created_at: at(IMPORT_READ_WAIT_MS + 1) }, NOW)).toBe(false);
    expect(importReadIsOpen({ extraction: null, created_at: at(IMPORT_READ_WAIT_MS - 1000) }, NOW)).toBe(true);
  });
  it("a read in flight is aged by its claim, not the upload: an old upload whose read just started keeps the draft waiting", () => {
    const old = at(IMPORT_READ_WAIT_MS * 3);
    expect(importReadIsOpen({ extraction: { state: "reading", claimed_at: at(5000) }, created_at: old }, NOW)).toBe(true);
    expect(importReadIsOpen({ extraction: { state: "compensating", claimed_at: at(5000) }, created_at: old }, NOW)).toBe(true);
    expect(importReadIsOpen({ extraction: { state: "reading", claimed_at: at(IMPORT_READ_WAIT_MS + 1) }, created_at: old }, NOW)).toBe(false);
    expect(importReadIsOpen({ extraction: { state: "reading" }, created_at: at(IMPORT_READ_WAIT_MS + 1) }, NOW)).toBe(false);
  });
});

describe("anyImportReadOpen", () => {
  it("reads only this tenant's imported files in an open state, a small page", async () => {
    h.rows = [{ extraction: { state: "read" }, created_at: at(1000) }];
    expect(await anyImportReadOpen("t1", NOW)).toBe(false);
    expect(h.tenants).toEqual(["t1"]);
    expect(h.filters).toContainEqual(["status", "imported"]);
    expect(h.filters).toContainEqual(["or", "extraction.is.null,extraction->>state.in.(reading,compensating)"]);
    expect(h.filters.some(([k]) => k === "limit")).toBe(false);
  });
  it("an old upload whose read just started is open", async () => {
    h.rows = [{ extraction: { state: "reading", claimed_at: at(1000) }, created_at: at(IMPORT_READ_WAIT_MS * 5) }];
    expect(await anyImportReadOpen("t1", NOW)).toBe(true);
  });
  it("a query error throws (the route fails closed on it)", async () => {
    h.error = { message: "db down" };
    await expect(anyImportReadOpen("t1", NOW)).rejects.toThrow("db down");
  });
  it("true while any one file is open", async () => {
    h.rows = [{ extraction: { state: "read" }, created_at: at(1000) }, { extraction: { state: "reading" }, created_at: at(2000) }];
    expect(await anyImportReadOpen("t1", NOW)).toBe(true);
  });
});
