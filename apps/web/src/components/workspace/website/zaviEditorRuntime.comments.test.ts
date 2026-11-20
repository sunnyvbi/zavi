// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEditorCommentPick, parseEditorRects, runtimeSupportsComments } from "./editorProtocol";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PARENT = "http://localhost:3010";
const PAGE = `
  <main>
    <section data-zavi-section="hero"><h1 class="hero">Class timetable</h1><a href="/book">Book now</a></section>
    <p class="sub">Seven days a week.</p>
  </main>`;

type Posted = Record<string, unknown>;
const posted: Posted[] = [];
let ready: Posted | undefined;

beforeAll(() => {
  Object.defineProperty(window, "parent", { value: { postMessage: (m: Posted) => posted.push(m) }, configurable: true });
  Object.defineProperty(document, "referrer", { value: PARENT, configurable: true });
  document.body.innerHTML = PAGE;
  (0, eval)(RUNTIME_SRC);
  ready = posted.find((m) => m.type === "zavi:editor-ready");
});

beforeEach(() => {
  send({ type: "zavi:editor-mode", enabled: false });
  send({ type: "zavi:editor-rects-request", selectors: [] });
  posted.length = 0;
  document.body.innerHTML = PAGE;
});

function send(data: Posted, origin = PARENT) {
  window.dispatchEvent(new MessageEvent("message", { data, origin }));
}
function rectOf(el: Element, r: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect;
}
const q = (s: string) => document.querySelector(s) as HTMLElement;
const of = (type: string) => posted.filter((m) => m.type === type);

describe("comment tool in the page", () => {
  it("announces that it can comment", () => {
    expect(runtimeSupportsComments(ready)).toBe(true);
  });

  it("a click pins the element under the cursor, at the point clicked, and never follows a link", () => {
    send({ type: "zavi:editor-mode", enabled: true, tool: "comment" });
    const link = q("a");
    rectOf(link, { left: 100, top: 40, width: 200, height: 20 });
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 150, clientY: 55 });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const picks = of("zavi:editor-comment-pick");
    expect(picks).toHaveLength(1);
    const parsed = parseEditorCommentPick(picks[0], PARENT, PARENT)!;
    expect(parsed).toMatchObject({ tag: "a", text: "Book now", section: "hero", relX: 0.25, relY: 0.75 });
    expect(document.querySelector(parsed.selector)).toBe(link);
    expect(of("zavi:editor-selected")).toHaveLength(0);
  });

  it("does not pin anything outside comment mode", () => {
    q("h1").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    send({ type: "zavi:editor-mode", enabled: true });
    q("h1").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(of("zavi:editor-comment-pick")).toHaveLength(0);
    expect(of("zavi:editor-selected")).toHaveLength(1);
  });
});

describe("rects for pins", () => {
  it("answers where each asked element is, and says which are gone", () => {
    rectOf(q("h1.hero"), { left: 10, top: 20, width: 300, height: 50 });
    send({ type: "zavi:editor-rects-request", selectors: ["h1.hero", "#removed", "h1.hero"] });
    const reply = parseEditorRects(of("zavi:editor-rects").at(-1), PARENT, PARENT)!;
    expect(reply.rects).toEqual({ "h1.hero": { x: 10, y: 20, w: 300, h: 50 }, "#removed": null });
  });

  it("never runs an unsafe selector the parent did not validate", () => {
    send({ type: "zavi:editor-rects-request", selectors: ["h1'),alert(1)//", "p.sub"] });
    const raw = of("zavi:editor-rects").at(-1) as { rects: Array<{ selector: string }> };
    expect(raw.rects.map((r) => r.selector)).toEqual(["p.sub"]);
  });

  it("ignores a rects request from another origin", () => {
    send({ type: "zavi:editor-rects-request", selectors: ["p.sub"] }, "https://evil.test");
    expect(of("zavi:editor-rects")).toHaveLength(0);
  });

  it("follows scrolling with fresh rects for the watched elements", async () => {
    const h1 = q("h1.hero");
    rectOf(h1, { left: 0, top: 200, width: 100, height: 20 });
    send({ type: "zavi:editor-rects-request", selectors: ["h1.hero"] });
    rectOf(h1, { left: 0, top: 50, width: 100, height: 20 });
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
    const last = parseEditorRects(of("zavi:editor-rects").at(-1), PARENT, PARENT)!;
    expect(last.rects["h1.hero"]).toEqual({ x: 0, y: 50, w: 100, h: 20 });
  });
});
