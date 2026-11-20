
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AnchorClient, AnchorSession } from "./anchor-backend";
import type { DaemonOp, DaemonResult } from "./types";
import {
  checkBrowserRequestUrl,
  installNetworkGuard,
  type GuardContext,
  type HostLookup,
} from "./network-guard";
import { buildPageOutline } from "./page-outline";

const ANCHOR_API_BASE =
  process.env.ANCHOR_API_BASE || "https://api.anchorbrowser.io";

const SELECTOR_TIMEOUT_MS = 5_000;
const NAV_TIMEOUT_MS = 30_000;
export const ANCHOR_HTTP_TIMEOUT_MS = 15_000;

interface Conn {
  browser: Browser;
  page: Page;
  guard?: { lastBlock: { url: string; reason: string } | null };
}

let guardLookup: HostLookup | undefined;
export function _setGuardLookupForTest(l: HostLookup | undefined): void {
  guardLookup = l;
}

async function guardedNavPostCheck(
  page: Page,
  response: Awaited<ReturnType<Page["goto"]>>,
): Promise<{ ok: true } | { ok: false; url: string; reason: string }> {
  const hops: string[] = [];
  let req = response?.request() ?? null;
  while (req) {
    hops.push(req.url());
    req = req.redirectedFrom();
  }
  hops.push(page.url());
  for (const u of hops) {
    const v = await checkBrowserRequestUrl(u, guardLookup);
    if (!v.allowed) return { ok: false, url: u, reason: v.reason };
  }
  return { ok: true };
}

function urlMatches(current: string, expected: string): boolean {
  const looksRegex =
    expected.startsWith("^") || expected.endsWith("$") || expected.includes("\\");
  if (looksRegex) {
    try {
      return new RegExp(expected).test(current);
    } catch {
      return current.includes(expected);
    }
  }
  return current.includes(expected);
}

