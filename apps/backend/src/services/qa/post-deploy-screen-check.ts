
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import {
  runShowabilityGate,
  type ChromiumLauncher,
  type ShowabilityResult,
} from "@/services/qa/showability-gate";
import { createAnchorChromiumLauncher } from "@/services/qa/anchor-launcher";

export const SCREEN_CHECK_TIMEOUT_MS = 90_000;
const NAV_TIMEOUT_MS = 25_000;

export type ScreenCheckRecord = {
  status: "pass" | "fail" | "skipped";
  checked_at: string;
  url?: string;
  reason?: string;
  fails?: string[];
  font_warnings?: string[];
  console_errors?: string[];
};

export type ScreenCheckDeps = {
  launcher?: ChromiumLauncher;
  run?: typeof runShowabilityGate;
  timeoutMs?: number;
  now?: () => Date;
};

function toHttps(raw: string): string {
  return raw.trim().replace(/^http:\/\//i, "https://");
}

export async function runPostDeployScreenCheck(
  input: { url: string | null; tenant_id?: string },
  deps: ScreenCheckDeps = {},
): Promise<ScreenCheckRecord> {
  const at = () => (deps.now ? deps.now() : new Date()).toISOString();
  const skipped = (reason: string, url?: string): ScreenCheckRecord => ({
    status: "skipped",
    checked_at: at(),
    ...(url ? { url } : {}),
    reason: reason.slice(0, 300),
  });

  if (!input.url) return skipped("no live url");
  const url = toHttps(input.url);
  try {
    await assertSafeUrl(url);
  } catch (e) {
    return skipped(`unsafe url: ${(e as Error).message}`, url);
  }

  let launcher = deps.launcher;
  if (!launcher) {
    const apiKey = process.env.ANCHOR_API_KEY;
    if (!apiKey) return skipped("ANCHOR_API_KEY not set", url);
    launcher = createAnchorChromiumLauncher({ apiKey, tenantId: input.tenant_id });
  }
  const run = deps.run ?? runShowabilityGate;

  let timer: NodeJS.Timeout | undefined;
  const bell = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), deps.timeoutMs ?? SCREEN_CHECK_TIMEOUT_MS);
  });
  let result: ShowabilityResult | "timeout";
  try {
    const work = run({ url, paths: ["/"], navTimeoutMs: NAV_TIMEOUT_MS }, launcher);
    work.catch(() => {});
    result = await Promise.race([work, bell]);
  } catch (e) {
    return skipped(`browser error: ${(e as Error).message}`, url);
  } finally {
    clearTimeout(timer);
  }
  if (result === "timeout") return skipped("timed out", url);

  if (result.snapshots.length > 0 && result.snapshots.every((s) => s.loadErr && !s.checks)) {
    return skipped(`browser could not load the page: ${result.snapshots[0].loadErr}`, url);
  }

  return {
    status: result.pass ? "pass" : "fail",
    checked_at: at(),
    url,
    fails: result.fails.slice(0, 10),
    font_warnings: result.fontWarnings.slice(0, 5),
    console_errors: result.snapshots.flatMap((s) => s.consoleErrors).slice(0, 5),
  };
}
