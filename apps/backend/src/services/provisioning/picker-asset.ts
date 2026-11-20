
export const PICKER_ASSET_PATH = "public/zavi-picker.js";

export const PICKER_LAYOUT_PATH = "app/layout.tsx";

export const PICKER_MARKER = "zavi:picker";

export const EDITOR_RUNTIME_SRC = "zavi-editor-runtime.js";
export const EDITOR_MARKER = "zavi:editor";

export function stripPickerFromLayout(source: string): string {
  if (
    !source.includes("zavi-picker.js") &&
    !source.includes(EDITOR_RUNTIME_SRC) &&
    !source.includes(PICKER_MARKER) &&
    !source.includes(EDITOR_MARKER)
  ) {
    return source;
  }

  return (
    source
      .replace(
        /\s*\{\/\*(?:(?!\*\/)[\s\S])*?zavi:(?:picker|editor)(?:(?!\*\/)[\s\S])*?\*\/\}/g,
        "",
      )
      .replace(/\s*<script[^>]*zavi-picker\.js[^>]*\/>/g, "")
      .replace(/\s*<script[^>]*zavi-picker\.js[^>]*>\s*<\/script>/g, "")
      .replace(/\s*<script[^>]*zavi-editor-runtime\.js[^>]*\/>/g, "")
      .replace(/\s*<script[^>]*zavi-editor-runtime\.js[^>]*>\s*<\/script>/g, "")
  );
}

const EDITOR_RUNTIME_SNIPPET =
  `        {/* zavi:editor — inline visual editor + "Made with Zavi" badge runtime,\n` +
  `            loaded from Zavi's origin so it reaches this app with no rebuild. Inert\n` +
  `            unless framed by an allowlisted Zavi origin; harmless to a real visitor.\n` +
  `            Auto-injected at build; safe to delete if you don't want it. */}\n` +
  `        <script src="https://www.zaviagent.com/${EDITOR_RUNTIME_SRC}" defer />`;

export function injectEditorRuntimeIntoLayout(source: string): string {
  if (source.includes(EDITOR_RUNTIME_SRC)) return source;
  const idx = source.lastIndexOf("</body>");
  if (idx === -1) return source;
  return source.slice(0, idx) + EDITOR_RUNTIME_SNIPPET + "\n      " + source.slice(idx);
}

export function stripPickerFromExport<T>(
  files: Map<string, T>,
  codec: { decode: (v: T) => string; encode: (s: string) => T },
): Map<string, T> {
  const out = new Map<string, T>();

  for (const [path, content] of files) {
    if (path === PICKER_ASSET_PATH || path.endsWith("/" + PICKER_ASSET_PATH)) {
      continue;
    }

    if (path.endsWith("layout.tsx") || path.endsWith("layout.jsx")) {
      const source = codec.decode(content);
      const cleaned = stripPickerFromLayout(source);
      out.set(path, cleaned === source ? content : codec.encode(cleaned));
      continue;
    }

    out.set(path, content);
  }

  return out;
}

export function hasPickerArtifacts<T>(
  files: Map<string, T>,
  decode: (v: T) => string,
): boolean {
  for (const [path, content] of files) {
    if (path === PICKER_ASSET_PATH || path.endsWith("/" + PICKER_ASSET_PATH)) return true;
    if (path.endsWith("layout.tsx") || path.endsWith("layout.jsx")) {
      const src = decode(content);
      if (src.includes("zavi-picker.js") || src.includes(EDITOR_RUNTIME_SRC)) return true;
    }
  }
  return false;
}
