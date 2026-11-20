import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SITE_REPO_DIR } from "../contract";
import { EDITOR_RUNTIME_SOURCE } from "../editor-runtime-source.generated";
import {
  DEFAULT_EDITOR_RUNTIME_ORIGIN,
  SITE_PREVIEW_CONFIG_PATH,
  editorRuntimeOrigin,
  editorRuntimeScriptSrc,
  refreshSitePreviewConfigCmd,
  SITE_PREVIEW_CONFIG_VERSION,
  siteDevStartCmd,
  sitePreviewConfigHash,
  sitePreviewConfigRefreshOutcome,
  sitePickerSource,
  sitePreviewConfigSource,
  withPublishedEditorRuntime,
  EDITOR_RUNTIME_LOAD_RETRIES,
  EDITOR_RUNTIME_RETRY_MS,
  writeSitePreviewConfigCmd,
} from "../preview-picker";

let repo = "";
const at = (text: string) => text.split(SITE_REPO_DIR).join(repo);

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "zavi-preview-picker-")));
  const vite = dirname(createRequire(join(process.cwd(), "package.json")).resolve("vite/package.json"));
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  symlinkSync(vite, join(repo, "node_modules", "vite"));
  writeFileSync(join(repo, "index.html"), "<!doctype html><html><head><title>t</title></head><body><div id=root></div></body></html>");
  writeFileSync(
    join(repo, "vite.config.mjs"),
    `export default { plugins: [{ name: "site-own", transformIndexHtml: (h) => h.replace("</head>", "<meta name=site-own content=kept></head>") }], define: { __SITE__: "1" } };\n`,
  );
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("the preview-only Vite config", () => {
  it("serves the site's own config with the picker added, in the dev server only", async () => {
    execFileSync("bash", ["-c", at(writeSitePreviewConfigCmd(at(sitePreviewConfigSource())))]);
    const configFile = at(SITE_PREVIEW_CONFIG_PATH);
    const { createServer, resolveConfig } = await import("vite");
    const server = await createServer({ configFile, root: repo, logLevel: "silent", server: { middlewareMode: true } });
    try {
      const html = await server.transformIndexHtml("/", "<!doctype html><html><head><title>t</title></head><body></body></html>");
      expect(html).toContain("<meta name=site-own content=kept>");
      expect(html).toContain("zavi:picker-ready");
      expect(html).toContain('"zavi:element-picked"');
      expect(html.indexOf("var PROTOCOL = 5;")).toBeGreaterThan(-1);
      expect(html.indexOf("var PROTOCOL = 5;")).toBeLessThan(html.indexOf("</head>"));
      expect(html.indexOf("zavi:picker-ready")).toBeLessThan(html.indexOf("</head>"));
      expect(html.slice(html.indexOf("<body"))).not.toMatch(/zavi|picker/i);
      expect(server.config.define?.__SITE__).toBe("1");
    } finally {
      await server.close();
    }
    const built = await resolveConfig({ configFile, root: repo, logLevel: "silent" }, "build");
    expect(built.plugins.map((p) => p.name)).toContain("site-own");
    expect(built.plugins.map((p) => p.name)).not.toContain("zavi-preview-picker");
  });

  it("loads the editor runtime from the configured origin, and only from an http(s) origin", async () => {
    const local = sitePreviewConfigSource(sitePickerSource(), editorRuntimeScriptSrc(editorRuntimeOrigin("http://localhost:3010/")));
    execFileSync("bash", ["-c", at(writeSitePreviewConfigCmd(at(local)))]);
    const { createServer } = await import("vite");
    const server = await createServer({ configFile: at(SITE_PREVIEW_CONFIG_PATH), root: repo, logLevel: "silent", server: { middlewareMode: true } });
    try {
      const html = await server.transformIndexHtml("/", "<!doctype html><html><head></head><body></body></html>");
      expect(html).toContain('<script src="http://localhost:3010/zavi-editor-runtime.js" defer></script>');
      expect(html).not.toContain("www.zaviagent.com");
    } finally {
      await server.close();
    }
    expect(editorRuntimeOrigin(undefined)).toBe(DEFAULT_EDITOR_RUNTIME_ORIGIN);
    expect(editorRuntimeOrigin("https://staging.zaviagent.com")).toBe("https://staging.zaviagent.com");
    for (const bad of ["http://evil.example", "javascript:alert(1)", "https://x.io/path", "https://x.io\"><script>", " "]) {
      expect(editorRuntimeOrigin(bad)).toBe(DEFAULT_EDITOR_RUNTIME_ORIGIN);
    }
  });

  it("reads the runtime origin from ZAVI_EDITOR_RUNTIME_ORIGIN when the config is written", () => {
    const prior = process.env.ZAVI_EDITOR_RUNTIME_ORIGIN;
    process.env.ZAVI_EDITOR_RUNTIME_ORIGIN = "http://127.0.0.1:3010";
    try {
      expect(sitePreviewConfigSource()).toContain(JSON.stringify("http://127.0.0.1:3010/zavi-editor-runtime.js"));
    } finally {
      if (prior === undefined) delete process.env.ZAVI_EDITOR_RUNTIME_ORIGIN;
      else process.env.ZAVI_EDITOR_RUNTIME_ORIGIN = prior;
    }
    expect(sitePreviewConfigSource()).not.toContain('"src":"https://www.zaviagent.com/zavi-editor-runtime.js"');
  });

  it("with no override the preview runs the editor runtime from this checkout inline, so the text tool never depends on what prod has deployed", async () => {
    const prior = process.env.ZAVI_EDITOR_RUNTIME_ORIGIN;
    delete process.env.ZAVI_EDITOR_RUNTIME_ORIGIN;
    try {
      execFileSync("bash", ["-c", at(writeSitePreviewConfigCmd(at(sitePreviewConfigSource())))]);
    } finally {
      if (prior !== undefined) process.env.ZAVI_EDITOR_RUNTIME_ORIGIN = prior;
    }
    const { createServer } = await import("vite");
    const server = await createServer({ configFile: at(SITE_PREVIEW_CONFIG_PATH), root: repo, logLevel: "silent", server: { middlewareMode: true } });
    try {
      const html = await server.transformIndexHtml(
        "/",
        '<!doctype html><html><head><script src="https://www.zaviagent.com/zavi-editor-runtime.js" defer></script></head><body><script src="/zavi-editor-runtime.js"></script></body></html>',
      );
      expect(html.match(/<script[^>]*src=["'][^"']*zavi-editor-runtime\.js[^>]*><\/script>/g)).toBeNull();
      expect(html.split("var PROTOCOL = 5;")).toHaveLength(2);
      expect(html).toContain("var PROTOCOL = 5;");
      expect(html).toContain('TEXT_EDITED: "zavi:editor-text-edited"');
      const runtimeAt = html.indexOf("var PROTOCOL = 5;");
      expect(html.lastIndexOf("<script", runtimeAt)).toBeGreaterThan(html.lastIndexOf("</script>", runtimeAt));
    } finally {
      await server.close();
    }
  });

  it("refreshing the config on a running preview rewrites it only when this checkout's config differs, so Vite restarts once", () => {
    const source = at(sitePreviewConfigSource());
    const refresh = at(refreshSitePreviewConfigCmd(source)).split(sitePreviewConfigHash(sitePreviewConfigSource())).join(sitePreviewConfigHash(source));
    rmSync(at(SITE_PREVIEW_CONFIG_PATH), { force: true });
    expect(execFileSync("bash", ["-c", refresh]).toString().trim()).toBe("__config=rewritten");
    expect(readFileSync(at(SITE_PREVIEW_CONFIG_PATH), "utf-8")).toBe(source);
    expect(execFileSync("bash", ["-c", refresh]).toString().trim()).toBe("__config=unchanged");
    writeFileSync(at(SITE_PREVIEW_CONFIG_PATH), "export default {};\n");
    expect(execFileSync("bash", ["-c", refresh]).toString().trim()).toBe("__config=rewritten");
    expect(readFileSync(at(SITE_PREVIEW_CONFIG_PATH), "utf-8")).toBe(source);
  });

  it("a config written by newer code is left alone and reported, never fought over", () => {
    const source = at(sitePreviewConfigSource());
    const refresh = at(refreshSitePreviewConfigCmd(source)).split(sitePreviewConfigHash(sitePreviewConfigSource())).join(sitePreviewConfigHash(source));
    const newer = source.replace(`export const zaviPreviewConfigVersion = ${SITE_PREVIEW_CONFIG_VERSION};`, `export const zaviPreviewConfigVersion = ${SITE_PREVIEW_CONFIG_VERSION + 1};`);
    expect(newer).not.toBe(source);
    writeFileSync(at(SITE_PREVIEW_CONFIG_PATH), newer);
    expect(execFileSync("bash", ["-c", refresh]).toString().trim()).toBe("__config=newer");
    expect(readFileSync(at(SITE_PREVIEW_CONFIG_PATH), "utf-8")).toBe(newer);
    const older = source.replace(`export const zaviPreviewConfigVersion = ${SITE_PREVIEW_CONFIG_VERSION};\n`, "");
    writeFileSync(at(SITE_PREVIEW_CONFIG_PATH), older);
    expect(execFileSync("bash", ["-c", refresh]).toString().trim()).toBe("__config=rewritten");
    expect(readFileSync(at(SITE_PREVIEW_CONFIG_PATH), "utf-8")).toBe(source);
    expect(sitePreviewConfigRefreshOutcome("x\n__config=newer\n")).toBe("newer");
    expect(sitePreviewConfigRefreshOutcome("")).toBeNull();
  });

  it("the inlined runtime is exactly this checkout's web runtime, with closing script tags escaped", () => {
    const web = readFileSync(join(__dirname, "../../../../../web/public/zavi-editor-runtime.js"), "utf-8");
    expect(EDITOR_RUNTIME_SOURCE).toBe(web.replace(/<\/script/gi, "<\\/script"));
    expect(EDITOR_RUNTIME_SOURCE).not.toMatch(/<\/script/i);
  });

  it("injects the picker the old builder shipped, which is inert unless framed and never posts to '*' after the handshake", () => {
    const picker = sitePickerSource();
    expect(picker).toContain("if (window.parent === window) return;");
    expect(picker).toContain("parentOrigin");
    expect(sitePreviewConfigSource()).toContain(JSON.stringify(picker));
  });

  it("writes the config outside the site's tracked files, so it never reaches the repo or the published build", () => {
    expect(SITE_PREVIEW_CONFIG_PATH.startsWith(`${SITE_REPO_DIR}/node_modules/`)).toBe(true);
    expect(writeSitePreviewConfigCmd()).not.toContain("git ");
  });
});

describe("the site dev server command", () => {
  function run(withConfig: boolean): string {
    const bin = join(repo, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npx"), '#!/bin/sh\necho "$@"\n');
    chmodSync(join(bin, "npx"), 0o755);
    const cfg = at(SITE_PREVIEW_CONFIG_PATH);
    if (withConfig) execFileSync("bash", ["-c", at(writeSitePreviewConfigCmd())]);
    else rmSync(cfg, { force: true });
    return execFileSync("bash", ["-c", at(siteDevStartCmd(5173))], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
      .toString()
      .trim();
  }

  it("boots Vite on the preview config when it was written", () => {
    expect(run(true)).toBe(`--no-install vite --config ${at(SITE_PREVIEW_CONFIG_PATH)} --host 0.0.0.0 --port 5173 --strictPort`);
  });

  it("boots Vite on the site's own config when the write failed", () => {
    expect(run(false)).toBe("--no-install vite --host 0.0.0.0 --port 5173 --strictPort");
  });
});

describe("the published editor loader", () => {
  function runLoader(framed: boolean) {
    const html = withPublishedEditorRuntime("<html><head><title>t</title></head><body></body></html>");
    const code = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    type Tag = { src?: string; defer?: boolean; onerror?: () => void };
    const appended: Tag[] = [];
    const fetches: unknown[] = [];
    const win: Record<string, unknown> = {};
    win.parent = framed ? {} : win;
    const document = {
      createElement: () => ({}) as Tag,
      head: { appendChild: (n: Tag) => appended.push(n) },
    };
    new Function("window", "document", "fetch", code)(win, document, (u: unknown) => fetches.push(u));
    return { appended, fetches };
  }

  it("does nothing for a visitor opening the site directly: no script, no request", () => {
    expect(runLoader(false)).toEqual({ appended: [], fetches: [] });
  });

  it("loads the production runtime only when the site is framed (the Build preview)", () => {
    expect(runLoader(true).appended).toEqual([expect.objectContaining({ src: "https://www.zaviagent.com/zavi-editor-runtime.js", defer: true })]);
  });

  it("retries a runtime that failed to load, with a growing wait, a bounded number of times", () => {
    vi.useFakeTimers();
    try {
      const { appended } = runLoader(true);
      for (let i = 1; i <= EDITOR_RUNTIME_LOAD_RETRIES + 1; i++) {
        appended[appended.length - 1]!.onerror!();
        vi.advanceTimersByTime(EDITOR_RUNTIME_RETRY_MS * i - 1);
        expect(appended).toHaveLength(Math.min(i, EDITOR_RUNTIME_LOAD_RETRIES + 1));
        vi.advanceTimersByTime(1);
        expect(appended).toHaveLength(Math.min(i + 1, EDITOR_RUNTIME_LOAD_RETRIES + 1));
      }
      vi.advanceTimersByTime(EDITOR_RUNTIME_RETRY_MS * 10);
      expect(appended).toHaveLength(EDITOR_RUNTIME_LOAD_RETRIES + 1);
      expect(appended.every((tag) => tag.src === "https://www.zaviagent.com/zavi-editor-runtime.js")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent, and leaves a page with no head untouched", () => {
    const once = withPublishedEditorRuntime("<head></head>");
    expect(withPublishedEditorRuntime(once)).toBe(once);
    expect(withPublishedEditorRuntime("<div>no head</div>")).toBe("<div>no head</div>");
  });
});
