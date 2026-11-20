
import { describe, it, expect, vi, beforeEach } from "vitest";
import { __resetCaptureLedgerForTest } from "@/services/agents/engine/capture-ledger";

type Chain = {
  from: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  agentRunsSingle: ReturnType<typeof vi.fn>;
  countResult: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
};

const c: Chain = {
  from: vi.fn(),
  upload: vi.fn(),
  upsert: vi.fn(),
  agentRunsSingle: vi.fn(),
  countResult: vi.fn(),
  rpc: vi.fn(),
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: (fn: string, args: unknown) => c.rpc(fn, args),
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
          select: () => ({
            eq: () => ({
              eq: () => c.countResult(),
            }),
          }),
          update: () => ({
            eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
          }),
        };
      }
      return c.from(tbl);
    },
    storage: {
      from: () => ({ upload: c.upload }),
    },
  }),
}));

vi.mock("@/services/tools/slack/upload_file", () => ({
  uploadFileToThread: vi.fn(),
}));

const isConfigured = vi.fn();
const genImage = vi.fn();
vi.mock("@/services/media-router/router", () => ({
  isTaskConfigured: (t: unknown) => isConfigured(t),
  routeImage: (t: unknown, r: unknown) => genImage(t, r),
  estimateCost: () => 0.06,
}));
const canAfford = vi.fn();
const flushCharges = vi.fn();
vi.mock("@/services/media-router/charge", () => ({
  canAffordMedia: (t: unknown, c: unknown) => canAfford(t, c),
  flushCharges: (p: unknown) => flushCharges(p),
}));

const renderPdfMock = vi.fn();
vi.mock("../render-pdf", async () => {
  const actual = await vi.importActual<typeof import("../render-pdf")>("../render-pdf");
  return {
    ...actual,
    renderPdf: (input: unknown, resolvedImages: unknown, embedded?: boolean[]) => {
      if (Array.isArray(resolvedImages) && embedded) {
        resolvedImages.forEach((b, i) => {
          if (b) embedded[i] = true;
        });
      }
      return renderPdfMock(input, resolvedImages, embedded);
    },
  };
});

const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const goodPdfBytes = new Uint8Array([...PDF_HEADER, 0x31, 0x2e, 0x37]);

const ONE_PIXEL_PNG_HEX =
  "89504E470D0A1A0A0000000D49484452000000010000000108000000003A7E9B550000000A49444154789C636800000082008177CD72B60000000049454E44AE426082";

const INPUT_WITH_ONE_IMAGE = {
  title: "Concept sheet",
  filename: "concepts.pdf",
  sections: [
    {
      heading: "Concept #1",
      body_markdown: "A minimal navy wordmark on cream.",
      image_concept: "minimal navy wordmark on cream",
    },
  ],
};

const INPUT_WITH_TWO_IMAGES = {
  title: "Multi",
  filename: "multi.pdf",
  sections: [
    {
      heading: "One",
      body_markdown: "First.",
      image_concept: "concept one",
    },
    {
      heading: "Two",
      body_markdown: "Second.",
      image_concept: "concept two",
    },
  ],
};

const INPUT_TEXT_ONLY = {
  title: "Text",
  filename: "text.pdf",
  sections: [{ heading: "H", body_markdown: "body" }],
};

function mockImageResponse(ct: string, bytesHex: string, ok = true, status = 200) {
  const buf = Buffer.from(bytesHex, "hex");
  return {
    ok,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === "content-type" ? ct : null),
    },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response;
}

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
  c.countResult.mockResolvedValue({ count: 0, error: null });
  c.rpc.mockResolvedValue({ data: "charged", error: null });
  renderPdfMock.mockResolvedValue(goodPdfBytes);
  isConfigured.mockResolvedValue(true);
  canAfford.mockResolvedValue(true);
  flushCharges.mockResolvedValue(undefined);
});

const importDeliver = async () => await import("../deliver-pdf");

