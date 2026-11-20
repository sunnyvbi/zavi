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
type Page = { text: string; deniedRead: { items?: number; denied?: string; error?: string } };

function fakeSite(site: { leaky?: boolean; ownerLands?: string; status?: number; adminHidesMessages?: boolean; sdkMissing?: boolean } = {}) {
  const calls: Call[] = [];
  const messages: string[] = [];
  let signedIn = false;
  let contexts = 0;
  const present = (path: string) => {
    const base = ["[data-zavi=home]", "[data-zavi=login-email]", "[data-zavi=contact-name]", "[data-zavi=contact-body]", "[data-zavi=contact-submit]"];
    if (path === "/admin") return signedIn ? ["[data-zavi=admin-shell]"] : ["[data-zavi=admin-signin]"];
    return base;
  };
  const launch = async () => ({
    newContext: async () => (contexts++, {
      newPage: async () => {
        let path = "/";
        let filled = "";
        let sent = false;
        const pageState = (): Page => ({
          text: path === "/admin" && signedIn && !site.adminHidesMessages ? messages.join("\n") : site.leaky && path === "/admin" ? messages.join("\n") : "",
          deniedRead: site.sdkMissing ? { error: "the page has no window.__zavi (keep src/zavi/index.ts)" }
            : signedIn ? { error: "the visitor journey is signed in" }
              : site.leaky ? { items: messages.length } : { items: 0 },
        });
        return {
          on: () => {},
          goto: async (url: string) => {
            calls.push(["goto", url]);
            const u = new URL(url);
            if (u.pathname === "/owner-link") { signedIn = true; path = site.ownerLands ?? "/admin"; }
            else path = u.pathname;
            return { status: () => site.status ?? 200 };
          },
          url: () => `https://site.example${path}`,
          close: async () => {},
          fill: async (sel: string, value: string) => { calls.push(["fill", sel, value]); if (sel === "[data-zavi=contact-name]") filled = value; },
          click: async (sel: string) => {
            calls.push(["click", sel]);
            if (sel === "[data-zavi=contact-submit]") { messages.push(filled); sent = true; }
          },
          waitForSelector: async (sel: string) => {
            calls.push(["expect", sel]);
            const ok = present(path).includes(sel) || (sel === "[data-zavi=contact-sent]" && sent);
            if (!ok) throw new Error(`timeout waiting for ${sel}`);
          },
          waitForURL: async (pred: (u: URL) => boolean) => {
            if (!pred(new URL(`https://site.example${path}`))) throw new Error(`timeout waiting for url, at ${path}`);
          },
          waitForLoadState: async () => {},
          waitForFunction: async (_fn: unknown, text: string) => {
            if (!pageState().text.includes(text)) throw new Error("timeout");
          },
          evaluate: async (fn: { toString(): string }, arg: string) => {
            calls.push(["evaluate", arg]);
            if (String(fn).includes("__zavi")) return pageState().deniedRead;
            return pageState().text.includes(arg);
          },
        };
      },
      close: async () => {},
    }),
    close: async () => {},
  });
  return { launch, calls, messages, contexts: () => contexts };
}

const base = "https://site.example";
const OWNER = `${base}/owner-link?token_hash=SECRET-TOKEN-123&type=magiclink`;
const names = (r: { journeys: Array<{ name: string; ok: boolean; skipped?: boolean }> }) =>
  r.journeys.map((j) => [j.name, j.ok, j.skipped ?? false]);

