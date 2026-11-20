
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const TENANT = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

let ledgerEntries: unknown[] = [];
vi.mock("@/services/agents/engine/capture-ledger", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getCaptureLedger: vi.fn(() => ledgerEntries),
  };
});

let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: 0,
  error: null,
};
let rpcThrows = false;
const rpcMock = vi.fn(async () => {
  if (rpcThrows) throw new Error("rpc boom");
  return rpcResult;
});

let selectResults: Array<{ data: unknown; error: { message: string } | null }> = [];
function nextSelectResult() {
  return selectResults.length > 0
    ? selectResults.shift()!
    : { data: [], error: null };
}

function makeBuilder() {
  const result = nextSelectResult();
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "lt", "order"]) {
    builder[m] = vi.fn(() => builder);
  }
  builder.limit = vi.fn(async () => result);
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return builder;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: vi.fn(() => makeBuilder()),
    rpc: (...args: unknown[]) => rpcMock(...(args as [])),
  }),
}));

import {
  deriveTopicKey,
  extractAskText,
  buildEvidenceRows,
  persistResearchEvidence,
  loadPriorEvidenceContext,
  loadResearchWatchBaseline,
  EXCERPT_MAX_BYTES,
  MAX_EVIDENCE_ROWS_PER_RUN,
} from "../persist-evidence";
import type { DispatcherResult } from "@/services/agents/types";

function entry(over: Record<string, unknown> = {}) {
  return {
    requested_url: "https://Example.com/Pricing/",
    final_url: "https://example.com/pricing",
    capture: "dom_text",
    status: 200,
    truncated: false,
    text_snippet: "Pro plan is $99/mo as of 2026.",
    ...over,
  };
}

const okResult = { parse_ok: true } as unknown as DispatcherResult;

beforeEach(() => {
  ledgerEntries = [];
  rpcResult = { data: 0, error: null };
  rpcThrows = false;
  selectResults = [];
  rpcMock.mockClear();
});

describe("deriveTopicKey", () => {
  it("is deterministic + order-independent (sorted tokens)", () => {
    const a = deriveTopicKey("Turo pricing teardown");
    const b = deriveTopicKey("teardown of Turo PRICING");
    expect(a).toBe(b);
    expect(a).toBe("pricing-turo");
  });
  it("strips stopwords + short tokens", () => {
    expect(deriveTopicKey("what is the competitor analysis of Getaround")).toBe(
      "getaround",
    );
  });
  it("returns null for empty / all-stopword asks", () => {
    expect(deriveTopicKey("")).toBeNull();
    expect(deriveTopicKey("what is the market")).toBeNull();
    expect(deriveTopicKey(null)).toBeNull();
  });
});

describe("extractAskText", () => {
  it("reads carrier keys in priority order", () => {
    expect(extractAskText({ current_message: "hi", question: "q" })).toBe("hi");
    expect(extractAskText({ task_description: "td" })).toBe("td");
    expect(extractAskText("raw")).toBe("raw");
    expect(extractAskText({})).toBe("");
  });

  it("P0-2: pulls the scheduled ask from a monitor-watch cron payload (standing_order.prompt)", () => {
    const watchPayload = {
      standing_order: {
        prompt: "Watch Turo pricing changes",
        deliver: { kind: "chat_thread", thread_id: "t" },
      },
    };
    const ask = extractAskText(watchPayload);
    expect(ask).toBe("Watch Turo pricing changes");
    expect(deriveTopicKey(ask)).toBe(deriveTopicKey("Turo pricing changes watch"));
    expect(deriveTopicKey(ask)).toContain("turo");
    expect(deriveTopicKey(ask)).toContain("pricing");
  });

  it("flat carriers still win over standing_order (a real chat turn isn't a watch)", () => {
    expect(
      extractAskText({
        current_message: "live ask",
        standing_order: { prompt: "scheduled ask", deliver: {} },
      }),
    ).toBe("live ask");
  });
});