describe("deliverPdf — per-section image gen (happy)", () => {
  it("(a) no image_concept anywhere → images_generated: 0, no Higgsfield call, no fetch", async () => {
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_TEXT_ONLY,
    );
    expect(out.images_generated).toBe(0);
    expect(out.logo_rendered).toBe(0);
    expect(isConfigured).not.toHaveBeenCalled();
    expect(genImage).not.toHaveBeenCalled();
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toEqual([null]);
  });

  it("(b) happy: valid PNG → renderer receives a Buffer at index 0, images_generated=1", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/one.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_ONE_IMAGE,
    );
    expect(out.images_generated).toBe(1);
    expect(genImage).toHaveBeenCalledWith("image.hero", {
      prompt: "minimal navy wordmark on cream",
      aspect_ratio: "16:9",
    });
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(Array.isArray(resolved)).toBe(true);
    expect(resolved).toHaveLength(1);
    expect(Buffer.isBuffer(resolved[0])).toBe(true);
    fetchMock.mockRestore();
  });
});

describe("deliverPdf — image gen fail-soft branches", () => {
  it("(c) Higgsfield UNCONFIGURED → images_generated: 0, PDF still emits, no fetch", async () => {
    isConfigured.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_ONE_IMAGE,
    );
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    expect(genImage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toEqual([null]);
    fetchMock.mockRestore();
  });

  it("(d) generatePlatformImage returns {ok:false} → images_generated: 0, PDF still emits", async () => {
    genImage.mockResolvedValue({ ok: false, error: "generator temporarily down" });
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_ONE_IMAGE,
    );
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toEqual([null]);
  });

  it("(e) fetched URL has BAD content-type (image/webp) → skip, images_generated: 0", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.webp", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/webp", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_ONE_IMAGE,
    );
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toEqual([null]);
    fetchMock.mockRestore();
  });

  it("(f) per-run image budget REACHED → skips Higgsfield entirely, images_generated: 0", async () => {
    c.countResult.mockResolvedValue({ count: 2, error: null });
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_ONE_IMAGE,
    );
    expect(out.images_generated).toBe(0);
    expect(isConfigured).not.toHaveBeenCalled();
    expect(genImage).not.toHaveBeenCalled();
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toEqual([null]);
  });

  it("(g) mixed success/failure across TWO sections → generated count = 1, failed one is null", async () => {
    genImage
      .mockResolvedValueOnce({ ok: true, imageUrl: "https://cdn.example/a.png", cost_usd: 0.06, model: "seedream" })
      .mockResolvedValueOnce({ ok: false, error: "boom" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_TWO_IMAGES,
    );
    expect(out.images_generated).toBe(1);
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toHaveLength(2);
    expect(Buffer.isBuffer(resolved[0])).toBe(true);
    expect(resolved[1]).toBeNull();
    fetchMock.mockRestore();
  });

  it("(h) fetch throws mid-download → skip that image, PDF still emits (fail-soft catch)", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/one.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("net down"));
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_ONE_IMAGE,
    );
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    fetchMock.mockRestore();
  });
});

describe("deliverPdf — image gen bounds + prompt fidelity", () => {
  it("(i) the prompt is the concept VERBATIM — NO 'no text, no logos, no watermarks' suffix", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/one.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, {
      title: "Logos",
      filename: "logos.pdf",
      sections: [
        {
          heading: "Concept #1",
          body_markdown: "Wordmark.",
          image_concept: "a bold sans-serif wordmark logo reading ZAVI",
        },
      ],
    });
    const prompt = (genImage.mock.calls[0][1] as { prompt: string }).prompt;
    expect(prompt).toBe("a bold sans-serif wordmark logo reading ZAVI");
    expect(prompt).not.toContain("no logos");
    expect(prompt).not.toContain("no text");
    expect(prompt).not.toContain("no watermarks");
    fetchMock.mockRestore();
  });

  it("(j) per-call ceiling: 10 sections with concepts → at most MAX_SECTION_IMAGES generations requested", async () => {
    const { deliverPdf, MAX_SECTION_IMAGES } = await importDeliver();
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, {
      title: "Ten",
      filename: "ten.pdf",
      sections: Array.from({ length: 10 }, (_, i) => ({
        heading: `Concept #${i + 1}`,
        body_markdown: `Body ${i + 1}.`,
        image_concept: `concept ${i + 1}`,
      })),
    });
    expect(MAX_SECTION_IMAGES).toBeLessThan(10);
    expect(genImage).toHaveBeenCalledTimes(MAX_SECTION_IMAGES);
    expect(out.images_generated).toBe(MAX_SECTION_IMAGES);
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toHaveLength(10);
    expect(resolved.filter((b: Buffer | null) => b !== null)).toHaveLength(MAX_SECTION_IMAGES);
    expect(resolved[9]).toBeNull();
    fetchMock.mockRestore();
  });

  it("(k) the image download passes an abort signal (no unbounded fetch)", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/one.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_ONE_IMAGE);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example/one.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fetchMock.mockRestore();
  });
});