describe("smoke.mjs: the starter journeys assert real behaviour", () => {
  it("full run: create through the UI, a visitor is denied, the owner reads it back as admin", async () => {
    const s = fakeSite();
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: s.launch, ownerLink: OWNER, allowWrites: true });
    expect(names(r)).toEqual([
      ["home", true, false], ["login", true, false], ["contact-create", true, false], ["visitor-denied", true, false], ["admin-sees-message", true, false],
    ]);
    expect(r.ok).toBe(true);
    expect(r.owner).toMatchObject({ name: "owner-admin", ok: true });
    expect(s.messages[0]).toMatch(/^zavi-smoke-\d+$/);
    expect(s.contexts()).toBe(1);
    const gotos = s.calls.filter((c) => c[0] === "goto").map((c) => String(c[1]));
    expect(gotos.findIndex((u) => u.includes("owner-link"))).toBeGreaterThan(s.calls.filter((c) => c[0] === "goto").findIndex((c) => String(c[1]).endsWith("/admin")));
  });

  it("FAILS when a signed-out visitor can read the protected collection", async () => {
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite({ leaky: true }).launch, ownerLink: OWNER, allowWrites: true });
    expect(r.ok).toBe(false);
    const j = r.journeys.find((x: { name: string }) => x.name === "visitor-denied");
    expect(j.ok).toBe(false);
    expect(j.reason).toMatch(/signed-out visitor could read|must not be/);
  });

  it("FAILS when the admin cannot see the record the visitor created (read-back is real)", async () => {
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite({ adminHidesMessages: true }).launch, ownerLink: OWNER, allowWrites: true });
    expect(r.ok).toBe(false);
    expect(r.journeys.find((x: { name: string }) => x.name === "admin-sees-message").reason).toMatch(/never appeared/);
  });

  it("FAILS when the page lost the SDK handle (the denied read cannot be proven)", async () => {
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite({ sdkMissing: true }).launch, allowWrites: true });
    expect(r.ok).toBe(false);
  });

  it("without writes: create, read-back AND the denied read are skipped (an empty collection proves nothing)", async () => {
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite().launch, ownerLink: OWNER, allowWrites: false });
    expect(r.ok).toBe(true);
    expect(r.journeys.find((x: { name: string }) => x.name === "contact-create")).toMatchObject({ skipped: true });
    expect(r.journeys.find((x: { name: string }) => x.name === "admin-sees-message")).toMatchObject({ skipped: true, reason: expect.stringMatching(/needs contact-create/) });
    expect(r.journeys.find((x: { name: string }) => x.name === "visitor-denied")).toMatchObject({ skipped: true, reason: expect.stringMatching(/needs contact-create/) });
  });

  it("a customer journey parses and, without a customer link, is skipped (not failed); a visitor cannot need it", async () => {
    const doc = JSON.parse(MANIFEST);
    doc.smoke.journeys.push({ name: "customer-home", path: "/", as: "customer" });
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(JSON.stringify(doc)), launch: fakeSite().launch, ownerLink: OWNER, allowWrites: true });
    expect(r.journeys.find((x: { name: string }) => x.name === "customer-home")).toMatchObject({ skipped: true, reason: "no customer link" });
    doc.smoke.journeys.push({ name: "after", path: "/", needs: "customer-home" });
    expect(() => smoke.parseManifest(JSON.stringify(doc))).toThrow(/cannot need a customer/);
  });

  it("without an owner link: owner journeys are skipped, not failed", async () => {
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite().launch, allowWrites: true });
    expect(r.ok).toBe(true);
    expect(r.owner).toBeNull();
    expect(r.journeys.find((x: { name: string }) => x.name === "admin-sees-message")).toMatchObject({ skipped: true, reason: "no owner link" });
  });

  it("an owner link that does not reach /admin fails the run, and owner journeys fail with it", async () => {
    const r = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite({ ownerLands: "/login" }).launch, ownerLink: OWNER, allowWrites: true });
    expect(r.ok).toBe(false);
    expect(r.owner.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN-123");
  });

  it("a failing entry URL fails the run and never echoes the preview token", async () => {
    const entry = "https://site.example/__zavi_preview/dep1/?t=1700000000.abcdef0123456789";
    const r = await smoke.runSmoke({ baseUrl: entry, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite({ status: 403 }).launch });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("abcdef0123456789");
  });
});

describe("smoke.mjs: manifest validation", () => {
  const j = (journeys: unknown[]) => JSON.stringify({ smoke: { journeys } });
  it("accepts the starter manifest", () => {
    expect(smoke.parseManifest(MANIFEST).journeys).toHaveLength(5);
  });
  it.each([
    ["a CSS selector", [{ name: "x", path: "/", expect: ".btn" }], /data-zavi/],
    ["an off-site path", [{ name: "x", path: "//evil.example/" }], /path/],
    ["a writes journey without {smoke}", [{ name: "b", path: "/", writes: true, steps: [{ fill: "[data-zavi=n]", value: "Pat" }] }], /\{smoke\}/],
    ["deniedRead in an owner journey", [{ name: "o", path: "/", as: "owner", steps: [{ deniedRead: "messages" }] }], /visitor journey/],
    ["deniedRead of a bad name", [{ name: "v", path: "/", steps: [{ deniedRead: "../auth" }] }], /collection name/],
    ["deniedRead without a writes journey it needs", [{ name: "v", path: "/", steps: [{ deniedRead: "messages" }] }], /must "needs" the writes journey/],
    ["deniedRead needing a journey that writes nothing", [{ name: "a", path: "/" }, { name: "v", path: "/", needs: "a", steps: [{ deniedRead: "messages" }] }], /must "needs" the writes journey/],
    ["needs a later journey", [{ name: "a", path: "/", needs: "b" }, { name: "b", path: "/" }], /earlier journey/],
    ["a visitor needing an owner journey", [{ name: "a", path: "/", as: "owner" }, { name: "b", path: "/", needs: "a" }], /cannot need an owner/],
    ["a bad as", [{ name: "a", path: "/", as: "admin" }], /as must be/],
    ["empty expectText", [{ name: "a", path: "/", steps: [{ expectText: "" }] }], /1-200/],
    ["an unknown step", [{ name: "a", path: "/", steps: [{ eval: "document.cookie" }] }], /unknown step/],
  ])("rejects %s", (_n, journeys, re) => {
    expect(() => smoke.parseManifest(j(journeys))).toThrow(re);
  });
});

describe("smoke.mjs: its own result line (developer convenience)", () => {
  it("prints one JSON line: pass, and a denied-read failure with its reason", async () => {
    const pass = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite().launch, ownerLink: OWNER, allowWrites: true });
    const fail = await smoke.runSmoke({ baseUrl: base, manifest: smoke.parseManifest(MANIFEST), launch: fakeSite({ leaky: true }).launch, ownerLink: OWNER, allowWrites: true });
    const line = (out: unknown) => JSON.parse(smoke.formatResult(out).trim());
    expect(line(pass)).toMatchObject({ ok: true });
    expect((line(pass).owner as { ok?: boolean } | undefined)?.ok).toBe(true);
    const f = line(fail);
    expect(f.ok).toBe(false);
    const failed = (f.journeys as Array<{ name: string; ok: boolean }>).find((j) => j.ok === false);
    expect(failed?.name).toBe("visitor-denied");
  });

  it("readEnv takes config from env only", () => {
    expect(() => smoke.readEnv({})).toThrow(/SMOKE_BASE_URL/);
    expect(smoke.readEnv({ SMOKE_BASE_URL: "https://x.example", SMOKE_ALLOW_WRITES: "true" }).allowWrites).toBe(false);
  });
});
