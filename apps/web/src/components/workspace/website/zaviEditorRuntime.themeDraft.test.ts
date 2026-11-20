import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PARENT = "http://localhost:3010";
const SAVED_CSS = ":root { --primary: 37 99 235; --background: 255 255 255; --radius: 0.5rem; --font-display: \"Inter\", sans-serif; }";

function frame() {
  const dom = new JSDOM(
    `<!doctype html><html><head><style id="theme">${SAVED_CSS}</style></head><body><h1 class="hero">Hi</h1></body></html>`,
    { url: "https://5173-sbx.e2b.app/", referrer: PARENT + "/", runScripts: "outside-only" },
  );
  const win = dom.window;
  const posted: Array<Record<string, unknown>> = [];
  Object.defineProperty(win, "parent", { value: { postMessage: (m: Record<string, unknown>) => posted.push(m) }, configurable: true });
  win.eval(RUNTIME_SRC);
  if (win.document.readyState === "loading") win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  const send = (data: unknown, origin = PARENT) => win.dispatchEvent(new win.MessageEvent("message", { data, origin }));
  const doc = win.document;
  const draft = () => doc.getElementById("zavi-theme-draft");
  const fonts = () => doc.getElementById("zavi-theme-draft-fonts");
  const rootVar = (name: string) => win.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
  return { send, doc, draft, fonts, rootVar, posted };
}

describe("zavi editor runtime: live theme draft", () => {
  it("announces protocol 5", () => {
    const f = frame();
    expect(f.posted.find((m) => m.type === "zavi:editor-ready")).toMatchObject({ protocol: 5 });
  });

  it("restyles the page with the draft over the saved theme, replaces it in place on the next drag step, and removes it on discard", () => {
    const f = frame();
    expect(f.rootVar("--primary")).toBe("37 99 235");
    f.send({
      type: "zavi:editor-theme-draft",
      theme: { colors: { primary: "#ff0000", background: "#101010", foreground: "#fafafa", accent: "#00ff00" }, fonts: { display: "Fraunces", body: "Plus Jakarta Sans" }, radius: "1rem" },
    });
    expect(f.rootVar("--primary")).toBe("255 0 0");
    expect(f.rootVar("--ring")).toBe("255 0 0");
    expect(f.rootVar("--background")).toBe("16 16 16");
    expect(f.rootVar("--card")).toBe("16 16 16");
    expect(f.rootVar("--foreground")).toBe("250 250 250");
    expect(f.rootVar("--accent")).toBe("0 255 0");
    expect(f.rootVar("--accent-foreground")).toBe("11 13 18");
    expect(f.rootVar("--radius")).toBe("1rem");
    expect(f.rootVar("--font-display")).toMatch(/^"Fraunces",/);
    expect(f.rootVar("--font-body")).toMatch(/^"Plus Jakarta Sans",/);
    expect(f.fonts()?.getAttribute("href")).toBe("https://fonts.googleapis.com/css2?family=Fraunces&family=Plus+Jakarta+Sans&display=swap");
    expect(f.doc.head.lastElementChild).toBe(f.draft());

    f.send({ type: "zavi:editor-theme-draft", theme: { colors: { primary: "#0000ff" } } });
    expect(f.doc.querySelectorAll("#zavi-theme-draft")).toHaveLength(1);
    expect(f.rootVar("--primary")).toBe("0 0 255");
    expect(f.rootVar("--primary-foreground")).toBe("255 255 255");
    expect(f.rootVar("--background")).toBe("255 255 255");
    expect(f.rootVar("--radius")).toBe("0.5rem");
    expect(f.fonts()).toBeNull();

    f.send({ type: "zavi:editor-theme-draft", theme: null });
    expect(f.draft()).toBeNull();
    expect(f.fonts()).toBeNull();
    expect(f.rootVar("--primary")).toBe("37 99 235");
    expect(f.doc.getElementById("theme")).not.toBeNull();
  });

  it("ignores a draft from a foreign origin", () => {
    const f = frame();
    f.send({ type: "zavi:editor-theme-draft", theme: { colors: { primary: "#ff0000" } } }, "https://evil.example");
    expect(f.draft()).toBeNull();
    expect(f.rootVar("--primary")).toBe("37 99 235");
    f.send({ type: "zavi:editor-theme-draft", theme: { colors: { primary: "#ff0000" } } });
    f.send({ type: "zavi:editor-theme-draft", theme: null }, "https://evil.example");
    expect(f.rootVar("--primary")).toBe("255 0 0");
  });

  it("drops values that could break out of the declaration", () => {
    const f = frame();
    f.send({
      type: "zavi:editor-theme-draft",
      theme: {
        colors: { primary: "red;} body{display:none} :root{--x:1", background: "#fff", foreground: "url(https://evil.example/x)" },
        fonts: { display: 'Inter"; } body { display: none } :root { --y: "', body: "Lato" },
        radius: "1rem; } body { display: none",
      },
    });
    const css = f.draft()?.textContent ?? "";
    expect(css).not.toMatch(/display|evil|url\(|--x|--y/);
    expect(css).toContain('--font-body: "Lato"');
    expect(f.rootVar("--primary")).toBe("37 99 235");
    expect(f.rootVar("--radius")).toBe("0.5rem");
    expect(f.fonts()?.getAttribute("href")).toBe("https://fonts.googleapis.com/css2?family=Lato&display=swap");

    f.send({ type: "zavi:editor-theme-draft", theme: { colors: { primary: "javascript:alert(1)" } } });
    expect(f.draft()).toBeNull();
  });
});
