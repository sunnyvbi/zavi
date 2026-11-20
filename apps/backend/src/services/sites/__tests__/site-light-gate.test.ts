import { describe, it, expect, vi } from "vitest";
import { classifySiteChange, compareCopyEdit, cssColorOnlyChange, runSiteLightGate, type SiteFetch } from "../site-light-gate";
import type { SiteSandbox } from "../contract";

const LIVE = "1111111aaaa";
const NEXT = "2222222bbbb";

const HERO_BEFORE = `import { Link } from "react-router-dom";

export default function Hero() {
  return (
    <section className="bg-white py-20">
      <h1 className="text-4xl font-bold text-slate-900">Rent bikes</h1>
      <p className="mt-4 text-lg">
        Pick up a bike in minutes &amp; ride all day.
      </p>
      <img src="/hero.png" alt="A bike" />
      <Link to="/book" className="btn">Book now</Link>
    </section>
  );
}
`;

const HERO_COPY = HERO_BEFORE.replace("Rent bikes</h1>", "Rent e-bikes fast</h1>")
  .replace("text-4xl font-bold text-slate-900", "text-5xl font-bold text-rose-600")
  .replace("Pick up a bike in minutes &amp; ride all day.", "Grab an e-bike in two minutes &amp; ride all day.")
  .replace('alt="A bike"', 'alt="An e-bike on a hill"');

function sandboxFor(diff: string, files: Record<string, string>, diffExit = 0) {
  const run = vi.fn(async (cmd: string) => {
    if (cmd.startsWith("git diff")) return { exitCode: diffExit, stdout: diff, stderr: diffExit ? "bad revision" : "" };
    const m = /^git show '([0-9a-f]+):(.+)'$/.exec(cmd);
    if (m && files[`${m[1]}:${m[2]}`] !== undefined) return { exitCode: 0, stdout: files[`${m[1]}:${m[2]}`], stderr: "" };
    return { exitCode: 128, stdout: "", stderr: "fatal: path not in tree" };
  });
  return { sandbox: { run, readFile: vi.fn(), listFiles: vi.fn() } as SiteSandbox, run };
}

describe("compareCopyEdit", () => {
  it("a text, class and alt change is a copy edit and yields only the new tokens", () => {
    const r = compareCopyEdit("src/components/Hero.tsx", HERO_BEFORE, HERO_COPY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens).toEqual(
      expect.arrayContaining(["Rent e-bikes fast", "Grab an e-bike in two minutes & ride all day.", "text-5xl", "text-rose-600", "An e-bike on a hill"]),
    );
    expect(r.tokens).not.toContain("font-bold");
    expect(r.tokens).not.toContain("Book now");
  });

  it("a changed handler, href or import is not a copy edit", () => {
    for (const after of [
      HERO_BEFORE.replace('to="/book"', 'to="/admin"'),
      HERO_BEFORE.replace('src="/hero.png"', 'src="https://evil.example/x.png"'),
      HERO_BEFORE.replace('<Link to="/book" className="btn">', '<Link to="/book" className="btn" onClick={() => fetch("/x")}>'),
      HERO_BEFORE.replace('import { Link } from "react-router-dom";', 'import { Link } from "react-router";'),
      HERO_BEFORE.replace('className="btn"', "className={cn(\"btn\", open && \"open\")}"),
      HERO_BEFORE.replace("Rent bikes</h1>", "Rent {bikes}</h1>"),
    ]) {
      expect(compareCopyEdit("src/components/Hero.tsx", HERO_BEFORE, after).ok).toBe(false);
    }
  });

  it("a reflowed paragraph and a template-literal class stay copy edits", () => {
    const before = "export const A = () => <p className={`a b`}>one two</p>;";
    const after = "export const A = () => <p className={`a c`}>\n    one\n    three\n  </p>;";
    expect(compareCopyEdit("src/A.jsx", before, after)).toEqual({ ok: true, tokens: ["one three", "c"], styles: true, colors_only: false });
  });

  it("index.html: title and meta content are copy, a script change is not", () => {
    const before = `<!doctype html><html><head><title>Bikes</title><meta name="description" content="Old"><script type="module" src="/src/main.tsx"></script></head><body><div id="root"></div></body></html>`;
    const copy = before.replace("<title>Bikes</title>", "<title>E-bikes in Lisbon</title>").replace('content="Old"', 'content="Rent e-bikes"');
    expect(compareCopyEdit("index.html", before, copy)).toEqual({ ok: true, tokens: ["E-bikes in Lisbon", "Rent e-bikes"], styles: false, colors_only: false });
    expect(compareCopyEdit("index.html", before, before.replace("/src/main.tsx", "https://evil.example/x.js")).ok).toBe(false);
    expect(compareCopyEdit("index.html", before, before.replace('<div id="root">', '<div id="root"><script>alert(1)</script>')).ok).toBe(false);
  });
});

