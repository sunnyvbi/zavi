
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isPrivateIp, assertSafeUrl, SsrfBlockedError } from "../url-guard";

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    promises: {
      lookup: vi.fn(),
    },
  };
});
import { promises as dns } from "node:dns";
const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

describe("isPrivateIp", () => {
  it("blocks IMDS 169.254.169.254", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("blocks IPv4 loopback 127.0.0.1", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("blocks RFC1918 10.x", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
  });

  it("blocks RFC1918 172.16-31.x", () => {
    expect(isPrivateIp("172.16.5.10")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  it("blocks RFC1918 192.168.x", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("blocks CGNAT 100.64.x", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
  });

  it("blocks IPv6 loopback ::1", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("blocks IPv6 link-local fe80::", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("blocks IPv6 ULA fc00::/7", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456::1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 of a private v4", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("allows a valid public IPv4 (1.1.1.1 Cloudflare)", () => {
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });

  it("allows a valid public IPv6 (2606:4700::1111)", () => {
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
  });
});

describe("assertSafeUrl", () => {
  beforeEach(() => mockLookup.mockReset());

  it("rejects non-https schemes (http)", async () => {
    await expect(assertSafeUrl("http://example.com")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertSafeUrl("http://example.com")).rejects.toMatchObject({ code: "ssrf_scheme" });
  });

  it("rejects javascript: scheme", async () => {
    await expect(assertSafeUrl("javascript:alert(1)")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects file: scheme", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects literal IMDS IP", async () => {
    await expect(assertSafeUrl("https://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects literal IPv4 loopback", async () => {
    await expect(assertSafeUrl("https://127.0.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects hostname that resolves to a private IP (DNS-rebind classic)", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSafeUrl("https://localhost.attacker.example/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects hostname where ANY resolved address is private (mixed result)", async () => {
    mockLookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(assertSafeUrl("https://mixed.example/")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects when DNS returns no addresses", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(assertSafeUrl("https://empty.example/")).rejects.toMatchObject({
      code: "ssrf_dns_failed",
    });
  });

  it("rejects malformed URL", async () => {
    await expect(assertSafeUrl("not-a-url")).rejects.toMatchObject({ code: "ssrf_parse" });
  });

  it("allows a valid public hostname (resolves to public IPs)", async () => {
    mockLookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const u = await assertSafeUrl("https://one.one.one.one/");
    expect(u.hostname).toBe("one.one.one.one");
  });
});

describe("assertSafeUrl: bracketed IPv6 literals are checked as IPs", () => {
  it.each(["https://[::1]/", "https://[fd00::1]/x", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/"])(
    "%s is blocked as a private IP, not as a DNS failure",
    async (u) => {
      await expect(assertSafeUrl(u)).rejects.toMatchObject({ code: "ssrf_blocked" });
    },
  );

  it("a public IPv6 literal passes without a lookup", async () => {
    await expect(assertSafeUrl("https://[2606:4700:4700::1111]/")).resolves.toBeInstanceOf(URL);
  });
});

import { isPrivateIp as isPrivateIpV6, ipv6Hextets } from "../url-guard";
describe("IPv6: every spelling judged by its bytes", () => {
  it("blocks loopback, mapped, compatible, NAT64/6to4 of private v4, ULA, link-local, site-local, multicast", () => {
    for (const ip of [
      "::1", "0:0:0:0:0:0:0:1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1",
      "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1", "fd12::1", "fc00::1", "fe80::1%en0",
      "febf::1", "fec0::1", "feff::1", "ff02::1", "2001:db8::1", "not:an:ip",
    ]) {
      expect(isPrivateIpV6(ip), ip).toBe(true);
    }
  });
  it("allows public addresses, including mapped/NAT64 of public v4", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:93.184.216.34", "64:ff9b::5db8:d822"]) {
      expect(isPrivateIpV6(ip), ip).toBe(false);
    }
  });
  it("expands compressed and embedded forms", () => {
    expect(ipv6Hextets("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(ipv6Hextets("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Hextets("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});
