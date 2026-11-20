
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.GBRAIN_EVAL_CAPTURE_TRACK = "1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockTable = Record<string, any> & {
  _resolve: { data: unknown; error: unknown };
  _insertCalls: Array<Record<string, unknown>>;
};

function newMockTable(): MockTable {
  const t = {} as MockTable;
  t._resolve = { data: null, error: null };
  t._insertCalls = [];
  t.select = vi.fn(() => t);
  t.eq = vi.fn(() => t);
  t.insert = vi.fn((row: Record<string, unknown>) => {
    t._insertCalls.push(row);
    return Promise.resolve(t._resolve);
  });
  t.maybeSingle = vi.fn(() => Promise.resolve(t._resolve));
  t.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
    resolve(t._resolve);
  return t;
}

const tables: Record<string, MockTable> = {};

function table(name: string): MockTable {
  if (!tables[name]) tables[name] = newMockTable();
  return tables[name];
}

vi.mock("@/services/supabase", () => {
  return {
    serviceClient: vi.fn(() => ({
      from: vi.fn((name: string) => table(name)),
    })),
  };
});

vi.mock("../embed", () => ({
  embedOne: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
  embedTexts: vi.fn(() => Promise.resolve([[0.1, 0.2, 0.3]])),
  EMBED_DIM: 3,
}));

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const RUN_A1 = "aaaaaaa1-1111-1111-1111-111111111111";
const RUN_B1 = "bbbbbbbb-2222-2222-2222-222222222222";

beforeEach(async () => {
  vi.resetModules();
  for (const k of Object.keys(tables)) delete tables[k];
});

afterEach(async () => {
  const { _drainPendingCaptures } = await import("../eval-capture");
  await _drainPendingCaptures();
});

function primeFlagEnabled(
  tenant_id: string,
  tenantFlag: boolean | null,
  globalFlag: boolean | null,
): void {
  const t = table("tenants");
  t._resolve = {
    data:
      tenantFlag === null
        ? { brain_eval_capture: null }
        : { brain_eval_capture: tenantFlag },
    error: null,
  };

  const g = table("system_config");
  g._resolve = {
    data:
      globalFlag === null
        ? { blob: {} }
        : { blob: { brain_eval_capture_default: globalFlag } },
    error: null,
  };
}

function primeAgentRun(run_id: string, tenant_id: string): void {
  const r = table("agent_runs");
  r._resolve = { data: { tenant_id }, error: null };
}

function primeSearchHits(hits: Array<Record<string, unknown>>): void {
  vi.mock("@/services/supabase", () => {
    return {
      serviceClient: vi.fn(() => ({
        from: vi.fn((name: string) => table(name)),
        rpc: vi.fn(() => Promise.resolve({ data: hits, error: null })),
      })),
    };
  });
}

describe("eval-capture — flag resolution (F4)", () => {
  it("captures when per-tenant flag is true (global off)", async () => {
    primeFlagEnabled(TENANT_A, true, false);
    primeAgentRun(RUN_A1, TENANT_A);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hello",
      hits: [],
      k: 8,
      latency_ms: 12,
      run_id: RUN_A1,
      agent_slug: "support-lead",
    });
    expect(table("eval_candidates")._insertCalls.length).toBe(1);
  });

  it("does NOT capture when per-tenant=false (overrides global=true) — F4 explicit override", async () => {
    primeFlagEnabled(TENANT_A, false, true);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hello",
      hits: [],
      k: 8,
      latency_ms: 12,
      run_id: null,
      agent_slug: null,
    });
    expect(table("eval_candidates")._insertCalls.length).toBe(0);
  });

  it("captures when tenant=null, global=true (fallback)", async () => {
    primeFlagEnabled(TENANT_A, null, true);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hello",
      hits: [],
      k: 8,
      latency_ms: 12,
      run_id: null,
      agent_slug: null,
    });
    expect(table("eval_candidates")._insertCalls.length).toBe(1);
  });

  it("does NOT capture when both null (final fallback = false)", async () => {
    primeFlagEnabled(TENANT_A, null, null);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hello",
      hits: [],
      k: 8,
      latency_ms: 12,
      run_id: null,
      agent_slug: null,
    });
    expect(table("eval_candidates")._insertCalls.length).toBe(0);
  });
});

