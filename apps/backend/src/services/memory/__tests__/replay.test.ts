
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  jaccardAtK,
  top1Stable,
  parseNdjson,
  REPLAY_SCHEMA_VERSION,
} from "../replay";

describe("jaccardAtK", () => {
  it("returns 1.0 for identical sets", () => {
    expect(jaccardAtK(["a", "b", "c"], ["a", "b", "c"])).toBe(1.0);
  });
  it("returns 0 for disjoint sets", () => {
    expect(jaccardAtK(["a", "b"], ["c", "d"])).toBe(0);
  });
  it("returns 1.0 for both-empty", () => {
    expect(jaccardAtK([], [])).toBe(1.0);
  });
  it("computes partial overlap", () => {
    expect(jaccardAtK(["a", "b", "c"], ["a", "b", "d"])).toBe(0.5);
  });
  it("respects k cutoff", () => {
    expect(jaccardAtK(["a", "b", "c"], ["a", "b", "z"], 2)).toBe(1.0);
  });
});

describe("top1Stable", () => {
  it("true when first matches", () => {
    expect(top1Stable(["a", "b"], ["a", "c"])).toBe(true);
  });
  it("false when first differs", () => {
    expect(top1Stable(["a", "b"], ["c", "a"])).toBe(false);
  });
  it("false on either-empty", () => {
    expect(top1Stable([], ["a"])).toBe(false);
    expect(top1Stable(["a"], [])).toBe(false);
  });
});

describe("parseNdjson", () => {
  it("parses valid rows + skips empty lines", () => {
    const ndjson = [
      JSON.stringify({
        schema_version: 1,
        tenant_id: "t1",
        tool_name: "search",
        query: "hello",
        retrieved_chunk_ids: ["c1"],
        retrieved_note_ids: [],
        latency_ms: 12,
        k: 8,
        run_id: null,
        agent_slug: null,
        created_at: "2026-05-17T00:00:00Z",
      }),
      "",
      JSON.stringify({
        schema_version: 1,
        tenant_id: "t2",
        tool_name: "search",
        query: "world",
        retrieved_chunk_ids: [],
        retrieved_note_ids: [],
        latency_ms: 5,
        k: 8,
        run_id: null,
        agent_slug: null,
        created_at: "2026-05-17T00:00:01Z",
      }),
    ].join("\n");
    const { rows, errors } = parseNdjson(ndjson);
    expect(rows.length).toBe(2);
    expect(errors.length).toBe(0);
  });

  it("reports malformed lines via errors[]", () => {
    const ndjson = "not json\n{\"valid\":1}";
    const { rows, errors } = parseNdjson(ndjson);
    expect(rows.length).toBe(0);
    expect(errors.length).toBe(2);
  });

  it("REPLAY_SCHEMA_VERSION is 1", () => {
    expect(REPLAY_SCHEMA_VERSION).toBe(1);
  });
});

vi.mock("../index", () => ({
  searchMemory: vi.fn(),
}));

describe("runReplay — tenant isolation (Codex P1-3)", () => {
  let runReplay: typeof import("../replay").runReplay;
  let mockedSearchMemory: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const replayMod = await import("../replay");
    runReplay = replayMod.runReplay;
    const indexMod = await import("../index");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSearchMemory = indexMod.searchMemory as any;
    mockedSearchMemory.mockReset();
    mockedSearchMemory.mockResolvedValue([]);
  });

  it("rejects rows whose tenant_id != requested tenant", async () => {
    const TENANT_A = "11111111-1111-1111-1111-111111111111";
    const TENANT_B = "22222222-2222-2222-2222-222222222222";
    const ndjson = [
      JSON.stringify({
        schema_version: 1,
        tenant_id: TENANT_A,
        tool_name: "search",
        query: "a-query",
        retrieved_chunk_ids: ["c1"],
        retrieved_note_ids: [],
        latency_ms: 10,
        k: 8,
        run_id: null,
        agent_slug: null,
        created_at: "2026-05-17T00:00:00Z",
      }),
      JSON.stringify({
        schema_version: 1,
        tenant_id: TENANT_B,
        tool_name: "search",
        query: "b-query",
        retrieved_chunk_ids: ["c2"],
        retrieved_note_ids: [],
        latency_ms: 10,
        k: 8,
        run_id: null,
        agent_slug: null,
        created_at: "2026-05-17T00:00:01Z",
      }),
    ].join("\n");

    const report = await runReplay({ tenant_id: TENANT_A, baselineNdjson: ndjson });
    expect(report.queries_replayed).toBe(1);
    expect(report.queries_rejected_cross_tenant).toBe(1);
    expect(mockedSearchMemory).toHaveBeenCalledTimes(1);
    expect(mockedSearchMemory).toHaveBeenCalledWith(
      TENANT_A,
      "a-query",
      8,
    );
  });

  it("envelope has expected shape + version", async () => {
    const TENANT = "11111111-1111-1111-1111-111111111111";
    const ndjson = JSON.stringify({
      schema_version: 1,
      tenant_id: TENANT,
      tool_name: "search",
      query: "x",
      retrieved_chunk_ids: ["c1"],
      retrieved_note_ids: [],
      latency_ms: 10,
      k: 8,
      run_id: null,
      agent_slug: null,
      created_at: "2026-05-17T00:00:00Z",
    });
    mockedSearchMemory.mockResolvedValueOnce([{ chunk_id: "c1" }]);
    const report = await runReplay({ tenant_id: TENANT, baselineNdjson: ndjson });
    expect(report.schema_version).toBe(1);
    expect(report.metric_name).toBe("scrubbed_query_jaccard_at_k");
    expect(report.tenant_id).toBe(TENANT);
    expect(report.queries_replayed).toBe(1);
    expect(report.queries_rejected_cross_tenant).toBe(0);
    expect(report.mean_jaccard).toBe(1.0);
    expect(report.top1_stability).toBe(1.0);
  });

  it("counts errors when searchMemory throws", async () => {
    const TENANT = "11111111-1111-1111-1111-111111111111";
    const ndjson = JSON.stringify({
      schema_version: 1,
      tenant_id: TENANT,
      tool_name: "search",
      query: "x",
      retrieved_chunk_ids: ["c1"],
      retrieved_note_ids: [],
      latency_ms: 10,
      k: 8,
      run_id: null,
      agent_slug: null,
      created_at: "2026-05-17T00:00:00Z",
    });
    mockedSearchMemory.mockRejectedValueOnce(new Error("search exploded"));
    const report = await runReplay({ tenant_id: TENANT, baselineNdjson: ndjson });
    expect(report.queries_replayed).toBe(0);
    expect(report.queries_errored).toBe(1);
  });
});