describe("buildEvidenceRows", () => {
  it("hashes the excerpt + records bytes for a successful capture", () => {
    const rows = buildEvidenceRows([entry()] as never);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.normalized_url).toBe("example.com/pricing");
    expect(r.capture_status).toBe("dom_text");
    expect(r.http_status).toBe(200);
    expect(r.excerpt).toBe("Pro plan is $99/mo as of 2026.");
    expect(r.content_hash).toBe(
      createHash("sha256").update(r.excerpt as string, "utf8").digest("hex"),
    );
    expect(r.excerpt_bytes).toBe(Buffer.byteLength(r.excerpt as string, "utf8"));
  });

  it("dedupes by normalized_url (last write wins)", () => {
    const rows = buildEvidenceRows([
      entry({ capture: "blocked", text_snippet: undefined }),
      entry({ text_snippet: "fresh render" }),
    ] as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].capture_status).toBe("dom_text");
    expect(rows[0].excerpt).toBe("fresh render");
  });

  it("carries NO excerpt/hash for blocked + empty_shell captures", () => {
    const rows = buildEvidenceRows([
      entry({ requested_url: "https://a.com", final_url: "https://a.com", capture: "blocked", text_snippet: undefined }),
      entry({ requested_url: "https://b.com", final_url: "https://b.com", capture: "empty_shell", text_snippet: undefined }),
    ] as never);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.excerpt).toBeNull();
      expect(r.content_hash).toBeNull();
      expect(r.excerpt_bytes).toBeNull();
    }
  });

  it("caps excerpt at EXCERPT_MAX_BYTES", () => {
    const big = "x".repeat(EXCERPT_MAX_BYTES + 5000);
    const rows = buildEvidenceRows([entry({ text_snippet: big })] as never);
    expect(Buffer.byteLength(rows[0].excerpt as string, "utf8")).toBeLessThanOrEqual(
      EXCERPT_MAX_BYTES,
    );
  });

  it("caps the row count at MAX_EVIDENCE_ROWS_PER_RUN", () => {
    const many = Array.from({ length: MAX_EVIDENCE_ROWS_PER_RUN + 20 }, (_, i) =>
      entry({ requested_url: `https://s${i}.com`, final_url: `https://s${i}.com` }),
    );
    expect(buildEvidenceRows(many as never)).toHaveLength(MAX_EVIDENCE_ROWS_PER_RUN);
  });
});

