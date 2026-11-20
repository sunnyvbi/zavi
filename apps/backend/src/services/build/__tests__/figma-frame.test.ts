import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sharp from "sharp";

const getSecret = vi.fn();
vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { exportFigmaFrame } from "../figma-frame";
import { parseFigmaFrameUrl, parseFigmaFrameRef } from "@zavi/shared";

const TOKEN = "figd_SECRET_token_value_1234567890";
const REF = { file_key: "AbCdEf1234567890XYZ", node_id: "12:34" };
const IMAGE_URL = "https://93.184.216.34/figma/render.png";

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
}

function figmaJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let logSpies: Array<{ mock: { calls: unknown[][] }; mockRestore(): void }> = [];

function everyLogArg(): string {
  return logSpies
    .flatMap((s) => s.mock.calls)
    .map((args) => JSON.stringify(args, (_k, v) => (v instanceof Error ? `${v.name}:${v.message}` : v)))
    .join("\n");
}

beforeEach(() => {
  getSecret.mockReset();
  fetchMock.mockReset();
  getSecret.mockResolvedValue(TOKEN);
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  for (const s of logSpies) s.mockRestore();
});

describe("exportFigmaFrame", () => {
  it("exports the frame with the tenant token, fetches the returned render and normalizes it to a jpeg", async () => {
    const bytes = await png();
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.figma.com/")) return figmaJson({ err: null, images: { "12:34": IMAGE_URL } });
      if (u === IMAGE_URL) return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
      throw new Error(`unexpected fetch ${u}`);
    });
    const result = await exportFigmaFrame("tnt-1", REF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const [apiUrl, apiInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(apiUrl).toBe("https://api.figma.com/v1/images/AbCdEf1234567890XYZ?ids=12%3A34&format=png&scale=2");
    expect((apiInit.headers as Record<string, string>)["X-Figma-Token"]).toBe(TOKEN);
    expect(getSecret).toHaveBeenCalledWith("tnt-1", "figma.api_key");
    const [imgUrl, imgInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(imgUrl)).toBe(IMAGE_URL);
    expect(JSON.stringify(imgInit ?? {})).not.toContain(TOKEN);
    expect(everyLogArg()).not.toContain(TOKEN);
  });

  it.each([
    [403, "figma_key_rejected"],
    [401, "figma_key_rejected"],
    [404, "figma_not_found"],
    [429, "figma_rate_limited"],
    [500, "figma_failed"],
  ] as const)("Figma %i returns safe retry guidance, never a throw, and the token never reaches a log", async (status, code) => {
    fetchMock.mockResolvedValue(figmaJson({ status, err: `Invalid token ${TOKEN}` }, status));
    const result = await exportFigmaFrame("tnt-1", REF);
    expect(result).toMatchObject({ ok: false, code });
    if (!result.ok) expect(result.note).toMatch(/try/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logSpies.some((s) => s.mock.calls.length > 0)).toBe(true);
    expect(everyLogArg()).not.toContain(TOKEN);
    expect(everyLogArg()).not.toContain("Invalid token");
    expect(everyLogArg()).toContain("build_figma_frame_failed");
  });

  it("not connected is a soft note and makes no network call", async () => {
    getSecret.mockResolvedValue(null);
    const result = await exportFigmaFrame("tnt-1", REF);
    expect(result).toMatchObject({ ok: false, code: "figma_not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Figma call that hangs past the deadline gives up as a timeout note", async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const result = await exportFigmaFrame("tnt-1", REF, { deadlineMs: 30 });
    expect(result).toMatchObject({ ok: false, code: "figma_timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a network failure reaching Figma is a timeout note", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await exportFigmaFrame("tnt-1", REF);
    expect(result).toMatchObject({ ok: false, code: "figma_timeout" });
  });

  it("a render URL pointing at a private address is refused before any fetch of it", async () => {
    for (const evil of ["https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/x.png", "https://10.0.0.5/x.png"]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(figmaJson({ err: null, images: { "12:34": evil } }));
      const result = await exportFigmaFrame("tnt-1", REF);
      expect(result).toMatchObject({ ok: false, code: "figma_image_unavailable" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.figma\.com\//);
    }
  });

  it("a non-https render URL or a null render is never fetched", async () => {
    for (const images of [{ "12:34": "http://93.184.216.34/x.png" }, { "12:34": null }, {}, { "99:1": IMAGE_URL }]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(figmaJson({ err: null, images }));
      const result = await exportFigmaFrame("tnt-1", REF);
      expect(result).toMatchObject({ ok: false, code: "figma_not_found" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("a render over the size cap or not an image is a soft note", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    for (const res of [
      () => new Response(big, { status: 200, headers: { "content-type": "image/png" } }),
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response("", { status: 302, headers: { location: "https://10.0.0.1/" } }),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (url: string | URL) =>
        String(url).startsWith("https://api.figma.com/") ? figmaJson({ err: null, images: { "12:34": IMAGE_URL } }) : res(),
      );
      const result = await exportFigmaFrame("tnt-1", REF);
      expect(result).toMatchObject({ ok: false, code: "figma_image_unavailable" });
    }
  });

  it("a malformed ref or one carrying a client image URL is refused before any secret read or fetch", async () => {
    for (const raw of [
      null,
      "https://www.figma.com/design/AbCdEf1234567890XYZ/x?node-id=12-34",
      { file_key: "AbCdEf1234567890XYZ" },
      { file_key: "../../v1/me", node_id: "12:34" },
      { file_key: "AbCdEf1234567890XYZ", node_id: "12:34&ids=1" },
      { file_key: "AbCdEf1234567890XYZ", node_id: "12:34", image_url: IMAGE_URL },
    ]) {
      const result = await exportFigmaFrame("tnt-1", raw);
      expect(result).toMatchObject({ ok: false, code: "figma_link_invalid" });
    }
    expect(getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Figma link parser", () => {
  it("accepts https figma.com design and file links with a node-id and normalizes 12-34 to 12:34", () => {
    expect(parseFigmaFrameUrl("https://www.figma.com/design/AbCdEf1234567890XYZ/Landing?node-id=12-34&t=abc")).toEqual(REF);
    expect(parseFigmaFrameUrl("  https://figma.com/file/AbCdEf1234567890XYZ/Landing?node-id=12%3A34  ")).toEqual(REF);
    expect(parseFigmaFrameRef({ file_key: "AbCdEf1234567890XYZ", node_id: "12-34" })).toEqual(REF);
  });

  it.each([
    "http://www.figma.com/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://www.figma.com/design/AbCdEf1234567890XYZ/x",
    "https://www.figma.com/design/AbCdEf1234567890XYZ/x?node-id=abc",
    "https://evil.com/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://figma.com.evil.com/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://evilfigma.com/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://www.figma.com@169.254.169.254/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://user:pw@www.figma.com/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://www.figma.com:8443/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://www.figma.com/proto/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://www.figma.com/design/short/x?node-id=12-34",
    "https://api.figma.com/v1/images/AbCdEf1234567890XYZ?ids=12:34",
    "javascript:alert(1)",
    "",
  ])("rejects %s", (url) => {
    expect(parseFigmaFrameUrl(url)).toBeNull();
  });
});
