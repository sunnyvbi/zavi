import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { SITE_REPO_DIR } from "../contract";
import { SITE_PREVIEW_CONFIG_PATH, sitePreviewConfigSource, writeSitePreviewConfigCmd } from "../preview-picker";
import { PREVIEW_ERROR_CATCHER_SOURCE } from "../preview-error-catcher";

type Entry = { kind: string; message: string; stack: string; page: string; at: number; count: number };
type Post = { data: { type: string; errors?: Entry[] }; target: string };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function framedPage(path = "/classes?__pt=secret-preview-token") {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=root></div></body></html>", {
    url: `https://5173-sbx.e2b.app${path}`,
    runScripts: "outside-only",
    virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  const posts: Post[] = [];
  Object.defineProperty(win, "parent", {
    configurable: true,
    value: { postMessage: (data: Post["data"], target: string) => posts.push({ data, target }) },
  });
  win.eval(PREVIEW_ERROR_CATCHER_SOURCE);
  const hello = (origin: string) =>
    win.dispatchEvent(new win.MessageEvent("message", { data: { type: "zavi:preview-errors-hello" }, origin }));
  const throwError = (error: Error, filename = "https://5173-sbx.e2b.app/src/App.tsx") =>
    win.dispatchEvent(new win.ErrorEvent("error", { message: `Uncaught ${error.name}: ${error.message}`, error, filename, lineno: 3, colno: 9 }));
  const reject = (reason: unknown) => {
    const event = new win.Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = reason;
    win.dispatchEvent(event);
  };
  const snapshots = () => posts.filter((p) => p.data.type === "zavi:preview-errors");
  const latest = () => snapshots().at(-1)?.data.errors ?? [];
  return { win, posts, hello, throwError, reject, snapshots, latest };
}

