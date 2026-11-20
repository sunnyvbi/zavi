import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { handle, type Env, type R2ObjectBodyLike } from "../worker";

const HOST = "acme.zaviagent.com";
const DEPLOY = "d_20260929";

function makeEnv(files: Record<string, string>, kv: Record<string, string> = {}) {
  const r2Gets: string[] = [];
  const kvGets: string[] = [];
  const env: Env = {
    SITES: {
      async get(key: string): Promise<R2ObjectBodyLike | null> {
        r2Gets.push(key);
        if (!(key in files)) return null;
        const bytes = new TextEncoder().encode(files[key]);
        return { body: new Blob([bytes]).stream(), size: bytes.byteLength, httpEtag: `"e-${key.length}"` };
      },
    },
    HOSTS: {
      async get(key: string) {
        kvGets.push(key);
        return key in kv ? kv[key] : null;
      },
    },
  };
  return { env, r2Gets, kvGets };
}

function live(extra: Record<string, string> = {}, deploy = DEPLOY) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) files[`sites/${HOST}/${deploy}/${k}`] = v;
  return makeEnv(files, {
    [`host:${HOST}`]: JSON.stringify({ deploy_id: deploy, sha: "abc", tenant_id: "t1", published_at: "2026-09-29T00:00:00Z" }),
  });
}

function req(path: string, init: RequestInit & { host?: string } = {}) {
  return new Request(`https://${init.host ?? HOST}${path}`, init);
}

const SITE = {
  "index.html": "<h1>home</h1>",
  "about.html": "<h1>about</h1>",
  "docs/index.html": "<h1>docs</h1>",
  "robots.txt": "User-agent: *",
  "_next/static/chunks/app-123.js": "console.log(1)",
  "_next/static/css/a.css": "body{}",
  "logo.svg": "<svg/>",
  "img/photo.PNG": "png",
  "favicon.ico": "ico",
  "font.woff2": "w",
  "404.html": "<h1>custom 404</h1>",
};

