import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");

const PAGE = `<!doctype html><html><body><h1 class="hero">Hi</h1><input id="q" /><div id="ed" contenteditable="true">x</div></body></html>`;

type Posted = Record<string, unknown>;

function frameApp() {
  const dom = new JSDOM(PAGE, {
    url: "https://shop-abc.zaviagent.com/",
    referrer: "https://www.zaviagent.com/",
    runScripts: "outside-only",
  });
  const win = dom.window;
  const posted: Posted[] = [];
  Object.defineProperty(win, "parent", { value: { postMessage: (m: Posted) => posted.push(m) }, configurable: true });
  win.eval(RUNTIME_SRC);
  if (win.document.readyState === "loading") win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  const keys = async () => {
    await new Promise((r) => win.setTimeout(r, 5));
    return posted.filter((m) => m.type === "zavi:editor-key");
  };
  const press = (target: Element | Document, init: KeyboardEventInit) => {
    const event = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return { win, keys, press };
}

describe("zavi editor runtime: preview-tools shortcut keys", () => {
  it("passes the toolbar's letter keys up to the Zavi window", async () => {
    const { win, keys, press } = frameApp();
    for (const key of ["e", "T", "a", "c"]) press(win.document.body, { key });
    expect((await keys()).map((m) => m.key)).toEqual(["e", "t", "a", "c"]);
    expect((await keys())[0]).toEqual({ type: "zavi:editor-key", key: "e", metaKey: false, ctrlKey: false });
  });

  it("passes ⌘. / Ctrl+. up without blocking the app's own use of it", async () => {
    const { win, keys, press } = frameApp();
    const event = press(win.document.body, { key: ".", metaKey: true });
    press(win.document.body, { key: ".", ctrlKey: true });
    expect((await keys()).map((m) => [m.key, m.metaKey, m.ctrlKey])).toEqual([
      [".", true, false],
      [".", false, true],
    ]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("never forwards what the person types, other keys, modified letters or repeats", async () => {
    const { win, keys, press } = frameApp();
    press(win.document.getElementById("q")!, { key: "e" });
    press(win.document.getElementById("ed")!, { key: "a" });
    press(win.document.body, { key: "x" });
    press(win.document.body, { key: "e", metaKey: true });
    press(win.document.body, { key: "c", ctrlKey: true });
    press(win.document.body, { key: "E", shiftKey: true });
    press(win.document.body, { key: "e", altKey: true });
    press(win.document.body, { key: "e", repeat: true });
    press(win.document.body, { key: "." });
    expect(await keys()).toEqual([]);
  });

  it("passes Escape up so a preview mode can be left from inside the app", async () => {
    const { win, keys, press } = frameApp();
    press(win.document.body, { key: "Escape" });
    press(win.document.body, { key: "Escape", metaKey: true });
    expect(await keys()).toEqual([{ type: "zavi:editor-key", key: "Escape", metaKey: false, ctrlKey: false }]);
  });

  it("leaves a key the app handles to the app, even a listener added after the runtime", async () => {
    const { win, keys, press } = frameApp();
    win.document.body.addEventListener("keydown", (e) => e.preventDefault());
    press(win.document.body, { key: "e" });
    win.addEventListener("keydown", (e) => {
      if (e.key === ".") e.preventDefault();
    });
    press(win.document.body, { key: ".", ctrlKey: true });
    expect(await keys()).toEqual([]);
  });
});
