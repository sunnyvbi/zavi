
import { chromium, type Browser, type Page } from "playwright-core";
import { createRestAnchorClient } from "@/services/sandbox/browser-mcp/anchor-rest-client";
import type { AnchorClient, AnchorSession, BrowserSessionTracker } from "@/services/sandbox/browser-mcp/anchor-backend";
import {
  openBrowserSession,
  setBrowserSessionProviderId,
  closeBrowserSession,
} from "@/services/sandbox/browser-mcp/browser-sessions";
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import type { ChromiumLauncher, ShowabilityPage } from "@/services/qa/showability-gate";

type Connect = (cdpUrl: string) => Promise<Browser>;

export type AnchorLauncherOpts = {
  apiKey: string;
  client?: AnchorClient;
  connect?: Connect;
  tenantId?: string;
  tracker?: BrowserSessionTracker;
};

const defaultTracker: BrowserSessionTracker = {
  open: (a) => openBrowserSession({ tenant_id: a.tenant_id, run_id: a.run_id, engine: "anchor", origin: a.origin }),
  setProviderId: (a) => setBrowserSessionProviderId(a),
  close: (a) => closeBrowserSession({ session_id: a.session_id, reason: a.reason }),
};

function settleWithin(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!p) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    p.then(
      () => (clearTimeout(t), resolve()),
      () => (clearTimeout(t), resolve()),
    );
  });
}

async function emulateViewport(page: Page, vp: { width: number; height: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: 1,
    mobile: vp.width < 500,
  });
}

async function guardNavigations(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      const ok = await assertSafeUrl(req.url()).then(() => true, () => false);
      if (!ok) return route.abort();
    }
    return route.continue();
  });
}

export function createAnchorChromiumLauncher(opts: AnchorLauncherOpts): ChromiumLauncher {
  const client = opts.client ?? createRestAnchorClient();
  const connect: Connect =
    opts.connect ?? ((cdpUrl) => chromium.connectOverCDP(cdpUrl, { timeout: 20_000 }));
  const apiKey = opts.apiKey;
  const tracker = opts.tracker ?? defaultTracker;

  return {
    async launch() {
      let session: AnchorSession | null = null;
      let browser: Browser | null = null;
      let rowId: string | null = null;
      const closeAll = async () => {
        await settleWithin(browser?.close(), 5_000);
        let deleted = true;
        if (session) {
          deleted = await client.closeSession({ apiKey, session }).then(
            () => true,
            () => false,
          );
        }
        if (rowId && deleted) await tracker.close({ session_id: rowId, reason: "screen_check_done" }).catch(() => {});
      };
      try {
        if (opts.tenantId) rowId = await tracker.open({ tenant_id: opts.tenantId, run_id: null, origin: "screen_check" });
        session = await client.createSession({ apiKey, viewport: { width: 1280, height: 800 } });
        if (rowId && tracker.setProviderId) {
          await tracker.setProviderId({ session_id: rowId, provider_session_id: session.id });
        }
        if (!session.cdp_url) throw new Error("anchor session has no cdp_url");
        browser = await connect(session.cdp_url);
      } catch (e) {
        await closeAll();
        throw e;
      }
      const b = browser;
      return {
        async newContext({ viewport }) {
          const ctx = b.contexts()[0] ?? (await b.newContext());
          const pages: Page[] = [];
          return {
            async newPage() {
              const page = await ctx.newPage();
              pages.push(page);
              await emulateViewport(page, viewport);
              await guardNavigations(page);
              return page as unknown as ShowabilityPage;
            },
            async close() {
              await Promise.all(pages.map((p) => p.close().catch(() => {})));
            },
          };
        },
        close: closeAll,
      };
    },
  };
}
