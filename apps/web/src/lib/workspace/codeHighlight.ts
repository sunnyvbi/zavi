import type { HighlighterCore } from "shiki/core";

export type CodeToken = { content: string; light?: string; dark?: string };

export const HIGHLIGHT_MAX_CHARS = 40_000;

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  toml: "toml",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  sh: "shellscript",
};

const LANG_BY_NAME: Record<string, string> = {
  ".prettierrc": "json",
  ".eslintrc": "json",
  "tsconfig.json": "json",
};

const LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  yaml: () => import("@shikijs/langs/yaml"),
  shellscript: () => import("@shikijs/langs/shellscript"),
};

const LANG_LABEL: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TypeScript JSX",
  javascript: "JavaScript",
  jsx: "JavaScript JSX",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  markdown: "Markdown",
  toml: "TOML",
  sql: "SQL",
  yaml: "YAML",
  shellscript: "Shell Script",
};

export function langForPath(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  if (LANG_BY_NAME[name]) return LANG_BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && !name.startsWith(".")) return null;
  return LANG_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function languageLabel(path: string): string {
  const lang = langForPath(path);
  return lang ? LANG_LABEL[lang] ?? lang : "Plain Text";
}

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [import("@shikijs/themes/light-plus"), import("@shikijs/themes/dark-plus")],
      langs: [],
    });
  })().catch((error: unknown) => {
    highlighter = null;
    throw error;
  });
  return highlighter;
}

export async function highlightCode(code: string, path: string): Promise<CodeToken[][] | null> {
  const lang = langForPath(path);
  if (!lang || code.length > HIGHLIGHT_MAX_CHARS) return null;
  try {
    const h = await getHighlighter();
    if (!loaded.has(lang)) {
      await h.loadLanguage((await LOADERS[lang]!()) as never);
      loaded.add(lang);
    }
    const { tokens } = h.codeToTokens(code.replace(/\n$/, ""), {
      lang,
      themes: { light: "light-plus", dark: "dark-plus" },
      defaultColor: false,
    });
    return tokens.map((line) =>
      line.map((token) => {
        const style = (token.htmlStyle ?? {}) as Record<string, string>;
        return { content: token.content, light: style["--shiki-light"], dark: style["--shiki-dark"] };
      }),
    );
  } catch {
    return null;
  }
}
