
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ARTIFACT_MAX_BYTES } from "../constants";
import {
  recordCapture,
  __resetCaptureLedgerForTest,
} from "@/services/agents/engine/capture-ledger";

type Chain = {
  from: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  agentRunsSingle: ReturnType<typeof vi.fn>;
};

const c: Chain = {
  from: vi.fn(),
  upload: vi.fn(),
  upsert: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
  eq: vi.fn(),
  agentRunsSingle: vi.fn(),
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (tbl: string) => {
      if (tbl === "agent_runs") {
        return {
          select: () => ({
            eq: () => ({ single: c.agentRunsSingle }),
          }),
        };
      }
      if (tbl === "run_artifacts") {
        return {
          upsert: c.upsert,
        };
      }
      return c.from(tbl);
    },
    storage: {
      from: () => ({ upload: c.upload }),
    },
  }),
}));

const slackUpload = vi.fn();
vi.mock("@/services/tools/slack/upload_file", () => ({
  uploadFileToThread: (args: unknown) => slackUpload(args),
}));

const renderPdfMock = vi.fn();
vi.mock("../render-pdf", async () => {
  const actual = await vi.importActual<typeof import("../render-pdf")>("../render-pdf");
  return {
    ...actual,
    renderPdf: (input: unknown) => renderPdfMock(input),
  };
});

const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const goodPdfBytes = new Uint8Array([...PDF_HEADER, 0x31, 0x2e, 0x37]);

const VALID_INPUT = {
  title: "Smoke",
  filename: "smoke.pdf",
  sections: [
    {
      heading: "S1",
      body_markdown: "body",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetCaptureLedgerForTest();
  c.agentRunsSingle.mockResolvedValue({
    data: { tenant_id: "tenant-A" },
    error: null,
  });
  c.upload.mockResolvedValue({ data: { path: "x" }, error: null });
  c.upsert.mockReturnValue({
    select: () => ({
      single: () => Promise.resolve({ data: { id: "artifact-uuid-1" }, error: null }),
    }),
  });
  renderPdfMock.mockResolvedValue(goodPdfBytes);
});

const importDeliver = async () => await import("../deliver-pdf");

describe("deliverPdf — happy path", () => {
  it("returns {artifact_id, filename, bytes, slack_ok:false} when slack not requested", async () => {
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      VALID_INPUT,
    );
    expect(out.artifact_id).toBe("artifact-uuid-1");
    expect(out.filename).toBe("smoke.pdf");
    expect(out.bytes).toBe(goodPdfBytes.byteLength);
    expect(out.slack_ok).toBe(false);
  });
});

describe("deliverPdf — tenant guard", () => {
  it("throws tenant_mismatch (no storage write, no row insert) when ctx tenant != run tenant", async () => {
    c.agentRunsSingle.mockResolvedValue({
      data: { tenant_id: "tenant-B" },
      error: null,
    });
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-of-B" }, VALID_INPUT),
    ).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.upsert).not.toHaveBeenCalled();
  });

  it("throws run_lookup_failed when the run row is missing", async () => {
    c.agentRunsSingle.mockResolvedValue({
      data: null,
      error: { message: "not found" },
    });
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "missing" }, VALID_INPUT),
    ).rejects.toMatchObject({ code: "run_lookup_failed" });
    expect(c.upload).not.toHaveBeenCalled();
  });
});

