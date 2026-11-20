import { describe, expect, it } from "vitest";
import { handle, type Env, type R2ObjectBodyLike } from "../worker";

const HOST = "home-cleaning-san-jose.zaviagent.com";
const DEPLOY = "d000000001-0a1b2c3d";

function env(record: Record<string, unknown>): Env {
  const files: Record<string, string> = {
    [`sites/${HOST}/${DEPLOY}/index.html`]: "<html><head></head><body><div id=root></div></body></html>",
    [`sites/${HOST}/${DEPLOY}/assets/app.js`]: "js",
    [`sites/${HOST}/${DEPLOY}/robots.txt`]: "User-agent: *\nAllow: /",
  };
  const kv: Record<string, string> = { [`host:${HOST}`]: JSON.stringify(record) };
  return {
    SITES: {
      async get(key: string): Promise<R2ObjectBodyLike | null> {
        if (!(key in files)) return null;
        const bytes = new TextEncoder().encode(files[key]);
        return { body: new Blob([bytes]).stream(), size: bytes.byteLength, httpEtag: `"e"` };
      },
    },
    HOSTS: {
      async get(key: string) {
        return key in kv ? kv[key] : null;
      },
      async put() {},
    },
  };
}

const HELD = { deploy_id: DEPLOY, sha: "abc", tenant_id: "t1", published_at: "2026-11-19T00:00:00Z", spa: true, noindex: true };
const RELEASED = { ...HELD, noindex: undefined };
const HTML = { accept: "text/html" };
const get = (e: Env, path: string, headers: Record<string, string> = HTML, method = "GET") =>
  handle(new Request(`https://${HOST}${path}`, { method, headers }), e, { waitUntil: () => undefined });

describe("a live site held from search until the owner checks it", () => {
  it("marks every response of a held site noindex: the page, a deep link, an asset, robots.txt and a HEAD", async () => {
    const e = env(HELD);
    for (const [path, headers, method] of [
      ["/", HTML, "GET"],
      ["/services/deep-clean", HTML, "GET"],
      ["/assets/app.js", {}, "GET"],
      ["/robots.txt", {}, "GET"],
      ["/", HTML, "HEAD"],
    ] as const) {
      const res = await get(e, path, headers, method);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-robots-tag"), `${method} ${path}`).toBe("noindex, nofollow");
    }
  });

  it("still serves the real page to visitors while held", async () => {
    const res = await get(env(HELD), "/");
    expect(res.headers.get("x-zavi-deploy-id")).toBe(DEPLOY);
    expect(await res.text()).toContain("<div id=root></div>");
  });

  it("a released site is indexable again", async () => {
    for (const path of ["/", "/assets/app.js"]) {
      const res = await get(env(RELEASED), path, path === "/" ? HTML : {});
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag"), path).toBeNull();
    }
  });

  it("only a literal true holds the site: a malformed flag does not hide a live site", async () => {
    const res = await get(env({ ...HELD, noindex: "yes" }), "/");
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });
});
