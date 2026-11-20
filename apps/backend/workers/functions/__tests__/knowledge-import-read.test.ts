import { describe, it, expect, vi, beforeEach } from "vitest";

const DOC = "11111111-1111-1111-1111-111111111111";
const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  loadedIds: [] as string[],
  enabledFor: [] as string[],
  enabled: true,
  runs: [] as Array<{ tenant_id: string; user_id: string; doc: { id: string } }>,
  outcome: { kind: "stored", stored: { state: "read" } } as { kind: string; stored?: unknown; message?: string },
  handler: null as null | ((ctx: unknown) => Promise<unknown>),
  onFailure: null as null | ((ctx: unknown) => Promise<unknown>),
  claims: [] as Array<[string, string]>,
  claimResult: "claim-X" as string | null,
  stores: [] as Array<[string, string, string, Record<string, unknown>]>,
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (cfg: { onFailure?: (ctx: unknown) => Promise<unknown> }, _trigger: unknown, handler: (ctx: unknown) => Promise<unknown>) => {
      h.handler = handler;
      h.onFailure = cfg.onFailure ?? null;
      return { handler };
    },
  },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      let id = "";
      const q: Record<string, any> = {
        select: () => q,
        eq: (_c: string, v: string) => { id = v; return q; },
        maybeSingle: async () => {
          h.loadedIds.push(id);
          return { data: h.row && h.row.id === id ? h.row : null, error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: vi.fn(async (_k: string, tenant_id: string) => { h.enabledFor.push(tenant_id); return h.enabled; }),
}));
vi.mock("@/services/personalization/documents", () => ({
  claimDocumentRead: vi.fn(async (tenant_id: string, id: string) => { h.claims.push([tenant_id, id]); return h.claimResult; }),
  setDocumentExtraction: vi.fn(async (tenant_id: string, id: string, claimId: string, ex: Record<string, unknown>) => {
    h.stores.push([tenant_id, id, claimId, ex]);
    return true;
  }),
}));
vi.mock("@/services/knowledge-import/run-read", () => ({
  runImportRead: vi.fn(async (input: { tenant_id: string; user_id: string; doc: { id: string } }) => {
    h.runs.push(input);
    return h.outcome;
  }),
}));

import { processImportRead, knowledgeImportReadFn } from "../knowledge-import-read";
import { runImportRead } from "@/services/knowledge-import/run-read";

function rowOf(over: Record<string, unknown> = {}) {
  return {
    id: DOC,
    tenant_id: TENANT_A,
    uploaded_by: "user-a",
    status: "imported",
    filename: "zavi-context.md",
    storage_path: `${TENANT_A}/${DOC}/zavi-context.md`,
    extraction: null,
    ...over,
  };
}

const step = { run: (_n: string, f: () => unknown) => f() };

beforeEach(() => {
  h.row = rowOf();
  h.loadedIds = [];
  h.enabledFor = [];
  h.enabled = true;
  h.runs = [];
  h.outcome = { kind: "stored", stored: { state: "read" } };
  h.claims = [];
  h.claimResult = "claim-X";
  h.stores = [];
});

describe("knowledge-import-read worker", () => {
  it("is registered (the handler is captured)", () => {
    expect(knowledgeImportReadFn).toBeTruthy();
    expect(h.handler).toBeTypeOf("function");
  });

  it("takes tenant_id and uploaded_by from the ROW and ignores a forged event tenant_id", async () => {
    const out = await h.handler!({ event: { data: { doc_id: DOC, tenant_id: TENANT_B } }, step });
    expect(out).toEqual({ outcome: "stored" });
    expect(h.loadedIds).toEqual([DOC]);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].tenant_id).toBe(TENANT_A);
    expect(h.runs[0].user_id).toBe("user-a");
    expect(h.runs[0].doc.id).toBe(DOC);
    expect(h.enabledFor).toEqual([TENANT_A]);
    expect(JSON.stringify(h.runs)).not.toContain(TENANT_B);
  });

  it("a doc id of tenant A is processed as tenant A even when the event says B (no event tenant at all works the same)", async () => {
    await h.handler!({ event: { data: { doc_id: DOC } }, step });
    await h.handler!({ event: { data: { doc_id: DOC, tenant_id: TENANT_B } }, step });
    expect(h.runs.map((r) => r.tenant_id)).toEqual([TENANT_A, TENANT_A]);
  });

  it("an unknown doc id reads nothing", async () => {
    const out = await h.handler!({ event: { data: { doc_id: "22222222-2222-2222-2222-222222222222", tenant_id: TENANT_A } }, step });
    expect(out).toEqual({ skipped: "not_found" });
    expect(h.runs).toHaveLength(0);
  });

  it("a malformed doc id is refused before any load", async () => {
    const out = await h.handler!({ event: { data: { doc_id: "x' or 1=1", tenant_id: TENANT_A } }, step });
    expect(out).toEqual({ skipped: "bad_id" });
    expect(h.loadedIds).toHaveLength(0);
  });
});

