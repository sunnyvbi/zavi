import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const SMOKE = pathToFileURL(join(__dirname, "..", "files", "scripts", "smoke.mjs")).href;
const MANIFEST = readFileSync(join(__dirname, "..", "files", "zavi-site.json"), "utf-8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let smoke: any;
beforeAll(async () => {
  const spec: string = SMOKE;
  smoke = await import(spec);
});

type Call = [string, ...unknown[]];

function fakeBrowser(opts: { present?: string[]; landAt?: string; status?: number; pageError?: string } = {}) {
  const calls: Call[] = [];
  const present = new Set(opts.present ?? []);
  let current = "";
  let contexts = 0;
  const launch = async () => ({
    newContext: async () => (contexts++, {
      newPage: async () => {
        const handlers: Record<string, (e: Error) => void> = {};
        return {
          on: (ev: string, cb: (e: Error) => void) => { handlers[ev] = cb; },
          goto: async (url: string) => {
            calls.push(["goto", url]);
            current = url;
            if (opts.pageError) handlers.pageerror?.(new Error(opts.pageError));
            if (opts.landAt) current = new URL(opts.landAt, "https://site.example").href;
            return { status: () => opts.status ?? 200 };
          },
          url: () => current,
          close: async () => {},
          fill: async (sel: string, value: string) => {
            calls.push(["fill", sel, value]);
            if (!present.has(sel)) throw new Error(`no element ${sel}`);
          },
          click: async (sel: string) => {
            calls.push(["click", sel]);
            if (!present.has(sel)) throw new Error(`no element ${sel}`);
          },
          waitForSelector: async (sel: string) => {
            calls.push(["expect", sel]);
            if (!present.has(sel)) throw new Error(`timeout waiting for ${sel}`);
          },
          waitForURL: async (pred: (u: URL) => boolean) => {
            if (!pred(new URL(current))) throw new Error(`timeout waiting for url, at ${current}`);
          },
        };
      },
      close: async () => {},
    }),
    close: async () => {},
  });
  return { launch, calls, contexts: () => contexts };
}

describe("smoke.mjs: manifest validation", () => {
  it("accepts the starter manifest", () => {
    expect(smoke.parseManifest(MANIFEST).journeys).toHaveLength(2);
  });

  it("rejects selectors that are not data-zavi hooks", () => {
    const bad = JSON.stringify({ smoke: { journeys: [{ name: "x", path: "/", expect: ".btn" }] } });
    expect(() => smoke.parseManifest(bad)).toThrow(/data-zavi/);
  });

  it("rejects off-site paths", () => {
    for (const path of ["https://evil.example/", "//evil.example/", "evil"]) {
      const bad = JSON.stringify({ smoke: { journeys: [{ name: "x", path }] } });
      expect(() => smoke.parseManifest(bad)).toThrow(/path/);
    }
  });

  it("rejects a writes journey whose fills never carry the {smoke} tag", () => {
    const bad = JSON.stringify({
      smoke: { journeys: [{ name: "book", path: "/", writes: true, steps: [{ fill: "[data-zavi=name]", value: "Pat" }] }] },
    });
    expect(() => smoke.parseManifest(bad)).toThrow(/\{smoke\}/);
  });

  it("rejects duplicate journey names and unknown steps", () => {
    const dup = JSON.stringify({ smoke: { journeys: [{ name: "a", path: "/" }, { name: "a", path: "/" }] } });
    expect(() => smoke.parseManifest(dup)).toThrow(/duplicate/);
    const unk = JSON.stringify({ smoke: { journeys: [{ name: "a", path: "/", steps: [{ hover: "[data-zavi=x]" }] }] } });
    expect(() => smoke.parseManifest(unk)).toThrow(/step/);
  });
});

describe("smoke.mjs: runSmoke", () => {
  const base = "https://preview.example";

  it("passes the starter journeys when the hooks exist", async () => {
    const b = fakeBrowser({ present: ["[data-zavi=login-email]"] });
    const res = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: b.launch });
    expect(res.ok).toBe(true);
    expect(res.journeys.map((j: { name: string; ok: boolean }) => [j.name, j.ok])).toEqual([["home", true], ["login", true]]);
    expect(b.calls).toContainEqual(["goto", `${base}/login`]);
    expect(res.owner).toBeNull();
  });

  it("opens a staged-preview entry URL once, then runs every journey on its origin in ONE context", async () => {
    const entry = "https://site.example/__zavi_preview/dep1/?t=1700000000.abcdef0123456789";
    const b = fakeBrowser({ present: ["[data-zavi=login-email]"] });
    const res = await smoke.runSmoke({ baseUrl: entry, manifest: smoke.parseManifest(MANIFEST), launch: b.launch });
    expect(res.ok).toBe(true);
    const gotos = b.calls.filter((c) => c[0] === "goto").map((c) => c[1]);
    expect(gotos[0]).toBe(entry);
    expect(gotos).toContain("https://site.example/login");
    expect(gotos.some((u) => String(u).includes("__zavi_preview/dep1/?t=") && u !== entry)).toBe(false);
    expect(b.contexts()).toBe(1);
  });

  it("a failing entry URL fails the run and never echoes the preview token", async () => {
    const entry = "https://site.example/__zavi_preview/dep1/?t=1700000000.abcdef0123456789";
    const b = fakeBrowser({ status: 403 });
    const res = await smoke.runSmoke({ baseUrl: entry, manifest: smoke.parseManifest(MANIFEST), launch: b.launch });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("abcdef0123456789");
  });

  it("fails a journey whose expected hook is missing", async () => {
    const b = fakeBrowser({ present: [] });
    const res = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: b.launch });
    expect(res.ok).toBe(false);
    expect(res.journeys.find((j: { name: string }) => j.name === "login").ok).toBe(false);
  });

  it("fails on an HTTP error status and on an uncaught page error", async () => {
    const e500 = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeBrowser({ status: 500, present: ["[data-zavi=login-email]"] }).launch });
    expect(e500.ok).toBe(false);
    const perr = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeBrowser({ pageError: "boom", present: ["[data-zavi=login-email]"] }).launch });
    expect(perr.ok).toBe(false);
    expect(perr.journeys[0].reason).toContain("boom");
  });

  it("skips writes journeys unless writes are allowed, and tags the written record zavi-smoke", async () => {
    const manifest = smoke.parseManifest(JSON.stringify({
      smoke: { journeys: [{
        name: "book", path: "/book", writes: true,
        steps: [{ fill: "[data-zavi=name]", value: "{smoke} guest" }, { click: "[data-zavi=submit]" }, { expect: "[data-zavi=done]" }],
      }] },
    }));
    const present = ["[data-zavi=name]", "[data-zavi=submit]", "[data-zavi=done]"];

    const off = fakeBrowser({ present });
    const skipped = await smoke.runSmoke({ baseUrl: base, manifest, launch: off.launch, allowWrites: false });
    expect(skipped.ok).toBe(true);
    expect(skipped.journeys[0]).toMatchObject({ name: "book", skipped: true });
    expect(off.calls).toEqual([]);

    const on = fakeBrowser({ present });
    const ran = await smoke.runSmoke({ baseUrl: base, manifest, launch: on.launch, allowWrites: true });
    expect(ran.ok).toBe(true);
    const fill = on.calls.find((c) => c[0] === "fill");
    expect(String(fill?.[2])).toMatch(/^zavi-smoke-\d+ guest$/);
  });

  it("runs the owner journey when an owner link is given and never echoes the link", async () => {
    const link = "https://proj.supabase.co/auth/v1/verify?token=SECRET-TOKEN&redirect_to=x";
    const good = await smoke.runSmoke({
      baseUrl: base, manifest: smoke.parseManifest(MANIFEST), ownerLink: link,
      launch: fakeBrowser({ present: ["[data-zavi=login-email]", "[data-zavi=admin-shell]"], landAt: "/admin" }).launch,
    });
    expect(good.ok).toBe(true);
    expect(good.owner).toMatchObject({ name: "owner-admin", ok: true });

    const bad = await smoke.runSmoke({
      baseUrl: base, manifest: smoke.parseManifest(MANIFEST), ownerLink: link,
      launch: fakeBrowser({ present: ["[data-zavi=login-email]"], landAt: "/login" }).launch,
    });
    expect(bad.ok).toBe(false);
    expect(bad.owner.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("SECRET-TOKEN");
  });

  it("formatResult prints exactly one JSON line", () => {
    const line = smoke.formatResult({ ok: true, journeys: [], owner: null });
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).ok).toBe(true);
  });

  it("readEnv takes config from env only, and requires SMOKE_BASE_URL", () => {
    expect(() => smoke.readEnv({})).toThrow(/SMOKE_BASE_URL/);
    expect(smoke.readEnv({ SMOKE_BASE_URL: "https://x.example/", SMOKE_ALLOW_WRITES: "1", SMOKE_OWNER_LINK: "https://l" }))
      .toEqual({ baseUrl: "https://x.example/", allowWrites: true, checkOverflow: false, ownerLink: "https://l" });
    expect(smoke.readEnv({ SMOKE_BASE_URL: "https://x.example", SMOKE_ALLOW_WRITES: "true" }).allowWrites).toBe(false);
  });
});

