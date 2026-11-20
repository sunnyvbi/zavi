import { describe, it, expect, vi, beforeEach } from "vitest";
const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a: unknown[]) => lookup(...a) }));
import { isPrivateAddress, safeFetchImage } from "../vendors/safe-fetch";

describe("safeFetchImage", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); lookup.mockReset(); });
  it("classifies private, loopback, link-local, CGNAT, metadata and ULA addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("rejects non-https without any network call", async () => {
    expect(await safeFetchImage("http://example.com/a.png")).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
  it("rejects a host that resolves to a private address", async () => {
    lookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    expect(await safeFetchImage("https://metadata.evil/a.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not follow redirects and requires an image content-type", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }));
    expect(await safeFetchImage("https://ex.com/a.png")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await safeFetchImage("https://ex.com/a.png")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "image/png" } }));
    expect((await safeFetchImage("https://ex.com/a.png"))?.mime).toBe("image/png");
    expect(fetchMock.mock.calls.at(-1)[1].redirect).toBe("manual");
  });
  it("refuses an oversize body without buffering it all: declared or streamed", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) } }));
    expect(await safeFetchImage("https://ex.com/a.png")).toBeNull();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(endless, { status: 200, headers: { "content-type": "image/png" } }));
    expect(await safeFetchImage("https://ex.com/a.png")).toBeNull();
    expect(pulled).toBeLessThan(20);
  });
});
