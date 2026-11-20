import { describe, it, expect } from "vitest";
import {
  stripPickerFromLayout,
  stripPickerFromExport,
  hasPickerArtifacts,
  injectEditorRuntimeIntoLayout,
  PICKER_ASSET_PATH,
} from "../picker-asset";
import { TEMPLATE_FILES } from "../templates/nextjs-supabase-tailwind/template-files.generated";

const b64 = {
  decode: (v: string) => Buffer.from(v, "base64").toString("utf8"),
  encode: (s: string) => Buffer.from(s, "utf8").toString("base64"),
};
const enc = (s: string) => b64.encode(s);

const SEEDED_LAYOUT = `import type { Metadata } from "next";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {/* zavi:picker — dev tooling for the Zavi preview. Inert unless framed by
            the Zavi builder, and stripped automatically when you export this repo
            to your own GitHub. Safe to delete if you don't want it. */}
        <script src="/zavi-picker.js" defer />
      </body>
    </html>
  );
}
`;

describe("the seed template ships the picker", () => {
  it("includes the picker asset and references it from the layout", () => {
    expect(Object.keys(TEMPLATE_FILES)).toContain(PICKER_ASSET_PATH);
    expect(TEMPLATE_FILES["app/layout.tsx"]).toContain("/zavi-picker.js");
  });

  it("is inert on a real visit to the customer's site", () => {
    expect(TEMPLATE_FILES[PICKER_ASSET_PATH]).toContain(
      "if (window.parent === window) return;",
    );
  });

  it("never broadcasts the selector — only the data-free handshake uses '*'", () => {
    const asset = TEMPLATE_FILES[PICKER_ASSET_PATH];

    const wildcardPosts = asset.match(/postMessage\([^;]*?,\s*"\*"\s*\)/gs) ?? [];
    expect(wildcardPosts).toHaveLength(1);
    expect(wildcardPosts[0]).toContain("READY");
    expect(wildcardPosts[0]).not.toContain("selector");

    const at = asset.indexOf("type: PICKED");
    expect(at).toBeGreaterThan(-1);
    const pickedPost = asset.slice(at, asset.indexOf(");", at) + 2);
    expect(pickedPost).toContain("parentOrigin");
    expect(pickedPost).not.toContain('"*"');
  });
});

describe("stripPickerFromLayout", () => {
  it("removes the script tag and its comment", () => {
    const out = stripPickerFromLayout(SEEDED_LAYOUT);
    expect(out).not.toContain("zavi-picker.js");
    expect(out).not.toContain("zavi:picker");
    expect(out).toContain("{children}");
    expect(out).toContain("<html lang=\"en\">");
  });

  it("still strips a layout the AI has since rewritten", () => {
    const rewritten = `export default function RootLayout({ children }) {
  return (<html><body><Providers>{children}</Providers><script defer src="/zavi-picker.js"></script></body></html>);
}`;
    const out = stripPickerFromLayout(rewritten);
    expect(out).not.toContain("zavi-picker.js");
    expect(out).toContain("<Providers>{children}</Providers>");
  });

  it("is a no-op on a layout that never had it", () => {
    const plain = "export default function L({children}){return <html><body>{children}</body></html>;}";
    expect(stripPickerFromLayout(plain)).toBe(plain);
  });

  it("also strips the centrally-hosted editor runtime script", () => {
    const out = stripPickerFromLayout(TEMPLATE_FILES["app/layout.tsx"]);
    expect(out).not.toContain("zavi-editor-runtime.js");
    expect(out).not.toContain("zavi:editor");
    expect(out).not.toContain("zavi-picker.js");
    expect(out).toContain("{children}");
  });
});

const AI_LAYOUT = `import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-body" });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-bg">
        <header>Agentmarket</header>
        {children}
      </body>
    </html>
  );
}
`;

describe("injectEditorRuntimeIntoLayout — the badge + inline editor must survive an AI-authored layout", () => {
  it("adds the runtime script when the AI dropped it", () => {
    const out = injectEditorRuntimeIntoLayout(AI_LAYOUT);
    expect(out).toContain("zavi-editor-runtime.js");
    expect(out).toContain("https://www.zaviagent.com/zavi-editor-runtime.js");
    expect(out.indexOf("zavi-editor-runtime.js")).toBeLessThan(out.indexOf("</body>"));
    expect(out).toContain("<header>Agentmarket</header>");
    expect(out).toContain("{children}");
  });

  it("is idempotent — a no-op when the tag is already present", () => {
    const once = injectEditorRuntimeIntoLayout(AI_LAYOUT);
    const twice = injectEditorRuntimeIntoLayout(once);
    expect(twice).toBe(once);
    const seed = TEMPLATE_FILES["app/layout.tsx"];
    expect(injectEditorRuntimeIntoLayout(seed)).toBe(seed);
  });

  it("never guesses — a fragment/nested layout with no </body> is left untouched", () => {
    const nested = "export default function L({children}){return <>{children}</>;}";
    expect(injectEditorRuntimeIntoLayout(nested)).toBe(nested);
  });

  it("what it injects is exactly what the export strip removes (round-trip safe)", () => {
    const injected = injectEditorRuntimeIntoLayout(AI_LAYOUT);
    expect(injected).toContain("zavi-editor-runtime.js");
    const stripped = stripPickerFromLayout(injected);
    expect(stripped).not.toContain("zavi-editor-runtime.js");
    expect(stripped).not.toContain("zavi:editor");
    expect(stripped).toContain("<header>Agentmarket</header>");
  });
});

describe("stripPickerFromExport — we must never ship Zavi tooling in code the user owns", () => {
  it("drops the asset and cleans the layout", () => {
    const files = new Map<string, string>([
      [PICKER_ASSET_PATH, enc("/* picker */")],
      ["app/layout.tsx", enc(SEEDED_LAYOUT)],
      ["app/page.tsx", enc("export default function P(){return <main/>;}")],
    ]);

    const out = stripPickerFromExport(files, b64);

    expect(out.has(PICKER_ASSET_PATH)).toBe(false);
    expect(b64.decode(out.get("app/layout.tsx")!)).not.toContain("zavi-picker.js");
    expect(hasPickerArtifacts(out, b64.decode)).toBe(false);
  });

  it("leaves every other file byte-identical", () => {
    const page = enc("export default function P(){return <main>hi</main>;}");
    const files = new Map<string, string>([
      [PICKER_ASSET_PATH, enc("x")],
      ["app/page.tsx", page],
      ["package.json", enc("{}")],
    ]);

    const out = stripPickerFromExport(files, b64);

    expect(out.get("app/page.tsx")).toBe(page);
    expect(out.get("package.json")).toBe(enc("{}"));
    expect(out.size).toBe(2);
  });

  it("catches a nested asset path too", () => {
    const files = new Map<string, string>([[`apps/web/${PICKER_ASSET_PATH}`, enc("x")]]);
    expect(stripPickerFromExport(files, b64).size).toBe(0);
  });

  it("strips the REAL seeded template end-to-end", () => {
    const files = new Map<string, string>(
      Object.entries(TEMPLATE_FILES).map(([p, c]) => [p, enc(c)]),
    );
    expect(hasPickerArtifacts(files, b64.decode)).toBe(true);

    const out = stripPickerFromExport(files, b64);

    expect(hasPickerArtifacts(out, b64.decode)).toBe(false);
    expect(out.has("app/page.tsx")).toBe(true);
    expect(out.has("package.json")).toBe(true);
  });
});
