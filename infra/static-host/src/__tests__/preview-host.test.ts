import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handle, hostKind, type Env, type R2ObjectBodyLike } from "../worker";

const LIVE = "acme.zaviagent.com";
const DOMAIN = "zavi-preview.dev";
const P1 = `${"a".repeat(26)}.${DOMAIN}`;
const P2 = `${"b".repeat(26)}.${DOMAIN}`;
const LIVE_DEPLOY = "d000000001-00000001";
const STAGED = "d000000002-00000002";
const OTHER = "d000000003-00000003";
const SECRET = "preview-secret";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const NOW_S = Math.floor(NOW / 1000);
const TEST_1 = "44444444-4444-4444-8444-444444444444";

function token(host: string, deploy: string, exp = NOW_S + 600, secret = SECRET): string {
  return `${exp}.${createHmac("sha256", secret).update(`preview.${host}.${deploy}.${exp}`).digest("hex")}`;
}
const cookieFor = (host: string, deploy: string, exp?: number, secret?: string) => `__zavi_preview=${deploy}.${token(host, deploy, exp, secret)}`;

function rec(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, hostname: LIVE, test_site_id: TEST_1, deploy_id: STAGED, exp: NOW_S + 900, shard_id: "abcdefghijklmnopqrst", shard_url: "https://abcdefghijklmnopqrst.supabase.co", ...extra });
}

function world(kvExtra: Record<string, string> = {}, opts: { domain?: string | null; secret?: string | null } = {}) {
  const files: Record<string, string> = {
    [`sites/${LIVE}/${LIVE_DEPLOY}/index.html`]: "<h1>live</h1>",
    [`sites/${LIVE}/${STAGED}/index.html`]: "<h1>candidate</h1>",
    [`sites/${LIVE}/${OTHER}/index.html`]: "<h1>other</h1>",
    [`sites/${P1}/${STAGED}/index.html`]: "<h1>planted under preview host</h1>",
  };
  const kv: Record<string, string> = {
    [`host:${LIVE}`]: JSON.stringify({ deploy_id: LIVE_DEPLOY, sha: "abc", tenant_id: "t1", published_at: "2026-09-29T00:00:00Z", spa: true }),
    [`preview:${P1}`]: rec(),
    ...kvExtra,
  };
  const kvGets: string[] = [];
  const r2Gets: string[] = [];
  const env: Env = {
    SITES: {
      async get(key: string): Promise<R2ObjectBodyLike | null> {
        r2Gets.push(key);
        if (!(key in files)) return null;
        const bytes = new TextEncoder().encode(files[key]);
        return { body: new Blob([bytes]).stream(), size: bytes.byteLength };
      },
    },
    HOSTS: {
      async get(key: string) {
        kvGets.push(key);
        return key in kv ? kv[key] : null;
      },
    },
    ...(opts.secret === null ? {} : { PREVIEW_HMAC_SECRET: opts.secret ?? SECRET }),
    ...(opts.domain === null ? {} : { PREVIEW_DOMAIN: opts.domain ?? DOMAIN }),
  };
  return { env, kvGets, r2Gets };
}

const get = (env: Env, host: string, path: string, headers: Record<string, string> = {}) =>
  handle(new Request(`https://${host}${path}`, { headers: { accept: "text/html", ...headers } }), env, undefined, () => NOW);

describe("preview host classification", () => {
  it("only a single 26-char base32 label under the domain is a preview host", () => {
    expect(hostKind(P1, DOMAIN)).toBe("preview");
    expect(hostKind(DOMAIN, DOMAIN)).toBe("reserved");
    expect(hostKind(`x.${DOMAIN}`, DOMAIN)).toBe("reserved");
    expect(hostKind(LIVE, DOMAIN)).toBe("site");
    expect(hostKind(P1, null)).toBe("site");
  });
});

