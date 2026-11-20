import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ safeFetch: vi.fn(), resolveAccount: vi.fn(), exec: vi.fn(), site: vi.fn(), guarded: vi.fn() }));
vi.mock("@/services/start-card/seed/notice-store", () => ({ guardedFetch: m.guarded }));
vi.mock("@/services/onboarding/enrichment/discover", () => ({ safeFetchText: m.safeFetch }));
vi.mock("@/services/onboarding/enrichment/url-guard", () => ({ assertSafeUrl: async (u: string) => new URL(u), SsrfBlockedError: class extends Error {} }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: m.resolveAccount }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: m.exec }));
vi.mock("@/services/tools/growth/seo/run", () => ({ resolveTenantSite: m.site }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: vi.fn(), tenantStorage: () => { throw new Error("storage must be injected"); } }));

import { eTldPlusOne } from "@/services/onboarding/enrichment/domain-match";
import {
  BOARD_LIST_BUDGET_MS,
  PINTEREST_BOARD_PAGE_CAP,
  PINTEREST_MAX_IMAGE_BYTES,
  PINTEREST_READINESS_CODES,
  PINTEREST_READINESS_TEXT,
  connectedPinterestUsername,
  hasNopinMeta,
  listPinterestBoards,
  resolvePinterestPublishReadiness,
  sameSiteIdentity,
  type PinterestReadinessDeps,
} from "../readiness";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "e0fe9ea8-0000-4000-8000-000000000000";
const IMG = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`;
const ACCOUNT = { tenant_id: TENANT, toolkit: "pinterest", connected_account_id: "ca_pin", auth_config_id: "ac" } as never;
const HTML_OK = `<html><head><meta property="og:title" content="Duvet"></head></html>`;
const HTML_NOPIN = `<html><head><meta name="pinterest" content="nopin" /></head></html>`;

function page(items: Array<Record<string, unknown>>, bookmark: string | null = null) {
  return { ok: true, status: 200, data: { items, bookmark }, error: null, outcome_unknown: false };
}

function deps(over: Partial<PinterestReadinessDeps> = {}): Partial<PinterestReadinessDeps> & {
  execute: ReturnType<typeof vi.fn>;
  storageInfo: ReturnType<typeof vi.fn>;
  fetchText: ReturnType<typeof vi.fn>;
  tenantSite: ReturnType<typeof vi.fn>;
  resolveAccount: ReturnType<typeof vi.fn>;
} {
  return {
    resolveAccount: vi.fn(async () => ACCOUNT),
    execute: vi.fn(async () => page([{ id: "222", name: "Linen", privacy: "PUBLIC" }])),
    storageInfo: vi.fn(async () => ({ contentType: "image/jpeg", size: 300_000 })),
    fetchText: vi.fn(async () => HTML_OK),
    tenantSite: vi.fn(async () => "https://acme.com"),
    now: () => 1_000_000,
    ...over,
  } as never;
}

const PIN = { board_id: "222", image_path: IMG, link: "https://acme.com/products/duvet" };

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
});

describe("board check", () => {
  it("follows the bookmark to a board on page 2, passing the bookmark back", async () => {
    const d = deps({
      execute: vi.fn()
        .mockResolvedValueOnce(page([{ id: "111", name: "A", privacy: "PUBLIC" }], "bm-2"))
        .mockResolvedValueOnce(page([{ id: "222", name: "Linen", privacy: "PUBLIC" }], null)) as never,
    });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r.ok).toBe(true);
    expect(r.checks.board).toEqual({ status: "pass" });
    expect(r.board).toEqual({ id: "222", name: "Linen", privacy: "PUBLIC", description: null, pin_count: null });
    expect(d.execute).toHaveBeenCalledTimes(2);
    expect(d.execute.mock.calls[0][0]).toMatchObject({ tool_slug: "PINTEREST_LIST_BOARDS", user_id: TENANT, connected_account_id: "ca_pin", arguments: { page_size: 250 } });
    expect(d.execute.mock.calls[0][0].arguments).not.toHaveProperty("bookmark");
    expect(d.execute.mock.calls[1][0].arguments).toEqual({ page_size: 250, bookmark: "bm-2" });
  });

  it("stops at the page cap on an endless bookmark and calls the board unverified, not missing", async () => {
    let n = 0;
    const d = deps({ execute: vi.fn(async () => page([{ id: `b${n}`, name: "x", privacy: "PUBLIC" }], `bm-${++n}`)) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(d.execute.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_LIST_BOARDS")).toHaveLength(PINTEREST_BOARD_PAGE_CAP);
    expect(r.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
    expect(r.ok).toBe(false);
    expect(r.reason_code).toBe("pinterest_lookup_failed");
  });

  it("a board past the page cap is looked up by id and passes, without failing as missing", async () => {
    let n = 0;
    const d = deps({
      execute: vi.fn(async (a: { tool_slug: string; arguments: Record<string, unknown> }) =>
        a.tool_slug === "PINTEREST_GET_BOARD"
          ? { ok: true, status: 200, data: { response_data: { id: "222", name: "Linen", privacy: "PUBLIC" } }, error: null, outcome_unknown: false }
          : page([{ id: `b${n}`, name: "x", privacy: "PUBLIC" }], `bm-${++n}`),
      ) as never,
    });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    const direct = d.execute.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_GET_BOARD");
    expect(direct).toHaveLength(1);
    expect(direct[0][0]).toMatchObject({ user_id: TENANT, connected_account_id: "ca_pin", arguments: { board_id: "222" } });
    expect(d.execute.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_LIST_BOARDS")).toHaveLength(PINTEREST_BOARD_PAGE_CAP);
    expect(r.checks.board).toEqual({ status: "pass" });
    expect(r.board).toMatchObject({ id: "222", name: "Linen", privacy: "PUBLIC" });
    expect(r.ok).toBe(true);
  });

  it("a board looked up by id past the page cap that is secret still fails as secret", async () => {
    const d = deps({
      execute: vi.fn(async (a: { tool_slug: string }) =>
        a.tool_slug === "PINTEREST_GET_BOARD"
          ? { ok: true, status: 200, data: { id: "222", name: "Linen", privacy: "SECRET" }, error: null, outcome_unknown: false }
          : page([{ id: "111", name: "x", privacy: "PUBLIC" }], "bm-same"),
      ) as never,
    });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r.checks.board).toMatchObject({ status: "fail", reason_code: "pinterest_board_secret" });
  });

  it("a direct lookup that returns some other board does not pass the staged one", async () => {
    let n = 0;
    const d = deps({
      execute: vi.fn(async (a: { tool_slug: string }) =>
        a.tool_slug === "PINTEREST_GET_BOARD"
          ? { ok: true, status: 200, data: { id: "999", name: "Other", privacy: "PUBLIC" }, error: null, outcome_unknown: false }
          : page([{ id: `b${n}`, name: "x", privacy: "PUBLIC" }], `bm-${++n}`),
      ) as never,
    });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
  });

  it("a full list that lacks the board never asks for it by id", async () => {
    const d = deps({ execute: vi.fn(async () => page([{ id: "111", name: "x", privacy: "PUBLIC" }])) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(d.execute.mock.calls.some((c) => c[0].tool_slug === "PINTEREST_GET_BOARD")).toBe(false);
    expect(r.checks.board).toMatchObject({ status: "fail", reason_code: "pinterest_board_missing" });
  });

  it("stops paging once the board is found", async () => {
    const d = deps({
      execute: vi.fn()
        .mockResolvedValueOnce(page([{ id: "222", name: "Linen", privacy: "PUBLIC" }], "bm-2"))
        .mockResolvedValue(page([], null)) as never,
    });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r.checks.board.status).toBe("pass");
    expect(d.execute).toHaveBeenCalledTimes(1);
  });

  it("fails pinterest_no_boards when the account has none", async () => {
    const d = deps({ execute: vi.fn(async () => page([])) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_no_boards", reason: PINTEREST_READINESS_TEXT.pinterest_no_boards });
    const acct = await resolvePinterestPublishReadiness(TENANT, undefined, { deps: d });
    expect(acct.checks.board).toMatchObject({ status: "fail", reason_code: "pinterest_no_boards" });
  });

  it("fails pinterest_board_missing when the full list lacks the id", async () => {
    const d = deps({ execute: vi.fn(async () => page([{ id: "111", name: "A", privacy: "PUBLIC" }])) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_board_missing", board: null, board_count: 1 });
  });

  it("fails pinterest_board_secret for a secret board, and reports its privacy", async () => {
    const d = deps({ execute: vi.fn(async () => page([{ id: "222", name: "Drafts", privacy: "SECRET" }])) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_board_secret", board: { id: "222", privacy: "SECRET" } });
    const acct = await resolvePinterestPublishReadiness(TENANT, undefined, { deps: d });
    expect(acct.checks.board).toMatchObject({ status: "fail", reason_code: "pinterest_board_secret" });
  });

  it("reads the list out of Composio's response_data wrapper", async () => {
    const d = deps({ execute: vi.fn(async () => ({ ok: true, status: 200, data: JSON.stringify({ response_data: { items: [{ id: 222, name: "Linen" }] } }), error: null, outcome_unknown: false })) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r.checks.board.status).toBe("pass");
    expect(r.board?.name).toBe("Linen");
  });

  it("fails pinterest_not_connected without listing boards", async () => {
    const d = deps({ resolveAccount: vi.fn(async () => null) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, undefined, { deps: d });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_not_connected" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("a failed lookup is unverified and blocks, and nothing throws", async () => {
    for (const over of [
      { resolveAccount: vi.fn(async () => { throw new Error("db down"); }) },
      { execute: vi.fn(async () => ({ ok: false, status: 503, data: null, error: "x", outcome_unknown: false })) },
      { execute: vi.fn(async () => { throw new Error("net"); }) },
    ]) {
      const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps(over as never) });
      expect(r.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
      expect(r.ok).toBe(false);
    }
  });
});

describe("board check: what the lookup did not prove", () => {
  it("a success with no board array is a failed lookup, never an empty account", async () => {
    for (const data of [{}, { items: null }, { items: "nope" }]) {
      const d = deps({ execute: vi.fn(async () => ({ ok: true, status: 200, data, error: null, outcome_unknown: false })) as never });
      const pin = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
      expect(pin.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
      const account = await resolvePinterestPublishReadiness(TENANT, undefined, { deps: d });
      expect(account.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
      expect(account.reason_code).not.toBe("pinterest_no_boards");
    }
  });

  it("an incomplete list of only secret boards is unverified, not ready", async () => {
    let n = 0;
    const d = deps({ execute: vi.fn(async () => page([{ id: `s${n}`, name: "x", privacy: "SECRET" }], `bm-${++n}`)) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, undefined, { deps: d });
    expect(r.ok).toBe(false);
    expect(r.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
    const done = await resolvePinterestPublishReadiness(TENANT, undefined, { deps: deps({ execute: vi.fn(async () => page([{ id: "s", name: "x", privacy: "SECRET" }])) as never }) });
    expect(done.checks.board).toMatchObject({ status: "fail", reason_code: "pinterest_board_secret" });
  });
});

describe("media check", () => {
  it("passes a tenant-owned jpeg under the cap, asking storage for exactly that path", async () => {
    const d = deps();
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(r.checks.media).toEqual({ status: "pass" });
    expect(d.storageInfo).toHaveBeenCalledWith(TENANT, IMG);
  });

  it("refuses another tenant's path without touching storage", async () => {
    const d = deps();
    const r = await resolvePinterestPublishReadiness(TENANT, { ...PIN, image_path: `${OTHER}/9f9f9f9f-0000-4000-8000-000000000000.jpg` }, { deps: d });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_media_invalid" });
    expect(d.storageInfo).not.toHaveBeenCalled();
  });

  it.each([
    ["missing object", null],
    ["gif", { contentType: "image/gif", size: 1000 }],
    ["no type", { contentType: null, size: 1000 }],
    ["over 20MB", { contentType: "image/png", size: PINTEREST_MAX_IMAGE_BYTES + 1 }],
    ["empty", { contentType: "image/webp", size: 0 }],
    ["unknown size", { contentType: "image/webp", size: null }],
  ])("fails pinterest_media_invalid for %s", async (_n, info) => {
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ storageInfo: vi.fn(async () => info) as never }) });
    expect(r.checks.media).toMatchObject({ status: "fail", reason_code: "pinterest_media_invalid" });
    expect(r.reason_code).toBe("pinterest_media_invalid");
  });

  it("accepts exactly 20MB and a content type with parameters", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ storageInfo: vi.fn(async () => ({ contentType: "image/png; charset=binary", size: PINTEREST_MAX_IMAGE_BYTES })) as never }) });
    expect(r.checks.media.status).toBe("pass");
  });

  it("a storage throw is a media failure, not a throw", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ storageInfo: vi.fn(async () => { throw new Error("s3"); }) as never }) });
    expect(r.checks.media.status).toBe("fail");
  });
});

describe("link check", () => {
  it("fetches through the injected safe fetcher with the bare host as the redirect root", async () => {
    const d = deps();
    await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://www.acme.com/products/duvet" }, { deps: d });
    expect(d.fetchText).toHaveBeenCalledTimes(1);
    const [url, root, deadline, max] = d.fetchText.mock.calls[0];
    expect(url).toBe("https://www.acme.com/products/duvet");
    expect(root).toBe("acme.com");
    expect(deadline).toBeGreaterThan(1_000_000);
    expect(max).toBeGreaterThan(0);
  });

  it("uses the SSRF-guarded safeFetchText by default, never a raw fetch", async () => {
    const raw = vi.spyOn(globalThis, "fetch");
    m.safeFetch.mockResolvedValue(HTML_OK);
    const d = deps();
    delete (d as Record<string, unknown>).fetchText;
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    expect(m.safeFetch).toHaveBeenCalledWith(PIN.link, "acme.com", expect.any(Number), expect.any(Number), expect.any(Function), expect.any(Function));
    const fetchImpl = m.safeFetch.mock.calls[0][5] as typeof fetch;
    m.guarded.mockResolvedValue(new Response("ok", { status: 200 }));
    const init = { method: "GET" };
    await fetchImpl("https://acme.com/x", init);
    expect(m.guarded).toHaveBeenCalledWith("https://acme.com/x", init);
    expect(raw).not.toHaveBeenCalled();
    expect(r.checks.link.status).toBe("pass");
    raw.mockRestore();
  });

  describe("through the real safeFetchText and guarded fetch", () => {
    async function viaRealFetcher(responses: Array<() => Response>) {
      const { safeFetchText } = await vi.importActual<typeof import("@/services/onboarding/enrichment/discover")>("@/services/onboarding/enrichment/discover");
      m.safeFetch.mockImplementation(safeFetchText);
      const queue = [...responses];
      m.guarded.mockImplementation(async () => {
        const next = queue.shift();
        if (!next) throw new Error("unexpected extra fetch");
        return next();
      });
      const d = deps({ now: () => Date.now() });
      delete (d as Record<string, unknown>).fetchText;
      return resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
    }
    const status = (code: number, headers?: Record<string, string>) => () => new Response(code >= 300 && code < 400 ? null : "gone", { status: code, headers });

    it.each([404, 410])("a %i page is a failure that refuses staging, not an unchecked warning", async (code) => {
      const r = await viaRealFetcher([status(code)]);
      expect(r.checks.link).toEqual({ status: "fail", reason_code: "pinterest_link_unreachable", reason: PINTEREST_READINESS_TEXT.pinterest_link_unreachable });
      expect(r).toMatchObject({ ok: false, reason_code: "pinterest_link_unreachable" });
    });

    it("a redirect that lands on a 404 is a failure too", async () => {
      const r = await viaRealFetcher([status(301, { location: "https://shop.acme.com/gone" }), status(404)]);
      expect(m.guarded).toHaveBeenCalledTimes(2);
      expect(m.guarded.mock.calls[1][0]).toBe("https://shop.acme.com/gone");
      expect(r).toMatchObject({ ok: false, reason_code: "pinterest_link_unreachable" });
    });

    it("a 404 that redirects on to a live page passes", async () => {
      const r = await viaRealFetcher([status(302, { location: "https://acme.com/products/duvet-v2" }), () => new Response(HTML_OK, { status: 200 })]);
      expect(r.checks.link).toEqual({ status: "pass" });
    });

    it.each([403, 429, 500, 503])("a %i bot block or server error stays unchecked and does not block", async (code) => {
      const r = await viaRealFetcher([status(code)]);
      expect(r.checks.link).toEqual({ status: "unverified", reason_code: "pinterest_link_unchecked", reason: PINTEREST_READINESS_TEXT.pinterest_link_unchecked });
      expect(r.ok).toBe(true);
      expect(r.reason_code).toBeUndefined();
    });

    it("a redirect off the company's domain to a 404 is not followed and stays unchecked", async () => {
      const r = await viaRealFetcher([status(301, { location: "https://evil.com/404" }), status(404)]);
      expect(m.guarded).toHaveBeenCalledTimes(1);
      expect(r.checks.link).toMatchObject({ status: "unverified", reason_code: "pinterest_link_unchecked" });
    });

    it("a network error stays unchecked", async () => {
      m.guarded.mockReset();
      const { safeFetchText } = await vi.importActual<typeof import("@/services/onboarding/enrichment/discover")>("@/services/onboarding/enrichment/discover");
      m.safeFetch.mockImplementation(safeFetchText);
      m.guarded.mockRejectedValue(new Error("ECONNRESET"));
      const d = deps({ now: () => Date.now() });
      delete (d as Record<string, unknown>).fetchText;
      const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: d });
      expect(r.checks.link).toMatchObject({ status: "unverified", reason_code: "pinterest_link_unchecked" });
      expect(r.ok).toBe(true);
    });
  });

  it("an injected fetcher that reports a 404 fails the link, a 403 does not", async () => {
    const at = (code: number) =>
      vi.fn(async (_u: string, _r: string, _d: number, _m: number, _a?: unknown, onStatus?: (s: number) => void) => {
        onStatus?.(code);
        return null;
      });
    const gone = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ fetchText: at(404) as never }) });
    expect(gone).toMatchObject({ ok: false, reason_code: "pinterest_link_unreachable" });
    const blocked = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ fetchText: at(403) as never }) });
    expect(blocked.checks.link).toMatchObject({ status: "unverified", reason_code: "pinterest_link_unchecked" });
    expect(blocked.ok).toBe(true);
  });

  it("the approve-time recheck of board and link refuses a 404 page", async () => {
    const fetchText = vi.fn(async (_u: string, _r: string, _d: number, _m: number, _a?: unknown, onStatus?: (s: number) => void) => {
      onStatus?.(404);
      return null;
    });
    const r = await resolvePinterestPublishReadiness(TENANT, { board_id: "222", link: PIN.link }, { only: ["board", "link"], deadlineMs: 5_000, deps: deps({ fetchText: fetchText as never }) });
    expect([r.checks.board, r.checks.link].find((c) => c.status === "fail")).toMatchObject({ reason_code: "pinterest_link_unreachable" });
  });

  it("lets the page redirect anywhere under the company's own domain, and nowhere else", async () => {
    const d = deps();
    await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://acme.com/products/duvet" }, { deps: d });
    expect(d.fetchText).toHaveBeenCalledTimes(1);
    const allow = d.fetchText.mock.calls[0][4] as (h: string) => boolean;
    expect(["acme.com", "www.acme.com", "shop.acme.com", "a.b.acme.com"].every(allow)).toBe(true);
    expect(["evil.com", "acme.com.evil.com", "notacme.com"].some(allow)).toBe(false);
  });

  it("keeps the exact-host redirect rule on a shared host", async () => {
    const d = deps({ tenantSite: vi.fn(async () => "acme.myshopify.com") as never });
    await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://acme.myshopify.com/p" }, { deps: d });
    expect(d.fetchText.mock.calls[0][1]).toBe("acme.myshopify.com");
    expect(d.fetchText.mock.calls[0][4]).toBeUndefined();
  });

  it("a page cut off before its head ends is not checked, and does not block", async () => {
    for (const html of ["", "<html><head><title>Duv"]) {
      const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ fetchText: vi.fn(async () => html) as never }) });
      expect(r.checks.link).toEqual({ status: "unverified", reason_code: "pinterest_link_partial", reason: PINTEREST_READINESS_TEXT.pinterest_link_partial });
      expect(r.ok).toBe(true);
    }
    const body = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ fetchText: vi.fn(async () => "<html><body><p>hi") as never }) });
    expect(body.checks.link).toEqual({ status: "pass" });
  });

  it("a page Zavi cannot open is not checked and does not block, since sites turn bots away", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ fetchText: vi.fn(async () => null) as never }) });
    expect(r.checks.link).toEqual({ status: "unverified", reason_code: "pinterest_link_unchecked", reason: PINTEREST_READINESS_TEXT.pinterest_link_unchecked });
    expect(r.ok).toBe(true);
    expect(r.reason_code).toBeUndefined();
  });

  it("fails an http link without fetching it", async () => {
    const d = deps();
    const r = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "http://acme.com/p" }, { deps: d });
    expect(r.checks.link).toMatchObject({ status: "fail", reason_code: "pinterest_link_unreachable" });
    expect(d.fetchText).not.toHaveBeenCalled();
  });

  it("fails pinterest_link_nopin when the page blocks pins", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ fetchText: vi.fn(async () => HTML_NOPIN) as never }) });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_link_nopin" });
    expect(r.checks.board.status).toBe("pass");
  });
});

describe("hasNopinMeta", () => {
  it.each([
    [`<meta name="pinterest" content="nopin">`, true],
    [`<meta content='nopin' name='pinterest' />`, true],
    [`<META NAME=pinterest CONTENT=NOPIN>`, true],
    [`<meta name="pinterest" content="nopin" description="Sorry">`, true],
    [`<meta name="pinterest-rich-pin" content="nopin">`, false],
    [`<meta name="description" content="nopin pinterest">`, false],
    [`<img data-pin-nopin="true" src="a.jpg">`, false],
    [`<meta name="pinterest" content="nohover">`, false],
    [`<!-- <meta name="pinterest" content="nopin"> --><meta name="x" content="y">`, false],
    [`<script>const t = '<meta name="pinterest" content="nopin">';</script>`, false],
    [`<!-- old --><meta name="pinterest" content="nopin">`, true],
    [`<script>x</script><meta name="pinterest" content="nopin">`, true],
  ])("%s -> %s", (html, want) => {
    expect(hasNopinMeta(html)).toBe(want);
  });
});

describe("identity check", () => {
  it("passes the same site, www twin and a subdomain of it", async () => {
    for (const link of ["https://acme.com/a", "https://www.acme.com/a", "https://shop.acme.com/a"]) {
      const r = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link }, { deps: deps({ tenantSite: vi.fn(async () => "www.acme.com") as never }) });
      expect(r.checks.identity).toEqual({ status: "pass" });
    }
  });

  it("fails pinterest_identity_mismatch for another domain", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://acme-deals.com/x" }, { deps: deps() });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_identity_mismatch" });
  });

  it("a sibling store on a shared host is a mismatch", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://rival.myshopify.com/p" }, { deps: deps({ tenantSite: vi.fn(async () => "https://acme.myshopify.com") as never }) });
    expect(r.checks.identity).toMatchObject({ status: "fail", reason_code: "pinterest_identity_mismatch" });
    expect(sameSiteIdentity("acme.myshopify.com", "www.acme.myshopify.com", eTldPlusOne)).toBe(true);
    expect(sameSiteIdentity("shop.acme.co.uk", "acme.co.uk", eTldPlusOne)).toBe(true);
    expect(sameSiteIdentity("rival.co.uk", "acme.co.uk", eTldPlusOne)).toBe(false);
  });

  it("another company's Zavi-hosted or Render site is a mismatch, and the company's own Zavi host still passes", async () => {
    const site = deps({ tenantSite: vi.fn(async () => "https://acme.zaviagent.com") as never });
    const rival = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://rival.zaviagent.com/p" }, { deps: site });
    expect(rival.checks.identity).toMatchObject({ status: "fail", reason_code: "pinterest_identity_mismatch" });
    expect(rival.ok).toBe(false);
    const own = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://acme.zaviagent.com/classes" }, { deps: site });
    expect(own.checks.identity).toMatchObject({ status: "pass" });
    expect(sameSiteIdentity("rival-1234abcd.onrender.com", "acme-5678efgh.onrender.com", eTldPlusOne)).toBe(false);
    expect(sameSiteIdentity("www.zaviagent.com", "acme.zaviagent.com", eTldPlusOne)).toBe(false);
  });

  it("a sibling under a domain Zavi does not know is shared is unverified, never checked", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://rival.blogspot.com/p" }, { deps: deps({ tenantSite: vi.fn(async () => "https://acme.blogspot.com") as never }) });
    expect(r.checks.identity).toEqual({ status: "unverified", reason_code: "pinterest_identity_related", reason: PINTEREST_READINESS_TEXT.pinterest_identity_related });
    expect(r.ok).toBe(true);
    const up = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://acme.com/p" }, { deps: deps({ tenantSite: vi.fn(async () => "https://shop.acme.com") as never }) });
    expect(up.checks.identity).toMatchObject({ status: "unverified", reason_code: "pinterest_identity_related" });
  });

  it("no website on file is unverified and does not block", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ tenantSite: vi.fn(async () => null) as never }) });
    expect(r.checks.identity).toMatchObject({ status: "unverified", reason_code: "pinterest_identity_unverified" });
    expect(r.ok).toBe(true);
    expect(r.reason_code).toBeUndefined();
  });

  it("a failing site lookup is unverified, not a throw", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { deps: deps({ tenantSite: vi.fn(async () => { throw new Error("db"); }) as never }) });
    expect(r.checks.identity.status).toBe("unverified");
    expect(r.ok).toBe(true);
  });
});

describe("shape", () => {
  it("only runs the requested checks", async () => {
    const d = deps();
    const r = await resolvePinterestPublishReadiness(TENANT, PIN, { only: ["board", "link"], deps: d });
    expect(r.checks.media).toEqual({ status: "skipped" });
    expect(r.checks.identity).toEqual({ status: "skipped" });
    expect(d.storageInfo).not.toHaveBeenCalled();
    expect(d.tenantSite).not.toHaveBeenCalled();
    expect(d.fetchText).toHaveBeenCalledTimes(1);
  });

  it("the account-level read skips media, link and identity", async () => {
    const d = deps();
    const r = await resolvePinterestPublishReadiness(TENANT, undefined, { deps: d });
    expect(r).toMatchObject({ ok: true, board_count: 1, checks: { board: { status: "pass" }, media: { status: "skipped" }, link: { status: "skipped" }, identity: { status: "skipped" } } });
  });

  it("names the first failing check in board, media, link, identity order", async () => {
    const r = await resolvePinterestPublishReadiness(TENANT, { ...PIN, link: "https://elsewhere.com/x" }, {
      deps: deps({ storageInfo: vi.fn(async () => null) as never, fetchText: vi.fn(async () => HTML_NOPIN) as never }),
    });
    expect(r.checks.media.status).toBe("fail");
    expect(r.checks.link.status).toBe("fail");
    expect(r.checks.identity.status).toBe("fail");
    expect(r.reason_code).toBe("pinterest_media_invalid");
  });

  it("every code has plain founder text with no dashes", () => {
    for (const code of PINTEREST_READINESS_CODES) {
      expect(PINTEREST_READINESS_TEXT[code].length).toBeGreaterThan(20);
      expect(PINTEREST_READINESS_TEXT[code]).not.toMatch(/[—–]|pinterest_/);
    }
  });
});

describe("connectedPinterestUsername", () => {
  const profile = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 401, data, error: ok ? null : "denied", outcome_unknown: false });

  it("reads the username from the tenant's own connected account", async () => {
    const d = deps({ execute: vi.fn(async () => profile({ username: " dudhat0633 ", account_type: "BUSINESS" })) });
    expect(await connectedPinterestUsername(TENANT, d as PinterestReadinessDeps)).toBe("dudhat0633");
    expect(d.resolveAccount).toHaveBeenCalledWith(TENANT);
    expect(d.execute).toHaveBeenCalledWith({
      tool_slug: "PINTEREST_GET_PROFILE",
      user_id: TENANT,
      connected_account_id: "ca_pin",
      arguments: {},
    }, expect.any(AbortSignal));
  });

  it("gives up on a Composio call that never answers, and cancels it", async () => {
    let seen: AbortSignal | undefined;
    const d = deps({ execute: vi.fn((_a: unknown, signal?: AbortSignal) => { seen = signal; return new Promise<never>(() => {}); }) });
    const started = Date.now();
    expect(await connectedPinterestUsername(TENANT, d as PinterestReadinessDeps, 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen?.aborted).toBe(true);
  });

  it("gives up on an account lookup that never answers, and never calls Composio after", async () => {
    type Account = Awaited<ReturnType<PinterestReadinessDeps["resolveAccount"]>>;
    let release: (value: Account | PromiseLike<Account>) => void = () => {};
    const d = deps({ resolveAccount: vi.fn(() => new Promise((r) => { release = r; })) as PinterestReadinessDeps["resolveAccount"] });
    expect(await connectedPinterestUsername(TENANT, d as PinterestReadinessDeps, 30)).toBeNull();
    release(ACCOUNT);
    await new Promise((r) => setTimeout(r, 10));
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("parses a JSON-string body the way Composio sometimes returns it", async () => {
    const d = deps({ execute: vi.fn(async () => profile(JSON.stringify({ username: "cakely" }))) });
    expect(await connectedPinterestUsername(TENANT, d as PinterestReadinessDeps)).toBe("cakely");
  });

  it("reads the username from Composio's wrapped profile response", async () => {
    const d = deps({ execute: vi.fn(async () => profile({ response_data: { username: "wrapped-acme" } })) });
    expect(await connectedPinterestUsername(TENANT, d as PinterestReadinessDeps)).toBe("wrapped-acme");
  });

  it("makes no Composio call when no account is connected", async () => {
    const d = deps({ resolveAccount: vi.fn(async () => null) });
    expect(await connectedPinterestUsername(TENANT, d as PinterestReadinessDeps)).toBeNull();
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("returns null on a refused read, a blank username, or a thrown lookup", async () => {
    expect(await connectedPinterestUsername(TENANT, deps({ execute: vi.fn(async () => profile(null, false)) }) as PinterestReadinessDeps)).toBeNull();
    expect(await connectedPinterestUsername(TENANT, deps({ execute: vi.fn(async () => profile({ username: "  " })) }) as PinterestReadinessDeps)).toBeNull();
    expect(await connectedPinterestUsername(TENANT, deps({ resolveAccount: vi.fn(async () => { throw new Error("db down"); }) }) as PinterestReadinessDeps)).toBeNull();
    expect(await connectedPinterestUsername(TENANT, deps({ execute: vi.fn(async () => { throw new Error("timeout"); }) }) as PinterestReadinessDeps)).toBeNull();
  });
});

describe("time limits on Pinterest's Composio calls", () => {
  const never = () => new Promise<never>(() => {});

  it("a board page that never answers ends as a failed lookup within the budget, and its call is cancelled", async () => {
    let seen: AbortSignal | undefined;
    const d = deps({ execute: vi.fn((_a: unknown, signal?: AbortSignal) => { seen = signal; return never(); }) as never });
    const started = Date.now();
    const r = await listPinterestBoards(TENANT, d as PinterestReadinessDeps, 40);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r).toEqual({ ok: false, code: "pinterest_lookup_failed" });
    expect(seen?.aborted).toBe(true);
  });

  it("an account lookup that never answers ends as a failed lookup and calls no board page", async () => {
    const d = deps({ resolveAccount: vi.fn(never) as never });
    const r = await listPinterestBoards(TENANT, d as PinterestReadinessDeps, 40);
    expect(r).toEqual({ ok: false, code: "pinterest_lookup_failed" });
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("past the budget, the boards already read come back marked incomplete", async () => {
    let calls = 0;
    const d = deps({
      execute: vi.fn(() => {
        calls += 1;
        return calls === 1 ? Promise.resolve(page([{ id: "111", name: "Yoga", privacy: "PUBLIC" }], "bm")) : never();
      }) as never,
    });
    const r = await listPinterestBoards(TENANT, d as PinterestReadinessDeps, 40);
    expect(r).toMatchObject({ ok: true, complete: false, boards: [{ id: "111", name: "Yoga" }] });
  });

  it("a board list that runs out of time does not spend more time asking for the staged board by id", async () => {
    let t = 1_000_000;
    const d = deps({
      now: () => t,
      execute: vi.fn(async (a: { tool_slug: string }) => {
        if (a.tool_slug === "PINTEREST_GET_BOARD") {
          return { ok: true, status: 200, data: { id: "222", name: "Linen", privacy: "PUBLIC" }, error: null, outcome_unknown: false };
        }
        t += 60_000;
        return page([{ id: "111", name: "Yoga", privacy: "PUBLIC" }], "bm");
      }) as never,
    });
    const r = await resolvePinterestPublishReadiness(TENANT, { board_id: "222", link: PIN.link }, { only: ["board"], deps: d });
    expect(d.execute.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_LIST_BOARDS")).toHaveLength(1);
    expect(d.execute.mock.calls.some((c) => c[0].tool_slug === "PINTEREST_GET_BOARD")).toBe(false);
    expect(r.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
    expect(r.ok).toBe(false);
  });

  describe("with part of the board-list budget left", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function slowPaging(getBoard: (signal?: AbortSignal) => Promise<unknown>) {
      let t = 1_000_000;
      let pages = 0;
      return deps({
        now: () => t,
        execute: vi.fn(async (a: { tool_slug: string }, signal?: AbortSignal) => {
          if (a.tool_slug === "PINTEREST_GET_BOARD") return getBoard(signal);
          pages += 1;
          if (pages === 1) t += BOARD_LIST_BUDGET_MS - 5_000;
          return page([{ id: "111", name: "Yoga", privacy: "PUBLIC" }], "bm");
        }) as never,
      });
    }

    it("still finds the staged board by id", async () => {
      const d = slowPaging(async () => ({ ok: true, status: 200, data: { id: "222", name: "Linen", privacy: "PUBLIC" }, error: null, outcome_unknown: false }));
      const r = await resolvePinterestPublishReadiness(TENANT, { board_id: "222", link: PIN.link }, { only: ["board"], deps: d });
      expect(d.execute.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_GET_BOARD")).toHaveLength(1);
      expect(r.checks.board).toEqual({ status: "pass" });
    });

    it("caps the by-id lookup to the time left, not a full Composio call", async () => {
      vi.useFakeTimers();
      let seen: AbortSignal | undefined;
      const d = slowPaging((signal) => {
        seen = signal;
        return new Promise<never>(() => {});
      });
      let done = false;
      const p = resolvePinterestPublishReadiness(TENANT, { board_id: "222", link: PIN.link }, { only: ["board"], deps: d }).then((r) => {
        done = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(d.execute.mock.calls.filter((c) => c[0].tool_slug === "PINTEREST_GET_BOARD")).toHaveLength(1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(seen?.aborted).toBe(true);
      expect((await p).checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
    });
  });

  it("at publish, a nopin page found in time still blocks while the board pages run past the deadline", async () => {
    const d = deps({ execute: vi.fn(never) as never, fetchText: vi.fn(async () => HTML_NOPIN) as never });
    const started = Date.now();
    const r = await resolvePinterestPublishReadiness(TENANT, { board_id: "222", link: PIN.link }, { only: ["board", "link"], deps: d, deadlineMs: 50 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.checks.link).toMatchObject({ status: "fail", reason_code: "pinterest_link_nopin" });
    expect(r.checks.board).toMatchObject({ status: "unverified", reason_code: "pinterest_lookup_failed" });
    expect(r).toMatchObject({ ok: false, reason_code: "pinterest_link_nopin" });
  });

  it("at publish, a link check that never answers is unverified by the deadline and does not block a ready board", async () => {
    const d = deps({ fetchText: vi.fn(never) as never });
    const r = await resolvePinterestPublishReadiness(TENANT, { board_id: "222", link: PIN.link }, { only: ["board", "link"], deps: d, deadlineMs: 50 });
    expect(r.checks.board).toEqual({ status: "pass" });
    expect(r.checks.link).toMatchObject({ status: "unverified", reason_code: "pinterest_link_unchecked" });
    expect(r.ok).toBe(true);
  });
});

describe("hasNopinMeta reads only the real name and content attributes", () => {
  it.each([
    ['<meta data-content="x" name="pinterest" content="nopin">', true],
    ['<meta data-name="pinterest" content="nopin">', false],
    ['<meta name="pinterest" data-content="nopin" content="ok">', false],
    ['<meta name="pinterest-rich-pin" content="nopin">', false],
  ])("%s → %s", (tag, expected) => {
    expect(hasNopinMeta(`<html><head>${tag}</head></html>`)).toBe(expected);
  });
});
