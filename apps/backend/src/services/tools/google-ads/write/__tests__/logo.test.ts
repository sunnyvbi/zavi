import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { asTenantId } from "@/services/tenant-client";
import {
  imageDimensions,
  isForbiddenAddress,
  loadLogoBytes,
  logoPathBelongsTo,
  pinnedFetch,
  sha256Hex,
  storeLogo,
  validateLogo,
  type LogoStoreDeps,
} from "../_logo";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function pngHeader(width: number, height: number, padTo = 64): Buffer {
  const b = Buffer.alloc(Math.max(33, padTo));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, ...Buffer.alloc(9)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
}

describe("imageDimensions", () => {
  it("reads a PNG IHDR", () => {
    expect(imageDimensions(pngHeader(256, 256))).toEqual({ width: 256, height: 256 });
  });
  it("reads a JPEG SOF0 after an APP0 segment", () => {
    expect(imageDimensions(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it("returns null for garbage and for a truncated header", () => {
    expect(imageDimensions(Buffer.from("not an image at all"))).toBeNull();
    expect(imageDimensions(pngHeader(256, 256).subarray(0, 20))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe("validateLogo", () => {
  it("accepts a square PNG and a near-square JPEG within 1%", () => {
    expect(validateLogo(pngHeader(256, 256))).toEqual({ mime: "image/png", width: 256, height: 256 });
    expect(validateLogo(jpegHeader(1000, 995))).toEqual({ mime: "image/jpeg", width: 1000, height: 995 });
  });
  it.each([
    ["non-square", pngHeader(400, 200), /square/],
    ["too small", pngHeader(100, 100), /at least 128x128/],
    ["not an image", Buffer.from("GIF89a....................."), /not a PNG or JPEG/],
    ["empty", Buffer.alloc(0), /empty/],
    ["too large", pngHeader(256, 256, 5_120_001), /limit is 5120000/],
  ])("refuses %s in plain words", (_label, bytes, why) => {
    expect(() => validateLogo(bytes)).toThrow(why);
    try {
      validateLogo(bytes);
    } catch (e) {
      expect((e as { code: string }).code).toBe("google_ads_demand_gen_logo_invalid");
    }
  });
});

describe("isForbiddenAddress", () => {
  it.each(["10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::", "2001:0:abcd::1", "::10.0.0.1"])(
    "refuses %s",
    (ip) => expect(isForbiddenAddress(ip)).toBe(true),
  );
  it.each(["142.250.72.14", "2607:f8b0:4005:80a::200e"])("allows public %s", (ip) => expect(isForbiddenAddress(ip)).toBe(false));
});

type ReqCall = { url: URL; options: Record<string, unknown> };

function fakeRequest(res: { status: number; headers?: Record<string, string>; body?: Buffer; chunks?: Buffer[] }) {
  const calls: ReqCall[] = [];
  const fn = ((url: URL, options: Record<string, unknown>, cb: (r: unknown) => void) => {
    calls.push({ url, options });
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; destroyed: boolean };
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = () => {
      const stream = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      stream.statusCode = res.status;
      stream.headers = res.headers ?? {};
      setImmediate(() => {
        cb(stream);
        for (const c of res.chunks ?? (res.body ? [res.body] : [])) stream.write(c);
        stream.end();
      });
    };
    return req;
  }) as unknown as typeof https.request;
  return { fn, calls };
}

describe("pinnedFetch", () => {
  const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

  it("refuses a private resolution before connecting", async () => {
    const req = fakeRequest({ status: 200, headers: { "content-type": "image/png" }, body: pngHeader(256, 256) });
    await expect(
      pinnedFetch("https://logo.example.com/a.png", { lookup: async () => [{ address: "10.0.0.1", family: 4 }], request: req.fn }),
    ).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_url_refused" });
    expect(req.calls).toHaveLength(0);
  });

  it("refuses when ANY resolved address is private", async () => {
    const req = fakeRequest({ status: 200 });
    await expect(
      pinnedFetch("https://logo.example.com/a.png", {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }],
        request: req.fn,
      }),
    ).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_url_refused" });
    expect(req.calls).toHaveLength(0);
  });

  it.each([
    ["http", "http://logo.example.com/a.png"],
    ["credentials", "https://u:p@logo.example.com/a.png"],
    ["a non-443 port", "https://logo.example.com:8443/a.png"],
    ["a private literal", "https://127.0.0.1/a.png"],
    ["an IPv6 loopback literal", "https://[::1]/a.png"],
  ])("refuses %s without a lookup or connection", async (_l, url) => {
    const req = fakeRequest({ status: 200 });
    const lookup = vi.fn(publicLookup);
    await expect(pinnedFetch(url, { lookup, request: req.fn })).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_url_refused" });
    expect(req.calls).toHaveLength(0);
  });

  it("pins the connection to the vetted address, with SNI set to the host", async () => {
    const bytes = pngHeader(256, 256);
    const req = fakeRequest({ status: 200, headers: { "content-type": "image/png" }, body: bytes });
    const out = await pinnedFetch("https://logo.example.com/a.png", { lookup: publicLookup, request: req.fn });
    expect(out.bytes.equals(bytes)).toBe(true);
    expect(out.content_type).toBe("image/png");
    const opts = req.calls[0].options as { servername: string; agent: unknown; lookup: (...a: unknown[]) => void };
    expect(opts.servername).toBe("logo.example.com");
    expect(opts.agent).toBe(false);
    const single = vi.fn();
    opts.lookup("evil.internal", {}, single);
    expect(single).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    const all = vi.fn();
    opts.lookup("evil.internal", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses a redirect instead of following it", async () => {
    const req = fakeRequest({ status: 302, headers: { location: "http://169.254.169.254/" } });
    await expect(pinnedFetch("https://logo.example.com/a.png", { lookup: publicLookup, request: req.fn })).rejects.toMatchObject({
      code: "google_ads_demand_gen_logo_url_refused",
      message: expect.stringMatching(/redirects/),
    });
    expect(req.calls).toHaveLength(1);
  });

  it("refuses a non-image, a non-200 and an oversized body", async () => {
    const html = fakeRequest({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html>") });
    await expect(pinnedFetch("https://x.example.com/a", { lookup: publicLookup, request: html.fn })).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_fetch_failed" });
    const missing = fakeRequest({ status: 404 });
    await expect(pinnedFetch("https://x.example.com/a", { lookup: publicLookup, request: missing.fn })).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_fetch_failed" });
    const declared = fakeRequest({ status: 200, headers: { "content-type": "image/png", "content-length": "9999999" } });
    await expect(pinnedFetch("https://x.example.com/a", { lookup: publicLookup, request: declared.fn })).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_fetch_failed" });
    const streamed = fakeRequest({ status: 200, headers: { "content-type": "image/png" }, chunks: [Buffer.alloc(3_000_000), Buffer.alloc(3_000_000)] });
    await expect(pinnedFetch("https://x.example.com/a", { lookup: publicLookup, request: streamed.fn })).rejects.toMatchObject({
      code: "google_ads_demand_gen_logo_fetch_failed",
      message: expect.stringMatching(/larger than/),
    });
  });

  it("the deadline covers DNS too: a lookup that never answers never connects", async () => {
    const req = fakeRequest({ status: 200 });
    await expect(
      pinnedFetch("https://slow.example.com/a.png", { lookup: () => new Promise(() => {}), request: req.fn, deadlineMs: 30 }),
    ).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_fetch_failed", message: expect.stringMatching(/resolving slow\.example\.com took longer/) });
    expect(req.calls).toHaveLength(0);
  });

  it("gives up at the deadline", async () => {
    const hang = (() => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => {};
      req.destroy = () => {};
      return req;
    }) as unknown as typeof https.request;
    await expect(pinnedFetch("https://x.example.com/a", { lookup: publicLookup, request: hang, deadlineMs: 30 })).rejects.toMatchObject({
      code: "google_ads_demand_gen_logo_fetch_failed",
      message: expect.stringMatching(/longer than/),
    });
  });
});

function memoryBucket() {
  const objects = new Map<string, Buffer>();
  const upload = vi.fn(async (path: string, body: Buffer, _o: { contentType: string; upsert: boolean }) => {
    if (objects.has(path)) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
    objects.set(path, Buffer.from(body));
    return { data: { path }, error: null };
  });
  const download = vi.fn(async (path: string) => {
    const b = objects.get(path);
    if (!b) return { data: null, error: { message: "Object not found", statusCode: "404" } };
    return { data: new Blob([new Uint8Array(b)]), error: null };
  });
  const deps = { bucket: () => ({ upload, download }) } as unknown as LogoStoreDeps;
  return { objects, upload, download, deps };
}

describe("storeLogo / loadLogoBytes", () => {
  it("stores under <tenant>/logos/<sha256>.png without upsert and returns the ref", async () => {
    const m = memoryBucket();
    const bytes = pngHeader(256, 256);
    const ref = await storeLogo(asTenantId(T1), bytes, m.deps);
    const sha = sha256Hex(bytes);
    expect(ref).toEqual({ storage_path: `${T1}/logos/${sha}.png`, sha256: sha, mime: "image/png", width: 256, height: 256 });
    expect(m.upload).toHaveBeenCalledWith(ref.storage_path, bytes, { contentType: "image/png", upsert: false });
  });

  it("treats 'already exists' as success: the same bytes are the same object", async () => {
    const m = memoryBucket();
    const bytes = pngHeader(256, 256);
    const a = await storeLogo(asTenantId(T1), bytes, m.deps);
    const b = await storeLogo(asTenantId(T1), bytes, m.deps);
    expect(b).toEqual(a);
    expect(m.objects.size).toBe(1);
  });

  it("refuses an invalid logo before uploading anything", async () => {
    const m = memoryBucket();
    await expect(storeLogo(asTenantId(T1), pngHeader(300, 100), m.deps)).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_invalid" });
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("a real storage failure is not swallowed", async () => {
    const deps = { bucket: () => ({ upload: async () => ({ data: null, error: { message: "boom", statusCode: "500" } }), download: vi.fn() }) } as unknown as LogoStoreDeps;
    await expect(storeLogo(asTenantId(T1), pngHeader(256, 256), deps)).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_store_failed" });
  });

  it("loads the same bytes back and verifies the hash", async () => {
    const m = memoryBucket();
    const bytes = pngHeader(256, 256);
    const ref = await storeLogo(asTenantId(T1), bytes, m.deps);
    const out = await loadLogoBytes(asTenantId(T1), ref, m.deps);
    expect(out.bytes.equals(bytes)).toBe(true);
    expect(out.base64).toBe(bytes.toString("base64"));
  });

  it("a changed object fails with logo_mismatch", async () => {
    const m = memoryBucket();
    const ref = await storeLogo(asTenantId(T1), pngHeader(256, 256), m.deps);
    m.objects.set(ref.storage_path, pngHeader(512, 512));
    await expect(loadLogoBytes(asTenantId(T1), ref, m.deps)).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_mismatch" });
  });

  it("tenant isolation: another tenant's stored path is refused before any read", async () => {
    const m = memoryBucket();
    const ref = await storeLogo(asTenantId(T1), pngHeader(256, 256), m.deps);
    m.download.mockClear();
    await expect(loadLogoBytes(asTenantId(T2), ref, m.deps)).rejects.toMatchObject({
      code: "google_ads_demand_gen_logo_mismatch",
      message: expect.stringMatching(/another workspace/),
    });
    expect(m.download).not.toHaveBeenCalled();
    expect(logoPathBelongsTo(T2, ref.storage_path)).toBe(false);
    expect(logoPathBelongsTo(T1.toUpperCase(), ref.storage_path)).toBe(true);
    expect(logoPathBelongsTo(T1, `${T1}x/logos/${ref.sha256}.png`)).toBe(false);
  });

  it("a ref whose path and hash disagree is refused before any read", async () => {
    const m = memoryBucket();
    const ref = await storeLogo(asTenantId(T1), pngHeader(256, 256), m.deps);
    m.download.mockClear();
    await expect(loadLogoBytes(asTenantId(T1), { ...ref, sha256: "0".repeat(64) }, m.deps)).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_mismatch" });
    expect(m.download).not.toHaveBeenCalled();
  });

  it("a missing object is a mismatch; a storage outage is retryable", async () => {
    const m = memoryBucket();
    const bytes = pngHeader(256, 256);
    const sha = sha256Hex(bytes);
    const ref = { storage_path: `${T1}/logos/${sha}.png`, sha256: sha, mime: "image/png" as const, width: 256, height: 256 };
    await expect(loadLogoBytes(asTenantId(T1), ref, m.deps)).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_mismatch" });
    const down = { bucket: () => ({ upload: vi.fn(), download: async () => ({ data: null, error: { message: "upstream timeout", statusCode: "503" } }) }) } as unknown as LogoStoreDeps;
    await expect(loadLogoBytes(asTenantId(T1), ref, down)).rejects.toMatchObject({ code: "google_ads_demand_gen_logo_unavailable" });
  });
});