function widthBrowser(widths: Record<string, number>, present: string[] = ["[data-zavi=login-email]"]) {
  const visits: Array<{ path: string; viewport: number | null }> = [];
  const launch = async () => ({
    newContext: async () => ({
      newPage: async () => {
        let viewport: number | null = null;
        let current = "";
        return {
          on: () => {},
          setViewportSize: async (v: { width: number; height: number }) => { viewport = v.width; },
          goto: async (url: string) => {
            current = new URL(url).pathname;
            visits.push({ path: current, viewport });
            return { status: () => 200 };
          },
          waitForTimeout: async () => {},
          evaluate: async () => ({ scrollWidth: viewport === null ? 1280 : widths[current] ?? viewport, innerWidth: viewport ?? 1280 }),
          url: () => current,
          close: async () => {},
          fill: async () => {},
          click: async () => {},
          waitForSelector: async (sel: string) => {
            if (!present.includes(sel)) throw new Error(`timeout waiting for ${sel}`);
          },
          waitForURL: async () => {},
        };
      },
      close: async () => {},
    }),
    close: async () => {},
  });
  return { launch, visits };
}

describe("smoke.mjs: no sideways scroll on a phone", () => {
  const base = "https://preview.example";
  const bookingManifest = () =>
    smoke.parseManifest(JSON.stringify({
      smoke: { journeys: [
        { name: "home", path: "/" },
        { name: "login", path: "/login", expect: "[data-zavi=login-email]" },
        { name: "book", path: "/book" },
      ] },
    }));

  it("fails when the booking page is wider than a 390px phone, naming the page and its width", async () => {
    const b = widthBrowser({ "/book": 1612 });
    const res = await smoke.runSmoke({ baseUrl: base, manifest: bookingManifest(), launch: b.launch, checkOverflow: true });
    expect(res.ok).toBe(false);
    const width = res.journeys.find((j: { name: string }) => j.name === "mobile-width");
    expect(width.ok).toBe(false);
    expect(width.reason).toContain("/book");
    expect(width.reason).toContain("1612");
    expect(res.journeys.filter((j: { name: string; ok: boolean }) => j.name !== "mobile-width").every((j: { ok: boolean }) => j.ok)).toBe(true);
  });

  it("checks / and every journey page at exactly 390px wide, and passes when they fit", async () => {
    const b = widthBrowser({});
    const res = await smoke.runSmoke({ baseUrl: base, manifest: bookingManifest(), launch: b.launch, checkOverflow: true });
    expect(res.ok).toBe(true);
    const phone = b.visits.filter((v) => v.viewport === smoke.MOBILE_WIDTH).map((v) => v.path);
    expect(smoke.MOBILE_WIDTH).toBe(390);
    expect(phone).toEqual(["/", "/login", "/book"]);
  });

  it("a one-pixel rounding overflow passes; two pixels fail", async () => {
    const ok = await smoke.runSmoke({ baseUrl: base, manifest: bookingManifest(), launch: widthBrowser({ "/": 391 }).launch, checkOverflow: true });
    expect(ok.ok).toBe(true);
    const bad = await smoke.runSmoke({ baseUrl: base, manifest: bookingManifest(), launch: widthBrowser({ "/": 392 }).launch, checkOverflow: true });
    expect(bad.ok).toBe(false);
  });

  it("does not check widths unless asked, so an old gate run is unchanged", async () => {
    const b = widthBrowser({ "/book": 1612 });
    const res = await smoke.runSmoke({ baseUrl: base, manifest: bookingManifest(), launch: b.launch });
    expect(res.ok).toBe(true);
    expect(res.journeys.map((j: { name: string }) => j.name)).not.toContain("mobile-width");
    expect(b.visits.some((v) => v.viewport !== null)).toBe(false);
  });

  it("readEnv turns the width check on only for SMOKE_CHECK_OVERFLOW=1", () => {
    expect(smoke.readEnv({ SMOKE_BASE_URL: "https://x.example", SMOKE_CHECK_OVERFLOW: "1" }).checkOverflow).toBe(true);
    expect(smoke.readEnv({ SMOKE_BASE_URL: "https://x.example", SMOKE_CHECK_OVERFLOW: "true" }).checkOverflow).toBe(false);
    expect(smoke.readEnv({ SMOKE_BASE_URL: "https://x.example" }).checkOverflow).toBe(false);
  });
});
