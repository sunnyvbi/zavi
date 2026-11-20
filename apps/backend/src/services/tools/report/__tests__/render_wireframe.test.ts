
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/agents/prototype-links", () => ({
  publishWireframeLink: vi.fn(),
}));

import { publishWireframeLink } from "@/services/agents/prototype-links";
import { renderWireframeTool } from "../render_wireframe";
import { ExpectedToolError } from "@/services/tools/types";
import { listReportTools } from "@/services/mcp/internal/report";

const ctx = {
  tenant_id: "t1",
  run_id: "r1",
  log: () => {},
};

const input = {
  title: "Booking flow",
  summary: "Pick, confirm, pay.",
  html: "<html><button>Book</button></html>",
  notes: [{ change: "One-tap", why: "fewer steps" }],
};

describe("renderWireframeTool.execute", () => {
  beforeEach(() => {
    vi.mocked(publishWireframeLink).mockReset();
  });

  it("throws missing_run_ctx when there is no run_id", async () => {
    await expect(
      renderWireframeTool.execute({ tenant_id: "t1", log: () => {} }, input),
    ).rejects.toMatchObject({ code: "missing_run_ctx" });
  });

  it("builds a kind=html_preview + variant=wireframe envelope and returns the url", async () => {
    vi.mocked(publishWireframeLink).mockResolvedValueOnce({
      published: true,
      slug: "AbC123",
      url: "https://preview.zaviagent.com/AbC123",
    });
    const out = await renderWireframeTool.execute(ctx, input);
    expect(out).toEqual({
      published: true,
      url: "https://preview.zaviagent.com/AbC123",
      slug: "AbC123",
    });
    const arg = vi.mocked(publishWireframeLink).mock.calls[0][0];
    expect(arg.tenant_id).toBe("t1");
    expect(arg.run_id).toBe("r1");
    expect(arg.envelope.kind).toBe("html_preview");
    expect(arg.envelope.variant).toBe("wireframe");
    expect(arg.envelope.rationale).toEqual(input.notes);
  });

  it("maps reason:disabled → wireframe_disabled", async () => {
    vi.mocked(publishWireframeLink).mockResolvedValueOnce({
      published: false,
      reason: "disabled",
    });
    await expect(renderWireframeTool.execute(ctx, input)).rejects.toMatchObject({
      code: "wireframe_disabled",
    });
  });

  it("maps reason:blocked → leak_blocked", async () => {
    vi.mocked(publishWireframeLink).mockResolvedValueOnce({
      published: false,
      reason: "blocked",
      detail: "stripe_key",
    });
    const err = await renderWireframeTool.execute(ctx, input).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("leak_blocked");
  });

  it("maps reason:error → publish_failed", async () => {
    vi.mocked(publishWireframeLink).mockResolvedValueOnce({
      published: false,
      reason: "error",
      detail: "rpc_null",
    });
    await expect(renderWireframeTool.execute(ctx, input)).rejects.toMatchObject({
      code: "publish_failed",
    });
  });
});

describe("report facade exposes render_wireframe", () => {
  it("lists render_wireframe (report_ prefix stripped) with an object input_schema", () => {
    const tools = listReportTools();
    const wf = tools.find((t) => t.tool_name === "render_wireframe");
    expect(wf).toBeTruthy();
    expect(wf?.server_id).toBe("report");
    expect(wf?.input_schema.type).toBe("object");
  });
});
