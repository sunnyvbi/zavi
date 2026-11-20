// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PARENT = "http://localhost:3010";
const PAGE = `<header><button class="signup">Sign up</button></header><main><h1 class="hero">Class timetable</h1></main>`;

type Posted = Record<string, unknown>;
const posted: Posted[] = [];

beforeAll(() => {
  Object.defineProperty(window, "parent", { value: { postMessage: (m: Posted) => posted.push(m) }, configurable: true });
  Object.defineProperty(document, "referrer", { value: PARENT, configurable: true });
  document.body.innerHTML = PAGE;
  (0, eval)(RUNTIME_SRC);
});

beforeEach(() => {
  vi.useFakeTimers();
  send({ type: "zavi:editor-mode", enabled: false });
  posted.length = 0;
  document.body.innerHTML = PAGE;
  send({ type: "zavi:editor-mode", enabled: true, tool: "text" });
});
afterEach(() => {
  vi.useRealTimers();
});

function send(data: Posted) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: PARENT }));
}
function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
}
function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}
function keyup(el: Element) {
  el.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true, cancelable: true }));
}
const q = (s: string) => document.querySelector(s) as HTMLElement;
const edits = () => posted.filter((m) => m.type === "zavi:editor-text-edited");

describe("a draft already reported is taken back when the edit ends without a change", () => {
  it("Escape after a pause reports the original text, so the saved draft is undone", () => {
    const hero = q("h1.hero");
    click(hero);
    hero.textContent = "Summer timetable";
    keyup(hero);
    vi.advanceTimersByTime(500);
    expect(edits().map((m) => m.text)).toEqual(["Summer timetable"]);
    key(hero, "Escape");
    expect(hero.textContent).toBe("Class timetable");
    expect(edits().map((m) => [m.text, m.before])).toEqual([
      ["Summer timetable", "Class timetable"],
      ["Class timetable", "Summer timetable"],
    ]);
    expect(edits()[1]!.selector).toBe(edits()[0]!.selector);
  });

  it("typing back to the original and pressing Enter takes the draft back too", () => {
    click(q("button.signup"));
    const field = document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement;
    field.value = "Join now";
    keyup(field);
    vi.advanceTimersByTime(500);
    field.value = "Sign up";
    key(field, "Enter");
    expect(q("button.signup").textContent).toBe("Sign up");
    expect(edits().map((m) => [m.text, m.before])).toEqual([
      ["Join now", "Sign up"],
      ["Sign up", "Join now"],
    ]);
  });

  it("emptying the text after a pause takes the draft back", () => {
    const hero = q("h1.hero");
    click(hero);
    hero.textContent = "Spring";
    keyup(hero);
    vi.advanceTimersByTime(500);
    hero.textContent = "   ";
    key(hero, "Enter");
    expect(hero.textContent).toBe("Class timetable");
    expect(edits().at(-1)).toMatchObject({ text: "Class timetable", before: "Spring" });
  });

  it("Escape with no draft reported says nothing", () => {
    const hero = q("h1.hero");
    click(hero);
    hero.textContent = "Summer";
    key(hero, "Escape");
    expect(edits()).toHaveLength(0);
  });

  it("a Clear from Zavi ends the edit without reporting anything back", () => {
    const hero = q("h1.hero");
    click(hero);
    hero.textContent = "Summer timetable";
    keyup(hero);
    vi.advanceTimersByTime(500);
    const selector = edits()[0]!.selector as string;
    send({ type: "zavi:editor-text-revert", edits: [{ selector, text: "Class timetable" }] });
    expect(hero.textContent).toBe("Class timetable");
    expect(edits()).toHaveLength(1);
  });
});
