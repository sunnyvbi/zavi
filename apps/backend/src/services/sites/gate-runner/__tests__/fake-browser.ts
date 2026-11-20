
export type FakeRoute = {
  status?: number;
  text?: string;
  console?: string[];
  pageErrors?: string[];
  mobileOverflow?: number;
  selectors?: string[];
  fields?: string[];
  ogTitle?: string;
  resourceErrors?: Array<{ url: string; text?: string }>;
  links?: string[];
  overlay?: boolean;
  images?: Array<{ src: string; naturalWidth: number; complete?: boolean }>;
  placeholders?: Array<{ kind: "icon" | "label"; text?: string; width?: number; height?: number; media?: boolean; inBrandPanel?: boolean; inHeader?: boolean }>;
  imageErrors?: number;
  submits?: Record<string, { method: string; url: string; body?: string; type?: string; headers?: Record<string, string> }>;
  navError?: string;
  blocks?: Array<{ text: string; mark?: string; chrome?: boolean; wraps?: boolean; hidden?: boolean }>;
  mobile?: Omit<FakeRoute, "mobile">;
};

function blockEls(route: FakeRoute, sel: string): unknown[] {
  const all = route.blocks ?? [];
  const pick = sel === "[data-zavi-section]" ? all.filter((b) => b.mark) : all.filter((b) => !b.mark);
  return pick.map((b) => ({
    innerText: b.text,
    getAttribute: (name: string) => (name === "data-zavi-section" ? (b.mark ?? null) : null),
    closest: (q: string) => (b.chrome && q === "header, nav, footer" ? {} : null),
    querySelector: (q: string) => (b.wraps && q === "section" ? {} : null),
    checkVisibility: () => b.hidden !== true,
  }));
}

function placeholderEls(route: FakeRoute, sel: string): unknown[] {
  const out: unknown[] = [];
  for (const p of route.placeholders ?? []) {
    const rect = { width: p.width ?? 600, height: p.height ?? 400 };
    const box: Record<string, unknown> = {
      tagName: "DIV",
      innerText: p.text ?? "",
      parentElement: null,
      getBoundingClientRect: () => rect,
      querySelector: () => (p.media ? {} : null),
      closest: () => null,
      children: [] as unknown[],
    };
    if (p.kind === "icon") {
      const svg = {
        tagName: "svg",
        parentElement: box,
        closest: (s: string) => ((p.inBrandPanel && s.includes("data-zavi-image")) || (p.inHeader && s.includes("header")) ? box : null),
      };
      box.children = [svg];
      if (sel.startsWith("svg")) out.push(svg);
    } else if (!sel.startsWith("svg")) {
      out.push(box);
    }
  }
  return out;
}

export type ApiReq = { method: string; path: string; headers: Record<string, string>; body?: unknown; as?: "owner" | "customer" | null };
export type ApiRes = { status: number; body?: unknown };

export type FakeSite = {
  origin: string;
  routes: Record<string, FakeRoute>;
  entryStatus?: number;
  api?: (req: ApiReq) => ApiRes;
  owner?: {
    reachesAdmin: boolean;
    token: string | null;
    pageError?: string;
    shell?: boolean;
    callbackError?: string;
    noCallback?: boolean;
    responses?: Array<{ path: string; status: number }>;
    linkFails?: boolean;
    stillSigningIn?: boolean;
    pendingApi?: string;
  };
  ownerLink?: string;
  customer?: { token: string | null; signedIn: boolean; landing?: string };
  customerLink?: string;
};

type Listener = (arg: unknown) => void;

function apiResponse(r: ApiRes) {
  const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
  return { status: () => r.status, text: async () => text, json: async () => JSON.parse(text) };
}

function withGlobals<T>(doc: unknown, win: unknown, fn: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = { document: g.document, window: g.window };
  g.document = doc;
  g.window = win;
  try {
    return fn();
  } finally {
    g.document = prev.document;
    g.window = prev.window;
  }
}