describe("deliverPdf — failure modes", () => {
  it("throws storage_upload_failed and skips row insert when upload fails", async () => {
    c.upload.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, VALID_INPUT),
    ).rejects.toMatchObject({ code: "storage_upload_failed" });
    expect(c.upsert).not.toHaveBeenCalled();
  });

  it("throws artifact_row_failed when upsert fails (orphan storage object acceptable at v0)", async () => {
    c.upsert.mockReturnValue({
      select: () => ({
        single: () =>
          Promise.resolve({ data: null, error: { message: "row boom" } }),
      }),
    });
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, VALID_INPUT),
    ).rejects.toMatchObject({ code: "artifact_row_failed" });
  });

  it("throws pdf_render_failed when renderer produces non-PDF bytes (magic-byte canary)", async () => {
    renderPdfMock.mockResolvedValue(new Uint8Array([0x45, 0x52, 0x52]));
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, VALID_INPUT),
    ).rejects.toMatchObject({ code: "pdf_render_failed" });
  });

  it("throws pdf_too_large BEFORE storage upload when bytes exceed ARTIFACT_MAX_BYTES", async () => {
    const huge = new Uint8Array(ARTIFACT_MAX_BYTES + 1);
    huge.set(PDF_HEADER, 0);
    renderPdfMock.mockResolvedValue(huge);
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, VALID_INPUT),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
    expect(c.upload).not.toHaveBeenCalled();
  });
});

