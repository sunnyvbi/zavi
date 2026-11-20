
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toAnthropicName, fromAnthropicName } from "../../types";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  pdfParseMock: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("pdf-parse", () => ({
  default: (...args: unknown[]) => mocks.pdfParseMock(...args),
}));

type Result = { data: unknown; error: unknown };

function mkBuilder(opts: { single?: Result; limit?: Result }) {
  const b = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(async () => opts.limit ?? { data: [], error: null }),
    single: vi.fn(async () => opts.single ?? { data: null, error: null }),
  };
  b.select.mockImplementation(() => b);
  b.eq.mockImplementation(() => b);
  b.order.mockImplementation(() => b);
  return b;
}

function mkSvc(opts: {
  run?: Result;
  artifactSingle?: Result;
  artifactList?: Result;
  downloadText?: string;
}) {
  const runB = mkBuilder({ single: opts.run });
  const artB = mkBuilder({ single: opts.artifactSingle, limit: opts.artifactList });
  const download = vi.fn(async () =>
    opts.downloadText === undefined
      ? { data: null, error: { message: "no blob configured" } }
      : {
          data: {
            arrayBuffer: async () =>
              new TextEncoder().encode(opts.downloadText).buffer,
          },
          error: null,
        },
  );
  const svc = {
    from: vi.fn((table: string) => (table === "agent_runs" ? runB : artB)),
    storage: { from: vi.fn(() => ({ download })) },
  };
  mocks.serviceClientMock.mockReturnValue(svc);
  return { svc, runB, artB, download };
}

const CTX = { tenant_id: "tenant-A", run_id: "run-1", agent_slug: "pm" };
const RUN_ROW: Result = {
  data: { tenant_id: "tenant-A", agent_slug: "pm" },
  error: null,
};
const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listArtifactsTools", () => {
  it("advertises artifacts__list + artifacts__get with the correct Anthropic name shape", async () => {
    const { listArtifactsTools } = await import("../artifacts");
    const tools = listArtifactsTools();
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(t.server_id).toBe("artifacts");
      expect(t.input_schema.type).toBe("object");
      const anthropicName = toAnthropicName(t.server_id, t.tool_name);
      expect(fromAnthropicName(anthropicName)).toEqual({
        server_id: "artifacts",
        tool_name: t.tool_name,
      });
    }
    expect(tools.map((t) => t.tool_name).sort()).toEqual(["get", "list"]);
  });
});

describe("callArtifactsTool — guard contract", () => {
  it("fast-fails with missing_run_ctx when run_id is empty, before ANY DB read", async () => {
    const { svc } = mkSvc({});
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(
      { tenant_id: "tenant-A", run_id: "" },
      "list",
      {},
    );
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("missing_run_ctx");
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("returns tool_unknown for an unknown tool name", async () => {
    mkSvc({});
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "bogus", {});
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("tool_unknown");
  });

  it("rejects a run that belongs to a different tenant (tenant_mismatch)", async () => {
    mkSvc({ run: { data: { tenant_id: "tenant-B", agent_slug: "pm" }, error: null } });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "list", {});
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("tenant_mismatch");
  });
});

describe("artifacts__list — scoped to the DERIVED tenant + agent", () => {
  it("queries run_artifacts with the tenant_id + agent_slug from the agent_runs row (not tool args)", async () => {
    const rows = [
      {
        id: ARTIFACT_ID,
        filename: "q2-report.pdf",
        mime: "application/pdf",
        thread_id: "22222222-2222-2222-2222-222222222222",
        created_at: "2026-06-09T00:00:00Z",
        bytes: 1024,
      },
    ];
    const { artB } = mkSvc({ run: RUN_ROW, artifactList: { data: rows, error: null } });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "list", {});
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).artifacts).toEqual(rows);
    expect(artB.eq).toHaveBeenCalledWith("tenant_id", "tenant-A");
    expect(artB.eq).toHaveBeenCalledWith("agent_slug", "pm");
    expect(artB.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(artB.limit).toHaveBeenCalledWith(20);
  });

  it("honors limit but the schema caps it at 20", async () => {
    const { artB } = mkSvc({ run: RUN_ROW, artifactList: { data: [], error: null } });
    const { callArtifactsTool } = await import("../artifacts");
    const ok = await callArtifactsTool(CTX, "list", { limit: 5 });
    expect(ok.ok).toBe(true);
    expect(artB.limit).toHaveBeenCalledWith(5);
    const over = await callArtifactsTool(CTX, "list", { limit: 50 });
    expect(over.ok).toBe(false);
    expect(JSON.parse(over.content).error).toBe("invalid_input");
  });
});