describe("eval-capture — trust boundary (Codex P2-6)", () => {
  it("drops run_id to null when it belongs to a DIFFERENT tenant", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    primeAgentRun(RUN_B1, TENANT_B);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hello",
      hits: [],
      k: 8,
      latency_ms: 12,
      run_id: RUN_B1,
      agent_slug: "support-lead",
    });
    const inserts = table("eval_candidates")._insertCalls;
    expect(inserts.length).toBe(1);
    expect(inserts[0].tenant_id).toBe(TENANT_A);
    expect(inserts[0].run_id).toBeNull();
  });

  it("preserves run_id when same-tenant", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    primeAgentRun(RUN_A1, TENANT_A);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hello",
      hits: [],
      k: 8,
      latency_ms: 12,
      run_id: RUN_A1,
      agent_slug: "support-lead",
    });
    const inserts = table("eval_candidates")._insertCalls;
    expect(inserts.length).toBe(1);
    expect(inserts[0].run_id).toBe(RUN_A1);
  });
});

describe("eval-capture — best-effort (insert error)", () => {
  it("does NOT throw when eval_candidates insert errors", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    primeAgentRun(RUN_A1, TENANT_A);
    const t = table("eval_candidates");
    t._resolve = { data: null, error: { message: "RLS policy denied" } };
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await expect(
      recordEvalCapture({
        tenant_id: TENANT_A,
        query: "hello",
        hits: [],
        k: 8,
        latency_ms: 12,
        run_id: RUN_A1,
        agent_slug: "support-lead",
      }),
    ).resolves.not.toThrow();
    expect(table("eval_capture_failures")._insertCalls.length).toBe(1);
    expect(table("eval_capture_failures")._insertCalls[0].reason).toBe("rls_reject");
  });
});

describe("eval-capture — cache (P2-5)", () => {
  it("_resetCaptureFlagCache forces re-lookup", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    primeAgentRun(RUN_A1, TENANT_A);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "first",
      hits: [],
      k: 8,
      latency_ms: 1,
      run_id: null,
      agent_slug: null,
    });
    expect(table("eval_candidates")._insertCalls.length).toBe(1);

    primeFlagEnabled(TENANT_A, false, null);
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "second",
      hits: [],
      k: 8,
      latency_ms: 1,
      run_id: null,
      agent_slug: null,
    });
    expect(table("eval_candidates")._insertCalls.length).toBe(2);

    _resetCaptureFlagCache(TENANT_A);
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "third",
      hits: [],
      k: 8,
      latency_ms: 1,
      run_id: null,
      agent_slug: null,
    });
    expect(table("eval_candidates")._insertCalls.length).toBe(2);
  });
});

describe("eval-capture — defensive clamps (P3-13/P3-14)", () => {
  it("clamps latency_ms to schema CHECK range", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hi",
      hits: [],
      k: 8,
      latency_ms: 9_999_999,
      run_id: null,
      agent_slug: null,
    });
    const inserts = table("eval_candidates")._insertCalls;
    expect(inserts.length).toBe(1);
    expect(inserts[0].latency_ms).toBeLessThan(600_000);
    expect(inserts[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("clamps k to 1..50", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hi",
      hits: [],
      k: 1000,
      latency_ms: 1,
      run_id: null,
      agent_slug: null,
    });
    const inserts = table("eval_candidates")._insertCalls;
    expect(inserts[0].k).toBeLessThanOrEqual(50);
  });

  it("truncates agent_slug over 200 chars defensively", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "hi",
      hits: [],
      k: 8,
      latency_ms: 1,
      run_id: null,
      agent_slug: "a".repeat(500),
    });
    const inserts = table("eval_candidates")._insertCalls;
    expect((inserts[0].agent_slug as string).length).toBeLessThanOrEqual(200);
  });
});

describe("eval-capture — PII scrubbing integration", () => {
  it("scrubbed query lands in the insert payload", async () => {
    primeFlagEnabled(TENANT_A, true, null);
    const { recordEvalCapture, _resetCaptureFlagCache } = await import(
      "../eval-capture"
    );
    _resetCaptureFlagCache();
    await recordEvalCapture({
      tenant_id: TENANT_A,
      query: "find alice@acme.com complaints",
      hits: [],
      k: 8,
      latency_ms: 1,
      run_id: null,
      agent_slug: null,
    });
    const inserts = table("eval_candidates")._insertCalls;
    expect(inserts[0].query).toBe("find [EMAIL] complaints");
  });
});
