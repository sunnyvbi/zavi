import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import net from "node:net";
import { safeAddress, startGuardProxy, type GuardProxy } from "../guard-proxy";

let proxy: GuardProxy;
let secret: http.Server;
let secretPort = 0;
let hits = 0;

beforeAll(async () => {
  secret = http.createServer((_q, r) => {
    hits++;
    r.end("router admin");
  });
  await new Promise<void>((r) => secret.listen(0, "127.0.0.1", () => r()));
  secretPort = (secret.address() as net.AddressInfo).port;
  proxy = await startGuardProxy({ resolve: async (h) => (h === "rebind.example" ? ["127.0.0.1"] : h === "public.example" ? ["93.184.216.34"] : []) });
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => secret.close(() => r()));
});

const viaProxy = (path: string) =>
  new Promise<number>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: proxy.port, method: "GET", path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(-1));
    req.end();
  });

const connectVia = (target: string) =>
  new Promise<string>((resolve) => {
    const s = net.connect(proxy.port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      resolve(d.toString().split("\r\n")[0]);
      s.destroy();
    });
    s.on("error", () => resolve("error"));
  });

describe("guard proxy", () => {
  it("refuses loopback, private, link-local and metadata addresses, and rebinding names", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1"]) {
      expect(await safeAddress(ip), ip).toBeNull();
    }
    expect(await safeAddress("localhost")).toBeNull();
    expect(await safeAddress("printer.local")).toBeNull();
    expect(await safeAddress("rebind.example", async () => ["127.0.0.1"])).toBeNull();
    expect(await safeAddress("public.example", async () => ["93.184.216.34"])).toBe("93.184.216.34");
  });
  it("a plain-HTTP request to a local service never reaches it", async () => {
    expect(await viaProxy(`http://127.0.0.1:${secretPort}/admin`)).toBe(403);
    expect(await viaProxy(`http://rebind.example/admin`)).toBe(403);
    expect(hits).toBe(0);
  });
  it("CONNECT (https, wss) to a private host or an odd port is refused", async () => {
    expect(await connectVia(`127.0.0.1:${secretPort}`)).toContain("403");
    expect(await connectVia("rebind.example:443")).toContain("403");
    expect(await connectVia("public.example:22")).toContain("403");
    expect(hits).toBe(0);
    expect(proxy.blocked()).toBeGreaterThanOrEqual(5);
  });
});