describe("deliverPdf — Higgsfield meter (attribution, idempotency, fail-closed)", () => {
  const keysCharged = () =>
    c.rpc.mock.calls.map((call) => (call[1] as { p_idempotency_key: string }).p_idempotency_key);

  const FOUR_SECTIONS = {
    title: "Four",
    filename: "four.pdf",
    sections: [0, 1, 2, 3].map((i) => ({
      heading: `S${i}`,
      body_markdown: "b",
      image_concept: `concept ${i}`,
    })),
  };

  it("meters against the RUN'S tenant, one DISTINCT key per image — 4 section images = 4 charges, not 1", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, FOUR_SECTIONS);

    expect(out.images_generated).toBe(4);
    const keys = keysCharged().sort();
    expect(keys.map((k) => k.split(":").slice(0, 3).join(":"))).toEqual([
      "run-1:pdf-image:0",
      "run-1:pdf-image:1",
      "run-1:pdf-image:2",
      "run-1:pdf-image:3",
    ]);
    expect(new Set(keys).size).toBe(4);
    for (const call of c.rpc.mock.calls) {
      expect(call[0]).toBe("consume_higgsfield_generate_or_reject");
      expect((call[1] as { p_tenant_id: string }).p_tenant_id).toBe("tenant-A");
    }
    fetchMock.mockRestore();
  });

  it("RETRY DOUBLE-SPEND: the same (run, image) claimed twice → 'charged' then 'already', and the vendor is NOT re-called", async () => {
    const claimed = new Set<string>();
    c.rpc.mockImplementation(async (_fn: string, args: { p_idempotency_key: string }) => {
      if (claimed.has(args.p_idempotency_key)) return { data: "already", error: null };
      claimed.add(args.p_idempotency_key);
      return { data: "charged", error: null };
    });
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();

    const first = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_ONE_IMAGE);
    expect(first.images_generated).toBe(1);
    expect(genImage).toHaveBeenCalledTimes(1);

    genImage.mockClear();
    const retry = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_ONE_IMAGE);
    expect(genImage).not.toHaveBeenCalled();
    expect(retry.images_generated).toBe(0);
    expect(retry.artifact_id).toBe("artifact-uuid-1");
    fetchMock.mockRestore();
  });

  it("FAIL CLOSED: the meter RPC errors → generatePlatformImage is NEVER called, PDF still emits text-only", async () => {
    c.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_TWO_IMAGES);

    expect(genImage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    fetchMock.mockRestore();
  });

  it("FAIL SOFT: over_cap skips THAT image, the PDF still ships and other images are unaffected", async () => {
    c.rpc.mockImplementation(async (_fn: string, args: { p_idempotency_key: string }) => ({
      data: args.p_idempotency_key.startsWith("run-1:pdf-image:0:") ? "charged" : "over_cap",
      error: null,
    }));
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_TWO_IMAGES);

    expect(genImage).toHaveBeenCalledTimes(1);
    expect(out.images_generated).toBe(1);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(Buffer.isBuffer(resolved[0])).toBe(true);
    expect(resolved[1]).toBeNull();
    fetchMock.mockRestore();
  });

  it("cap setting unset: the meter still caps the tenant at the built-in 100 a day, and the image under it is made", async () => {
    const prev = process.env.MEDIA_DAILY_GENERATE_CAP;
    delete process.env.MEDIA_DAILY_GENERATE_CAP;
    delete process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
    try {
      genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
      );
      const { deliverPdf } = await importDeliver();
      const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_ONE_IMAGE);
      expect(out.images_generated).toBe(1);
      expect(c.rpc).toHaveBeenCalledWith(
        "consume_higgsfield_generate_or_reject",
        expect.objectContaining({ p_daily_cap: 100, p_idempotency_key: expect.stringMatching(/^run-1:pdf-image:0:/) }),
      );
      fetchMock.mockRestore();
    } finally {
      if (prev === undefined) delete process.env.MEDIA_DAILY_GENERATE_CAP;
      else process.env.MEDIA_DAILY_GENERATE_CAP = prev;
    }
  });
});

