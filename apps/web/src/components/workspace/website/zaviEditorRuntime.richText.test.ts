// @vitest-environment jsdom

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PARENT = "http://localhost:3010";

const PAGE = `
  <main>
    <h1 class="hero">A quieter way to rent a car. <br><span class="muted">Northline opens the road soon.</span></h1>
    <section class="card"><h2>Volvo XC40</h2><p>260 mi range</p><svg><text>logo</text></svg><script>var x = 1;</script><div><button>Notify me</button></div></section>
    <div class="wordy"><p>${"Long copy. ".repeat(250)}</p><p>${"More copy. ".repeat(150)}</p></div>
    <div class="huge">${Array.from({ length: 41 }, (_, i) => `<p>Line ${i}</p>`).join("")}</div>
    <p class="lede">A small fleet, carefully chosen.</p>
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
function select(selector: string): Posted | undefined {
  send({ type: "zavi:editor-mode", enabled: true });
  posted.length = 0;
  document.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return [...posted].reverse().find((m) => m.type === "zavi:editor-selected");
}
function apply(selector: string, patch: Posted) {
  send({ type: "zavi:editor-apply", selector, patch });
}
const hero = () => document.querySelector("h1.hero")!;

describe("editor runtime: a heading with a styled second line", () => {
  it("reports each text run so Ask AI has words to rewrite", () => {
    const sel = select("h1.hero");
    expect(sel?.textEditable).toBe(false);
    expect(sel?.segments).toEqual(["A quieter way to rent a car. ", "Northline opens the road soon."]);
    expect(sel?.text).toBe("");
  });

  it("rewrites both runs and keeps the <br> and the muted span", () => {
    select("h1.hero");
    apply("h1.hero", { segments: ["Rent a car, quietly. ", "Northline is almost here."] });
    expect(hero().textContent).toBe("Rent a car, quietly. Northline is almost here.");
    expect(hero().querySelector("br")).not.toBeNull();
    expect(hero().querySelector("span.muted")?.textContent).toBe("Northline is almost here.");
  });

  it("undo puts both original runs back, and the toolbar is re-sent the new runs", () => {
    select("h1.hero");
    posted.length = 0;
    apply("h1.hero", { segments: ["Rent a car, quietly. ", "Northline is almost here."] });
    const reemit = posted.find((m) => m.type === "zavi:editor-selected");
    expect(reemit?.segments).toEqual(["Rent a car, quietly. ", "Northline is almost here."]);
    send({ type: "zavi:editor-undo" });
    expect(hero().textContent).toBe("A quieter way to rent a car. Northline opens the road soon.");
    expect(hero().querySelector("span.muted")?.textContent).toBe("Northline opens the road soon.");
    send({ type: "zavi:editor-redo" });
    expect(hero().querySelector("span.muted")?.textContent).toBe("Northline is almost here.");
  });

  it("refuses a patch whose run count does not match the page", () => {
    apply("h1.hero", { segments: ["One line only."] });
    expect(hero().textContent).toBe("A quieter way to rent a car. Northline opens the road soon.");
  });

  it("refuses a patch that would blank a run, so undo can never lose count", () => {
    apply("h1.hero", { segments: ["Rent a car. ", "  "] });
    expect(hero().querySelector("span.muted")?.textContent).toBe("Northline opens the road soon.");
  });

  it("a selected card reports the words of its headings, paragraphs and buttons, not script or svg text", () => {
    const sel = select("section.card");
    expect(sel?.textEditable).toBe(false);
    expect(sel?.segments).toEqual(["Volvo XC40", "260 mi range", "Notify me"]);
    expect(sel?.text).toBe("");
  });

  it("polishing a card rewrites each piece in place and keeps every child element", () => {
    select("section.card");
    apply("section.card", { segments: ["Volvo XC40 Recharge", "260-mile range", "Tell me first"] });
    const card = document.querySelector("section.card")!;
    expect(card.querySelector("h2")?.textContent).toBe("Volvo XC40 Recharge");
    expect(card.querySelector("p")?.textContent).toBe("260-mile range");
    expect(card.querySelector("button")?.textContent).toBe("Tell me first");
    expect(card.querySelector("script")?.textContent).toBe("var x = 1;");
    expect(card.querySelector("svg text")?.textContent).toBe("logo");
    send({ type: "zavi:editor-undo" });
    expect(card.querySelector("h2")?.textContent).toBe("Volvo XC40");
    expect(card.querySelector("button")?.textContent).toBe("Notify me");
  });

  it("a block with more than 4000 characters of text reports no runs, yet applies stored runs exactly as the live site does", () => {
    const sel = select("div.wordy");
    expect(sel?.segments).toBeUndefined();
    apply("div.wordy", { segments: ["Short.", "Shorter."] });
    expect(document.querySelector("div.wordy p")?.textContent).toBe("Short.");
    send({ type: "zavi:editor-undo" });
    expect(document.querySelector("div.wordy p")?.textContent?.startsWith("Long copy.")).toBe(true);
  });

  it("a block with more than 40 pieces of text reports none and cannot be rewritten", () => {
    const sel = select("div.huge");
    expect(sel?.segments).toBeUndefined();
    expect(sel?.text).toBe("");
    apply("div.huge", { segments: Array.from({ length: 41 }, () => "X") });
    expect(document.querySelector("div.huge p")?.textContent).toBe("Line 0");
  });

  it("a plain leaf still reports text and no runs", () => {
    const sel = select("p.lede");
    expect(sel?.textEditable).toBe(true);
    expect(sel?.segments).toBeUndefined();
    expect(sel?.text).toBe("A small fleet, carefully chosen.");
  });
});
