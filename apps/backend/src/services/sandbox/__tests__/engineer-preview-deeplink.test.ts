import { describe, it, expect } from "vitest";
import {
  sanitizePreviewPath,
  derivePreviewPathFromFiles,
  deriveMarkersForPath,
} from "../engineer-preview";

describe("sanitizePreviewPath — accepts only unambiguous same-origin paths", () => {
  it.each([
    ["/", "/"],
    ["/tutor/bookings", "/tutor/bookings"],
    ["/settings/billing", "/settings/billing"],
    ["/search?q=hello", "/search?q=hello"],
    ["  /trimmed  ", "/trimmed"],
    ["/page#section", "/page"],
    ["/a%20b", "/a%20b"],
  ])("keeps %j -> %j", (input, expected) => {
    expect(sanitizePreviewPath(input)).toBe(expected);
  });
});

describe("sanitizePreviewPath — rejects everything that could escape the origin", () => {
  it.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox(1)"],
    ["https://evil.com/steal"],
    ["http://evil.com"],
    ["//evil.com"],
    ["///evil.com"],
    ["/\\evil.com"],
    ["\\\\evil.com"],
    ["/path\\to"],
    ["/../../etc/passwd"],
    ["/a/../../../secret"],
    ["/%2e%2e%2fetc%2fpasswd"],
    ["/%2E%2E/"],
    ["/..%2f.."],
    ["relative/path"],
    [""],
    ["   "],
    [null],
    [undefined],
    [42],
    [{ path: "/x" }],
    [["/x"]],
  ])("rejects %j", (input) => {
    expect(sanitizePreviewPath(input as unknown)).toBeNull();
  });

  it("rejects control characters (CR/LF/NUL) that enable header + parser splitting", () => {
    expect(sanitizePreviewPath(`/ok${String.fromCharCode(0)}`)).toBeNull();
    expect(sanitizePreviewPath(`/ok${String.fromCharCode(13)}${String.fromCharCode(10)}`)).toBeNull();
    expect(sanitizePreviewPath(`/ok${String.fromCharCode(127)}`)).toBeNull();
    expect(sanitizePreviewPath("/ok%0d%0aSet-Cookie:%20x=1")).toBeNull();
  });

  it("rejects an over-long path", () => {
    expect(sanitizePreviewPath(`/${"a".repeat(400)}`)).toBeNull();
  });

  it("rejects a malformed percent-escape rather than throwing", () => {
    expect(sanitizePreviewPath("/bad%")).toBeNull();
    expect(sanitizePreviewPath("/bad%zz")).toBeNull();
  });

  it("never returns a value that could be read as protocol-relative", () => {
    for (const probe of ["//x", "/\\x", "/%2f%2fx"]) {
      const out = sanitizePreviewPath(probe);
      expect(out === null || !out.startsWith("//")).toBe(true);
    }
  });
});

describe("__pt is a reserved query param and cannot be smuggled via preview_path", () => {
  const buildProxyUrl = (rawPath: string | null, token: string): string => {
    const target = sanitizePreviewPath(rawPath) ?? "/";
    const qIdx = target.indexOf("?");
    const targetPath = qIdx === -1 ? target : target.slice(0, qIdx);
    const params = new URLSearchParams(qIdx === -1 ? "" : target.slice(qIdx + 1));
    params.delete("__pt");
    params.set("__pt", token);
    return `/prefix${targetPath}?${params.toString()}`;
  };

  it("emits exactly ONE __pt, ours, even when the path carries its own", () => {
    const url = buildProxyUrl("/bookings?__pt=attacker", "REAL");
    expect(url.match(/__pt=/g)).toHaveLength(1);
    expect(url).toContain("__pt=REAL");
    expect(url).not.toContain("attacker");
  });

  it("preserves the path's other query params alongside our token", () => {
    const url = buildProxyUrl("/search?q=tutors&tab=all", "REAL");
    expect(url).toContain("q=tutors");
    expect(url).toContain("tab=all");
    expect(url.match(/__pt=/g)).toHaveLength(1);
  });

  it("falls back to the app root when the path is null", () => {
    expect(buildProxyUrl(null, "REAL")).toBe("/prefix/?__pt=REAL");
  });

  it("falls back to the app root when the path is rejected by the sanitizer", () => {
    expect(buildProxyUrl("javascript:alert(1)", "REAL")).toBe("/prefix/?__pt=REAL");
  });
});