describe("deliverPdf — logo_spec server-side SVG", () => {
  const circleLogo = (fill: string) => ({
    elements: [{ type: "circle", cx: 32, cy: 32, r: 20, fill }],
  });
  const ONE_LOGO = {
    title: "Logo",
    filename: "logo.pdf",
    sections: [
      { heading: "Concept #1", body_markdown: "A navy disc.", logo_spec: circleLogo("#123456") },
    ],
  };

  it("(L1) logo_spec rasterizes → renderer gets a Buffer, logo_rendered=1/logo_embedded=1, ZERO meter + ZERO vendor call", async () => {
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, ONE_LOGO);
    expect(out.logo_rendered).toBe(1);
    expect(out.logo_embedded).toBe(1);
    expect(out.images_generated).toBe(0);
    expect(genImage).not.toHaveBeenCalled();
    expect(c.rpc).not.toHaveBeenCalled();
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(Buffer.isBuffer(resolved[0])).toBe(true);
  });

  it("(L2) 6 logo sections ALL render — no 4-image cap on the free logo path (at the per-call max)", async () => {
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, {
      title: "Six",
      filename: "six.pdf",
      sections: Array.from({ length: 6 }, (_, i) => ({
        heading: `Logo ${i + 1}`,
        body_markdown: `Body ${i + 1}.`,
        logo_spec: circleLogo(i % 2 ? "#111111" : "#eeeeee"),
      })),
    });
    expect(out.logo_rendered).toBe(6);
    expect(c.rpc).not.toHaveBeenCalled();
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved.filter((b: Buffer | null) => b !== null)).toHaveLength(6);
  });

  it("(L3) section with BOTH logo_spec + image_concept → logo wins, Higgsfield NEVER metered or called", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, {
      title: "Both",
      filename: "both.pdf",
      sections: [
        {
          heading: "Both fields",
          body_markdown: "logo must win.",
          logo_spec: circleLogo("#222222"),
          image_concept: "a photographic office",
        },
      ],
    });
    expect(out.logo_rendered).toBe(1);
    expect(out.images_generated).toBe(0);
    expect(c.rpc).not.toHaveBeenCalled();
    expect(genImage).not.toHaveBeenCalled();
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(Buffer.isBuffer(resolved[0])).toBe(true);
    fetchMock.mockRestore();
  });

  it("(L4) invalid logo_spec is dropped (text-only), PDF still ships, no throw", async () => {
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, {
      title: "Bad",
      filename: "bad.pdf",
      sections: [
        {
          heading: "Bad spec",
          body_markdown: "still renders.",
          logo_spec: { elements: [{ type: "path", d: "</path><script>", fill: "url(http://evil)" }] },
        },
      ],
    });
    expect(out.logo_rendered).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toEqual([null]);
  });

  it("(L5) INVALID logo_spec + image_concept → NEVER meters a photo fallback (logo intent suppresses it), text-only", async () => {
    genImage.mockResolvedValue({ ok: true, imageUrl: "https://cdn.example/x.png", cost_usd: 0.06, model: "seedream" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockImageResponse("image/png", ONE_PIXEL_PNG_HEX),
    );
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, {
      title: "Bad+photo",
      filename: "badphoto.pdf",
      sections: [
        {
          heading: "Bad logo, has photo prompt",
          body_markdown: "text only.",
          logo_spec: { elements: [{ type: "circle", cx: 999999, cy: 1, r: 1 }] },
          image_concept: "a photographic office skyline",
        },
      ],
    });
    expect(c.rpc).not.toHaveBeenCalled();
    expect(genImage).not.toHaveBeenCalled();
    expect(out.images_generated).toBe(0);
    expect(out.logo_rendered).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    const [, resolved] = renderPdfMock.mock.calls[0];
    expect(resolved).toEqual([null]);
    fetchMock.mockRestore();
  });
});

