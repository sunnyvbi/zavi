import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { rateLimit } from "express-rate-limit";
import { ipBucket, tokenIpKey, tokenRateKey, tokenPerClientRateLimit } from "../token-rate-limit";

const req = (body: unknown, ip = "203.0.113.7") => ({ body, ip }) as any;

describe("tokenRateKey", () => {
  it("keys by client_id and source IP when the request names a client", () => {
    expect(tokenRateKey(req({ client_id: "abc" }))).toBe("client:abc|ip:203.0.113.7");
    expect(tokenRateKey(req({ client_id: "abc" }, "198.51.100.9"))).toBe("client:abc|ip:198.51.100.9");
  });
  it("groups IPv6 callers to their /64 for both limits", () => {
    expect(tokenRateKey(req({ client_id: "abc" }, "2001:db8:0:1::5"))).toBe("client:abc|ip:2001:db8:0:1::/64");
    expect(tokenIpKey(req({}, "2001:db8:0:1::5"))).toBe(tokenIpKey(req({}, "2001:db8:0:1:ffff::9")));
  });
  it("falls back to the IP without a usable client_id", () => {
    expect(tokenRateKey(req({}))).toBe("ip:203.0.113.7");
    expect(tokenRateKey(req({ client_id: "" }))).toBe("ip:203.0.113.7");
    expect(tokenRateKey(req({ client_id: "x".repeat(201) }))).toBe("ip:203.0.113.7");
    expect(tokenRateKey(req(undefined))).toBe("ip:203.0.113.7");
  });
});

describe("ipBucket", () => {
  it("keeps IPv4 and groups IPv6 to its /64", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("2001:db8:0:1:aaaa::1")).toBe("2001:db8:0:1::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("2001:0DB8:0000:0001:1:2:3:4")).toBe("2001:db8:0:1::/64");
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:198.51.100.9")).not.toBe(ipBucket("::ffff:203.0.113.7"));
  });
});

describe("per-IP /token ceiling", () => {
  it("counts every address in one IPv6 /64 together, whatever client_id they send", () => {
    const keys = ["2001:db8:0:1::1", "2001:db8:0:1::2", "2001:db8:0:1:ffff::3"].map((ip) => tokenIpKey(req({}, ip)));
    expect(new Set(keys).size).toBe(1);
  });
});

describe("per-client /token limit", () => {
  it("one client hitting its limit does not block another client on the same IP", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(rateLimit({ ...tokenPerClientRateLimit, max: 2 }));
    app.post("/token", (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const send = async (client_id: string) =>
      (
        await fetch(`http://127.0.0.1:${port}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id, grant_type: "refresh_token" }),
        })
      ).status;
    try {
      expect(await send("a")).toBe(200);
      expect(await send("a")).toBe(200);
      expect(await send("a")).toBe(429);
      expect(await send("b")).toBe(200);
    } finally {
      server.close();
    }
  });
});
