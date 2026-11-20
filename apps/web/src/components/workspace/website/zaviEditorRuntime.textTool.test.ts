// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PARENT = "http://localhost:3010";

const PAGE = `
  <header>
    <nav><a class="nav-link" href="/timetable">Timetable</a><a href="/prices">Prices</a></nav>
    <button class="signup">Sign up</button>
  </header>
  <main>
    <h1 class="hero">Class timetable</h1>
    <p class="sub">Classes run seven days a week.</p>
    <div class="days"><button>Mon</button><button>Sun</button></div>
    <input class="email" value="typed@x.test" />
  </main>`;

type Posted = Record<string, unknown>;
const posted: Posted[] = [];

beforeAll(() => {
  Object.defineProperty(window, "parent", {
    value: { postMessage: (m: Posted) => posted.push(m) },
    configurable: true,
  });
  Object.defineProperty(document, "referrer", { value: PARENT, configurable: true });
  document.body.innerHTML = PAGE;
  (0, eval)(RUNTIME_SRC);
});

beforeEach(() => {
  send({ type: "zavi:editor-mode", enabled: false });
  posted.length = 0;
  document.body.innerHTML = PAGE;
});

function send(data: Posted) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: PARENT }));
}
function textMode(on = true) {
  send(on ? { type: "zavi:editor-mode", enabled: true, tool: "text" } : { type: "zavi:editor-mode", enabled: false });
}
function click(el: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
  el.dispatchEvent(ev);
  return ev;
}
function key(el: Element, k: string, shiftKey = false) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
}
function keyup(el: Element, k = "a") {
  el.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true, cancelable: true }));
}
const q = (s: string) => document.querySelector(s) as HTMLElement;
const edits = () => posted.filter((m) => m.type === "zavi:editor-text-edited");