describe("processImportRead skips", () => {
  const deps = () => ({
    loadDoc: async () => h.row as never,
    enabled: async () => h.enabled,
    run: runImportRead,
  });

  it("a file that is not an import (approved/archived)", async () => {
    h.row = rowOf({ status: "approved" });
    expect(await processImportRead(DOC, deps())).toEqual({ skipped: "not_imported" });
    expect(h.runs).toHaveLength(0);
  });

  it.each([
    [{ state: "read", facts: 4 }],
    [{ state: "stored", reason: "image" }],
    [{ state: "unreadable", reason: "no text in it" }],
  ])("a settled extraction %j", async (extraction) => {
    h.row = rowOf({ extraction });
    expect(await processImportRead(DOC, deps())).toEqual({ skipped: "settled" });
    expect(h.runs).toHaveLength(0);
  });

  it("an in-flight claim is not settled: it goes to the shared path, which reports busy (the function waits and re-checks)", async () => {
    h.row = rowOf({ extraction: { state: "reading", claim_id: "c", claimed_at: new Date().toISOString() } });
    h.outcome = { kind: "busy", current: { state: "reading" } } as never;
    expect(await processImportRead(DOC, deps())).toEqual({ outcome: "busy" });
  });

  it("the kill switch off", async () => {
    h.enabled = false;
    expect(await processImportRead(DOC, deps())).toEqual({ skipped: "setup_off" });
    expect(h.runs).toHaveLength(0);
  });

  it("a row with no uploader", async () => {
    h.row = rowOf({ uploaded_by: null });
    expect(await processImportRead(DOC, deps())).toEqual({ skipped: "no_uploader" });
    expect(h.runs).toHaveLength(0);
  });

  it("a failed read throws so Inngest retries it", async () => {
    h.outcome = { kind: "failed", message: "download failed" };
    await expect(processImportRead(DOC, deps())).rejects.toThrow(/download failed/);
  });
});

describe("retries exhausted (onFailure)", () => {
  const fail = (data: Record<string, unknown>) =>
    h.onFailure!({ event: { data: { event: { name: "knowledge/import.read", data } } }, error: new Error("boom") });

  it("stores the file as unreadable under a fresh claim, tenant from the ROW (a forged event tenant is ignored)", async () => {
    await fail({ doc_id: DOC, tenant_id: TENANT_B });
    expect(h.loadedIds).toEqual([DOC]);
    expect(h.claims).toEqual([[TENANT_A, DOC]]);
    expect(h.stores).toHaveLength(1);
    const [tenant, id, claim, ex] = h.stores[0];
    expect([tenant, id, claim]).toEqual([TENANT_A, DOC, "claim-X"]);
    expect(ex).toMatchObject({ state: "unreadable", reason: "I couldn't read it right now, try again later", claim_id: "claim-X" });
    expect(JSON.stringify(h.claims)).not.toContain(TENANT_B);
  });

  it("a settled read is left alone", async () => {
    h.row = rowOf({ extraction: { state: "read", facts: 3 } });
    await fail({ doc_id: DOC });
    expect(h.claims).toHaveLength(0);
    expect(h.stores).toHaveLength(0);
  });

  it("a read held by a live claim elsewhere is left to it", async () => {
    h.claimResult = null;
    await fail({ doc_id: DOC });
    expect(h.claims).toHaveLength(1);
    expect(h.stores).toHaveLength(0);
  });

  it("an unknown doc or a non-import is left alone", async () => {
    await fail({ doc_id: "22222222-2222-2222-2222-222222222222" });
    h.row = rowOf({ status: "approved" });
    await fail({ doc_id: DOC });
    expect(h.claims).toHaveLength(0);
  });
});