describe("persistResearchEvidence", () => {
  it("skips a non-successful run (no RPC)", async () => {
    ledgerEntries = [entry()];
    const out = await persistResearchEvidence({
      tenant_id: TENANT,
      run_id: RUN_ID,
      payload: { current_message: "Turo pricing" },
      result: { parse_ok: false } as unknown as DispatcherResult,
    });
    expect(out.persisted).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("skips when the ledger captured nothing", async () => {
    ledgerEntries = [];
    const out = await persistResearchEvidence({
      tenant_id: TENANT,
      run_id: RUN_ID,
      payload: {},
      result: okResult,
    });
    expect(out.persisted).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("calls the RPC with tenant + run + topic_key + rows, returns the count", async () => {
    ledgerEntries = [entry()];
    rpcResult = { data: 1, error: null };
    const out = await persistResearchEvidence({
      tenant_id: TENANT,
      run_id: RUN_ID,
      payload: { current_message: "Turo pricing teardown" },
      result: okResult,
    });
    expect(out.persisted).toBe(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [, args] = rpcMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_run_id).toBe(RUN_ID);
    expect(args.p_topic_key).toBe("pricing-turo");
    expect(Array.isArray(args.p_rows)).toBe(true);
    expect((args.p_rows as unknown[]).length).toBe(1);
  });

  it("is failure-tolerant — RPC error returns 0, does not throw", async () => {
    ledgerEntries = [entry()];
    rpcResult = { data: null, error: { message: "permission denied" } };
    const out = await persistResearchEvidence({
      tenant_id: TENANT,
      run_id: RUN_ID,
      payload: {},
      result: okResult,
    });
    expect(out.persisted).toBe(0);
  });

  it("is failure-tolerant — a thrown RPC returns 0, does not throw", async () => {
    ledgerEntries = [entry()];
    rpcThrows = true;
    await expect(
      persistResearchEvidence({
        tenant_id: TENANT,
        run_id: RUN_ID,
        payload: {},
        result: okResult,
      }),
    ).resolves.toEqual({ persisted: 0 });
  });
});

describe("loadPriorEvidenceContext", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    url: "https://example.com/pricing",
    normalized_url: "example.com/pricing",
    capture_status: "dom_text",
    accessed_at: "2026-05-10T12:00:00Z",
    as_of_date: null,
    ...over,
  });

  it("renders topic-matched rows with the last-fetched date", async () => {
    selectResults = [
      {
        data: [
          row({ url: "https://example.com/pricing", normalized_url: "example.com/pricing" }),
          row({ url: "https://example.com/plans", normalized_url: "example.com/plans" }),
          row({ url: "https://example.com/about", normalized_url: "example.com/about" }),
        ],
        error: null,
      },
    ];
    const out = await loadPriorEvidenceContext(TENANT, "pricing-turo");
    expect(out).toContain("https://example.com/pricing — last fetched 2026-05-10 (dom_text)");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("falls back to recency when the topic has too few hits", async () => {
    selectResults = [
      { data: [], error: null },
      { data: [row({ url: "https://x.com", normalized_url: "x.com" })], error: null },
    ];
    const out = await loadPriorEvidenceContext(TENANT, "some-topic");
    expect(out).toContain("https://x.com — last fetched 2026-05-10");
  });

  it("dedupes by normalized_url across topic + recency", async () => {
    selectResults = [
      { data: [row({ normalized_url: "example.com/pricing" })], error: null },
      {
        data: [
          row({ normalized_url: "example.com/pricing" }),
          row({ url: "https://y.com", normalized_url: "y.com" }),
        ],
        error: null,
      },
    ];
    const out = await loadPriorEvidenceContext(TENANT, "t");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("surfaces the source as-of date when present", async () => {
    selectResults = [
      { data: [row({ as_of_date: "2026-04-01" }), row({ normalized_url: "z.com", url: "https://z.com" }), row({ normalized_url: "w.com", url: "https://w.com" })], error: null },
    ];
    const out = await loadPriorEvidenceContext(TENANT, "t");
    expect(out).toContain("source as-of 2026-04-01");
  });

  it("returns empty string when the tenant has no prior evidence", async () => {
    selectResults = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    const out = await loadPriorEvidenceContext(TENANT, "t");
    expect(out).toBe("");
  });
});

describe("loadResearchWatchBaseline — TOPIC-SCOPED, NO recency fallback (prosecutor regression)", () => {
  const brow = (over: Record<string, unknown> = {}) => ({
    url: "https://example.com/pricing",
    normalized_url: "example.com/pricing",
    excerpt: "Pro plan is $99/mo",
    ...over,
  });

  it("null topic_key → returns [] WITHOUT querying (no fallback baseline → no suppression)", async () => {
    selectResults = [
      { data: [brow({ url: "https://unrelated.com", normalized_url: "unrelated.com" })], error: null },
    ];
    const out = await loadResearchWatchBaseline(TENANT, null);
    expect(out).toEqual([]);
  });

  it("topic match → returns the topic rows", async () => {
    selectResults = [
      {
        data: [
          brow({ url: "https://example.com/pricing", normalized_url: "example.com/pricing" }),
          brow({ url: "https://example.com/plans", normalized_url: "example.com/plans" }),
        ],
        error: null,
      },
    ];
    const out = await loadResearchWatchBaseline(TENANT, "pricing-turo");
    expect(out.map((r) => r.url)).toEqual([
      "https://example.com/pricing",
      "https://example.com/plans",
    ]);
  });

  it("FEW topic hits → does NOT fall back to recency (the fail-closed bug)", async () => {
    selectResults = [
      { data: [brow({ url: "https://example.com/pricing", normalized_url: "example.com/pricing" })], error: null },
      { data: [brow({ url: "https://unrelated.com", normalized_url: "unrelated.com" })], error: null },
    ];
    const out = await loadResearchWatchBaseline(TENANT, "some-topic");
    expect(out.map((r) => r.url)).toEqual(["https://example.com/pricing"]);
    expect(out.some((r) => r.url === "https://unrelated.com")).toBe(false);
  });

  it("zero topic hits → returns [] (→ totalUrls 0 → no suppression → enqueue)", async () => {
    selectResults = [
      { data: [], error: null },
      { data: [brow({ url: "https://unrelated.com", normalized_url: "unrelated.com" })], error: null },
    ];
    const out = await loadResearchWatchBaseline(TENANT, "no-hits-topic");
    expect(out).toEqual([]);
  });
});