describe("deliverPdf — unverified-source fail-closed gate", () => {
  it("(a) clean ledger → emits normally", async () => {
    recordCapture("run-1", {
      requested_url: "https://ok.example/p",
      final_url: "https://ok.example/p",
      capture: "dom_text",
      status: 200,
      truncated: false,
    });
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      VALID_INPUT,
    );
    expect(out.artifact_id).toBe("artifact-uuid-1");
    expect(c.upload).toHaveBeenCalled();
  });

  it("(b) blocked source + NO disclosure → blocked (no render, no upload, no row)", async () => {
    recordCapture("run-1", {
      requested_url: "https://blocked.example/p",
      final_url: "https://blocked.example/p",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, VALID_INPUT),
    ).rejects.toMatchObject({
      code: "artifact_unverified_source",
      meta: { unrendered_sources: ["https://blocked.example/p"] },
    });
    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(c.upload).not.toHaveBeenCalled();
    expect(c.upsert).not.toHaveBeenCalled();
  });

  it("(c) blocked source WITH an in-body disclosure → emits", async () => {
    recordCapture("run-1", {
      requested_url: "https://blocked.example/p",
      final_url: "https://blocked.example/p",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    const inputWithDisclosure = {
      ...VALID_INPUT,
      sections: [
        {
          heading: "Competitor pricing",
          body_markdown:
            "We could not load https://blocked.example/p (origin blocked the request), so pricing is unconfirmed.",
        },
      ],
    };
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      inputWithDisclosure,
    );
    expect(out.artifact_id).toBe("artifact-uuid-1");
    expect(c.upload).toHaveBeenCalled();
  });

  it("substring host match does NOT fool the gate — disclosing 'notblocked.example' keeps blocked.example blocked", async () => {
    recordCapture("run-1", {
      requested_url: "https://blocked.example/p",
      final_url: "https://blocked.example/p",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    const inputWithDecoy = {
      ...VALID_INPUT,
      sections: [
        {
          heading: "Competitor pricing",
          body_markdown:
            "We could not load https://notblocked.example/x, so pricing is unconfirmed.",
        },
      ],
    };
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, inputWithDecoy),
    ).rejects.toMatchObject({
      code: "artifact_unverified_source",
      meta: { unrendered_sources: ["https://blocked.example/p"] },
    });
    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(c.upload).not.toHaveBeenCalled();
  });

  it("per-source disclosure inside a table cell (names the host) satisfies the gate", async () => {
    recordCapture("run-1", {
      requested_url: "https://blocked.example/p",
      final_url: "https://blocked.example/p",
      capture: "empty_shell",
      status: 200,
      truncated: false,
    });
    const inputWithTableDisclosure = {
      ...VALID_INPUT,
      sections: [
        {
          heading: "Pricing matrix",
          body_markdown: "See table.",
          table: {
            columns: ["Vendor", "Price"],
            rows: [["Acme", "could not load blocked.example, source unavailable"]],
          },
        },
      ],
    };
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      inputWithTableDisclosure,
    );
    expect(out.artifact_id).toBe("artifact-uuid-1");
  });

  it("(P2-C) GENERIC footer disclosure does NOT pass — footer is excluded + source not named", async () => {
    recordCapture("run-1", {
      requested_url: "https://blocked.example/p",
      final_url: "https://blocked.example/p",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    const inputWithFooterOnly = {
      ...VALID_INPUT,
      footer: "Note: some sources could not be verified.",
    };
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, inputWithFooterOnly),
    ).rejects.toMatchObject({ code: "artifact_unverified_source" });
    expect(c.upload).not.toHaveBeenCalled();
  });

  it("(P2-C) a disclosure PHRASE that does not name the failed source does NOT pass", async () => {
    recordCapture("run-1", {
      requested_url: "https://blocked.example/p",
      final_url: "https://blocked.example/p",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    const inputGenericPhrase = {
      ...VALID_INPUT,
      sections: [
        {
          heading: "Findings",
          body_markdown:
            "We could not verify one of the cited sources, but the analysis holds.",
        },
      ],
    };
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, inputGenericPhrase),
    ).rejects.toMatchObject({
      code: "artifact_unverified_source",
      meta: { unrendered_sources: ["https://blocked.example/p"] },
    });
  });

  it("(P2-C)(a) disclosing source A does NOT unblock undisclosed source B", async () => {
    recordCapture("run-1", {
      requested_url: "https://a.example/p",
      final_url: "https://a.example/p",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    recordCapture("run-1", {
      requested_url: "https://b.example/q",
      final_url: "https://b.example/q",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    const inputNamesOnlyA = {
      ...VALID_INPUT,
      sections: [
        {
          heading: "Sources",
          body_markdown: "We could not load https://a.example/p, so that figure is unconfirmed.",
        },
      ],
    };
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, inputNamesOnlyA),
    ).rejects.toMatchObject({
      code: "artifact_unverified_source",
      meta: { unrendered_sources: ["https://b.example/q"] },
    });
  });

  it("(P2-C) CROSS-UNIT: a phrase in one section + a different source's URL in another section does NOT pass", async () => {
    recordCapture("run-1", {
      requested_url: "https://b.example/q",
      final_url: "https://b.example/q",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    const inputCrossUnit = {
      ...VALID_INPUT,
      sections: [
        {
          heading: "Method",
          body_markdown: "Some pages could not be loaded during research.",
        },
        {
          heading: "Findings",
          body_markdown: "Per https://b.example/q, pricing is $99/mo.",
        },
      ],
    };
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, inputCrossUnit),
    ).rejects.toMatchObject({
      code: "artifact_unverified_source",
      meta: { unrendered_sources: ["https://b.example/q"] },
    });
  });

  it("(P2-C)(b) per-source CO-LOCATED disclosure for EVERY blocked source passes", async () => {
    recordCapture("run-1", {
      requested_url: "https://a.example/p",
      final_url: "https://a.example/p",
      capture: "blocked",
      status: 403,
      truncated: false,
    });
    recordCapture("run-1", {
      requested_url: "https://b.example/q",
      final_url: "https://b.example/q",
      capture: "empty_shell",
      status: 200,
      truncated: false,
    });
    const inputBothDisclosed = {
      ...VALID_INPUT,
      sections: [
        {
          heading: "A",
          body_markdown: "We could not load https://a.example/p (blocked), so it is unconfirmed.",
        },
        {
          heading: "B",
          body_markdown: "We could not load b.example either (empty shell); figures unconfirmed.",
        },
      ],
    };
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      inputBothDisclosed,
    );
    expect(out.artifact_id).toBe("artifact-uuid-1");
    expect(c.upload).toHaveBeenCalled();
  });
});

describe("deliverPdf — slack soft-fail", () => {
  it("returns slack_ok:false when slack upload throws (artifact_id still returned)", async () => {
    slackUpload.mockRejectedValue(new Error("slack down"));
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      { ...VALID_INPUT, channel_id: "C123", thread_ts: "1.234" },
    );
    expect(out.artifact_id).toBe("artifact-uuid-1");
    expect(out.slack_ok).toBe(false);
  });

  it("returns slack_ok:true on slack happy path", async () => {
    slackUpload.mockResolvedValue(undefined);
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      { ...VALID_INPUT, channel_id: "C123" },
    );
    expect(out.slack_ok).toBe(true);
  });
});