describe("artifacts__get — no existence oracle across agents/tenants", () => {
  const baseRow = {
    id: ARTIFACT_ID,
    tenant_id: "tenant-A",
    agent_slug: "pm",
    run_id: "run-0",
    storage_path: "tenant-A/run-0/q2-report.csv",
    filename: "q2-report.csv",
    mime: "text/csv",
    bytes: 10,
    thread_id: null,
    created_at: "2026-06-09T00:00:00Z",
  };

  it("rejects a row owned by ANOTHER AGENT as not_found (never reads bytes)", async () => {
    const { download } = mkSvc({
      run: RUN_ROW,
      artifactSingle: { data: { ...baseRow, agent_slug: "research" }, error: null },
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("not_found");
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects a row owned by ANOTHER TENANT as not_found (same code — no oracle)", async () => {
    const { download } = mkSvc({
      run: RUN_ROW,
      artifactSingle: {
        data: { ...baseRow, tenant_id: "tenant-B", storage_path: "tenant-B/run-0/q2-report.csv" },
        error: null,
      },
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("not_found");
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects a missing row as not_found (identical to the ownership rejections)", async () => {
    mkSvc({ run: RUN_ROW, artifactSingle: { data: null, error: { message: "0 rows" } } });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("not_found");
  });

  it("rejects a non-uuid artifact_id as invalid_input", async () => {
    mkSvc({ run: RUN_ROW });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: "../../etc" });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("invalid_input");
  });

  const pdfRow = {
    ...baseRow,
    storage_path: "tenant-A/run-0/q2-report.pdf",
    filename: "q2-report.pdf",
    mime: "application/pdf",
  };

  it("extracts and returns PDF text inline (NOT a storage URL)", async () => {
    mocks.pdfParseMock.mockResolvedValueOnce({ text: "  Q2 revenue was $1.2M.  " });
    const { download } = mkSvc({
      run: RUN_ROW,
      artifactSingle: { data: pdfRow, error: null },
      downloadText: "%PDF-1.4 fake bytes",
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.content).toBe("Q2 revenue was $1.2M.");
    expect(body.truncated).toBe(false);
    expect(body.filename).toBe("q2-report.pdf");
    expect(r.content).not.toMatch(/storage_path|https?:\/\//);
    expect(download).toHaveBeenCalledWith("tenant-A/run-0/q2-report.pdf");
  });

  it("returns content:null + a regenerate message when a PDF has no extractable text (image-only/scanned)", async () => {
    mocks.pdfParseMock.mockResolvedValueOnce({ text: "   \n  " });
    mkSvc({
      run: RUN_ROW,
      artifactSingle: { data: pdfRow, error: null },
      downloadText: "%PDF-1.4 scanned",
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.content).toBeNull();
    expect(body.message).toMatch(/no extractable text/i);
  });

  it("returns content:null + a regenerate message when pdf-parse throws (encrypted/corrupt)", async () => {
    mocks.pdfParseMock.mockRejectedValueOnce(new Error("bad XRef entry"));
    mkSvc({
      run: RUN_ROW,
      artifactSingle: { data: pdfRow, error: null },
      downloadText: "%PDF-1.4 corrupt",
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.content).toBeNull();
    expect(body.message).toMatch(/could not extract text/i);
  });

  it("truncates extracted PDF text to the 64KB char cap with a truncated flag", async () => {
    mocks.pdfParseMock.mockResolvedValueOnce({ text: "y".repeat(70_000) });
    mkSvc({
      run: RUN_ROW,
      artifactSingle: { data: pdfRow, error: null },
      downloadText: "%PDF-1.4 big",
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.truncated).toBe(true);
    expect(body.content).toHaveLength(64 * 1024);
    expect(body.message).toMatch(/truncated/);
  });

  it("returns metadata + binary message (NOT content, NOT a storage URL) for a non-PDF binary (xlsx)", async () => {
    const { download } = mkSvc({
      run: RUN_ROW,
      artifactSingle: {
        data: {
          ...baseRow,
          storage_path: "tenant-A/run-0/model.xlsx",
          filename: "model.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        error: null,
      },
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.content).toBeNull();
    expect(body.message).toMatch(/binary artifact/);
    expect(body.filename).toBe("model.xlsx");
    expect(r.content).not.toMatch(/storage_path|https?:\/\//);
    expect(download).not.toHaveBeenCalled();
  });

  it("returns inline content for text mimes, capped at 64KB with a truncated flag", async () => {
    const big = "x".repeat(70_000);
    const { download } = mkSvc({
      run: RUN_ROW,
      artifactSingle: { data: { ...baseRow, bytes: big.length }, error: null },
      downloadText: big,
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(download).toHaveBeenCalledWith("tenant-A/run-0/q2-report.csv");
    expect(body.truncated).toBe(true);
    expect(body.content).toHaveLength(64 * 1024);
    expect(body.message).toMatch(/truncated/);
  });

  it("returns full content untruncated for a small text artifact", async () => {
    mkSvc({
      run: RUN_ROW,
      artifactSingle: { data: baseRow, error: null },
      downloadText: "a,b\n1,2\n",
    });
    const { callArtifactsTool } = await import("../artifacts");
    const r = await callArtifactsTool(CTX, "get", { artifact_id: ARTIFACT_ID });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.content).toBe("a,b\n1,2\n");
    expect(body.truncated).toBe(false);
  });
});

describe("discovery wiring (source-level — runs without a live DB)", () => {
  const SRC = readFileSync(join(__dirname, "..", "..", "discovery.ts"), "utf-8");

  it("imports listArtifactsTools from internal/artifacts", () => {
    expect(SRC).toMatch(
      /import \{ listArtifactsTools \} from ['"]\.\/internal\/artifacts['"]/,
    );
  });

  it("registers 'artifacts' in PLATFORM_INTERNAL_SERVERS", () => {
    expect(SRC).toMatch(/server_id:\s*['"]artifacts['"]/);
  });

  it("has a branch for server_id='artifacts' in listToolsForServer", () => {
    expect(SRC).toMatch(/server\.server_id === ['"]artifacts['"]/);
    expect(SRC).toMatch(/tools = listArtifactsTools\(\)/);
  });
});

describe("execute wiring (source-level)", () => {
  const SRC = readFileSync(join(__dirname, "..", "..", "execute.ts"), "utf-8");

  it("imports callArtifactsTool", () => {
    expect(SRC).toMatch(
      /import \{ callArtifactsTool \} from ['"]\.\/internal\/artifacts['"]/,
    );
  });

  it("dispatches server_id === 'artifacts' to callArtifactsTool with the FULL ctx", () => {
    expect(SRC).toMatch(/return callArtifactsTool\(ctx, tool_name, args\)/);
  });
});
