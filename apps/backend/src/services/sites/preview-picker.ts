import { createHash } from "node:crypto";
import { SITE_REPO_DIR } from "./contract";
import { TEMPLATE_FILES } from "@/services/provisioning/templates/nextjs-supabase-tailwind/template-files.generated";
import { EDITOR_RUNTIME_SRC, PICKER_ASSET_PATH } from "@/services/provisioning/picker-asset";
import { PREVIEW_ERROR_CATCHER_SOURCE } from "./preview-error-catcher";
import { EDITOR_RUNTIME_SOURCE } from "./editor-runtime-source.generated";
import { FIRST_DRAFT_PLUGIN_IMPORTS, firstDraftPluginSource } from "./first-draft";

export const SITE_PREVIEW_CONFIG_DIR = `${SITE_REPO_DIR}/node_modules/.zavi`;
export const SITE_PREVIEW_CONFIG_PATH = `${SITE_PREVIEW_CONFIG_DIR}/preview.vite.config.mjs`;

export function sitePickerSource(): string {
  const source = TEMPLATE_FILES[PICKER_ASSET_PATH];
  if (!source) throw new Error(`the picker asset ${PICKER_ASSET_PATH} is missing from the template`);
  return source;
}

export const DEFAULT_EDITOR_RUNTIME_ORIGIN = "https://www.zaviagent.com";
const RUNTIME_ORIGIN_RE = /^(https:\/\/[a-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1))(?::\d{1,5})?$/;

export function editorRuntimeOrigin(raw: string | undefined = process.env.ZAVI_EDITOR_RUNTIME_ORIGIN): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "").toLowerCase();
  return RUNTIME_ORIGIN_RE.test(value) ? value : DEFAULT_EDITOR_RUNTIME_ORIGIN;
}

export function editorRuntimeScriptSrc(origin: string = editorRuntimeOrigin()): string {
  return `${origin}/${EDITOR_RUNTIME_SRC}`;
}

export function previewEditorRuntimeOverride(raw: string | undefined = process.env.ZAVI_EDITOR_RUNTIME_ORIGIN): string | null {
  return (raw ?? "").trim() ? editorRuntimeScriptSrc(editorRuntimeOrigin(raw)) : null;
}

export const EDITOR_RUNTIME_LOAD_RETRIES = 3;
export const EDITOR_RUNTIME_RETRY_MS = 1000;

export function publishedEditorLoader(src: string = `${DEFAULT_EDITOR_RUNTIME_ORIGIN}/${EDITOR_RUNTIME_SRC}`): string {
  return `<script>(function(){try{if(window.parent!==window){var n=0;var load=function(){var s=document.createElement("script");s.src=${JSON.stringify(src)};s.defer=true;s.onerror=function(){if(n<${EDITOR_RUNTIME_LOAD_RETRIES}){n++;setTimeout(load,${EDITOR_RUNTIME_RETRY_MS}*n);}};document.head.appendChild(s);};load();}}catch(e){}})();</script>`;
}

export function withPublishedEditorRuntime(html: string): string {
  if (html.includes(EDITOR_RUNTIME_SRC)) return html;
  const at = html.search(/<\/head>/i);
  if (at < 0) return html;
  return html.slice(0, at) + publishedEditorLoader() + html.slice(at);
}

export const SITE_PREVIEW_CONFIG_VERSION = 3;
const CONFIG_VERSION_LINE = (v: number) => `export const zaviPreviewConfigVersion = ${v};`;

export function sitePreviewConfigSource(
  picker: string = sitePickerSource(),
  runtimeSrc: string | null = previewEditorRuntimeOverride(),
  catcher: string = PREVIEW_ERROR_CATCHER_SOURCE,
): string {
  return [
    `import { loadConfigFromFile, mergeConfig } from "vite";`,
    ...FIRST_DRAFT_PLUGIN_IMPORTS,
    CONFIG_VERSION_LINE(SITE_PREVIEW_CONFIG_VERSION),
    `const catcher = ${JSON.stringify(catcher)};`,
    `const picker = ${JSON.stringify(picker)};`,
    `const runtime = ${JSON.stringify(
      runtimeSrc ? { tag: "script", attrs: { src: runtimeSrc, defer: true }, injectTo: "head" } : { tag: "script", children: EDITOR_RUNTIME_SOURCE, injectTo: "head" },
    )};`,
    firstDraftPluginSource(),
    `export default async (env) => {`,
    `  const loaded = await loadConfigFromFile(env, undefined, ${JSON.stringify(SITE_REPO_DIR)});`,
    `  return mergeConfig(loaded ? loaded.config : {}, {`,
    `    plugins: [{`,
    `      name: "zavi-preview-picker",`,
    `      apply: "serve",`,
    `      transformIndexHtml: (html) => ({`,
    `        html: html.replace(/<script\\b[^>]*\\bsrc=["']?[^"'\\s>]*zavi-editor-runtime\\.js[^>]*>\\s*<\\/script>/gi, ""),`,
    `        tags: [`,
    `          { tag: "script", children: catcher, injectTo: "head-prepend" },`,
    `          runtime,`,
    `          { tag: "script", children: picker, injectTo: "head" },`,
    `        ],`,
    `      }),`,
    `    }, zaviDraft],`,
    `  });`,
    `};`,
    ``,
  ].join("\n");
}

export function sitePreviewConfigHash(source: string = sitePreviewConfigSource()): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export type SitePreviewConfigRefresh = "unchanged" | "newer" | "rewritten" | "write_failed";

export function sitePreviewConfigRefreshOutcome(stdout: string): SitePreviewConfigRefresh | null {
  const m = /__config=(unchanged|newer|rewritten|write_failed)\b/.exec(stdout);
  return m ? (m[1] as SitePreviewConfigRefresh) : null;
}

export function refreshSitePreviewConfigCmd(source: string = sitePreviewConfigSource(), version: number = SITE_PREVIEW_CONFIG_VERSION): string {
  const hash = sitePreviewConfigHash(source);
  const file = SITE_PREVIEW_CONFIG_PATH;
  return [
    `cur=$(sed -n 's/^export const zaviPreviewConfigVersion = \\([0-9][0-9]*\\);$/\\1/p' '${file}' 2>/dev/null | head -n1);`,
    `if [ -n "$cur" ] && [ "$cur" -gt ${version} ]; then echo __config=newer;`,
    `elif [ "$cur" = ${version} ] && [ "$(sha256sum '${file}' 2>/dev/null | cut -d' ' -f1)" = '${hash}' ]; then echo __config=unchanged;`,
    `elif ${writeSitePreviewConfigCmd(source)}; then echo __config=rewritten; else echo __config=write_failed; fi`,
  ].join(" ");
}

export function writeSitePreviewConfigCmd(source: string = sitePreviewConfigSource()): string {
  const b64 = Buffer.from(source, "utf8").toString("base64");
  return [
    `mkdir -p '${SITE_PREVIEW_CONFIG_DIR}'`,
    `printf '%s' '${b64}' | base64 -d > '${SITE_PREVIEW_CONFIG_PATH}.tmp'`,
    `mv -f '${SITE_PREVIEW_CONFIG_PATH}.tmp' '${SITE_PREVIEW_CONFIG_PATH}'`,
  ].join(" && ");
}

export function siteDevStartCmd(port: number): string {
  const flags = `--host 0.0.0.0 --port ${port} --strictPort`;
  return `if [ -f '${SITE_PREVIEW_CONFIG_PATH}' ]; then exec npx --no-install vite --config '${SITE_PREVIEW_CONFIG_PATH}' ${flags}; else exec npx --no-install vite ${flags}; fi`;
}
