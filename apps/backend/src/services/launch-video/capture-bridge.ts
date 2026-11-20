
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { assertSafeUrl, isPrivateIp } from "@/services/onboarding/enrichment/url-guard";

async function realResolveHost(host: string): Promise<string[]> {
  const res = await dnsLookup(host, { all: true });
  return res.map((r) => r.address);
}
import {
  browserCheckExpr,
  SHOWABILITY_MIN_BODY_LEN,
  type ShowabilityChecks,
} from "@/services/qa/showability-gate";
import {
  meterPlatformGeneration,
  type PlatformGate,
} from "@/services/mcp/higgsfield-meter";
import type { GeneratedImage } from "./media";
import type { VideoBrief } from "./brief-mapper";

const CAPTURE_VIEWPORT = { width: 1280, height: 720 } as const;
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_200;

export function normalizeCaptureUrl(raw: string): string {
  const t = raw.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export type CaptureSnapshot = {
  status: number;
  loadErr: string | null;
  checks: ShowabilityChecks | null;
  hasPasswordField: boolean;
};

export type CaptureVerdict = { showable: true } | { showable: false; reason: string };

export function evaluateCaptureShowability(snap: CaptureSnapshot): CaptureVerdict {
  if (snap.loadErr) return { showable: false, reason: `load_failed: ${snap.loadErr}` };
  if (snap.status && snap.status >= 400) return { showable: false, reason: `http_${snap.status}` };
  if (snap.hasPasswordField) return { showable: false, reason: "login_wall" };
  const c = snap.checks;
  if (!c) return { showable: false, reason: "no_checks" };
  if (c.bodyLen < SHOWABILITY_MIN_BODY_LEN) return { showable: false, reason: `near_empty(${c.bodyLen})` };
  if (c.dirtyText) return { showable: false, reason: "dirty_text" };
  return { showable: true };
}

export type CaptureRoute = {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
};

export type CaptureChromiumLauncher = {
  launch(opts: { headless: boolean; args?: string[] }): Promise<{
    newContext(opts: {
      viewport: { width: number; height: number };
    }): Promise<{
      newPage(): Promise<CapturePage>;
      route?(pattern: string, handler: (route: CaptureRoute) => void): Promise<void>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
};

export type CapturePage = {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(fn: string): Promise<unknown>;
  screenshot(opts: { fullPage: boolean; type: "png" }): Promise<Buffer>;
};

async function realCaptureChromium(): Promise<CaptureChromiumLauncher> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("playwright" as string);
  return mod.chromium as CaptureChromiumLauncher;
}

const DISMISS_CONSENT_EXPR = `() => {
  const rx = /^(accept|accept all|agree|i agree|allow all|got it|ok|okay)$/i;
  const els = [...document.querySelectorAll('button,[role=button],a')];
  for (const e of els) {
    const t = (e.textContent || '').trim();
    if (rx.test(t)) { try { (e).click(); } catch {} return true; }
  }
  return false;
}`;

const HAS_PASSWORD_EXPR = `() => {
  const els = [...document.querySelectorAll('input[type=password]')];
  return els.some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
}`;

export type CaptureStillDeps = {
  launcher?: CaptureChromiumLauncher;
  meter?: (input: Parameters<typeof meterPlatformGeneration>[0]) => Promise<PlatformGate>;
  resolveHost?: (host: string) => Promise<string[]>;
};

export type CaptureStillResult =
  | { ok: true; png: Buffer }
  | { ok: false; reason: string };

export async function captureProductStill(
  args: { tenant_id: string; run_id: string; url: string; variant?: string },
  deps: CaptureStillDeps = {},
): Promise<CaptureStillResult> {
  const meter = deps.meter ?? meterPlatformGeneration;
  const resolveHost = deps.resolveHost ?? realResolveHost;

  let safe: URL;
  try {
    safe = await assertSafeUrl(normalizeCaptureUrl(args.url));
  } catch (e) {
    return { ok: false, reason: `ssrf_blocked: ${(e as Error).message}` };
  }

  let gate: PlatformGate;
  try {
    gate = await meter({
      tenant_id: args.tenant_id,
      run_id: args.run_id,
      surface: "lv-capture",
      index: `${args.variant ?? "v0"}:capture`,
    });
  } catch (e) {
    return { ok: false, reason: `meter_threw: ${(e as Error).message}` };
  }
  if (gate.decision !== "charged") {
    return { ok: false, reason: `meter_${gate.decision}${gate.error ? `: ${gate.error}` : ""}` };
  }

  let launcher: CaptureChromiumLauncher;
  try {
    launcher = deps.launcher ?? (await realCaptureChromium());
  } catch (e) {
    return { ok: false, reason: `no_browser: ${(e as Error).message}` };
  }

  let browser: Awaited<ReturnType<CaptureChromiumLauncher["launch"]>> | null = null;
  try {
    browser = await launcher.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const ctx = await browser.newContext({ viewport: { ...CAPTURE_VIEWPORT } });
    if (typeof ctx.route === "function") {
      await ctx.route("**/*", async (route) => {
        let host = "";
        try {
          host = new URL(route.request().url()).hostname.replace(/^\[|\]$/g, "");
        } catch {
        }
        if (!host) {
          await route.abort();
          return;
        }
        if (isIP(host) !== 0) {
          if (isPrivateIp(host)) await route.abort();
          else await route.continue();
          return;
        }
        try {
          const addrs = await resolveHost(host);
          if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a))) {
            await route.abort();
            return;
          }
        } catch {
          await route.abort();
          return;
        }
        await route.continue();
      });
    }
    let snap: CaptureSnapshot;
    let png: Buffer;
    try {
      const page = await ctx.newPage();
      let status = 0;
      let loadErr: string | null = null;
      try {
        const resp = await page.goto(safe.toString(), { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate(DISMISS_CONSENT_EXPR).catch(() => undefined);
        await page.waitForTimeout(400);
        await assertSafeUrl(page.url());
      } catch (e) {
        loadErr = String(e);
      }
      let checks: ShowabilityChecks | null = null;
      let hasPasswordField = false;
      try {
        checks = (await page.evaluate(browserCheckExpr())) as ShowabilityChecks;
      } catch (e) {
        loadErr = loadErr ?? String(e);
      }
      try {
        hasPasswordField = Boolean(await page.evaluate(HAS_PASSWORD_EXPR));
      } catch {
        hasPasswordField = false;
      }
      snap = { status, loadErr, checks, hasPasswordField };
      png = await page.screenshot({ fullPage: false, type: "png" });
    } finally {
      await ctx.close().catch(() => undefined);
    }

    const verdict = evaluateCaptureShowability(snap);
    if (!verdict.showable) return { ok: false, reason: verdict.reason };
    if (!png || png.byteLength === 0) return { ok: false, reason: "empty_screenshot" };
    return { ok: true, png };
  } catch (e) {
    return { ok: false, reason: `capture_failed: ${(e as Error).message}` };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export type CaptureTarget = { beatIndex: number; itemIndex: number | null };

export function resolveCaptureTarget(brief: VideoBrief): CaptureTarget | null {
  const pIdx = brief.beats.findIndex(
    (b) => b.kind === "productui" && Array.isArray((b as { items?: unknown[] }).items) && (b as { items: unknown[] }).items.length > 0,
  );
  if (pIdx >= 0) return { beatIndex: pIdx, itemIndex: 0 };
  const hIdx = brief.beats.findIndex((b) => b.kind === "hook");
  if (hIdx >= 0) return { beatIndex: hIdx, itemIndex: null };
  return null;
}

export function stripImagePromptAt(brief: VideoBrief, target: CaptureTarget): void {
  const beat = brief.beats[target.beatIndex] as
    | { imagePrompt?: string; items?: Array<{ imagePrompt?: string }> }
    | undefined;
  if (!beat) return;
  if (target.itemIndex == null) {
    delete beat.imagePrompt;
  } else if (beat.items && beat.items[target.itemIndex]) {
    delete beat.items[target.itemIndex].imagePrompt;
  }
}

export function captureImageFor(target: CaptureTarget, png: Buffer, variant: string): GeneratedImage {
  return {
    beatIndex: target.beatIndex,
    itemIndex: target.itemIndex,
    filename: `capture_${variant}.png`,
    bytes: png,
  };
}