describe("the preview error catcher inside the framed app", () => {
  it("announces itself with no payload and hands errors only to an approved Zavi page that asked", async () => {
    const page = framedPage();
    expect(page.posts).toEqual([
      { data: { type: "zavi:preview-errors-ready" }, target: "*" },
      { data: { type: "zavi:preview-render", state: "pending" }, target: "*" },
    ]);
    page.throwError(new TypeError("Cannot read properties of undefined (reading 'map')"));
    await wait(80);
    expect(page.snapshots()).toHaveLength(0);

    page.hello("https://evil.example");
    page.hello("http://192.168.1.9:3070");
    page.hello("http://localhost.evil.example:3070");
    page.hello("http://localhost:8080");
    await wait(80);
    expect(page.snapshots()).toHaveLength(0);

    page.hello("http://localhost:3070");
    expect(page.snapshots()).toHaveLength(1);
    expect(page.snapshots()[0]!.target).toBe("http://localhost:3070");
    const [entry] = page.latest();
    expect(entry).toMatchObject({
      kind: "error",
      message: "TypeError: Cannot read properties of undefined (reading 'map')",
      page: "/classes",
      count: 1,
    });
    expect(JSON.stringify(page.posts)).not.toContain("secret-preview-token");
  });

  it("answers the staging web app and never a customer site or lookalike on zaviagent.com", async () => {
    const page = framedPage("/");
    page.throwError(new TypeError("boom"));
    page.hello("https://hush.zaviagent.com");
    page.hello("https://latest.zaviagent.com.evil.example");
    page.hello("https://preview.zaviagent.com");
    await wait(80);
    expect(page.snapshots()).toHaveLength(0);
    page.hello("https://latest.zaviagent.com");
    expect(page.snapshots().map((p) => p.target)).toEqual(["https://latest.zaviagent.com"]);
    expect(page.latest().map((e) => e.message)).toEqual(["TypeError: boom"]);
  });

  it("catches failed promises, script load failures and real console errors, and merges repeats", async () => {
    const page = framedPage("/");
    page.hello("https://www.zaviagent.com");
    page.reject(new Error("Failed to fetch dynamically imported module"));
    const script = page.win.document.createElement("script");
    script.src = "https://5173-sbx.e2b.app/src/main.tsx?t=1700000000000";
    page.win.document.body.appendChild(script);
    script.dispatchEvent(new page.win.Event("error"));
    page.win.console.error(new Error("boundary caught it"));
    page.throwError(new RangeError("too deep"));
    page.throwError(new RangeError("too deep"));
    await wait(80);
    const entries = page.latest();
    expect(entries.map((e) => [e.kind, e.message, e.count])).toEqual([
      ["rejection", "Error: Failed to fetch dynamically imported module", 1],
      ["load", "Failed to load script https://5173-sbx.e2b.app/src/main.tsx", 1],
      ["console", "Error: boundary caught it", 1],
      ["error", "RangeError: too deep", 2],
    ]);
    expect(page.snapshots().every((s) => s.target === "https://www.zaviagent.com")).toBe(true);
  });

  it("ignores React dev warnings, detail-less cross-origin errors and Zavi's own helper scripts", async () => {
    const page = framedPage("/");
    page.hello("http://localhost:3010");
    page.win.console.error("Warning: Each child in a list should have a unique \"key\" prop.%s", "\n in li");
    page.win.console.error("Each child in a list should have a unique \"key\" prop.");
    page.win.console.error(new Error("Warning: Function components cannot be given refs"));
    page.win.dispatchEvent(new page.win.ErrorEvent("error", { message: "Script error.", filename: "" }));
    const own = new Error("selector failed");
    own.stack = "Error: selector failed\n    at pick (https://www.zaviagent.com/zavi-editor-runtime.js:10:3)";
    page.throwError(own, "https://www.zaviagent.com/zavi-editor-runtime.js");
    page.throwError(new SyntaxError("Unexpected token"));
    await wait(80);
    expect(page.latest().map((e) => e.message)).toEqual(["SyntaxError: Unexpected token"]);
  });

  it("strips tokens, keys and signed query strings before anything leaves the frame", async () => {
    const page = framedPage("/");
    page.hello("http://localhost:3010");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    const error = new Error(
      `Image failed https://abc.supabase.co/storage/v1/object/sign/a.png?token=${jwt} with apiKey=sk_live_abcdef1234567890 and Bearer ${jwt}`,
    );
    error.stack = `Error: boom\n    at load (https://5173-sbx.e2b.app/src/Gallery.tsx?t=1700000000000&sig=deadbeef:12:5)`;
    page.reject(error);
    await wait(80);
    const sent = JSON.stringify(page.snapshots());
    expect(sent).not.toContain("eyJ");
    expect(sent).not.toContain("sk_live");
    expect(sent).not.toContain("token=");
    expect(sent).not.toContain("deadbeef");
    expect(page.latest()[0]!.stack).toContain("https://5173-sbx.e2b.app/src/Gallery.tsx:12:5");
    expect(page.latest()[0]!.message).toContain("https://abc.supabase.co/storage/v1/object/sign/a.png");
  });

  it("keeps at most 20 errors, each cut to a safe length", async () => {
    const page = framedPage("/");
    page.hello("http://localhost:3010");
    for (let i = 0; i < 30; i++) page.throwError(new Error(`failure ${i} ${"x".repeat(i === 29 ? 2000 : 0)}`));
    await wait(80);
    const entries = page.latest();
    expect(entries).toHaveLength(20);
    expect(entries[0]!.message.startsWith("Error: failure 10")).toBe(true);
    expect(Math.max(...entries.map((e) => e.message.length))).toBeLessThanOrEqual(500);
  });

  it("reports Vite's red code-error overlay and drops it once the overlay goes away", async () => {
    const page = framedPage("/");
    const { win } = page;
    class Overlay extends win.HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML =
          '<div class="message-body">Transform failed with 1 error:\nsrc/App.tsx:4:2: Expected ";"</div><div class="file">/src/App.tsx:4:2</div>';
      }
    }
    win.customElements.define("vite-error-overlay", Overlay);
    page.hello("http://localhost:3010");
    const overlay = win.document.createElement("vite-error-overlay");
    win.document.body.appendChild(overlay);
    await wait(100);
    expect(page.latest().map((e) => [e.kind, e.message])).toEqual([["compile", "Build error: Transform failed with 1 error:"]]);
    expect(page.latest()[0]!.stack).toContain("/src/App.tsx:4:2");
    overlay.remove();
    await wait(100);
    expect(page.latest()).toEqual([]);
  });

  it("counts one Vite overlay once however much the page changes under it, and a new overlay again", async () => {
    const page = framedPage("/");
    const { win } = page;
    class Overlay extends win.HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = '<div class="message-body">Transform failed with 1 error:\nsrc/App.tsx:4:2: Expected ";"</div>';
      }
    }
    win.customElements.define("vite-error-overlay", Overlay);
    page.hello("http://localhost:3010");
    const first = win.document.createElement("vite-error-overlay");
    win.document.body.appendChild(first);
    await wait(100);
    const before = page.snapshots().length;
    expect(page.latest().map((e) => [e.kind, e.count])).toEqual([["compile", 1]]);
    for (let i = 0; i < 5; i++) {
      const box = win.document.createElement("div");
      win.document.documentElement.appendChild(box);
      await wait(20);
      box.remove();
      await wait(20);
    }
    await wait(100);
    expect(page.snapshots().length).toBe(before);
    expect(page.latest().map((e) => [e.kind, e.count])).toEqual([["compile", 1]]);
    first.remove();
    await wait(100);
    expect(page.latest()).toEqual([]);
    win.document.body.appendChild(win.document.createElement("vite-error-overlay"));
    await wait(100);
    expect(page.latest().map((e) => [e.kind, e.count])).toEqual([["compile", 1]]);
    win.document.body.querySelector("vite-error-overlay")!.replaceWith(win.document.createElement("vite-error-overlay"));
    await wait(100);
    expect(page.latest().map((e) => [e.kind, e.count])).toEqual([["compile", 2]]);
  });
});