describe("preview host", () => {
  it("the signed entry link sets the cookie; the candidate deploy is then served from the LIVE prefix", async () => {
    const { env, kvGets, r2Gets } = world();
    const entry = await get(env, P1, `/__zavi_preview/${STAGED}/?t=${token(P1, STAGED)}`);
    expect(entry.status).toBe(302);
    const setCookie = entry.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`__zavi_preview=${STAGED}.`);
    const cookie = setCookie.split(";")[0];
    const res = await get(env, P1, "/bookings", { cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>candidate</h1>");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(r2Gets.every((k) => k.startsWith(`sites/${LIVE}/${STAGED}/`))).toBe(true);
    expect(kvGets.some((k) => k.startsWith("host:"))).toBe(false);
  });

  it("without a cookie, or with a forged / expired / wrong-secret one, nothing is served", async () => {
    for (const cookie of [undefined, `__zavi_preview=${STAGED}.${NOW_S + 600}.${"0".repeat(64)}`, cookieFor(P1, STAGED, NOW_S - 1), cookieFor(P1, STAGED, NOW_S + 600, "other")]) {
      const { env, r2Gets } = world();
      const res = await get(env, P1, "/", cookie ? { cookie } : {});
      expect(res.status, String(cookie)).toBe(403);
      expect(r2Gets).toHaveLength(0);
    }
  });

  it("a valid cookie for ANOTHER deploy (even one under the same live prefix) is refused", async () => {
    const { env, r2Gets } = world();
    const res = await get(env, P1, "/", { cookie: cookieFor(P1, OTHER) });
    expect(res.status).toBe(403);
    expect(r2Gets).toHaveLength(0);
  });

  it("an entry link for a deploy the record does not name is refused, even when correctly signed", async () => {
    const { env } = world();
    const res = await get(env, P1, `/__zavi_preview/${OTHER}/?t=${token(P1, OTHER)}`);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a cookie or link for one preview host does not open another (swap)", async () => {
    const { env, r2Gets } = world({ [`preview:${P2}`]: rec({ test_site_id: "55555555-5555-4555-8555-555555555555" }) });
    expect((await get(env, P2, "/", { cookie: cookieFor(P1, STAGED) })).status).toBe(403);
    expect((await get(env, P2, `/__zavi_preview/${STAGED}/?t=${token(P1, STAGED)}`)).status).toBe(403);
    expect(r2Gets).toHaveLength(0);
  });

  it("an expired, missing or malformed record serves nothing, whatever the cookie", async () => {
    for (const r of [rec({ exp: NOW_S }), null, rec({ hostname: P2 }), rec({ hostname: "../x" }), rec({ deploy_id: "../d" }), "{"]) {
      const { env, r2Gets } = world(r === null ? { [`preview:${P1}`]: "" } : { [`preview:${P1}`]: r });
      const res = await get(env, P1, "/", { cookie: cookieFor(P1, STAGED) });
      expect(res.status, String(r)).toBe(404);
      expect(r2Gets).toHaveLength(0);
    }
  });

  it("a preview host never falls back to host: and malformed preview-domain hosts are 404", async () => {
    const planted = JSON.stringify({ deploy_id: LIVE_DEPLOY, sha: "x", tenant_id: "t", published_at: "x", spa: true });
    const { env, kvGets } = world({ [`preview:${P1}`]: "", [`host:${P1}`]: planted, [`host:x.${DOMAIN}`]: planted });
    expect((await get(env, P1, "/")).status).toBe(404);
    expect((await get(env, `x.${DOMAIN}`, "/")).status).toBe(404);
    expect(kvGets.filter((k) => k.startsWith("host:"))).toEqual([]);
  });
});

describe("live hostname is unaffected", () => {
  it("serves the live deploy; a planted preview: record or a preview cookie for another host changes nothing", async () => {
    const { env, kvGets } = world({ [`preview:${LIVE}`]: rec() });
    const res = await get(env, LIVE, "/", { cookie: cookieFor(P1, STAGED) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>live</h1>");
    expect(kvGets.some((k) => k.startsWith("preview:"))).toBe(false);
  });

  it("with no PREVIEW_DOMAIN configured, preview-looking hosts are ordinary hosts (no record = not published)", async () => {
    const { env } = world({}, { domain: null });
    expect((await get(env, P1, "/")).status).toBe(404);
  });
});
