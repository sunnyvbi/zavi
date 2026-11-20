
export const SANDBOX_PROBE_TIMEOUT_MS = 20_000;
const SANDBOX_HTML_MAX = 200_000;
const SANDBOX_MAX_SCRIPTS = 8;
const SANDBOX_MAX_IMPORTS = 16;
const SANDBOX_MAX_DEPTH = 3;
const SANDBOX_MAX_MODULES = 48;
const SANDBOX_MODULE_MAX = 200_000;

export type ProbeFetch = (url: string, init: RequestInit) => Promise<globalThis.Response>;

export function sameOriginModuleScripts(html: string, origin: string): string[] {
  const out: string[] = [];
  const tagRe = /<script\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) && out.length < SANDBOX_MAX_SCRIPTS) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']?module\b/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) continue;
    try {
      const u = new URL(src, `${origin}/`);
      if (u.origin !== origin) continue;
      const href = `${u.origin}${u.pathname}${u.search}`;
      if (!out.includes(href)) out.push(href);
    } catch {
    }
  }
  return out;
}

export function sameOriginStaticImports(code: string, moduleUrl: string, origin: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) && out.length < SANDBOX_MAX_IMPORTS) {
    try {
      const u = new URL(m[1], moduleUrl);
      if (u.origin !== origin) continue;
      const href = `${u.origin}${u.pathname}${u.search}`;
      if (!out.includes(href)) out.push(href);
    } catch {
    }
  }
  return out;
}

function isAppModule(href: string): boolean {
  try {
    const path = new URL(href).pathname;
    return !path.startsWith("/@") && !path.startsWith("/node_modules/");
  } catch {
    return false;
  }
}

export async function probeSandboxDevServer(
  origin: string,
  fetchFn: ProbeFetch = (u, i) => fetch(u, i),
  timeoutMs: number = SANDBOX_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = (url: string) =>
    fetchFn(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*", "User-Agent": "ZaviPreviewCheck/1.0" },
      signal: controller.signal,
    });
  try {
    const page = await get(`${origin}/`);
    if (page.status < 200 || page.status >= 300) {
      void page.body?.cancel().catch(() => undefined);
      return false;
    }
    const type = (page.headers.get("content-type") ?? "").toLowerCase();
    const html = (await page.text()).slice(0, SANDBOX_HTML_MAX);
    if (!type.includes("text/html") && !/<html[\s>]/i.test(html)) return false;
    const ok = (status: number) => status >= 200 && status < 300;
    const seen = new Set<string>();
    let level = sameOriginModuleScripts(html, origin);
    for (const u of level) seen.add(u);
    for (let depth = 0; level.length > 0; depth++) {
      const readImports = depth < SANDBOX_MAX_DEPTH;
      const results = await Promise.all(
        level.map(async (u) => {
          const r = await get(u);
          if (!ok(r.status) || !readImports || !isAppModule(u)) {
            void r.body?.cancel().catch(() => undefined);
            return { ok: ok(r.status), imports: [] as string[] };
          }
          const code = (await r.text()).slice(0, SANDBOX_MODULE_MAX);
          return { ok: true, imports: sameOriginStaticImports(code, u, origin) };
        }),
      );
      if (!results.every((r) => r.ok)) return false;
      const next: string[] = [];
      for (const r of results) {
        for (const href of r.imports) {
          if (seen.has(href) || seen.size >= SANDBOX_MAX_MODULES) continue;
          seen.add(href);
          next.push(href);
        }
      }
      level = next;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
