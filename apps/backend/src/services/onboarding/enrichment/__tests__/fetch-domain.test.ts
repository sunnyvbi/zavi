
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchDomain, MAX_BYTES_PER_PAGE } from "../fetch-domain";

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    promises: { lookup: vi.fn() },
  };
});
import { promises as dns } from "node:dns";
const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

const originalFetch = globalThis.fetch;

function makeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { "content-type": "text/html" },
  });
}

function makeBigBody(totalBytes: number): Response {
  let emitted = 0;
  const chunkSize = 16 * 1024;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= totalBytes) {
        controller.close();
        return;
      }
      const remaining = totalBytes - emitted;
      const size = Math.min(chunkSize, remaining);
      controller.enqueue(new Uint8Array(size).fill(0x41));
      emitted += size;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

describe("fetchDomain", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches the allowlist and returns partial pages", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url as string).pathname;
      if (path === "/" || path === "/about") {
        return makeResponse(`<html><title>${path}</title><body>hello ${path}</body></html>`);
      }
      return makeResponse("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const r = await fetchDomain("acme.example");
    expect(r.pages_attempted).toBe(13);
    expect(r.pages_fetched).toBe(2);
    expect(r.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(["/", "/about"]);
  });

  it.each(["netlify.app", "framer.app", "carrd.co", "my.canva.site", "lovable.app", "glitch.me"])("fetches the business on %s, not its provider", async (suffix) => {
    const host = `example-clinic.${suffix}`;
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input)); seen.push(url.href);
      if (url.pathname === "/sitemap.xml") {
        return makeResponse(`<urlset><url><loc>https://${host}/solutions/patient-booking</loc></url><url><loc>https://other-clinic.${suffix}/solutions/other</loc></url></urlset>`, {headers:{"content-type":"application/xml"}});
      }
      if (url.pathname === "/" || url.pathname === "/solutions/patient-booking") {
        return makeResponse(`<html><title>Example Clinic</title><body>${url.pathname}</body></html>`);
      }
      return makeResponse("not found", {status:404});
    }) as typeof globalThis.fetch;
    const result = await fetchDomain(host);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => new URL(url).hostname === host)).toBe(true);
    expect(result.pages.map((page) => page.url)).toContain(`https://${host}/solutions/patient-booking`);
  });

  it("rejects redirects to another business on the same hosting provider", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input); seen.push(url);
      return makeResponse("", {status:302, headers:{location:"https://other-clinic.netlify.app/"}});
    }) as typeof globalThis.fetch;
    const result = await fetchDomain("example-clinic.netlify.app");
    expect(seen.every((url) => new URL(url).hostname === "example-clinic.netlify.app")).toBe(true);
    expect(result.pages).toEqual([]);
  });

  it.each(["example.com", "example-clinic.netlify.app"])("allows a business's www redirect for %s", async (host) => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/") return makeResponse("not found", {status:404});
      return url.hostname === host
        ? makeResponse("", {status:302, headers:{location:`https://www.${host}/`}})
        : makeResponse("<html><title>Example</title><body>Example company</body></html>");
    }) as typeof globalThis.fetch;
    expect((await fetchDomain(host)).pages.map((page) => page.url)).toContain(`https://www.${host}/`);
  });

  it("stream-cap aborts BEFORE downloading a 5MB body (stream byte counter)", async () => {
    let totalBytesYielded = 0;
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url as string).pathname;
      if (path === "/") {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (totalBytesYielded >= 10 * 1024 * 1024) {
              controller.close();
              return;
            }
            const chunk = new Uint8Array(16 * 1024).fill(0x42);
            totalBytesYielded += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
      }
      return makeResponse("nope", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    await fetchDomain("acme.example");
    const SLACK = 1024 * 1024;
    expect(totalBytesYielded).toBeLessThan(MAX_BYTES_PER_PAGE + SLACK);
    expect(totalBytesYielded).toBeLessThan(10 * 1024 * 1024);
  });

  it("404 on every path returns 0 pages and zero ssrf_blocked, never throws", async () => {
    globalThis.fetch = vi.fn(async () =>
      makeResponse("not found", { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await fetchDomain("acme.example");
    expect(r.pages_fetched).toBe(0);
    expect(r.ssrf_blocked).toBe(0);
    expect(r.aborted_reason).toBeUndefined();
  });

  it("counts ssrf-blocked attempts when DNS resolves to private IP", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    globalThis.fetch = vi.fn(async () =>
      makeResponse("never reached"),
    ) as unknown as typeof globalThis.fetch;
    const r = await fetchDomain("acme.example");
    expect(r.ssrf_blocked).toBe(r.pages_attempted);
    expect(r.pages_fetched).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects redirect to cross-eTLD+1 host", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url as string).pathname;
      if (path === "/about") {
        return makeResponse("", {
          status: 302,
          headers: { location: "https://attacker.example/", "content-type": "text/html" },
        });
      }
      return makeResponse("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const r = await fetchDomain("acme.example");
    expect(r.pages.map((p) => p.url).every((u) => !u.includes("attacker"))).toBe(true);
  });

  it("does NOT capture a page that redirects into a login wall (?next=)", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url as string).pathname;
      if (path === "/") {
        return makeResponse(`<html><title>Home</title><body>real home</body></html>`);
      }
      if (path === "/about") {
        return makeResponse("", {
          status: 302,
          headers: {
            location: "https://acme.example/login?next=%2Fabout",
            "content-type": "text/html",
          },
        });
      }
      if (path === "/login") {
        return makeResponse(`<html><title>Sign in</title><body>login page</body></html>`);
      }
      return makeResponse("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const r = await fetchDomain("acme.example");
    const paths = r.pages.map((p) => new URL(p.url).pathname);
    expect(paths).toContain("/");
    expect(paths.some((p) => p.startsWith("/login"))).toBe(false);
    expect(r.pages.every((p) => !p.text_excerpt.includes("login page"))).toBe(true);
  });

  it("dedupes pages with identical title + excerpt (keeps one)", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url as string).pathname;
      if (["/", "/about", "/help", "/contact"].includes(path)) {
        return makeResponse(`<html><title>Acme</title><body>same catch-all body</body></html>`);
      }
      return makeResponse("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const r = await fetchDomain("acme.example");
    expect(r.pages.length).toBe(1);
    expect(r.pages[0].title).toBe("Acme");
  });
});