describe("the catcher's render signal", () => {
  const renders = (page: ReturnType<typeof framedPage>) =>
    page.posts.filter((p) => p.data.type === "zavi:preview-render").map((p) => (p.data as { state?: string }).state);
  const fireLoad = (page: ReturnType<typeof framedPage>) => page.win.dispatchEvent(new page.win.Event("load"));
  const moduleScript = (page: ReturnType<typeof framedPage>, src: string) => {
    const s = page.win.document.createElement("script");
    s.type = "module";
    s.src = src;
    page.win.document.body.appendChild(s);
    s.dispatchEvent(new page.win.Event("error"));
  };

  it("says rendered as soon as the app puts content in #root, once, and only a state word", async () => {
    const page = framedPage("/");
    const root = page.win.document.getElementById("root")!;
    const h = page.win.document.createElement("h1");
    h.textContent = "Fresh bread every morning";
    root.appendChild(h);
    await wait(20);
    root.appendChild(page.win.document.createElement("p"));
    await wait(20);
    expect(renders(page)).toEqual(["pending", "rendered"]);
    expect(JSON.stringify(page.posts)).not.toContain("Fresh bread");
  });

  it("says failed when a same-origin module script fails to load and nothing rendered (a 502 under the page)", async () => {
    const page = framedPage("/");
    moduleScript(page, "https://5173-sbx.e2b.app/src/main.tsx");
    expect(renders(page)).toEqual(["pending", "failed"]);
    page.win.document.getElementById("root")!.appendChild(page.win.document.createElement("main"));
    await wait(20);
    expect(renders(page)).toEqual(["pending", "failed", "rendered"]);
  });

  it("a failed cross-origin script, or a classic one, is not a failed render", async () => {
    const page = framedPage("/");
    moduleScript(page, "https://cdn.example.com/widget.js");
    const classic = page.win.document.createElement("script");
    classic.src = "https://5173-sbx.e2b.app/legacy.js";
    page.win.document.body.appendChild(classic);
    classic.dispatchEvent(new page.win.Event("error"));
    expect(renders(page)).toEqual(["pending"]);
  });

  it("a page still empty a few seconds after load says empty; one that threw says errored", async () => {
    vi.useFakeTimers();
    try {
      const empty = framedPage("/");
      fireLoad(empty);
      vi.advanceTimersByTime(3_900);
      expect(renders(empty)).toEqual(["pending"]);
      vi.advanceTimersByTime(200);
      expect(renders(empty)).toEqual(["pending", "empty"]);

      const crashed = framedPage("/");
      crashed.throwError(new TypeError("Cannot read properties of undefined (reading 'map')"));
      fireLoad(crashed);
      vi.advanceTimersByTime(4_100);
      expect(renders(crashed)).toEqual(["pending", "errored"]);

      const fine = framedPage("/");
      fine.win.document.getElementById("root")!.appendChild(fine.win.document.createElement("div"));
      fireLoad(fine);
      vi.advanceTimersByTime(4_100);
      expect(renders(fine).at(-1)).toBe("rendered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeats its state to the parent that asks (a Build view that mounted late)", () => {
    const page = framedPage("/");
    moduleScript(page, "https://5173-sbx.e2b.app/@vite/client");
    page.win.dispatchEvent(new page.win.MessageEvent("message", { data: { type: "zavi:preview-render-hello" }, origin: "https://www.zaviagent.com" }));
    expect(renders(page)).toEqual(["pending", "failed", "failed"]);
  });
});

describe("the catcher in the preview dev server", () => {
  let repo = "";
  const at = (text: string) => text.split(SITE_REPO_DIR).join(repo);
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "zavi-preview-catcher-")));
    const vite = dirname(createRequire(join(process.cwd(), "package.json")).resolve("vite/package.json"));
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    symlinkSync(vite, join(repo, "node_modules", "vite"));
    writeFileSync(join(repo, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("runs first in the head of the served preview and never in a production build", async () => {
    execFileSync("bash", ["-c", at(writeSitePreviewConfigCmd(at(sitePreviewConfigSource())))]);
    const { createServer } = await import("vite");
    const server = await createServer({ configFile: at(SITE_PREVIEW_CONFIG_PATH), root: repo, logLevel: "silent", server: { middlewareMode: true } });
    try {
      const html = await server.transformIndexHtml("/", "<!doctype html><html><head><title>t</title></head><body></body></html>");
      const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
      const catcherAt = head.indexOf("zavi:preview-errors-ready");
      expect(catcherAt).toBeGreaterThan(-1);
      expect(catcherAt).toBeLessThan(head.indexOf("zavi-editor-runtime.js"));
      expect(catcherAt).toBeLessThan(head.indexOf("<title>"));
      const dom = new JSDOM(html, { url: "https://5173-sbx.e2b.app/", runScripts: "dangerously", virtualConsole: new VirtualConsole(), beforeParse(win) {
        Object.defineProperty(win, "parent", { configurable: true, value: { postMessage: () => {} } });
      } });
      expect((dom.window as unknown as { __zaviErrorCatcher?: boolean }).__zaviErrorCatcher).toBe(true);
    } finally {
      await server.close();
    }
  });
});
