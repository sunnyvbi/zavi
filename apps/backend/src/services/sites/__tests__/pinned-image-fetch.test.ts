import { describe, expect, it, vi } from "vitest";
import { fetchPublicImage, isPublicAddress, pinnedLookup, type PinnedFetchDeps } from "../pinned-image-fetch";

function deps(addrs: Array<{ address: string; family: number }>, body: Uint8Array | null = new Uint8Array([1, 2, 3])) {
  const get = vi.fn<Parameters<PinnedFetchDeps["get"]>, ReturnType<PinnedFetchDeps["get"]>>(async () => ({ status: 200, type: "image/png", bytes: body }));
  const resolve = vi.fn<Parameters<PinnedFetchDeps["resolve"]>, ReturnType<PinnedFetchDeps["resolve"]>>(async () => addrs);
  return { resolve, get } satisfies PinnedFetchDeps;
}

describe("fetchPublicImage", () => {
  it("connects to the vetted public address", async () => {
    const d = deps([{ address: "93.184.216.34", family: 4 }]);
    expect(await fetchPublicImage("https://photos.example/a.png", d)).toEqual(new Uint8Array([1, 2, 3]));
    expect(d.get).toHaveBeenCalledWith(expect.any(URL), "93.184.216.34", 4);
  });

  it("refuses private, mixed and unusual addresses before connecting", async () => {
    for (const a of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fd00::1", "192.168.1.1", "::ffff:7f00:1", "::ffff:127.0.0.1", "febf::1", "64:ff9b::a00:1", "::ffff:0:127.0.0.1"]) {
      const d = deps([{ address: "93.184.216.34", family: 4 }, { address: a, family: a.includes(":") ? 6 : 4 }]);
      expect(await fetchPublicImage("https://photos.example/a.png", d)).toBeNull();
      expect(d.get).not.toHaveBeenCalled();
    }
    const d = deps([{ address: "93.184.216.34", family: 4 }]);
    for (const u of ["http://photos.example/a.png", "https://user:pw@photos.example/a.png", "https://photos.example:8443/a.png", "not a url"]) {
      expect(await fetchPublicImage(u, d)).toBeNull();
    }
    expect(d.get).not.toHaveBeenCalled();
  });

  it("classifies addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  it("returns nothing for an empty answer", async () => {
    expect(await fetchPublicImage("https://photos.example/a.png", deps([{ address: "93.184.216.34", family: 4 }], null))).toBeNull();
  });
});

describe("pinnedLookup", () => {
  it("answers both callback shapes with the vetted address", () => {
    const lookup = pinnedLookup("93.184.216.34", 4) as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void;
    const single: unknown[] = [];
    lookup("example.com", {}, (...a) => single.push(...a));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    const all: unknown[] = [];
    lookup("example.com", { all: true }, (...a) => all.push(...a));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });

  it("lets a real request connect through it (Node asks with all: true)", async () => {
    const { createServer, request } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end("png");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(
          { host: "pinned.example", port, path: "/x.png", lookup: pinnedLookup("127.0.0.1", 4) },
          (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve(b));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("png");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