describe("compareCopyEdit: entities and meta content", () => {
  const FOOTER = (year: string) => `export default function Footer() {
  return (
    <footer className="py-8">
      <p>&copy; ${year} Acme &mdash; made with care &hellip; &rsquo;til &rarr; &euro;5</p>
      <p title="&copy; ${year} Acme">x</p>
    </footer>
  );
}
`;

  it("a footer year edit with named entities is a copy edit whose tokens are decoded", () => {
    const r = compareCopyEdit("src/components/Footer.tsx", FOOTER("2025"), FOOTER("2026"));
    expect(r).toEqual({ ok: true, tokens: ["\u00a9 2026 Acme \u2014 made with care \u2026 \u2019til \u2192 \u20ac5", "\u00a9 2026 Acme"], styles: false, colors_only: false });
  });

  it("jsx: content is copy only on a description, og: or twitter: meta", () => {
    const meta = (attrs: string, content: string) => `export const H = () => <head><meta ${attrs} content="${content}" /></head>;`;
    for (const attrs of ['name="description"', 'property="og:title"', 'name="twitter:card"']) {
      expect(compareCopyEdit("src/H.tsx", meta(attrs, "Old"), meta(attrs, "New words"))).toEqual({ ok: true, tokens: ["New words"], styles: false, colors_only: false });
    }
    for (const attrs of ['http-equiv="Content-Security-Policy"', 'http-equiv="refresh"', 'name="viewport"', ""]) {
      expect(compareCopyEdit("src/H.tsx", meta(attrs, "default-src 'self'"), meta(attrs, "default-src *")).ok).toBe(false);
    }
    const div = (c: string) => `export const D = () => <div content="${c}">x</div>;`;
    expect(compareCopyEdit("src/D.tsx", div("a"), div("b")).ok).toBe(false);
  });

  it("index.html: content is copy only on a description, og: or twitter: meta", () => {
    const page = (meta: string) => `<!doctype html><html><head>${meta}<script type="module" src="/src/main.tsx"></script></head><body><div id="root"></div></body></html>`;
    expect(compareCopyEdit("index.html", page('<meta property="og:description" content="Old">'), page('<meta property="og:description" content="Fresh &amp; new">'))).toEqual({ ok: true, tokens: ["Fresh & new"], styles: false, colors_only: false });
    for (const [before, after] of [
      ['<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">', '<meta http-equiv="Content-Security-Policy" content="default-src *">'],
      ['<meta http-equiv="refresh" content="0">', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
      ['<meta name="viewport" content="width=device-width">', '<meta name="viewport" content="width=10">'],
    ]) {
      expect(compareCopyEdit("index.html", page(before), page(after)).ok).toBe(false);
    }
  });
});

describe("classifySiteChange", () => {
  it("copy-only tsx + css changes are light, migrations untouched", async () => {
    const { sandbox, run } = sandboxFor("M\tsrc/components/Hero.tsx\nM\tsrc/index.css\n", {
      [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE,
      [`${NEXT}:src/components/Hero.tsx`]: HERO_COPY,
    });
    const c = await classifySiteChange(sandbox, LIVE, NEXT);
    expect(c).toMatchObject({ files: 2, migrations_touched: false, light: { ok: true } });
    expect(run.mock.calls[0][0]).toBe(`git diff --no-ext-diff --no-color --name-status -M ${LIVE} ${NEXT}`);
    expect(run.mock.calls.some(([cmd]) => String(cmd).includes("index.css"))).toBe(true);
    expect(c?.light).toMatchObject({ styles: true, colors_only: false });
  });

  it.each([
    ["a .ts file", "M\tsrc/lib/records.ts\n", false],
    ["a new migration", "A\tsupabase/migrations/004_add_price.sql\nM\tsrc/components/Hero.tsx\n", true],
    ["an edited migration", "M\tsupabase/migrations/001_init.sql\n", true],
    ["an added component", "A\tsrc/components/New.tsx\n", false],
    ["a deleted component", "D\tsrc/components/Old.tsx\n", false],
    ["a renamed component", "R100\tsrc/components/A.tsx\tsrc/components/B.tsx\n", false],
    ["package.json", "M\tpackage.json\n", false],
    ["tailwind.config.ts", "M\ttailwind.config.ts\n", false],
    ["a nested index.html", "M\tpublic/index.html\n", false],
    ["a quoted path", 'M\t"src/caf\\303\\251.tsx"\n', false],
  ])("%s takes the full gate", async (_label, diff, migrations) => {
    const { sandbox } = sandboxFor(diff, {
      [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE,
      [`${NEXT}:src/components/Hero.tsx`]: HERO_COPY,
    });
    const c = await classifySiteChange(sandbox, LIVE, NEXT);
    expect(c?.light.ok).toBe(false);
    expect(c?.migrations_touched).toBe(migrations);
  });

  it("a structural tsx edit takes the full gate", async () => {
    const { sandbox } = sandboxFor("M\tsrc/components/Hero.tsx\n", {
      [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE,
      [`${NEXT}:src/components/Hero.tsx`]: HERO_BEFORE.replace('to="/book"', 'to="/admin"'),
    });
    expect((await classifySiteChange(sandbox, LIVE, NEXT))?.light.ok).toBe(false);
  });

  it("an unreadable diff is unknown (null), and bad shas never reach the shell", async () => {
    const failed = sandboxFor("", {}, 128);
    expect(await classifySiteChange(failed.sandbox, LIVE, NEXT)).toBeNull();
    const evil = sandboxFor("", {});
    expect(await classifySiteChange(evil.sandbox, "abc1234; rm -rf /", NEXT)).toBeNull();
    expect(evil.run).not.toHaveBeenCalled();
  });
});

const PREVIEW = "https://shop-abc.zaviagent.com/__zavi_preview/d000000001-abcdef12/?t=1234.previewsig0123456789abcdef";
const COOKIE = "__zavi_preview=d000000001-abcdef12.1234.previewsig0123456789abcdef";
const HTML = `<!doctype html><html><head><title>Shop</title><script type="module" crossorigin src="/assets/index-AbC.js"></script><link rel="stylesheet" crossorigin href="/assets/index-XyZ.css"></head><body><div id="root"></div></body></html>`;
const JS = `const t="Rent e-bikes fast",c="text-5xl font-bold text-rose-600";const g="Grab an e-bike in two minutes \\u0026 ride all day.";import("./Book-q1.js");`;

type Route = { status: number; body?: string; headers?: Record<string, string>; cookies?: string[] };

function fakeFetch(routes: Record<string, Route>, opts: { throwOn?: string } = {}) {
  const calls: Array<{ url: string; cookie?: string; redirect?: string }> = [];
  const fn: SiteFetch = async (url, init) => {
    calls.push({ url, cookie: init?.headers?.cookie, redirect: init?.redirect });
    if (opts.throwOn && url.includes(opts.throwOn)) throw new Error(`connect ECONNREFUSED ${url}`);
    const r = routes[url] ?? { status: 404, body: "not found" };
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null, getSetCookie: () => r.cookies ?? [] },
      text: async () => r.body ?? "",
    };
  };
  return { fn, calls };
}

function goodRoutes(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    [PREVIEW]: { status: 302, headers: { location: "/" }, cookies: [`${COOKIE}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`] },
    "https://shop-abc.zaviagent.com/": { status: 200, body: HTML, headers: { "x-zavi-preview": "1" } },
    "https://shop-abc.zaviagent.com/assets/index-AbC.js": { status: 200, body: JS },
    "https://shop-abc.zaviagent.com/assets/index-XyZ.css": { status: 200, body: ".text-rose-600{color:#e11d48}" },
    "https://shop-abc.zaviagent.com/assets/Book-q1.js": { status: 200, body: `const b="Book your e-bike";` },
    ...over,
  };
}

const TOKENS = ["Rent e-bikes fast", "text-5xl", "text-rose-600", "Grab an e-bike in two minutes & ride all day."];

describe("runSiteLightGate", () => {
  it("passes when the preview redirects with its cookie, everything loads and every new token is in the bundle", async () => {
    const f = fakeFetch(goodRoutes());
    const r = await runSiteLightGate({ preview_url: PREVIEW, tokens: [...TOKENS, "Book your e-bike"], fetchFn: f.fn });
    expect(r).toMatchObject({ ok: true, owner_journey: "not_required" });
    expect(f.calls[0]).toMatchObject({ url: PREVIEW, redirect: "manual" });
    for (const c of f.calls.slice(1)) expect(c.cookie).toBe(COOKIE);
  });

  it("fails when a new text is not in the published bundle, without leaking the preview token", async () => {
    const f = fakeFetch(goodRoutes());
    const r = await runSiteLightGate({ preview_url: PREVIEW, tokens: [...TOKENS, "Ride free on Sundays"], fetchFn: f.fn });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('"Ride free on Sundays"');
    expect(JSON.stringify(r)).not.toContain("previewsig0123456789abcdef");
  });

  it.each([
    ["the preview link does not redirect", { [PREVIEW]: { status: 403, body: "expired" } }, "403"],
    ["the preview link sets no cookie", { [PREVIEW]: { status: 302, cookies: ["other=1; Path=/"] } }, "cookie"],
    ["the home page is not the staged preview", { "https://shop-abc.zaviagent.com/": { status: 200, body: HTML } }, "staged preview"],
    ["the home page errors", { "https://shop-abc.zaviagent.com/": { status: 500, headers: { "x-zavi-preview": "1" } } }, "500"],
    ["a script asset is missing", { "https://shop-abc.zaviagent.com/assets/index-AbC.js": { status: 404 } }, "/assets/index-AbC.js answered 404"],
    ["a stylesheet asset is missing", { "https://shop-abc.zaviagent.com/assets/index-XyZ.css": { status: 404 } }, "index-XyZ.css"],
    ["the page loads no script", { "https://shop-abc.zaviagent.com/": { status: 200, body: "<html><body>hi</body></html>", headers: { "x-zavi-preview": "1" } } }, "no script"],
  ])("fails when %s", async (_label, over, expected) => {
    const r = await runSiteLightGate({ preview_url: PREVIEW, tokens: TOKENS, fetchFn: fakeFetch(goodRoutes(over as Record<string, Route>)).fn });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(expected);
  });

  it("passes a named-entity copy edit against the bundle esbuild emits, where entities are already decoded", async () => {
    const r0 = compareCopyEdit("src/F.tsx", "export const F = () => <p>&copy; 2025 Acme &mdash; all rights</p>;", "export const F = () => <p>&copy; 2026 Acme &mdash; all rights</p>;");
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    const bundle = `const f="\\xA9 2026 Acme \\u2014 all rights";`;
    const f = fakeFetch(goodRoutes({ "https://shop-abc.zaviagent.com/assets/index-AbC.js": { status: 200, body: bundle } }));
    const r = await runSiteLightGate({ preview_url: PREVIEW, tokens: r0.tokens, fetchFn: f.fn });
    expect(r).toMatchObject({ ok: true });
  });

  it("a missing new text is flagged missing_text, and only that failure is", async () => {
    const miss = await runSiteLightGate({ preview_url: PREVIEW, tokens: [...TOKENS, "Ride free on Sundays"], fetchFn: fakeFetch(goodRoutes()).fn });
    expect(miss).toMatchObject({ ok: false, missing_text: true });
    const broken = await runSiteLightGate({
      preview_url: PREVIEW,
      tokens: TOKENS,
      fetchFn: fakeFetch(goodRoutes({ "https://shop-abc.zaviagent.com/assets/index-AbC.js": { status: 404 } })).fn,
    });
    expect(broken.ok).toBe(false);
    expect((broken as { missing_text?: boolean }).missing_text).toBeUndefined();
  });

  it("a network error is a failure whose reason carries no preview token", async () => {
    const r = await runSiteLightGate({ preview_url: PREVIEW, tokens: TOKENS, fetchFn: fakeFetch(goodRoutes(), { throwOn: "__zavi_preview" }).fn });
    expect(r.ok).toBe(false);
    expect(r.reason).not.toContain("previewsig0123456789abcdef");
    expect(r.reason).toContain("[redacted]");
  });
});

describe("light gate review fixes (DEL-1323)", () => {
  it("an og:image, og:url or twitter:image change is not a copy edit, in jsx or index.html", () => {
    const meta = (attrs: string, content: string) => `export const H = () => <head><meta ${attrs} content="${content}" /></head>;`;
    const page = (attrs: string, content: string) =>
      `<!doctype html><html><head><meta ${attrs} content="${content}"><script type="module" src="/src/main.tsx"></script></head><body><div id="root"></div></body></html>`;
    for (const attrs of ['property="og:image"', 'property="og:image:secure_url"', 'property="og:url"', 'name="twitter:image"']) {
      expect(compareCopyEdit("src/H.tsx", meta(attrs, "/a.png"), meta(attrs, "https://x.supabase.co/b.png")).ok).toBe(false);
      expect(compareCopyEdit("index.html", page(attrs, "/a.png"), page(attrs, "https://x.supabase.co/b.png")).ok).toBe(false);
    }
    expect(compareCopyEdit("index.html", page('property="og:title"', "Old"), page('property="og:title"', "New")).ok).toBe(true);
  });

  it("classifySiteChange marks a .css change and a class change as styles, and a text change as not", async () => {
    const files = {
      [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE,
      [`${NEXT}:src/components/Hero.tsx`]: HERO_COPY,
    };
    const css = await classifySiteChange(sandboxFor("M\tsrc/index.css\n", {}).sandbox, LIVE, NEXT);
    expect(css?.light).toMatchObject({ ok: true, styles: true, colors_only: false });
    const cls = await classifySiteChange(sandboxFor("M\tsrc/components/Hero.tsx\n", files).sandbox, LIVE, NEXT);
    expect(cls?.light).toMatchObject({ ok: true, styles: true, colors_only: false });
    const textOnly = await classifySiteChange(
      sandboxFor("M\tsrc/components/Hero.tsx\n", {
        [`${LIVE}:src/components/Hero.tsx`]: HERO_BEFORE,
        [`${NEXT}:src/components/Hero.tsx`]: HERO_BEFORE.replace("Rent bikes</h1>", "Rent e-bikes</h1>"),
      }).sandbox,
      LIVE,
      NEXT,
    );
    expect(textOnly?.light).toMatchObject({ ok: true, styles: false });
    const dropped = compareCopyEdit("src/A.tsx", 'export const A = () => <p className="w-full px-4">x</p>;', 'export const A = () => <p className="w-full">x</p>;');
    expect(dropped).toMatchObject({ ok: true, styles: true, colors_only: false });
  });

  it.each([
    ["the preview link does not redirect", goodRoutes({ [PREVIEW]: { status: 403, body: "expired" } }), null],
    ["the preview link fetch throws", goodRoutes(), PREVIEW],
    ["the home page errors", goodRoutes({ "https://shop-abc.zaviagent.com/": { status: 503, headers: { "x-zavi-preview": "1" } } }), null],
    ["the home page fetch throws", goodRoutes(), "https://shop-abc.zaviagent.com/"],
    ["a script asset answers 503", goodRoutes({ "https://shop-abc.zaviagent.com/assets/index-AbC.js": { status: 503 } }), null],
    ["a stylesheet asset is rate limited (429)", goodRoutes({ "https://shop-abc.zaviagent.com/assets/index-XyZ.css": { status: 429 } }), null],
    ["the preview link sets no cookie", goodRoutes({ [PREVIEW]: { status: 302, cookies: ["other=1; Path=/"] } }), null],
    ["the home page lacks the preview header", goodRoutes({ "https://shop-abc.zaviagent.com/": { status: 200, body: HTML } }), null],
  ])("marks %s as unreachable (infra), not a code failure", async (_label, routes, throwAt) => {
    const base = fakeFetch(routes);
    const fetchFn: SiteFetch = async (url, init) => {
      if (url === throwAt) throw new Error("getaddrinfo EAI_AGAIN");
      return base.fn(url, init);
    };
    const r = await runSiteLightGate({ preview_url: PREVIEW, tokens: TOKENS, fetchFn });
    expect(r).toMatchObject({ ok: false, infra: true });
    expect((r as { missing_text?: boolean }).missing_text).toBeUndefined();
  });

  it.each([
    ["a script asset is missing", { "https://shop-abc.zaviagent.com/assets/index-AbC.js": { status: 404 } }],
    ["a stylesheet asset is forbidden", { "https://shop-abc.zaviagent.com/assets/index-XyZ.css": { status: 403 } }],
    ["the page loads no script", { "https://shop-abc.zaviagent.com/": { status: 200, body: "<html><body>hi</body></html>", headers: { "x-zavi-preview": "1" } } }],
  ])("keeps %s a code failure (no infra mark)", async (_label, over) => {
    const r = await runSiteLightGate({ preview_url: PREVIEW, tokens: TOKENS, fetchFn: fakeFetch(goodRoutes(over as Record<string, Route>)).fn });
    expect(r.ok).toBe(false);
    expect((r as { infra?: boolean }).infra).toBeUndefined();
  });
});

describe("DEL-1323 B30: colour-only style changes", () => {
  const BTN = (cls: string) => `export const B = () => <a href="/book" className="${cls}">Book</a>;`;
  const swap = (before: string, after: string) => compareCopyEdit("src/B.tsx", BTN(before), BTN(after));

  it.each([
    ["bg-red-500 px-4 text-white", "bg-blue-600 px-4 text-white"],
    ["bg-red-500 text-white", "text-slate-900 bg-emerald-50"],
    ["hover:bg-red-500 md:text-white", "hover:bg-rose-700/80 md:text-black"],
    ["border-t-red-500 ring-offset-white", "border-t-sky-300 ring-offset-slate-950"],
    ["bg-primary text-primary-foreground", "bg-destructive text-destructive-foreground"],
    ["from-pink-500 to-transparent", "from-[#ff8800] to-[rgb(0,0,0)]"],
  ])("%s -> %s is a colour-only swap", (before, after) => {
    expect(swap(before, after)).toMatchObject({ ok: true, styles: true, colors_only: true });
  });

  it.each([
    ["bg-red-500 flex", "bg-red-500 grid"],
    ["bg-red-500", "bg-red-500 hidden"],
    ["bg-red-500 w-full", "bg-blue-500"],
    ["bg-red-500 p-2", "bg-blue-500 p-4"],
    ["text-red-500", "text-lg"],
    ["text-4xl text-slate-900", "text-5xl text-rose-600"],
    ["bg-red-500", "text-red-500"],
    ["bg-red-500", "hover:bg-red-500"],
    ["bg-red-500", "!bg-blue-500"],
    ["text-white", "text-white bg-red-500"],
    ["bg-red-500 text-white", "bg-blue-500"],
    ["border-red-500", "border-2"],
    ["shadow-red-500", "shadow-lg"],
    ["bg-red-500", "bg-[url(/x.png)]"],
    ["bg-brand", "bg-red-500"],
  ])("%s -> %s is not colour only", (before, after) => {
    const r = swap(before, after);
    expect(r).toMatchObject({ ok: true, styles: true });
    expect((r as { colors_only: boolean }).colors_only).toBe(false);
  });

  it("every class attribute must be a colour swap, compared one by one", () => {
    const two = (a: string, b: string) => `export const C = () => <div className="${a}"><p className="${b}">x</p></div>;`;
    expect(compareCopyEdit("src/C.tsx", two("flex bg-red-500", "p-4"), two("flex bg-blue-500", "p-4"))).toMatchObject({ colors_only: true });
    expect(compareCopyEdit("src/C.tsx", two("flex bg-red-500", "p-4"), two("p-4 bg-blue-500", "flex"))).toMatchObject({ colors_only: false });
  });

  it("index.html class swaps follow the same rule", () => {
    const page = (cls: string) =>
      `<!doctype html><html><head><script type="module" src="/src/main.tsx"></script></head><body class="${cls}"><div id="root"></div></body></html>`;
    expect(compareCopyEdit("index.html", page("bg-white text-slate-900"), page("bg-slate-950 text-white"))).toMatchObject({ colors_only: true });
    expect(compareCopyEdit("index.html", page("bg-white"), page("bg-white overflow-x-hidden"))).toMatchObject({ colors_only: false });
  });

  const CSS = `@tailwind base;
:root {
  --primary: 221 83% 53%;
  --brand: #ff5500;
  --radius: 0.5rem;
}
/* buttons */
.btn { color: #fff; background: linear-gradient(to right, red 10%, rgb(0 0 0 / 50%) 90%); border: 1px solid rebeccapurple; padding: 8px 16px; }
.btn:hover { @apply bg-red-500 text-white shadow; }
.hero::after { content: "red"; background: url("red.png") no-repeat white; }
@media (min-width: 640px) { .btn { box-shadow: 0 1px 2px hsl(0 0% 0% / 0.2); width: 50%; } }
`;

  it.each([
    ["a hex colour", CSS.replace("color: #fff", "color: #0f172a")],
    ["a named colour to hex", CSS.replace("solid rebeccapurple", "solid #663399")],
    ["gradient stop colours", CSS.replace("red 10%, rgb(0 0 0 / 50%) 90%", "blue 10%, hsl(200 50% 40%) 90%")],
    ["an hsl channel custom property", CSS.replace("--primary: 221 83% 53%", "--primary: 142.1 76.2% 36.3%")],
    ["a hex custom property", CSS.replace("--brand: #ff5500", "--brand: oklch(0.7 0.2 40)")],
    ["an @apply colour swap", CSS.replace("@apply bg-red-500 text-white shadow", "@apply bg-emerald-600 text-slate-50 shadow")],
    ["a shadow colour in a media query", CSS.replace("hsl(0 0% 0% / 0.2)", "rgba(15, 23, 42, 0.3)")],
    ["the background colour next to a url", CSS.replace("no-repeat white", "no-repeat black")],
    ["a comment and whitespace", CSS.replace("/* buttons */", "/* primary buttons */").replace("color: #fff;", "color:   #ffffff ;")],
  ])("css: %s is colour only", (_label, after) => {
    expect(cssColorOnlyChange(CSS, after)).toBe(true);
  });

  it.each([
    ["a padding value", CSS.replace("padding: 8px 16px", "padding: 8px 24px")],
    ["a width in a media query", CSS.replace("width: 50%", "width: 120%")],
    ["a non-colour custom property", CSS.replace("--radius: 0.5rem", "--radius: 1rem")],
    ["a colour custom property turned into a length", CSS.replace("--brand: #ff5500", "--brand: 12px")],
    ["a selector", CSS.replace(".btn:hover", ".btn:focus")],
    ["a colour word in a selector", CSS.replace(".hero::after", ".red::after")],
    ["a media query", CSS.replace("min-width: 640px", "min-width: 768px")],
    ["a new declaration", CSS.replace("padding: 8px 16px;", "padding: 8px 16px; display: none;")],
    ["a colour word in content text", CSS.replace('content: "red"', 'content: "blue"')],
    ["a colour word in a url", CSS.replace('url("red.png")', 'url("blue.png")')],
    ["a border width next to a colour", CSS.replace("1px solid rebeccapurple", "4px solid rebeccapurple")],
    ["!important added", CSS.replace("color: #fff", "color: #000 !important")],
    ["an @apply layout swap", CSS.replace("@apply bg-red-500 text-white shadow", "@apply bg-red-500 text-white shadow hidden")],
    ["a var() reference", CSS.replace("color: #fff", "color: var(--brand)")],
    ["an unbalanced brace", `${CSS}}`],
    ["an unterminated comment", `${CSS}/* x`],
    ["an at-import", `@import url("https://evil.example/x.css");\n${CSS}`],
  ])("css: %s is not colour only", (_label, after) => {
    expect(cssColorOnlyChange(CSS, after)).toBe(false);
  });

  it("classifySiteChange: a .css colour change plus a tsx colour swap is colour only, a layout change anywhere is not", async () => {
    const files = {
      [`${LIVE}:src/index.css`]: CSS,
      [`${NEXT}:src/index.css`]: CSS.replace("color: #fff", "color: #0f172a"),
      [`${LIVE}:src/B.tsx`]: BTN("bg-red-500 px-4"),
      [`${NEXT}:src/B.tsx`]: BTN("bg-blue-600 px-4"),
    };
    const ok = await classifySiteChange(sandboxFor("M\tsrc/index.css\nM\tsrc/B.tsx\n", files).sandbox, LIVE, NEXT);
    expect(ok?.light).toEqual({ ok: true, tokens: ["bg-blue-600"], styles: true, colors_only: true });
    const layout = await classifySiteChange(
      sandboxFor("M\tsrc/index.css\nM\tsrc/B.tsx\n", { ...files, [`${NEXT}:src/B.tsx`]: BTN("bg-blue-600 px-6") }).sandbox,
      LIVE,
      NEXT,
    );
    expect(layout?.light).toMatchObject({ ok: true, styles: true, colors_only: false });
    const cssLayout = await classifySiteChange(
      sandboxFor("M\tsrc/index.css\n", { ...files, [`${NEXT}:src/index.css`]: CSS.replace("width: 50%", "width: 100vw") }).sandbox,
      LIVE,
      NEXT,
    );
    expect(cssLayout?.light).toMatchObject({ ok: true, styles: true, colors_only: false });
    const unreadable = await classifySiteChange(sandboxFor("M\tsrc/index.css\n", {}).sandbox, LIVE, NEXT);
    expect(unreadable?.light).toMatchObject({ ok: true, styles: true, colors_only: false });
  });
});

describe("compareCopyEdit on starter section pages", () => {
  const page = (o: { subtitle?: string; body?: string; tagline?: string; answer?: string; to?: string; src?: string; name?: string; extra?: boolean }) => `import { Hero, Features, FAQ } from "../components/sections";
const SITE = { name: "${o.name ?? "Hearth & Crumb"}", tagline: "${o.tagline ?? "Slow bread"}" };
export default function Home() {
  return (
    <>
      <Hero eyebrow="Since 1998" title="Slow bread" subtitle="${o.subtitle ?? "Baked before sunrise"}" image={{ src: "${o.src ?? "/images/shop.jpg"}", alt: "Shop front" }} />
      <Features items={[{ title: "Flour", body: "${o.body ?? "Stone milled"}" }${o.extra ? ', { title: "New", body: "x" }' : ""}]} />
      <FAQ items={[{ question: "Open Sundays?", answer: "${o.answer ?? "Yes, from 8"}" }]} />
      <a href="${o.to ?? "/order"}">Order</a>
    </>
  );
}
`;

  it.each([
    ["a Hero subtitle", { subtitle: "Warm loaves every morning" }, "Warm loaves every morning"],
  ])("%s edit stays on the light path and must show its new text", (_what, change, token) => {
    const r = compareCopyEdit("src/pages/Home.tsx", page({}), page(change));
    expect(r.ok).toBe(true);
    expect(r.ok && r.tokens).toContain(token);
  });

  it.each([
    ["an object body", { body: "Heritage wheat from Oregon" }],
    ["an object answer", { answer: "Yes, from 9" }],
    ["an object tagline", { tagline: "Bread worth waking for" }],
    ["an image path", { src: "/images/other.jpg" }],
    ["a link target", { to: "/admin" }],
    ["a new item", { extra: true }],
    ["the site name, which also names the address and share card", { name: "Crumb & Co" }],
  ])("%s change still takes the full gate", (_what, change) => {
    expect(compareCopyEdit("src/pages/Home.tsx", page({}), page(change)).ok).toBe(false);
  });
});


describe("functional object values require the full gate", () => {
  it.each(["price", "period", "answer", "body", "title", "label"])("preserves %s values even if the key resembles copy", (key) => {
    const code = (value: string) => `const config = { ${key}: "${value}" }; export default function Checkout() { return <button onClick={() => charge(Number(config.${key}))}>Pay</button>; }`;
    expect(compareCopyEdit("src/Checkout.tsx", code("100"), code("1000")).ok).toBe(false);
  });
});
