import { chromium, type Browser } from "playwright-core";
import type { StartCardRenderResult } from "@zavi/shared";
import { measureTab, PHONE, TAB_BUDGET_MS, withCeiling, type RenderSites } from "../checks/render";
import type { GuardProxy } from "./guard-proxy";

export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function localRenderSites(opts: { proxy: GuardProxy; chromePath?: string }): RenderSites {
  return async (urls) => {
    if (urls.length === 0) return null;
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({
        executablePath: opts.chromePath ?? DEFAULT_CHROME,
        headless: true,
        proxy: { server: `http://127.0.0.1:${opts.proxy.port}` },
        args: [
          "--proxy-bypass-list=<-loopback>",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-quic",
          "--dns-prefetch-disable",
          "--disable-features=DnsOverHttps,NetworkPrediction",
          "--disable-extensions",
          "--no-first-run",
          "--disable-background-networking",
        ],
        env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
      });
      await browser.newContext({
        serviceWorkers: "block",
        viewport: { width: PHONE.width, height: PHONE.height },
        acceptDownloads: false,
      });
      const b = browser;
      return (await Promise.all(urls.map((u) => withCeiling(measureTab(b, u), TAB_BUDGET_MS)))) as (StartCardRenderResult | null)[];
    } catch (e) {
      console.error(`[seed-scan] local render failed: ${(e as Error)?.message?.slice(0, 200)}`);
      return null;
    } finally {
      await browser?.close().catch(() => {});
    }
  };
}