describe("static-host worker", () => {
  it("serves index.html at root with html headers", async () => {
    const { env, kvGets, r2Gets } = live(SITE);
    const res = await worker.fetch(req("/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-zavi-deploy-id")).toBe(DEPLOY);
    expect(kvGets).toEqual([`host:${HOST}`]);
    expect(r2Gets).toEqual([`sites/${HOST}/${DEPLOY}/index.html`]);
  });

  it("maps /foo to foo.html after trying foo", async () => {
    const { env, r2Gets } = live(SITE);
    const res = await worker.fetch(req("/about"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>about</h1>");
    expect(r2Gets).toEqual([`sites/${HOST}/${DEPLOY}/about`, `sites/${HOST}/${DEPLOY}/about.html`]);
  });

  it("maps /docs and /docs/ to nested index.html", async () => {
    const { env } = live(SITE);
    for (const p of ["/docs", "/docs/"]) {
      const res = await worker.fetch(req(p), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<h1>docs</h1>");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
  });

  it("decodes percent-encoded paths to the stored key", async () => {
    const { env } = live({ "my file.png": "img", "caf\u00e9/index.html": "cafe" });
    const r1 = await worker.fetch(req("/my%20file.png"), env);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toBe("image/png");
    const r2 = await worker.fetch(req("/caf%C3%A9/"), env);
    expect(await r2.text()).toBe("cafe");
  });

  it("prefers the exact key over .html and index.html", async () => {
    const { env } = live({ "x": "raw", "x.html": "html", "x/index.html": "idx" });
    const res = await worker.fetch(req("/x"), env);
    expect(await res.text()).toBe("raw");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("serves 404.html from the same deploy with status 404 and no-cache", async () => {
    const { env, r2Gets } = live(SITE);
    const res = await worker.fetch(req("/missing"), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>custom 404</h1>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(r2Gets.at(-1)).toBe(`sites/${HOST}/${DEPLOY}/404.html`);
  });

  it("missing asset under _next/static 404s without the immutable header", async () => {
    const { env } = live(SITE);
    const res = await worker.fetch(req("/_next/static/chunks/gone.js"), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).not.toContain("immutable");
  });

  it("falls back to plain 404 when the deploy has no 404.html", async () => {
    const { env } = live({ "index.html": "home" });
    const res = await worker.fetch(req("/nope"), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not read 404.html from another deploy", async () => {
    const { env } = makeEnv(
      { [`sites/${HOST}/old/404.html`]: "old 404", [`sites/${HOST}/${DEPLOY}/index.html`]: "home" },
      { [`host:${HOST}`]: JSON.stringify({ deploy_id: DEPLOY, sha: "s", tenant_id: "t", published_at: "x" }) },
    );
    const res = await worker.fetch(req("/nope"), env);
    expect(await res.text()).toBe("Not Found");
  });

  it("returns not-published page when no KV entry and never touches R2", async () => {
    const { env, r2Gets } = makeEnv({ [`sites/${HOST}/${DEPLOY}/index.html`]: "home" });
    const res = await worker.fetch(req("/"), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("This site is not published yet");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(r2Gets).toEqual([]);
  });

  it("treats malformed KV or unsafe deploy_id as not published", async () => {
    for (const value of ["not json", JSON.stringify({ deploy_id: "../other" }), JSON.stringify({ deploy_id: 5 })]) {
      const { env, r2Gets } = makeEnv({}, { [`host:${HOST}`]: value });
      const res = await worker.fetch(req("/"), env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("This site is not published yet");
      expect(r2Gets).toEqual([]);
    }
  });

  it("HEAD returns headers and no body", async () => {
    const { env } = live(SITE);
    const res = await worker.fetch(req("/_next/static/chunks/app-123.js", { method: "HEAD" }), env);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-length")).toBe("14");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("HEAD on unpublished host has no body", async () => {
    const { env } = makeEnv({});
    const res = await worker.fetch(req("/", { method: "HEAD" }), env);
    expect(res.status).toBe(404);
    expect(res.body).toBeNull();
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s returns 405 without reading storage", async (method) => {
    const { env, kvGets, r2Gets } = live(SITE);
    const res = await worker.fetch(req("/", { method }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(kvGets).toEqual([]);
    expect(r2Gets).toEqual([]);
  });

  it.each([
    ["/_next/static/css/a.css", "text/css; charset=utf-8", "public, max-age=31536000, immutable"],
    ["/robots.txt", "text/plain; charset=utf-8", "public, max-age=0, must-revalidate"],
    ["/logo.svg", "image/svg+xml", "public, max-age=0, must-revalidate"],
    ["/img/photo.PNG", "image/png", "public, max-age=0, must-revalidate"],
    ["/favicon.ico", "image/x-icon", "public, max-age=0, must-revalidate"],
    ["/font.woff2", "font/woff2", "public, max-age=0, must-revalidate"],
    ["/about.html", "text/html; charset=utf-8", "no-cache"],
  ])("%s -> %s / %s", async (path, type, cache) => {
    const { env } = live(SITE);
    const res = await worker.fetch(req(path), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("cache-control")).toBe(cache);
  });

  it("html served via .html fallback gets html headers, not the extensionless key's", async () => {
    const { env } = live(SITE);
    const res = await worker.fetch(req("/about"), env);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("looks up KV by lowercased host, strips port and trailing dot", async () => {
    const { env, kvGets, r2Gets } = live(SITE);
    const r1 = await worker.fetch(new Request("https://ACME.ZavIAgent.com:8443/"), env);
    expect(r1.status).toBe(200);
    const r2 = await worker.fetch(new Request("https://acme.zaviagent.com./"), env);
    expect(r2.status).toBe(200);
    expect(kvGets).toEqual([`host:${HOST}`, `host:${HOST}`]);
    expect(r2Gets.every((k) => k.startsWith(`sites/${HOST}/${DEPLOY}/`))).toBe(true);
  });

  it("isolates hosts from each other", async () => {
    const { env } = makeEnv(
      { [`sites/other.zaviagent.com/${DEPLOY}/secret.txt`]: "secret" },
      { "host:other.zaviagent.com": JSON.stringify({ deploy_id: "d2", sha: "", tenant_id: "", published_at: "" }),
        [`host:${HOST}`]: JSON.stringify({ deploy_id: DEPLOY, sha: "", tenant_id: "", published_at: "" }) },
    );
    const res = await worker.fetch(req("/secret.txt"), env);
    expect(res.status).toBe(404);
  });

  describe("path traversal cannot escape the deploy prefix", () => {
    const secretFiles = {
      [`sites/${HOST}/other-deploy/secret.txt`]: "SECRET",
      [`sites/${HOST}/secret.txt`]: "SECRET",
      [`sites/other.zaviagent.com/${DEPLOY}/index.html`]: "SECRET",
      "secret.txt": "SECRET",
      [`sites/${HOST}/${DEPLOY}/404.html`]: "custom 404",
    };
    const kv = { [`host:${HOST}`]: JSON.stringify({ deploy_id: DEPLOY, sha: "", tenant_id: "", published_at: "" }) };

    it.each([
      "/../secret.txt",
      "/../other-deploy/secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/other-deploy/secret.txt",
      "/..%2fother-deploy%2fsecret.txt",
      "/..%2Fsecret.txt",
      "/a/..%2f..%2fother-deploy/secret.txt",
      "/..%5csecret.txt",
      "/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..%2f..%2f..%2fother.zaviagent.com%2f" + DEPLOY + "%2findex.html",
      "/%00secret.txt",
      "/%E0%A4%A",
    ])("%s", async (path) => {
      const { env, r2Gets } = makeEnv(secretFiles, kv);
      const res = await worker.fetch(req(path), env);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
      const prefix = `sites/${HOST}/${DEPLOY}/`;
      for (const k of r2Gets) {
        expect(k.startsWith(prefix)).toBe(true);
        expect(k.slice(prefix.length).split("/")).not.toContain("..");
      }
    });
  });
});

const PREVIEW_SECRET = "preview-secret";
const WAKE_SECRET = "wake-secret";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const NOW_S = Math.floor(NOW / 1000);

function hmacHex(secret: string, msg: string): string {
  return createHmac("sha256", secret).update(msg).digest("hex");
}

function previewToken(host: string, deploy: string, exp: number, secret = PREVIEW_SECRET): string {
  return `${exp}.${hmacHex(secret, `preview.${host}.${deploy}.${exp}`)}`;
}

type SiteEnvOpts = { spa?: boolean; paused?: boolean; lastseen?: string; kvGetHang?: (key: string) => boolean };

function siteEnv(files: Record<string, string>, opts: SiteEnvOpts = {}, deploy = DEPLOY) {
  const r2: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) r2[k.startsWith("sites/") ? k : `sites/${HOST}/${deploy}/${k}`] = v;
  const kv: Record<string, string> = {
    [`host:${HOST}`]: JSON.stringify({
      deploy_id: deploy, sha: "abc", tenant_id: "t1", published_at: "2026-09-29T00:00:00Z",
      ...(opts.spa === false ? {} : { spa: true }),
    }),
  };
  if (opts.paused) kv[`paused:${HOST}`] = "1";
  if (opts.lastseen) kv[`lastseen:${HOST}`] = opts.lastseen;
  const base = makeEnv(r2, kv);
  const puts: Array<[string, string]> = [];
  const env: Env = {
    ...base.env,
    HOSTS: {
      async get(key: string) {
        base.kvGets.push(key);
        if (opts.kvGetHang?.(key)) return new Promise<string | null>(() => undefined);
        return key in kv ? kv[key] : null;
      },
      async put(key: string, value: string) {
        puts.push([key, value]);
        kv[key] = value;
      },
    },
    PREVIEW_HMAC_SECRET: PREVIEW_SECRET,
    WAKE_HMAC_SECRET: WAKE_SECRET,
    ZAVI_API: "https://api.example.test",
  };
  return { env, kv, puts, r2Gets: base.r2Gets, kvGets: base.kvGets };
}

function fakeCtx() {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, waits };
}

const HTML = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
const SPA_SITE = {
  "index.html": "<div id=root></div>",
  "assets/app-1.js": "js",
  "logo.png": "png",
};

describe("SPA fallback (spa host records only)", () => {
  it("serves index.html for an HTML navigation to a client route", async () => {
    const { env } = siteEnv(SPA_SITE);
    const res = await handle(req("/dashboard/settings", { headers: HTML }), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<div id=root></div>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("never falls back for an asset miss, even when the browser accepts html", async () => {
    const { env } = siteEnv(SPA_SITE);
    for (const [path, headers] of [
      ["/assets/gone.js", { accept: "*/*" }],
      ["/missing.png", HTML],
      ["/dashboard", { accept: "application/json" }],
    ] as const) {
      const res = await handle(req(path, { headers }), env, fakeCtx().ctx, () => NOW);
      expect(res.status).toBe(404);
    }
  });

  it("does not fall back when the host record is not spa", async () => {
    const { env } = siteEnv(SPA_SITE, { spa: false });
    const res = await handle(req("/dashboard", { headers: HTML }), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(404);
  });
});

describe("preview path", () => {
  const STAGED = "d_staged";
  const files = {
    ...SPA_SITE,
    [`sites/${HOST}/${STAGED}/index.html`]: "<h1>staged</h1>",
    [`sites/${HOST}/${STAGED}/assets/app-2.js`]: "staged js",
  };

  it("a valid token redirects to the clean path and sets a host-only preview cookie", async () => {
    const { env, puts } = siteEnv(files);
    const t = previewToken(HOST, STAGED, NOW_S + 900);
    const res = await handle(req(`/__zavi_preview/${STAGED}/login?next=%2Fadmin&t=${t}`), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fadmin");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__zavi_preview=${STAGED}.${t}`);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Max-Age=900/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(puts).toEqual([]);
  });

  it("a link without the embed flag keeps the same-site Lax cookie (publish gate and staged previews unchanged)", async () => {
    const { env } = siteEnv(files);
    const t = previewToken(HOST, STAGED, NOW_S + 900);
    const res = await handle(req(`/__zavi_preview/${STAGED}/?t=${t}`), env, fakeCtx().ctx, () => NOW);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Partitioned/);
  });

  it("a version-history link sets a partitioned SameSite=None cookie and drops the flag from the redirect", async () => {
    const { env, puts } = siteEnv(files);
    const t = previewToken(HOST, STAGED, NOW_S + 900);
    const res = await handle(req(`/__zavi_preview/${STAGED}/menu?x=1&t=${t}&zavi_embed=1`), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/menu?x=1");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__zavi_preview_frame=${STAGED}.${t}`);
    expect(cookie).toMatch(/SameSite=None/);
    expect(cookie).toMatch(/Partitioned/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).not.toMatch(/SameSite=Lax/);
    expect(puts).toEqual([]);
  });

  it("the end path clears both preview cookie forms and sends the frame back to the live page", async () => {
    const { env, puts } = siteEnv(files);
    const res = await handle(req(`/__zavi_preview_end?next=${encodeURIComponent("/menu?x=1")}`), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/menu?x=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cleared = res.headers.getSetCookie();
    expect(cleared).toHaveLength(3);
    for (const c of cleared) {
      expect(c).toMatch(/^__zavi_preview(_frame)?=;/);
      expect(c).toMatch(/Max-Age=0/);
      expect(c).toMatch(/Path=\//);
    }
    expect(cleared.some((c) => /^__zavi_preview_frame=;/.test(c) && /SameSite=None/.test(c) && /Partitioned/.test(c))).toBe(true);
    expect(cleared.some((c) => /^__zavi_preview=;/.test(c) && /SameSite=None/.test(c) && /Partitioned/.test(c))).toBe(true);
    expect(cleared.some((c) => /SameSite=Lax/.test(c))).toBe(true);
    expect(puts).toEqual([]);
  });

  describe("a Build-pane version preview never leaks into the founder's own tab (QA 8-4)", () => {
    const frame = () => `__zavi_preview_frame=${STAGED}.${previewToken(HOST, STAGED, NOW_S + 600)}`;

    it("inside the Build pane frame, the frame cookie serves the old version and its assets", async () => {
      const { env } = siteEnv(files);
      const page = await handle(req("/", { headers: { ...HTML, cookie: frame(), "sec-fetch-dest": "iframe" } }), env, fakeCtx().ctx, () => NOW);
      expect(await page.text()).toBe("<h1>staged</h1>");
      const asset = await handle(req("/assets/app-2.js", { headers: { cookie: frame(), "sec-fetch-dest": "script" } }), env, fakeCtx().ctx, () => NOW);
      expect(await asset.text()).toBe("staged js");
    });

    it("a top-level visit to the live address shows the live version and ends the frame cookie", async () => {
      const { env } = siteEnv(files);
      const res = await handle(req("/", { headers: { ...HTML, cookie: frame(), "sec-fetch-dest": "document" } }), env, fakeCtx().ctx, () => NOW);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-zavi-deploy-id")).not.toBe(STAGED);
      const cleared = res.headers.getSetCookie();
      expect(cleared.some((c) => /^__zavi_preview_frame=;/.test(c) && /Max-Age=0/.test(c) && /Partitioned/.test(c))).toBe(true);
    });

    it("a version preview the founder opened in its own tab (not the frame) still works top-level", async () => {
      const { env } = siteEnv(files);
      const cookie = `__zavi_preview=${STAGED}.${previewToken(HOST, STAGED, NOW_S + 600)}`;
      const res = await handle(req("/", { headers: { ...HTML, cookie, "sec-fetch-dest": "document" } }), env, fakeCtx().ctx, () => NOW);
      expect(await res.text()).toBe("<h1>staged</h1>");
    });
  });

  it.each(["//evil.example/x", "https://evil.example/", "/\\evil.example", "menu"])("the end path never redirects off the site (%s)", async (next) => {
    const { env } = siteEnv(files);
    const res = await handle(req(`/__zavi_preview_end?next=${encodeURIComponent(next)}`), env, fakeCtx().ctx, () => NOW);
    expect(res.headers.get("location")).toBe("/");
  });

  it("the end path answers even while a preview cookie is set, instead of serving the old build", async () => {
    const { env } = siteEnv(files);
    const cookie = `__zavi_preview=${STAGED}.${previewToken(HOST, STAGED, NOW_S + 600)}`;
    const res = await handle(req("/__zavi_preview_end", { headers: { ...HTML, cookie } }), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("the embed flag never rescues a bad token", async () => {
    const { env } = siteEnv(files);
    const res = await handle(req(`/__zavi_preview/${STAGED}/?t=${previewToken(HOST, "d_other", NOW_S + 900)}&zavi_embed=1`), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("with the cookie, the staged deploy is served (assets and SPA routes), never cached", async () => {
    const { env, puts } = siteEnv(files);
    const cookie = `other=1; __zavi_preview=${STAGED}.${previewToken(HOST, STAGED, NOW_S + 600)}`;
    const home = await handle(req("/", { headers: { ...HTML, cookie } }), env, fakeCtx().ctx, () => NOW);
    expect(await home.text()).toBe("<h1>staged</h1>");
    expect(home.headers.get("x-zavi-deploy-id")).toBe(STAGED);
    expect(home.headers.get("cache-control")).toBe("private, no-store");
    const route = await handle(req("/admin", { headers: { ...HTML, cookie } }), env, fakeCtx().ctx, () => NOW);
    expect(await route.text()).toBe("<h1>staged</h1>");
    const asset = await handle(req("/assets/app-2.js", { headers: { cookie } }), env, fakeCtx().ctx, () => NOW);
    expect(await asset.text()).toBe("staged js");
    expect(puts).toEqual([]);
  });

  it("works before the hostname has any live deploy", async () => {
    const { env } = makeEnv({ [`sites/${HOST}/${STAGED}/index.html`]: "<h1>staged</h1>" });
    env.PREVIEW_HMAC_SECRET = PREVIEW_SECRET;
    const cookie = `__zavi_preview=${STAGED}.${previewToken(HOST, STAGED, NOW_S + 600)}`;
    const res = await handle(req("/", { headers: { ...HTML, cookie } }), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>staged</h1>");
  });

  it.each([
    ["bad signature", () => previewToken(HOST, STAGED, NOW_S + 600, "wrong")],
    ["expired", () => previewToken(HOST, STAGED, NOW_S - 1)],
    ["lifetime longer than 15 minutes", () => previewToken(HOST, STAGED, NOW_S + 3600)],
    ["token for another deploy", () => previewToken(HOST, "d_other", NOW_S + 600)],
    ["token for another host", () => previewToken("other.zaviagent.com", STAGED, NOW_S + 600)],
    ["garbage", () => "nope"],
    ["missing", () => ""],
  ])("rejects a %s token with 403 and no cookie", async (_label, token) => {
    const { env, r2Gets } = siteEnv(files);
    const t = token();
    const res = await handle(req(`/__zavi_preview/${STAGED}/${t ? `?t=${t}` : ""}`), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(r2Gets).toEqual([]);
  });

  it("rejects every token when the Worker has no preview secret", async () => {
    const { env } = siteEnv(files);
    delete env.PREVIEW_HMAC_SECRET;
    const res = await handle(req(`/__zavi_preview/${STAGED}/?t=${previewToken(HOST, STAGED, NOW_S + 600)}`), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(403);
  });

  it("an invalid preview cookie is ignored and the live deploy is served", async () => {
    const { env } = siteEnv(files);
    const cookie = `__zavi_preview=${STAGED}.${previewToken(HOST, STAGED, NOW_S + 600, "wrong")}`;
    const res = await handle(req("/", { headers: { ...HTML, cookie } }), env, fakeCtx().ctx, () => NOW);
    expect(await res.text()).toBe("<div id=root></div>");
    expect(res.headers.get("x-zavi-deploy-id")).toBe(DEPLOY);
  });

  it("rejects an unsafe deploy id in the preview path", async () => {
    const { env } = siteEnv(files);
    const res = await handle(req(`/__zavi_preview/..%2fother/?t=x`), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(403);
  });
});

describe("paused hosts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves the waking page and fires exactly one signed wake POST via waitUntil", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { env, r2Gets } = siteEnv(SPA_SITE, { paused: true });
    const { ctx, waits } = fakeCtx();
    const res = await handle(req("/pricing", { headers: HTML }), env, ctx, () => NOW);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain('http-equiv="refresh" content="15"');
    expect(body).toContain("waking up");
    expect(r2Gets).toEqual([]);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/public/sites/wake");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-zavi-wake-ts"]).toBe(String(NOW_S));
    expect(headers["x-zavi-wake-sig"]).toBe(hmacHex(WAKE_SECRET, `${HOST}.${NOW_S}`));
    expect(JSON.parse(String(init.body))).toEqual({ hostname: HOST });
  });

  it("an asset request to a paused host gets a 503 without a wake POST", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const { env } = siteEnv(SPA_SITE, { paused: true });
    const { ctx, waits } = fakeCtx();
    const res = await handle(req("/assets/app-1.js", { headers: { accept: "*/*" } }), env, ctx, () => NOW);
    expect(res.status).toBe(503);
    expect(waits).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without the wake secret the waking page still shows but nothing is posted", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const { env } = siteEnv(SPA_SITE, { paused: true });
    delete env.WAKE_HMAC_SECRET;
    const { ctx, waits } = fakeCtx();
    const res = await handle(req("/", { headers: HTML }), env, ctx, () => NOW);
    expect(res.status).toBe(503);
    await Promise.all(waits);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an unpaused spa host serves normally", async () => {
    const { env } = siteEnv(SPA_SITE);
    const res = await handle(req("/", { headers: HTML }), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<div id=root></div>");
  });

  it("legacy (non-spa) hosts never read the paused key", async () => {
    const { env, kvGets } = siteEnv(SPA_SITE, { spa: false, paused: true });
    const res = await handle(req("/", { headers: HTML }), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(200);
    expect(kvGets).toEqual([`host:${HOST}`]);
  });
});

describe("visit marks (lastseen)", () => {
  it("writes lastseen off the response path when it is missing", async () => {
    const { env, puts } = siteEnv(SPA_SITE);
    const { ctx, waits } = fakeCtx();
    const res = await handle(req("/", { headers: HTML }), env, ctx, () => NOW);
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(puts).toEqual([[`lastseen:${HOST}`, new Date(NOW).toISOString()]]);
  });

  it("does not rewrite a mark younger than an hour, rewrites an older one", async () => {
    const fresh = siteEnv(SPA_SITE, { lastseen: new Date(NOW - 59 * 60_000).toISOString() });
    const a = fakeCtx();
    await handle(req("/", { headers: HTML }), fresh.env, a.ctx, () => NOW);
    await Promise.all(a.waits);
    expect(fresh.puts).toEqual([]);

    const stale = siteEnv(SPA_SITE, { lastseen: new Date(NOW - 61 * 60_000).toISOString() });
    const b = fakeCtx();
    await handle(req("/", { headers: HTML }), stale.env, b.ctx, () => NOW);
    await Promise.all(b.waits);
    expect(stale.puts).toEqual([[`lastseen:${HOST}`, new Date(NOW).toISOString()]]);
  });

  it("never blocks the response on the lastseen read", async () => {
    const { env } = siteEnv(SPA_SITE, { kvGetHang: (k) => k.startsWith("lastseen:") });
    const { ctx, waits } = fakeCtx();
    const res = await handle(req("/", { headers: HTML }), env, ctx, () => NOW);
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
  });

  it("does not mark asset requests, legacy hosts or previews", async () => {
    const asset = siteEnv(SPA_SITE);
    const a = fakeCtx();
    await handle(req("/assets/app-1.js", { headers: { accept: "*/*" } }), asset.env, a.ctx, () => NOW);
    expect(a.waits).toHaveLength(0);

    const legacy = siteEnv(SPA_SITE, { spa: false });
    const b = fakeCtx();
    await handle(req("/", { headers: HTML }), legacy.env, b.ctx, () => NOW);
    expect(b.waits).toHaveLength(0);

    const pv = siteEnv({ ...SPA_SITE, [`sites/${HOST}/d_s/index.html`]: "s" });
    const c = fakeCtx();
    const cookie = `__zavi_preview=d_s.${previewToken(HOST, "d_s", NOW_S + 600)}`;
    await handle(req("/", { headers: { ...HTML, cookie } }), pv.env, c.ctx, () => NOW);
    expect(c.waits).toHaveLength(0);
  });

  it("the default export passes the real ExecutionContext through", async () => {
    const { env } = siteEnv(SPA_SITE);
    const { ctx, waits } = fakeCtx();
    await worker.fetch(req("/", { headers: HTML }), env, ctx);
    expect(waits).toHaveLength(1);
  });
});

const UNPUBLISHED_MESSAGE = "This site hasn't been published yet. Publish it from Zavi to see it here.";
const UNPUBLISHED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="15">
<title>Not published yet</title>
<style>
html,body{height:100%;margin:0}
body{background:#1c1c1c;color:#a1a1aa;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:0 16px;box-sizing:border-box;text-align:center}
main{display:flex;flex-direction:column;align-items:center;gap:28px;max-width:640px}
svg{width:88px;height:88px}
p{margin:0;font-size:17px;line-height:1.5;letter-spacing:.01em}
</style>
</head>
<body>
<main>
<svg viewBox="0 0 88 88" aria-hidden="true"><rect width="88" height="88" rx="24" fill="#a1a1aa"/><path d="M26 28h36v8L38 60h24v8H26v-8l24-24H26z" fill="#1c1c1c"/></svg>
<p>${UNPUBLISHED_MESSAGE}</p>
</main>
</body>
</html>`;
const PLAIN_UNPUBLISHED = "This site is not published yet";

function unpublishedEnv(kvSeed: Record<string, string> = {}) {
  const files: Record<string, string> = {
    [`sites/${HOST}/${DEPLOY}/index.html`]: "<h1>staged, never published</h1>",
    [`sites/${HOST}/${DEPLOY}/404.html`]: "<h1>the site's own 404</h1>",
    [`sites/${HOST}/${DEPLOY}/assets/app-1.js`]: "js",
  };
  const kv: Record<string, string> = { ...kvSeed };
  const base = makeEnv(files);
  const puts: Array<[string, string]> = [];
  const env: Env = {
    ...base.env,
    HOSTS: {
      async get(key: string) {
        base.kvGets.push(key);
        return key in kv ? kv[key] : null;
      },
      async put(key: string, value: string) {
        puts.push([key, value]);
        kv[key] = value;
      },
    },
    PREVIEW_HMAC_SECRET: PREVIEW_SECRET,
    WAKE_HMAC_SECRET: WAKE_SECRET,
    ZAVI_API: "https://api.example.test",
  };
  return { env, kv, puts, r2Gets: base.r2Gets, kvGets: base.kvGets };
}

const KV_EDGE_MISS_WINDOW_S = 60;

function scheduledReload(html: string): { seconds: number; target: string | null } | null {
  const tag = html.match(/<meta\s+http-equiv=["']?refresh["']?\s+content=["']([^"']*)["'][^>]*>/i);
  if (!tag) return null;
  const m = tag[1].match(/^\s*(\d+)\s*(?:[;,]\s*url\s*=\s*(.+))?$/i);
  if (!m) return null;
  return { seconds: Number(m[1]), target: m[2]?.trim() ?? null };
}

function expectUnpublishedPageHeaders(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(res.headers.get("x-zavi-deploy-id")).toBeNull();
  expect(res.headers.get("etag")).toBeNull();
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("retry-after")).toBeNull();
}

describe("unpublished host (no host record)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("an HTML navigation gets the Zavi not-published page: 404, never cached, noindex, nothing read from R2, no wake, no visit mark", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const { env, r2Gets, kvGets, puts } = unpublishedEnv({ [`paused:${HOST}`]: "1" });
    const { ctx, waits } = fakeCtx();
    const res = await handle(req("/", { headers: HTML }), env, ctx, () => NOW);
    expectUnpublishedPageHeaders(res);
    const body = await res.text();
    expect(body).toBe(UNPUBLISHED_HTML);
    expect(body).toContain(UNPUBLISHED_MESSAGE);
    expect(body).toContain("<title>Not published yet</title>");
    expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(body).not.toMatch(/<script|https?:\/\/|\ssrc=|\shref=|@import|url\(/i);
    expect(body).not.toContain("staged, never published");
    expect(r2Gets).toEqual([]);
    expect(kvGets).toEqual([`host:${HOST}`]);
    expect(waits).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it.each(["/", "/book", "/deep/client/route/"])(
    "a visitor who opens %s while this edge still misses the just-written host record reaches the live site with no manual reload",
    async (path) => {
      const { env, kv, r2Gets } = unpublishedEnv();
      kv[`host:${HOST}`] = "";
      const first = await handle(req(path, { headers: HTML }), env, fakeCtx().ctx, () => NOW);
      expectUnpublishedPageHeaders(first);
      const reload = scheduledReload(await first.text());
      expect(reload, "the not-published page must reload itself").not.toBeNull();
      expect(reload!.target).toBeNull();
      expect(reload!.seconds).toBeGreaterThan(0);
      expect(reload!.seconds).toBeLessThanOrEqual(KV_EDGE_MISS_WINDOW_S);
      expect(r2Gets).toEqual([]);

      kv[`host:${HOST}`] = JSON.stringify({ deploy_id: DEPLOY, sha: "abc", tenant_id: "t1", published_at: "2026-09-30T12:00:00Z", spa: true });
      const second = await handle(req(path, { headers: HTML }), env, fakeCtx().ctx, () => NOW + reload!.seconds * 1000);
      expect(second.status).toBe(200);
      expect(second.headers.get("x-zavi-deploy-id")).toBe(DEPLOY);
      expect(await second.text()).toBe("<h1>staged, never published</h1>");
    },
  );

  it.each(["/pricing", "/about.html", "/deep/client/route/", "/assets/app-1.js", "/404.html"])(
    "a browser opening %s on an unpublished host gets the same page, never a staged file",
    async (path) => {
      const { env, r2Gets } = unpublishedEnv();
      const res = await handle(req(path, { headers: HTML }), env, fakeCtx().ctx, () => NOW);
      expectUnpublishedPageHeaders(res);
      expect(await res.text()).toBe(UNPUBLISHED_HTML);
      expect(r2Gets).toEqual([]);
    },
  );

  it("HEAD navigation: the same status and headers, and no body", async () => {
    const { env, r2Gets } = unpublishedEnv();
    const res = await worker.fetch(req("/", { method: "HEAD", headers: HTML }), env);
    expectUnpublishedPageHeaders(res);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe("");
    expect(r2Gets).toEqual([]);
  });

  it("the default export, with no ExecutionContext, serves the page with x-robots-tag noindex, nofollow", async () => {
    const { env } = unpublishedEnv();
    const res = await worker.fetch(req("/", { headers: { accept: "TEXT/HTML" } }), env);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(UNPUBLISHED_HTML);
  });

  it.each(["not json", JSON.stringify({ deploy_id: "../other" }), JSON.stringify({ deploy_id: 5 }), ""])(
    "a malformed or unsafe host record (%s) is unpublished: the page, and R2 is never read",
    async (value) => {
      const { env, r2Gets } = unpublishedEnv({ [`host:${HOST}`]: value });
      const res = await handle(req("/", { headers: HTML }), env, fakeCtx().ctx, () => NOW);
      expectUnpublishedPageHeaders(res);
      expect(await res.text()).toBe(UNPUBLISHED_HTML);
      expect(r2Gets).toEqual([]);
    },
  );

  it.each([
    ["no Accept header", "/", undefined],
    ["a script fetch", "/assets/app-1.js", "*/*"],
    ["an image fetch", "/favicon.ico", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"],
    ["a stylesheet fetch", "/assets/app.css", "text/css,*/*;q=0.1"],
    ["a JSON client", "/api/data", "application/json"],
    ["a plain-text client at the root", "/", "text/plain"],
  ])("%s keeps the short plain 404 and never gets the HTML page", async (_label, path, accept) => {
    for (const method of ["GET", "HEAD"]) {
      const { env, r2Gets } = unpublishedEnv();
      const res = await handle(req(path, { method, headers: accept ? { accept } : {} }), env, fakeCtx().ctx, () => NOW);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.text();
      expect(body).toBe(method === "HEAD" ? "" : PLAIN_UNPUBLISHED);
      expect(body).not.toContain("<");
      expect(r2Gets).toEqual([]);
    }
  });

  it("a publish shows on the very next request, and an unpublish brings the page back", async () => {
    const { env, kv } = unpublishedEnv();
    const nav = () => handle(req("/", { headers: HTML }), env, fakeCtx().ctx, () => NOW);
    const before = await nav();
    expectUnpublishedPageHeaders(before);
    expect(await before.text()).toBe(UNPUBLISHED_HTML);
    kv[`host:${HOST}`] = JSON.stringify({ deploy_id: DEPLOY, sha: "abc", tenant_id: "t1", published_at: "2026-10-02T00:00:00Z", spa: true });
    const after = await nav();
    expect(after.status).toBe(200);
    expect(await after.text()).toBe("<h1>staged, never published</h1>");
    expect(after.headers.get("x-zavi-deploy-id")).toBe(DEPLOY);
    expect(after.headers.get("x-robots-tag")).toBeNull();
    delete kv[`host:${HOST}`];
    const again = await nav();
    expectUnpublishedPageHeaders(again);
    expect(await again.text()).toBe(UNPUBLISHED_HTML);
  });

  it("a signed preview of the staged deploy still works on an unpublished host; without the cookie the same host shows the page", async () => {
    const { env } = unpublishedEnv();
    const cookie = `__zavi_preview=${DEPLOY}.${previewToken(HOST, DEPLOY, NOW_S + 600)}`;
    const previewed = await handle(req("/", { headers: { ...HTML, cookie } }), env, fakeCtx().ctx, () => NOW);
    expect(previewed.status).toBe(200);
    expect(await previewed.text()).toBe("<h1>staged, never published</h1>");
    expect(previewed.headers.get("x-robots-tag")).toBeNull();
    const forged = `__zavi_preview=${DEPLOY}.${previewToken(HOST, DEPLOY, NOW_S + 600, "wrong")}`;
    const refused = await handle(req("/", { headers: { ...HTML, cookie: forged } }), env, fakeCtx().ctx, () => NOW);
    expectUnpublishedPageHeaders(refused);
    expect(await refused.text()).toBe(UNPUBLISHED_HTML);
  });
});

describe("published hosts never see the not-published page (guard)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a published host serves its site to a browser, with no noindex header", async () => {
    const { env } = siteEnv(SPA_SITE);
    for (const path of ["/", "/pricing"]) {
      const res = await handle(req(path, { headers: HTML }), env, fakeCtx().ctx, () => NOW);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<div id=root></div>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(res.headers.get("x-zavi-deploy-id")).toBe(DEPLOY);
    }
  });

  it("a published host's own missing page stays its own 404, HTML or plain", async () => {
    const own = live(SITE);
    const custom = await handle(req("/missing", { headers: HTML }), own.env, fakeCtx().ctx, () => NOW);
    expect(custom.status).toBe(404);
    expect(await custom.text()).toBe("<h1>custom 404</h1>");
    expect(custom.headers.get("x-robots-tag")).toBeNull();
    const bare = live({ "index.html": "home" });
    const plain = await handle(req("/missing", { headers: HTML }), bare.env, fakeCtx().ctx, () => NOW);
    expect(plain.status).toBe(404);
    expect(await plain.text()).toBe("Not Found");
    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("a paused published host still gets the waking page, not the not-published page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const { env } = siteEnv(SPA_SITE, { paused: true });
    const res = await handle(req("/", { headers: HTML }), env, fakeCtx().ctx, () => NOW);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("waking up");
    expect(body).not.toContain(UNPUBLISHED_MESSAGE);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("a missing or malformed preview-domain host keeps its own plain 404, even for a browser", async () => {
    const { env } = unpublishedEnv();
    env.PREVIEW_DOMAIN = "zavi-preview.dev";
    for (const host of [`${"a".repeat(26)}.zavi-preview.dev`, "www.zavi-preview.dev", "zavi-preview.dev"]) {
      const res = await handle(req("/", { host, headers: HTML }), env, fakeCtx().ctx, () => NOW);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe("This preview does not exist or has expired");
    }
  });
});