describe("text tool: click a piece of text and type on it", () => {
  it("makes a plain text element editable in place, and Enter saves and reports it once", () => {
    textMode();
    const h1 = q("h1.hero");
    click(h1);
    expect(h1.getAttribute("contenteditable")).toMatch(/^(plaintext-only|true)$/);
    h1.textContent = "This week at Stillwater";
    key(h1, "Enter");
    expect(h1.hasAttribute("contenteditable")).toBe(false);
    expect(edits()).toEqual([
      { type: "zavi:editor-text-edited", selector: expect.any(String), text: "This week at Stillwater", before: "Class timetable", protocol: 5 },
    ]);
    expect(posted).toContainEqual({ type: "zavi:editor-text-submit", protocol: 5 });
    expect(document.querySelector(edits()[0]!.selector as string)).toBe(h1);
  });

  it("Escape puts the original text back and reports nothing", () => {
    textMode();
    const sub = q("p.sub");
    click(sub);
    sub.textContent = "half typed";
    key(sub, "Escape");
    expect(sub.textContent).toBe("Classes run seven days a week.");
    expect(sub.hasAttribute("contenteditable")).toBe(false);
    expect(edits()).toEqual([]);
  });

  it("an emptied or unchanged text is not saved", () => {
    textMode();
    const h1 = q("h1.hero");
    click(h1);
    h1.textContent = "   ";
    key(h1, "Enter");
    expect(h1.textContent).toBe("Class timetable");
    click(h1);
    key(h1, "Enter");
    expect(edits()).toEqual([]);
  });

  it("the page's own focus ring is off while a label is edited, so only the editor's box shows, and comes back after", () => {
    textMode();
    const link = q("a.nav-link");
    link.style.outline = "2px solid rgb(37, 99, 235)";
    link.style.boxShadow = "0 0 0 2px rgb(37, 99, 235)";
    click(link);
    expect(link.getAttribute("contenteditable")).not.toBeNull();
    expect(link.style.outline).toMatch(/none/);
    expect(link.style.boxShadow).toBe("none");
    key(link, "Escape");
    expect(link.hasAttribute("contenteditable")).toBe(false);
    expect(link.style.outline).toBe("2px solid rgb(37, 99, 235)");
    expect(link.style.boxShadow).toBe("0 0 0 2px rgb(37, 99, 235)");
  });

  it("a button edited through its label field loses its own focus ring while edited, and gets it back after", () => {
    textMode();
    const btn = q("button.signup");
    btn.style.boxShadow = "0 0 0 2px rgb(37, 99, 235)";
    click(btn);
    expect(document.querySelector("input[data-zavi-inline-field]")).toBeTruthy();
    expect(btn.style.boxShadow).toBe("none");
    expect(btn.style.outline).toMatch(/none/);
    key(document.querySelector("input[data-zavi-inline-field]")!, "Escape");
    expect(document.querySelector("input[data-zavi-inline-field]")).toBeNull();
    expect(btn.style.boxShadow).toBe("0 0 0 2px rgb(37, 99, 235)");
  });

  it("clicking a link or button edits its label and never follows it", () => {
    textMode();
    const link = q("a.nav-link");
    const ev = click(link);
    expect(ev.defaultPrevented).toBe(true);
    expect(link.getAttribute("contenteditable")).not.toBeNull();
    link.textContent = "Schedule";
    const signup = q("button.signup");
    expect(click(signup).defaultPrevented).toBe(true);
    expect(edits().map((m) => m.text)).toEqual(["Schedule"]);
    expect(link.hasAttribute("contenteditable")).toBe(false);
    expect(signup.hasAttribute("contenteditable")).toBe(false);
    expect(document.querySelector("input[data-zavi-inline-field]")).toBeTruthy();
  });

  it("pressing Enter on a button label with layout whitespace that was not changed saves nothing", () => {
    textMode();
    const signup = q("button.signup");
    signup.textContent = "\n      Sign   up\n    ";
    const raw = signup.textContent;
    click(signup);
    const field = document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement;
    expect(field.value).toBe("Sign up");
    key(field, "Enter");
    expect(signup.textContent).toBe(raw);
    expect(edits()).toEqual([]);
  });

  it("a button's label is typed into a field laid over it, because a button never takes typing itself", () => {
    textMode();
    const signup = q("button.signup");
    expect(click(signup).defaultPrevented).toBe(true);
    const field = document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement;
    expect(field.value).toBe("Sign up");
    expect(document.activeElement).toBe(field);
    expect(click(field).defaultPrevented).toBe(true);
    expect(document.querySelector("input[data-zavi-inline-field]")).toBe(field);
    field.value = "Join now";
    key(field, "Enter");
    expect(document.querySelector("input[data-zavi-inline-field]")).toBeNull();
    expect(signup.textContent).toBe("Join now");
    expect(edits().map((m) => [m.text, m.before])).toEqual([["Join now", "Sign up"]]);
    click(signup);
    const again = document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement;
    again.value = "Nope";
    key(again, "Escape");
    expect(document.querySelector("input[data-zavi-inline-field]")).toBeNull();
    expect(signup.textContent).toBe("Join now");
    expect(edits()).toHaveLength(1);
    click(signup);
    (document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement).value = "Book a class";
    click(q("h1.hero"));
    expect(signup.textContent).toBe("Book a class");
    expect(edits()).toHaveLength(2);
    expect(q("h1.hero").getAttribute("contenteditable")).not.toBeNull();
  });

  it("a container with child elements and a form field are never made editable", () => {
    textMode();
    for (const target of ["div.days", "nav", "header", "main", "input.email"]) {
      click(q(target));
      expect(document.querySelectorAll("[contenteditable]"), target).toHaveLength(0);
      expect(document.querySelector("input[data-zavi-inline-field]"), target).toBeNull();
    }
    expect(edits()).toEqual([]);
  });

  it("Shift+Enter keeps typing, line breaks are saved as spaces", () => {
    textMode();
    const h1 = q("h1.hero");
    click(h1);
    key(h1, "Enter", true);
    expect(h1.getAttribute("contenteditable")).not.toBeNull();
    h1.textContent = "Class\ntimetable\r\nthis week";
    key(h1, "Enter");
    expect(edits()[0]!.text).toBe("Class timetable this week");
  });

  it("turning the tool off while typing keeps what was typed", () => {
    textMode();
    const sub = q("p.sub");
    click(sub);
    sub.textContent = "Classes run daily.";
    textMode(false);
    expect(edits().map((m) => m.text)).toEqual(["Classes run daily."]);
    expect(sub.hasAttribute("contenteditable")).toBe(false);
    textMode();
    const sun = q("div.days button:nth-of-type(2)");
    click(sun);
    (document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement).value = "sunday";
    textMode(false);
    expect(edits().map((m) => m.text)).toEqual(["Classes run daily.", "sunday"]);
    expect(sun.textContent).toBe("sunday");
    expect(document.querySelector("input[data-zavi-inline-field]")).toBeNull();
  });

  it("a saved text change can be undone", () => {
    textMode();
    const h1 = q("h1.hero");
    click(h1);
    h1.textContent = "New";
    key(h1, "Enter");
    expect(posted.some((m) => m.type === "zavi:editor-history" && m.canUndo === true)).toBe(true);
    send({ type: "zavi:editor-undo" });
    expect(h1.textContent).toBe("Class timetable");
  });

  it("the normal select tool still selects instead of typing", () => {
    send({ type: "zavi:editor-mode", enabled: true });
    const h1 = q("h1.hero");
    click(h1);
    expect(h1.hasAttribute("contenteditable")).toBe(false);
    expect(posted.some((m) => m.type === "zavi:editor-selected")).toBe(true);
  });

  it("a message from a page that is not Zavi cannot switch the tool on", () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "zavi:editor-mode", enabled: true, tool: "text" }, origin: "https://evil.example" }),
    );
    click(q("h1.hero"));
    expect(document.querySelectorAll("[contenteditable]")).toHaveLength(0);
  });
});