export function createRestAnchorClient(): AnchorClient {
  const connBySession = new Map<string, Conn>();

  async function getConn(session: AnchorSession): Promise<Conn> {
    const existing = connBySession.get(session.id);
    if (existing) return existing;
    if (!session.cdp_url) {
      throw new Error(`anchor session ${session.id} has no cdp_url to connect`);
    }
    const browser = await chromium.connectOverCDP(session.cdp_url);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const conn: Conn = { browser, page: undefined as unknown as Page };
    if (session.network_guard) {
      const guard = { lastBlock: null as { url: string; reason: string } | null };
      try {
        await installNetworkGuard(ctx as unknown as GuardContext, {
          lookup: guardLookup,
          onBlock: (url, reason) => {
            guard.lastBlock = { url, reason };
          },
        });
      } catch (e) {
        await browser.close().catch(() => {});
        throw new Error(`network_guard_install_failed: ${(e as Error).message}`);
      }
      conn.guard = guard;
    }
    conn.page = ctx.pages()[0] ?? (await ctx.newPage());
    connBySession.set(session.id, conn);
    return conn;
  }

  async function applyOp(conn: Conn, op: DaemonOp): Promise<DaemonResult> {
    const page = conn.page;
    switch (op.op) {
      case "nav": {
        if (conn.guard) {
          const pre = await checkBrowserRequestUrl(op.url, guardLookup);
          if (!pre.allowed) {
            return {
              ok: false,
              error_code: "nav_blocked_by_guard",
              error_message: `navigation refused (${pre.reason})`,
            };
          }
          conn.guard.lastBlock = null;
          let response: Awaited<ReturnType<Page["goto"]>> = null;
          try {
            response = await page.goto(op.url, {
              waitUntil: "domcontentloaded",
              timeout: NAV_TIMEOUT_MS,
            });
          } catch (e) {
            const blocked = conn.guard.lastBlock as { url: string; reason: string } | null;
            if (blocked) {
              await page.goto("about:blank").catch(() => {});
              return {
                ok: false,
                error_code: "nav_blocked_by_guard",
                error_message: `navigation refused (${blocked.reason})`,
              };
            }
            throw e;
          }
          const post = await guardedNavPostCheck(page, response);
          if (!post.ok) {
            await page.goto("about:blank").catch(() => {});
            return {
              ok: false,
              error_code: "nav_blocked_by_guard",
              error_message: `navigation refused after redirect (${post.reason})`,
            };
          }
          return { ok: true };
        }
        await page.goto(op.url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT_MS,
        });
        return { ok: true };
      }
      case "click":
        await page.click(op.selector, { timeout: SELECTOR_TIMEOUT_MS });
        return { ok: true };
      case "fill": {
        let editable = false;
        try {
          editable = await page
            .locator(op.selector)
            .first()
            .evaluate((el) => el instanceof HTMLElement && el.isContentEditable);
        } catch {
          editable = false;
        }
        if (editable) {
          await page.locator(op.selector).first().click({ timeout: SELECTOR_TIMEOUT_MS });
          await page.locator(op.selector).first().evaluate((el, value) => {
            const node = el as HTMLElement;
            node.focus();
            node.textContent = value;
            node.dispatchEvent(new Event("input", { bubbles: true }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
          }, op.value);
          return { ok: true };
        }
        await page.fill(op.selector, op.value, { timeout: SELECTOR_TIMEOUT_MS });
        return { ok: true };
      }
      case "text": {
        const t = await page
          .locator(op.selector)
          .first()
          .innerText({ timeout: SELECTOR_TIMEOUT_MS });
        return { ok: true, result: t };
      }
      case "assert_text": {
        let actual: string;
        try {
          actual = await page
            .locator(op.selector)
            .first()
            .innerText({ timeout: SELECTOR_TIMEOUT_MS });
        } catch (e) {
          return {
            ok: false,
            error_code: "assert_text_failed",
            error_message: `selector not found: ${op.selector}`,
          };
        }
        if (actual.includes(op.expected)) return { ok: true };
        return {
          ok: false,
          error_code: "assert_text_miss",
          error_message: `"${op.expected}" not found in element text`,
        };
      }
      case "assert_url": {
        const current = page.url();
        if (urlMatches(current, op.expected)) return { ok: true };
        return {
          ok: false,
          error_code: "assert_url_miss",
          error_message: `url ${current} doesn't match ${op.expected}`,
        };
      }
      case "screenshot": {
        const path =
          op.path || `/tmp/anchor-shots/${Date.now()}.png`;
        await mkdir(dirname(path), { recursive: true });
        const buf = await page.screenshot({ path, fullPage: true });
        const result: Record<string, unknown> = { path };
        if (buf && buf.byteLength <= 3_000_000) {
          result.image_base64 = buf.toString("base64");
          result.image_mime = "image/png";
        }
        return { ok: true, result };
      }
      case "wait_for":
        await page.waitForSelector(op.selector, {
          timeout: op.timeout_ms ?? SELECTOR_TIMEOUT_MS,
        });
        return { ok: true };
      case "dom_snapshot":
        return {
          ok: false,
          error_code: "unsupported_op",
          error_message: "dom_snapshot is in-sandbox-daemon only",
        };
      case "console_errors":
        return {
          ok: false,
          error_code: "unsupported_op",
          error_message: "console_errors is in-sandbox-daemon only",
        };
      case "current_url":
        return { ok: true, result: { url: page.url() } };
      case "ax_snapshot":
      case "click_ref":
      case "type_ref":
      case "select_option":
      case "set_checked":
      case "key":
      case "scroll":
      case "resolve":
      case "hover_ref":
      case "hover_xy":
      case "click_xy":
      case "drag_ref":
      case "drag_xy":
      case "scroll_at":
      case "key_chord":
      case "nav_history":
      case "history_go":
      case "reload":
      case "zoom":
      case "get_page_text":
      case "wait_until":
      case "choose":
        return {
          ok: false,
          error_code: "unsupported_op",
          error_message: `${op.op} runs only on the extension engine`,
        };
      case "page_outline": {
        const html = await page.content();
        return { ok: true, result: buildPageOutline(html, page.url(), op.max_chars) };
      }
      default: {
        const _never: never = op;
        return {
          ok: false,
          error_code: "unknown_op",
          error_message: `unknown op ${JSON.stringify(_never)}`,
        };
      }
    }
  }

  return {
    async createSession({ apiKey, profileId, headful, oneTimeLiveViewUrl, viewport, networkGuard }) {
      const body: Record<string, unknown> = {};
      const browserCfg: Record<string, unknown> = {};
      if (profileId) {
        body.profile = { id: profileId };
      }
      if (headful) {
        browserCfg.headless = { active: false };
      }
      if (viewport) {
        browserCfg.viewport = { width: viewport.width, height: viewport.height };
      }
      if (Object.keys(browserCfg).length > 0) {
        body.browser = browserCfg;
      }
      if (oneTimeLiveViewUrl) {
        body.session = { live_view: { one_time_url: true } };
      }
      const res = await fetch(`${ANCHOR_API_BASE}/v1/sessions`, {
        method: "POST",
        headers: {
          "anchor-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ANCHOR_HTTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`anchor create-session failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        data?: { id?: string; cdp_url?: string; live_view_url?: string };
        id?: string;
        cdp_url?: string;
        live_view_url?: string;
      };
      const id = json.data?.id ?? json.id;
      const cdp_url = json.data?.cdp_url ?? json.cdp_url;
      const live_view_url = json.data?.live_view_url ?? json.live_view_url;
      if (!id) throw new Error("anchor create-session: no session id in response");
      return { id, cdp_url, live_view_url, ...(networkGuard ? { network_guard: true } : {}) };
    },

    async runAction({ session, op }) {
      try {
        const conn = await getConn(session);
        return await applyOp(conn, op);
      } catch (e) {
        return {
          ok: false,
          error_code: `${op.op}_failed`,
          error_message: (e as Error).message,
        };
      }
    },

    async closeSession({ apiKey, session }) {
      const conn = connBySession.get(session.id);
      if (conn) {
        await conn.browser.close().catch(() => {
        });
        connBySession.delete(session.id);
      }
      const res = await fetch(`${ANCHOR_API_BASE}/v1/sessions/${session.id}`, {
        method: "DELETE",
        headers: { "anchor-api-key": apiKey },
        signal: AbortSignal.timeout(ANCHOR_HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`anchor delete-session: HTTP ${res.status}`);
    },
  };
}

export async function deleteAnchorSessionById(
  apiKey: string,
  providerSessionId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${ANCHOR_API_BASE}/v1/sessions/${providerSessionId}`,
      { method: "DELETE", headers: { "anchor-api-key": apiKey }, signal: AbortSignal.timeout(ANCHOR_HTTP_TIMEOUT_MS) },
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