export function fakeLaunch(site: FakeSite) {
  const calls: {
    goto: string[];
    api: ApiReq[];
    contexts: Array<Record<string, unknown> | undefined>;
    routes: Array<{ match: (u: URL) => boolean; handle: (route: unknown) => unknown }>;
    wsRoutes: Array<{ match: unknown; handle: (ws: unknown) => unknown }>;
    screenshots: Array<{ width: number; path: string; type?: string; quality?: number; fullPage?: boolean }>;
  } = { goto: [], api: [], contexts: [], routes: [], wsRoutes: [], screenshots: [] };
  let closed = false;

  const newContext = (opts?: Record<string, unknown>) => {
    calls.contexts.push(opts);
    const width = (opts?.viewport as { width?: number } | undefined)?.width ?? 1280;
    const ctxRoutes: Array<{ match: (u: URL) => boolean; handle: (route: unknown) => unknown }> = [];
    let signedInAs: "owner" | "customer" | null = null;
    const request = {
      async fetch(url: string, o?: { method?: string; headers?: Record<string, string> }) {
        const u = new URL(url);
        const req = { method: (o?.method ?? "GET").toUpperCase(), path: u.pathname + u.search, headers: o?.headers ?? {} };
        calls.api.push(req);
        return apiResponse(site.api ? site.api(req) : { status: 404 });
      },
      async get(url: string, o?: { headers?: Record<string, string> }) {
        const u = new URL(url);
        const req = { method: "GET", path: u.pathname + u.search, headers: o?.headers ?? {} };
        calls.api.push(req);
        return apiResponse(site.api ? site.api(req) : { status: 404 });
      },
      async post(url: string, o?: { headers?: Record<string, string>; data?: unknown }) {
        const u = new URL(url);
        const req = { method: "POST", path: u.pathname + u.search, headers: o?.headers ?? {}, body: o?.data };
        calls.api.push(req);
        return apiResponse(site.api ? site.api(req) : { status: 404 });
      },
    };
    const context = {
      request,
      async route(match: (u: URL) => boolean, handle: (route: unknown) => unknown) {
        calls.routes.push({ match, handle });
        ctxRoutes.push({ match, handle });
      },
      async routeWebSocket(match: unknown, handle: (ws: unknown) => unknown) {
        calls.wsRoutes.push({ match, handle });
      },
      async storageState() {
        return { cookies: [], origins: [] };
      },
      async close() {},
      async newPage() {
        const listeners: Record<string, Listener[]> = {};
        let current = "";
        let route: FakeRoute = {};
        const filled: Record<string, string> = {};
        const emit = (ev: string, arg: unknown) => (listeners[ev] ?? []).forEach((l) => l(arg));
        const doc = () => ({
          body: { innerText: route.text ?? "" },
          querySelectorAll: (sel: string) =>
            sel === 'svg[class*="lucide-image"]' || sel === "div, figure, span, p"
              ? placeholderEls(route, sel)
              : sel === '[data-zavi-image="error"]'
                ? Array.from({ length: route.imageErrors ?? 0 }, () => ({}))
              : sel === "[data-zavi-section]" || sel === "section"
                ? blockEls(route, sel)
              : sel === "input, textarea"
              ? (route.fields ?? []).map((value) => ({ value }))
              : sel === "a[href]"
                ? (route.links ?? []).map((href) => ({ getAttribute: () => href }))
                : [],
          querySelector: (sel: string) =>
            sel === 'meta[property="og:title"]' && route.ogTitle !== undefined
              ? { getAttribute: () => route.ogTitle }
              : sel === "vite-error-overlay" && route.overlay
                ? {}
                : (route.selectors ?? []).includes(sel)
                  ? {}
                  : null,
          documentElement: { scrollHeight: 2000 },
          images: (route.images ?? []).map((i) => ({ complete: i.complete ?? true, naturalWidth: i.naturalWidth, currentSrc: i.src, getAttribute: () => i.src })),
        });
        const zavi = {
          auth: {
            ready: async () => undefined,
            session: () => (signedInAs === "customer" && site.customer?.signedIn ? { email: "gate-customer@x" } : signedInAs === "owner" ? { email: "gate-owner@x" } : null),
          },
        };
        const win = () => ({
          __zavi: zavi,
          location: current ? new URL(current) : undefined,
          scrollY: 0,
          scrollX: 0,
          innerWidth: width,
          innerHeight: 800,
          scrollTo(x: number) {
            this.scrollX = Math.max(0, Math.min(x, width < 500 ? route.mobileOverflow ?? 0 : 0));
          },
        });
        const has = (sel: string) => (route.selectors ?? []).includes(sel);
        return {
          on(ev: string, l: Listener) {
            (listeners[ev] ??= []).push(l);
          },
          async goto(url: string) {
            calls.goto.push(url);
            if (site.customerLink && url === site.customerLink) {
              const c = site.customer ?? { token: null, signedIn: false };
              const cb = `${site.origin}/api/auth/callback?type=magiclink&token_hash=hash87654321&confirm=1`;
              const location = c.token ? `/auth/confirm#access_token=${c.token}&refresh_token=r` : "/auth/confirm#type=magiclink";
              emit("response", { url: () => cb, status: () => 303, headers: () => ({ location }) });
              if (c.signedIn) signedInAs = "customer";
              const landing = c.landing ?? "/";
              current = `${site.origin}${landing}`;
              route = site.routes[landing] ?? { status: 200, text: "" };
              return { status: () => 200 };
            }
            if (site.ownerLink && url === site.ownerLink) {
              const o = site.owner ?? { reachesAdmin: false, token: null };
              if (o.linkFails) throw new Error(`page.goto: net::ERR_CONNECTION_RESET at ${url}`);
              const cb = `${site.origin}/api/auth/callback?type=magiclink&token_hash=hash12345678&confirm=1`;
              if (!o.noCallback) {
                const location = o.callbackError
                  ? `/auth/confirm#error=${o.callbackError}`
                  : o.token ? `/auth/confirm#access_token=${o.token}&refresh_token=r` : "/auth/confirm#type=magiclink";
                emit("response", { url: () => cb, status: () => 303, headers: () => ({ location }) });
              }
              for (const r of o.responses ?? []) emit("response", { url: () => `${site.origin}${r.path}`, status: () => r.status, headers: () => ({}) });
              if (o.pendingApi) emit("request", { url: () => `${site.origin}${o.pendingApi}` });
              current = `${site.origin}${o.reachesAdmin ? "/admin" : "/auth/confirm"}#access_token=${o.token ?? "none"}`;
              if (o.reachesAdmin && o.token) signedInAs = "owner";
              route = o.reachesAdmin
                ? { status: 200, text: "Admin", selectors: o.shell === false ? ["[data-zavi=admin-signin]"] : ["[data-zavi=admin-shell]"] }
                : o.stillSigningIn
                  ? { status: 200, text: "Signing you in..." }
                  : { status: 200, text: "Bad link", selectors: ["[data-zavi=auth-error]"] };
              if (o.pageError) emit("pageerror", new Error(o.pageError));
              return { status: () => 200 };
            }
            const u = new URL(url);
            if (u.origin === site.origin && u.pathname.startsWith("/__zavi_preview/")) {
              current = url;
              route = { status: site.entryStatus ?? 200, text: "preview" };
              return { status: () => route.status };
            }
            const next = site.routes[u.pathname] ?? { status: 404, text: "Not found" };
            if (next.navError) throw new Error(next.navError);
            current = url;
            route = width < 500 && next.mobile ? { ...next, ...next.mobile } : next;
            emit("response", { url: () => url, status: () => route.status ?? 200, headers: () => ({}) });
            for (const m of route.console ?? []) emit("console", { type: () => "error", text: () => m });
            for (const m of route.resourceErrors ?? []) {
              emit("console", { type: () => "error", text: () => m.text ?? "Failed to load resource: net::ERR_NAME_NOT_RESOLVED", location: () => ({ url: m.url }) });
            }
            for (const m of route.pageErrors ?? []) emit("pageerror", new Error(m));
            return { status: () => route.status ?? 200 };
          },
          async waitForLoadState() {},
          async waitForURL(pred: (u: URL) => boolean) {
            if (!pred(new URL(current))) throw new Error(`timeout waiting for URL (at ${new URL(current).pathname})`);
          },
          async waitForSelector(sel: string) {
            if (!has(sel)) throw new Error(`page.waitForSelector: Timeout exceeded waiting for ${sel}\n  navigated to "${current}"`);
          },
          async fill(sel: string, value: string) {
            if (!has(sel)) throw new Error(`no element ${sel}`);
            filled[sel] = value;
          },
          async click(sel: string) {
            if (!has(sel)) throw new Error(`no element ${sel}`);
            const submit = route.submits?.[sel];
            if (!submit) return;
            const body = submit.body ?? JSON.stringify(filled);
            const req = {
              method: () => submit.method,
              url: () => submit.url,
              postData: () => body,
              headers: () => ({ "content-type": submit.type ?? "application/json", ...(submit.headers ?? {}) }),
            };
            let fulfilled = false;
            for (const r of ctxRoutes) {
              if (!r.match(new URL(submit.url))) continue;
              await r.handle({
                request: () => req,
                continue: async () => undefined,
                fulfill: async () => {
                  fulfilled = true;
                },
              });
              if (fulfilled) return;
            }
            const apiReq = { method: submit.method, path: new URL(submit.url).pathname, headers: {}, body, as: signedInAs };
            calls.api.push(apiReq);
            const status = site.api ? site.api(apiReq).status : 404;
            emit("response", { request: () => req, status: () => status, url: () => submit.url });
          },
          async evaluate<A, R>(fn: (a: A) => R, arg: A): Promise<R> {
            return withGlobals(doc(), win(), () => fn(arg));
          },
          async waitForFunction<A>(fn: (a: A) => boolean, arg: A) {
            if (!withGlobals(doc(), win(), () => fn(arg))) throw new Error("timeout");
          },
          async screenshot(o?: { type?: string; quality?: number; fullPage?: boolean }) {
            calls.screenshots.push({ width, path: new URL(current).pathname, ...(o ?? {}) });
            return Buffer.from(`shot:${width}:${new URL(current).pathname}`);
          },
          async close() {},
        };
      },
    };
    return context;
  };

  const browser = {
    newContext: async (opts?: Record<string, unknown>) => newContext(opts),
    async close() {
      closed = true;
    },
  };
  return { launch: async () => browser, calls, isClosed: () => closed };
}