describe("text tool: a pause in typing reports the change, and Clear puts the page back in place", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a short pause while still typing reports the text once, and finishing with the same text reports nothing more", () => {
    vi.useFakeTimers();
    textMode();
    const signup = q("button.signup");
    click(signup);
    const field = document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement;
    field.value = "Join";
    keyup(field);
    vi.advanceTimersByTime(200);
    field.value = "Join now";
    keyup(field);
    vi.advanceTimersByTime(300);
    expect(edits()).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(edits().map((m) => [m.text, m.before])).toEqual([["Join now", "Sign up"]]);
    expect(document.querySelector("input[data-zavi-inline-field]")).toBe(field);
    keyup(field);
    vi.advanceTimersByTime(1000);
    expect(edits()).toHaveLength(1);
    key(field, "Enter");
    expect(edits()).toHaveLength(1);
    expect(signup.textContent).toBe("Join now");

    const hero = q("h1.hero");
    click(hero);
    hero.textContent = "Spring timetable";
    keyup(hero);
    vi.advanceTimersByTime(500);
    hero.textContent = "Spring timetable 2027";
    key(hero, "Enter");
    expect(edits().map((m) => m.text)).toEqual(["Join now", "Spring timetable", "Spring timetable 2027"]);
  });

  it("a revert puts the original text back mid-edit and after, ends the edit, reports nothing, and drops the undo steps", () => {
    vi.useFakeTimers();
    textMode();
    const hero = q("h1.hero");
    click(hero);
    hero.textContent = "Summer timetable";
    key(hero, "Enter");
    const signup = q("button.signup");
    click(signup);
    const field = document.querySelector("input[data-zavi-inline-field]") as HTMLInputElement;
    field.value = "Join now";
    keyup(field);
    vi.advanceTimersByTime(500);
    const before = posted.length;
    const selectors = edits().map((m) => m.selector as string);
    expect(selectors).toHaveLength(2);

    send({
      type: "zavi:editor-text-revert",
      edits: [
        { selector: selectors[0], text: "Class timetable" },
        { selector: selectors[1], text: "Sign up" },
      ],
    });

    expect(hero.textContent).toBe("Class timetable");
    expect(signup.textContent).toBe("Sign up");
    expect(document.querySelector("input[data-zavi-inline-field]")).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(edits()).toHaveLength(2);
    expect(posted.slice(before).some((m) => m.type === "zavi:editor-history")).toBe(true);
    for (let i = 0; i < 20; i++) send({ type: "zavi:editor-undo" });
    expect(hero.textContent).toBe("Class timetable");
    expect(signup.textContent).toBe("Sign up");
  });

  it("a revert from a page that is not Zavi changes nothing", () => {
    textMode();
    const hero = q("h1.hero");
    click(hero);
    hero.textContent = "Summer timetable";
    key(hero, "Enter");
    const selector = edits()[0]!.selector as string;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "zavi:editor-text-revert", edits: [{ selector, text: "Hacked" }] },
        origin: "https://evil.test",
      }),
    );
    expect(hero.textContent).toBe("Summer timetable");
  });

  it("the box drawn round a label being edited is dashed only, with no solid ring outside it", () => {
    textMode();
    click(q("button.signup"));
    const boxes = [...document.querySelectorAll<HTMLElement>("div")].filter(
      (d) => d.style.position === "fixed" && d.style.display === "block",
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.style.borderStyle).toBe("dashed");
      expect(box.style.boxShadow).toBe("");
    }
  });
});