describe("derivePreviewPathFromFiles", () => {
  const f = (path: string) => ({ path });

  it("maps an app-router page to its route", () => {
    expect(derivePreviewPathFromFiles([f("app/tutor/bookings/page.tsx")])).toBe("/tutor/bookings");
  });

  it("maps the app-router root page to /", () => {
    expect(derivePreviewPathFromFiles([f("app/page.tsx")])).toBe("/");
  });

  it("strips route groups — they are organisational, not part of the URL", () => {
    expect(derivePreviewPathFromFiles([f("app/(marketing)/pricing/page.tsx")])).toBe("/pricing");
  });

  it("handles a nested repo prefix (apps/web/...)", () => {
    expect(derivePreviewPathFromFiles([f("apps/web/src/app/settings/page.tsx")])).toBe("/settings");
  });

  it("maps a pages-router page to its route", () => {
    expect(derivePreviewPathFromFiles([f("pages/about.tsx")])).toBe("/about");
  });

  it("maps pages/index to /", () => {
    expect(derivePreviewPathFromFiles([f("pages/index.tsx")])).toBe("/");
  });

  it("maps a nested pages-router route", () => {
    expect(derivePreviewPathFromFiles([f("pages/tutor/bookings.tsx")])).toBe("/tutor/bookings");
  });

  it("returns null for a dynamic segment — we never fabricate an id", () => {
    expect(derivePreviewPathFromFiles([f("app/tutors/[id]/page.tsx")])).toBeNull();
    expect(derivePreviewPathFromFiles([f("app/blog/[...slug]/page.tsx")])).toBeNull();
    expect(derivePreviewPathFromFiles([f("pages/tutors/[id].tsx")])).toBeNull();
  });

  it("returns null for a component-only diff (the most common engineer PR)", () => {
    expect(
      derivePreviewPathFromFiles([
        f("components/BookingCard.tsx"),
        f("lib/format.ts"),
        f("styles/globals.css"),
      ]),
    ).toBeNull();
  });

  it("returns null when several distinct routes changed — we can't say which one the PR is about", () => {
    expect(
      derivePreviewPathFromFiles([f("app/a/page.tsx"), f("app/b/page.tsx")]),
    ).toBeNull();
  });

  it("collapses several files serving the SAME route to that one route", () => {
    expect(
      derivePreviewPathFromFiles([
        f("app/tutor/bookings/page.tsx"),
        f("components/Tabs.tsx"),
        f("app/tutor/bookings/loading.tsx"),
      ]),
    ).toBe("/tutor/bookings");
  });

  it("ignores pages-router non-routes (_app, _document, api/)", () => {
    expect(
      derivePreviewPathFromFiles([f("pages/_app.tsx"), f("pages/api/hello.ts")]),
    ).toBeNull();
  });

  it("returns null for Vite / React-Router — routes live in config, not the filesystem", () => {
    expect(derivePreviewPathFromFiles([f("src/routes/Bookings.tsx")])).toBeNull();
  });

  it("returns null on an empty diff", () => {
    expect(derivePreviewPathFromFiles([])).toBeNull();
  });

  it("tolerates malformed entries", () => {
    expect(
      derivePreviewPathFromFiles([
        { path: undefined },
        { path: 42 } as unknown as { path?: unknown },
        f("app/ok/page.tsx"),
      ]),
    ).toBe("/ok");
  });
});

describe("deriveMarkersForPath", () => {
  it("pulls visible JSX text from the file that serves the route", () => {
    const files = [
      {
        path: "app/tutor/bookings/page.tsx",
        content: `export default function P(){return(<div><h2>Pending</h2><h2>Upcoming</h2><h2>History</h2></div>);}`,
      },
    ];
    const markers = deriveMarkersForPath(files, "/tutor/bookings");
    expect(markers).toContain("Pending");
    expect(markers).toContain("Upcoming");
    expect(markers).toContain("History");
  });

  it("ignores files that do NOT serve the route — shared text proves nothing", () => {
    const files = [
      { path: "components/Nav.tsx", content: `<a>Dashboard</a>` },
      { path: "app/tutor/bookings/page.tsx", content: `<h2>Pending</h2>` },
    ];
    expect(deriveMarkersForPath(files, "/tutor/bookings")).toEqual(["Pending"]);
  });

  it("drops generic words that appear on every page including the home page", () => {
    const files = [
      {
        path: "app/x/page.tsx",
        content: `<div><span>Loading</span><span>Get started</span><span>Distinctive Heading</span></div>`,
      },
    ];
    const markers = deriveMarkersForPath(files, "/x");
    expect(markers).toEqual(["Distinctive Heading"]);
  });

  it("returns [] when there is nothing distinctive — the probe then fails closed", () => {
    const files = [{ path: "app/x/page.tsx", content: `<div><Chart data={d} /></div>` }];
    expect(deriveMarkersForPath(files, "/x")).toEqual([]);
  });

  it("returns [] when no file serves the route", () => {
    expect(deriveMarkersForPath([{ path: "lib/x.ts", content: "const a=1;" }], "/x")).toEqual([]);
  });

  it("caps the marker count", () => {
    const content = Array.from({ length: 20 }, (_, i) => `<h2>Heading Number ${i}</h2>`).join("");
    expect(deriveMarkersForPath([{ path: "app/x/page.tsx", content }], "/x").length)
      .toBeLessThanOrEqual(5);
  });
});
