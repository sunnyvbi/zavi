
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toAnthropicName, fromAnthropicName } from "../../types";

const deliverMock = vi.fn();
vi.mock("@/services/reports/deliver-pdf", () => ({
  deliverPdf: (...args: unknown[]) => deliverMock(...args),
}));

const deliverCsvMock = vi.fn();
vi.mock("@/services/reports/deliver-csv", () => ({
  deliverCsv: (...args: unknown[]) => deliverCsvMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  deliverMock.mockResolvedValue({
    artifact_id: "artifact-uuid-1",
    filename: "smoke.pdf",
    bytes: 1024,
    slack_ok: false,
  });
  deliverCsvMock.mockResolvedValue({
    artifact_id: "artifact-uuid-2",
    filename: "data.csv",
    bytes: 64,
  });
});

const validInput = {
  title: "Smoke",
  filename: "smoke.pdf",
  sections: [
    {
      heading: "S1",
      body_markdown: "body",
    },
  ],
};

describe("listReportTools", () => {
  it("advertises report__render_pdf with the correct Anthropic name shape", async () => {
    const { listReportTools } = await import("../report");
    const tools = listReportTools();
    const t = tools.find((x) => x.tool_name === "render_pdf")!;
    expect(t).toBeDefined();
    expect(t.server_id).toBe("report");
    expect(t.tool_name).toBe("render_pdf");
    expect(t.input_schema.type).toBe("object");
    const anthropicName = toAnthropicName(t.server_id, t.tool_name);
    expect(anthropicName).toBe("report__render_pdf");
    const back = fromAnthropicName(anthropicName);
    expect(back).toEqual({ server_id: "report", tool_name: "render_pdf" });
  });

  it("also advertises report__render_csv (Gap 10) + report__render_blog + report__render_wireframe", async () => {
    const { listReportTools } = await import("../report");
    const tools = listReportTools();
    expect(tools.map((t) => t.tool_name).sort()).toEqual([
      "generate_image",
      "get_page_design_guide",
      "render_artifact",
      "render_blog",
      "render_csv",
      "render_deck",
      "render_doc",
      "render_pdf",
      "render_social_image",
      "render_wireframe",
      "render_xlsx",
    ]);
    const csv = tools.find((t) => t.tool_name === "render_csv")!;
    expect(csv.server_id).toBe("report");
    expect(csv.input_schema.type).toBe("object");
    expect(toAnthropicName(csv.server_id, csv.tool_name)).toBe(
      "report__render_csv",
    );
  });
});

describe("callReportTool", () => {
  const validCtx = {
    tenant_id: "tenant-A",
    run_id: "run-1",
  };

  it("returns success on happy path and invokes deliverPdf with the parsed input", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(validCtx, "render_pdf", validInput);
    expect(r.ok).toBe(true);
    expect(r.is_error).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.artifact_id).toBe("artifact-uuid-1");
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("returns tool_unknown for an unknown tool name", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(validCtx, "bogus", {});
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("tool_unknown");
  });

  it("fast-fails with missing_run_ctx when run_id is empty (hard contract — guard cannot be bypassed)", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(
      { tenant_id: "tenant-A", run_id: "" },
      "render_pdf",
      validInput,
    );
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("missing_run_ctx");
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("converts ZodError to invalid_input (catches the gap buffer's wrapper has)", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(validCtx, "render_pdf", { title: 123 });
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("invalid_input");
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("surfaces ExpectedToolError from deliverPdf with its code (e.g. tenant_mismatch)", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    deliverMock.mockRejectedValueOnce(
      new ExpectedToolError("tenant_mismatch", "fake mismatch"),
    );
    const { callReportTool } = await import("../report");
    const r = await callReportTool(validCtx, "render_pdf", validInput);
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("tenant_mismatch");
  });

  const validCsvInput = {
    filename: "data.csv",
    columns: ["Region", "Rev"],
    rows: [
      ["North", "100"],
      ["South", "80"],
    ],
  };

  it("render_csv happy path invokes deliverCsv with a sanitized filename + escaped bytes", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(validCtx, "render_csv", {
      ...validCsvInput,
      filename: "../secret/report",
      rows: [["=cmd()", "1"], ["ok", "2"]],
    });
    expect(r.ok).toBe(true);
    expect(deliverCsvMock).toHaveBeenCalledTimes(1);
    const [, input] = deliverCsvMock.mock.calls[0];
    expect(input.filename).toBe("report.csv");
    expect(input.csv).toContain("'=cmd()");
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("render_csv rejects a filename that reduces to nothing (filename_invalid)", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(validCtx, "render_csv", {
      ...validCsvInput,
      filename: "///",
    });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("filename_invalid");
    expect(deliverCsvMock).not.toHaveBeenCalled();
  });

  it("render_csv fast-fails missing_run_ctx (tenant guard cannot be bypassed)", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(
      { tenant_id: "tenant-A", run_id: "" },
      "render_csv",
      validCsvInput,
    );
    expect(JSON.parse(r.content).error).toBe("missing_run_ctx");
    expect(deliverCsvMock).not.toHaveBeenCalled();
  });

  it("render_csv rejects jagged rows as invalid_input", async () => {
    const { callReportTool } = await import("../report");
    const r = await callReportTool(validCtx, "render_csv", {
      filename: "x.csv",
      columns: ["a", "b"],
      rows: [["1"]],
    });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("invalid_input");
    expect(deliverCsvMock).not.toHaveBeenCalled();
  });
});

describe("discovery wiring (source-level — runs without a live DB)", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "..", "discovery.ts"),
    "utf-8",
  );

  it("imports listReportTools from internal/report", () => {
    expect(SRC).toMatch(
      /import \{ listReportTools \} from ['"]\.\/internal\/report['"]/,
    );
  });

  it("registers 'report' in PLATFORM_INTERNAL_SERVERS", () => {
    expect(SRC).toMatch(/server_id:\s*['"]report['"]/);
  });

  it("has a branch for server_id='report' in listToolsForServer", () => {
    expect(SRC).toMatch(/server\.server_id === ['"]report['"]/);
    expect(SRC).toMatch(/tools = listReportTools\(\)/);
  });
});

describe("execute wiring (source-level)", () => {
  const SRC = readFileSync(
    join(__dirname, "..", "..", "execute.ts"),
    "utf-8",
  );

  it("imports callReportTool", () => {
    expect(SRC).toMatch(
      /import \{ callReportTool \} from ['"]\.\/internal\/report['"]/,
    );
  });

  it("dispatches server_id === 'report' to callReportTool with the FULL ctx", () => {
    expect(SRC).toMatch(/server_id === ['"]report['"]/);
    expect(SRC).toMatch(/callReportTool\(ctx,\s*tool_name,\s*args\)/);
  });
});