describe("deliverPdf — media router + credit charge", () => {
  const DEADLINE_MS = 120_000;

  it("(R1) routes image.hero and charges only the images embedded in the delivered PDF", async () => {
    genImage.mockResolvedValue({
      ok: true,
      imageUrl: "https://cdn.example/x.png",
      cost_usd: 0.06,
      model: "seedream",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockImageResponse("image/png", ONE_PIXEL_PNG_HEX));
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_TWO_IMAGES,
    );

    expect(out.images_generated).toBe(2);
    expect(genImage).toHaveBeenNthCalledWith(1, "image.hero", {
      prompt: "concept one",
      aspect_ratio: "16:9",
    });
    expect(canAfford).toHaveBeenCalledTimes(2);
    expect(canAfford).toHaveBeenCalledWith("tenant-A", 0.06);

    expect(flushCharges).toHaveBeenCalledTimes(1);
    const charges = flushCharges.mock.calls[0][0] as Array<{
      key: string;
      cost_usd: number;
      task: string;
      tenant_id: string;
      run_id: string | null;
      model: string;
    }>;
    expect(charges.map((c) => c.key.split(":").slice(0, 3).join(":")).sort()).toEqual([
      "run-1:pdf-image:0",
      "run-1:pdf-image:1",
    ]);
    expect(charges[0]).toMatchObject({
      cost_usd: 0.06,
      task: "image.hero",
      tenant_id: "tenant-A",
      run_id: "run-1",
      model: "seedream",
    });
    expect(flushCharges.mock.invocationCallOrder[0]).toBeGreaterThan(
      c.upload.mock.invocationCallOrder[0],
    );
    expect(flushCharges.mock.invocationCallOrder[0]).toBeGreaterThan(
      c.upsert.mock.invocationCallOrder[0],
    );
    fetchMock.mockRestore();
  });

  it("(R2) an image that lands AFTER the deadline is neither embedded nor charged", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const late = new Promise<void>((res) => {
        release = res;
      });
      genImage
        .mockResolvedValueOnce({
          ok: true,
          imageUrl: "https://cdn.example/fast.png",
          cost_usd: 0.06,
          model: "seedream",
        })
        .mockImplementationOnce(async () => {
          await late;
          return {
            ok: true,
            imageUrl: "https://cdn.example/slow.png",
            cost_usd: 0.06,
            model: "seedream",
          };
        });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockImageResponse("image/png", ONE_PIXEL_PNG_HEX));
      const { deliverPdf } = await importDeliver();
      const pending = deliverPdf(
        { tenant_id: "tenant-A", run_id: "run-1" },
        INPUT_WITH_TWO_IMAGES,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
      release();
      const out = await pending;

      expect(out.images_generated).toBe(1);
      const [, resolved] = renderPdfMock.mock.calls[0];
      expect(Buffer.isBuffer(resolved[0])).toBe(true);
      expect(resolved[1]).toBeNull();
      const charges = flushCharges.mock.calls[0][0] as Array<{ key: string }>;
      expect(charges.map((x) => x.key.split(":").slice(0, 3).join(":"))).toEqual(["run-1:pdf-image:0"]);
      fetchMock.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("(R3) cannot afford → no vendor call, the PDF still ships, nothing is charged", async () => {
    canAfford.mockResolvedValue(false);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { deliverPdf } = await importDeliver();
    const out = await deliverPdf(
      { tenant_id: "tenant-A", run_id: "run-1" },
      INPUT_WITH_ONE_IMAGE,
    );
    expect(genImage).not.toHaveBeenCalled();
    expect(out.images_generated).toBe(0);
    expect(out.artifact_id).toBe("artifact-uuid-1");
    expect(flushCharges.mock.calls[0]?.[0] ?? []).toEqual([]);
    fetchMock.mockRestore();
  });

  it("(R4) a FAILED artifact store charges nothing", async () => {
    genImage.mockResolvedValue({
      ok: true,
      imageUrl: "https://cdn.example/x.png",
      cost_usd: 0.06,
      model: "seedream",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockImageResponse("image/png", ONE_PIXEL_PNG_HEX));
    c.upload.mockResolvedValue({ data: null, error: { message: "bucket down" } });
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_ONE_IMAGE),
    ).rejects.toThrow(/bucket down/);
    expect(genImage).toHaveBeenCalledTimes(1);
    expect(flushCharges).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("(R5) the run_artifacts row failing charges nothing either", async () => {
    genImage.mockResolvedValue({
      ok: true,
      imageUrl: "https://cdn.example/x.png",
      cost_usd: 0.06,
      model: "seedream",
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockImageResponse("image/png", ONE_PIXEL_PNG_HEX));
    c.upsert.mockReturnValue({
      select: () => ({
        single: () => Promise.resolve({ data: null, error: { message: "row rejected" } }),
      }),
    });
    const { deliverPdf } = await importDeliver();
    await expect(
      deliverPdf({ tenant_id: "tenant-A", run_id: "run-1" }, INPUT_WITH_ONE_IMAGE),
    ).rejects.toThrow(/row rejected/);
    expect(flushCharges).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
