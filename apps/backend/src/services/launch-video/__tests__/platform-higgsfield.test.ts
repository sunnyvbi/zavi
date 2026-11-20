import { describe, it, expect, afterEach, vi } from "vitest";

const mcp = vi.hoisted(() => ({
  isPlatformMcpConfigured: vi.fn(),
  generateMcpImage: vi.fn(),
}));
vi.mock("../platform-higgsfield-mcp", () => mcp);

import {
  generatePlatformTts,
  generatePlatformImage,
  isPlatformHiggsfieldConfigured,
  isPlatformTtsAvailable,
  PLATFORM_TTS_UNAVAILABLE_REASON,
} from "../platform-higgsfield";

const ORIG_KEY = process.env.HIGGSFIELD_API_KEY;

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.HIGGSFIELD_API_KEY;
  else process.env.HIGGSFIELD_API_KEY = ORIG_KEY;
  vi.restoreAllMocks();
  mcp.isPlatformMcpConfigured.mockReset();
  mcp.generateMcpImage.mockReset();
});

describe("generatePlatformImage — MCP only, never the REST/Developer API", () => {
  it("returns the MCP result and makes no REST call, even with a REST key set", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    mcp.isPlatformMcpConfigured.mockResolvedValue(true);
    mcp.generateMcpImage.mockResolvedValue({ ok: true, url: "https://cdn/i.png", jobId: "j1" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await generatePlatformImage({ prompt: "a red apple", aspect_ratio: "1:1" });
    expect(r).toMatchObject({ ok: true, imageUrl: "https://cdn/i.png", jobId: "j1" });
    expect(mcp.generateMcpImage).toHaveBeenCalledWith({ prompt: "a red apple", aspect_ratio: "1:1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an MCP failure as-is instead of falling back to REST", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    mcp.generateMcpImage.mockResolvedValue({
      ok: false,
      error: "higgsfield MCP platform credential not configured",
      reason: "credential_rejected",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await generatePlatformImage({ prompt: "x" });
    expect(r).toMatchObject({ ok: false, reason: "credential_rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("turns a thrown token read into ok:false, not a REST call", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    mcp.generateMcpImage.mockRejectedValue(new Error("get_platform_secret failed: timeout"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await generatePlatformImage({ prompt: "x" });
    expect(r).toMatchObject({ ok: false, reason: "vendor_error" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("isPlatformHiggsfieldConfigured — follows the MCP credential, not the REST key", () => {
  it("is true with no REST key when MCP is configured", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    mcp.isPlatformMcpConfigured.mockResolvedValue(true);
    expect(await isPlatformHiggsfieldConfigured()).toBe(true);
  });

  it("is false with a REST key when MCP is not configured", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    mcp.isPlatformMcpConfigured.mockResolvedValue(false);
    expect(await isPlatformHiggsfieldConfigured()).toBe(false);
  });

  it("is false, not a throw, when the token read fails", async () => {
    mcp.isPlatformMcpConfigured.mockRejectedValue(new Error("db down"));
    expect(await isPlatformHiggsfieldConfigured()).toBe(false);
  });
});

const TTS_ARGS = { variant: "elevenlabs", voice_type: "preset", voice_id: "v1", prompt: "hi" } as const;

describe("generatePlatformTts — a real call, and an honest failure", () => {
  it("returns ok:false when the platform key is unset, distinctly from a vendor failure", async () => {
    delete process.env.HIGGSFIELD_API_KEY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await generatePlatformTts({ ...TTS_ARGS });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/HIGGSFIELD_API_KEY/);
      expect(r.reason).toBe("not_configured");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("degrades to ok:false and never throws when the network is down", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const r = await generatePlatformTts({ ...TTS_ARGS });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/TTS submit failed/i);
      expect(r.reason).toBe("vendor_error");
    }
  });

  it("cannot report success without making a network call", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in test"));
    const r = await generatePlatformTts({ ...TTS_ARGS });
    if (r.ok) {
      expect(
        fetchSpy,
        "generatePlatformTts returned ok:true with no HTTP call — that audioUrl is fabricated, not generated",
      ).toHaveBeenCalled();
    } else {
      expect(r.ok).toBe(false);
    }
  });

  it("cannot report failure without making a network call either", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in test"));
    const r = await generatePlatformTts({ ...TTS_ARGS });
    expect(r.ok).toBe(false);
    expect(
      fetchSpy,
      "generatePlatformTts failed without attempting a request — a canned failure can never notice a fixed credential",
    ).toHaveBeenCalled();
  });

  it("POSTs the TTS job to the fnf endpoint that actually serves text2speech_v2", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const submit = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: "Invalid or expired token" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((...args) => submit(...args));

    await generatePlatformTts({ ...TTS_ARGS });

    const [url, init] = submit.mock.calls[0];
    expect(url).toBe("https://fnf.higgsfield.ai/developer/v2alpha/audios/text2speech_v2/generations");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Key key:secret");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.params.prompt).toBe("hi");
    expect(body.params.variant).toBe("elevenlabs");
  });

  it("reports a rejected credential as credential_rejected, not as 'no endpoint'", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: "Invalid or expired token" }),
    } as unknown as Response);

    const r = await generatePlatformTts({ ...TTS_ARGS });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("credential_rejected");
      expect(r.error).toMatch(/401/);
      expect(r.error).toMatch(/Invalid or expired token/i);
    }
  });

  it("produces real audio the moment the credential works — no code change needed", async () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    const submit = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ id: "job_1" }),
    });
    const poll = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ status: "completed", audio: { url: "https://cdn/vo.mp3" }, credits: 0.3 }),
    });
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((...args) => (n++ === 0 ? submit(...args) : poll(...args)));

    const r = await generatePlatformTts({ ...TTS_ARGS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audioUrl).toBe("https://cdn/vo.mp3");
      expect(r.credits).toBe(0.3);
    }
    expect(poll.mock.calls[0][0]).toBe("https://fnf.higgsfield.ai/developer/v2alpha/jobs/job_1");
  }, 10_000);

  it("PLATFORM_TTS_UNAVAILABLE_REASON names the credential, not a missing endpoint", () => {
    expect(PLATFORM_TTS_UNAVAILABLE_REASON).toMatch(/credential/i);
    expect(PLATFORM_TTS_UNAVAILABLE_REASON).toMatch(/401/);
    expect(PLATFORM_TTS_UNAVAILABLE_REASON).toMatch(/text2speech_v2/);
    expect(PLATFORM_TTS_UNAVAILABLE_REASON).toMatch(/fnf\.higgsfield\.ai/);
    expect(PLATFORM_TTS_UNAVAILABLE_REASON).not.toMatch(/no text-to-speech endpoint/i);
    expect(PLATFORM_TTS_UNAVAILABLE_REASON).not.toMatch(/pending/i);
  });

  it("isPlatformTtsAvailable() is a config gate, not a hard-coded 'impossible'", () => {
    process.env.HIGGSFIELD_API_KEY = "key:secret";
    expect(isPlatformTtsAvailable()).toBe(true);
    delete process.env.HIGGSFIELD_API_KEY;
    expect(isPlatformTtsAvailable()).toBe(false);
  });
});
