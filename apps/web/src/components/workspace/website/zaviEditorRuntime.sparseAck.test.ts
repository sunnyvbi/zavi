// @vitest-environment jsdom

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PARENT = "http://localhost:3010";

const HERO = ["A quieter way to rent a car. ", "Northline opens the road soon."];
const PAGE = `
  <main>
    <h1 class="hero">${HERO[0]}<br><span class="muted">${HERO[1]}</span></h1>
    <section class="card"><h2>Volvo XC40</h2><p class="price">$68</p><p>260 mi range</p></section>
    <div class="long"><p>${"a".repeat(6000)}</p><p>short tail</p></div>
    <p class="lede">A small fleet.</p>
  </main>`;

type Posted = Record<string, unknown>;
const posted: Posted[] = [];
let ready: Posted | undefined;

beforeAll(() => {
  Object.defineProperty(window, "parent", {
    value: { postMessage: (m: Posted) => posted.push(m) },
    configurable: true,
  });
  Object.defineProperty(document, "referrer", { value: PARENT, configurable: true });
  document.body.innerHTML = PAGE;
  (0, eval)(RUNTIME_SRC);
  ready = posted.find((m) => m.type === "zavi:editor-ready");
});

beforeEach(() => {
  send({ type: "zavi:editor-mode", enabled: false });
  while (history().canUndo) send({ type: "zavi:editor-undo" });
  posted.length = 0;
  document.body.innerHTML = PAGE;
});

function send(data: Posted) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: PARENT }));
}
function history(): { canUndo: boolean } {
  const h = [...posted].reverse().find((m) => m.type === "zavi:editor-history");
  return { canUndo: h?.canUndo === true };
}
function applied(): Posted[] {
  return posted.filter((m) => m.type === "zavi:editor-applied");
}
const q = (s: string) => document.querySelector(s)!;

describe("runtime protocol 4", () => {
  it("announces that it confirms applies and takes sparse runs", () => {
    expect(ready).toMatchObject({ type: "zavi:editor-ready", protocol: 5 });
    send({ type: "zavi:editor-mode", enabled: true });
    q("h1.hero").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.find((m) => m.type === "zavi:editor-selected")).toMatchObject({ protocol: 5, segments: HERO });
  });
});

describe("sparse runs", () => {
  it("a null run is left exactly as the page rendered it, and 'null' is never written", () => {
    q("section.card p.price").textContent = "$72";
    send({
      type: "zavi:editor-apply",
      selector: "section.card",
      patch: { segments: ["Volvo XC40 Recharge", null, "260-mile range"] },
    });
    expect(q("section.card h2").textContent).toBe("Volvo XC40 Recharge");
    expect(q("section.card p.price").textContent).toBe("$72");
    expect(q("section.card").textContent).not.toContain("null");
    expect(q("section.card p:nth-of-type(2)").textContent).toBe("260-mile range");
  });

  it("a patch of only nulls, or with a blank run, changes nothing", () => {
    send({ type: "zavi:editor-apply", selector: "section.card", patch: { segments: [null, null, null] } });
    send({ type: "zavi:editor-apply", selector: "section.card", patch: { segments: ["X", "  ", null] } });
    expect(q("section.card").textContent).toBe("Volvo XC40$68260 mi range");
  });

  it("undo of a sparse rewrite restores every run", () => {
    send({ type: "zavi:editor-apply", selector: "section.card", patch: { segments: [null, null, "Longer range"] } });
    send({ type: "zavi:editor-undo" });
    expect(q("section.card").textContent).toBe("Volvo XC40$68260 mi range");
  });
});

describe("apply acknowledgement", () => {
  it("acks a run patch that landed", () => {
    send({
      type: "zavi:editor-apply",
      selector: "h1.hero",
      patch: { segments: ["Rent a car, quietly. ", "Northline is almost here."] },
      ack: true,
    });
    expect(applied()).toEqual([{ type: "zavi:editor-applied", selector: "h1.hero", ok: true, protocol: 5 }]);
    expect(q("h1.hero span.muted").textContent).toBe("Northline is almost here.");
  });

  it("a run patch whose count no longer matches the page is reported not applied and leaves nothing half-done", () => {
    q("h1.hero").insertAdjacentHTML("beforeend", "<em>New badge</em>");
    send({
      type: "zavi:editor-apply",
      selector: "h1.hero",
      patch: { segments: ["Rent a car, quietly. ", "Northline is almost here."], style: { color: "#0a2540" } },
      ack: true,
    });
    expect(applied()).toEqual([{ type: "zavi:editor-applied", selector: "h1.hero", ok: false, protocol: 5 }]);
    expect((q("h1.hero") as HTMLElement).style.color).toBe("");
    expect(q("h1.hero span.muted").textContent).toBe(HERO[1]);
    expect(history().canUndo).toBe(false);
  });

  it("flat text onto a container is reported not applied", () => {
    send({ type: "zavi:editor-apply", selector: "section.card", patch: { text: "wipe" }, ack: true });
    expect(applied()[0]).toMatchObject({ ok: false });
    expect(q("section.card h2").textContent).toBe("Volvo XC40");
  });

  it("an element that is gone is reported not applied", () => {
    send({ type: "zavi:editor-apply", selector: "#nope", patch: { style: { color: "#111111" } }, ack: true });
    expect(applied()[0]).toMatchObject({ selector: "#nope", ok: false });
  });

  it("a plain apply without ack or reveal posts no ack, as before", () => {
    send({ type: "zavi:editor-apply", selector: "p.lede", patch: { text: "Hi" } });
    expect(applied()).toEqual([]);
    expect(q("p.lede").textContent).toBe("Hi");
  });
});

describe("undo is not bound by the 4000-character report cap", () => {
  it("undo after a rewrite that grew past 4000 characters puts the original runs back", () => {
    const grown = ["x".repeat(2500) + " ", "y".repeat(2000)];
    send({ type: "zavi:editor-apply", selector: "h1.hero", patch: { segments: grown } });
    expect(q("h1.hero").textContent).toBe(grown.join(""));
    send({ type: "zavi:editor-undo" });
    expect(q("h1.hero").textContent).toBe(HERO.join(""));
    send({ type: "zavi:editor-redo" });
    expect(q("h1.hero").textContent).toBe(grown.join(""));
  });

  it("undo restores a run longer than the 5000-character apply cap in full", () => {
    send({ type: "zavi:editor-apply", selector: "div.long", patch: { segments: ["Short.", null] } });
    expect(q("div.long p").textContent).toBe("Short.");
    send({ type: "zavi:editor-undo" });
    expect(q("div.long p").textContent).toBe("a".repeat(6000));
  });
});
