// @vitest-environment jsdom

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PRE_SPARSE_COMMIT = "26faf79e2c55fc06ad0bf37abead3380079805bc";
const PRE_SPARSE_RUNTIME = execFileSync(
  "git",
  ["show", `${PRE_SPARSE_COMMIT}:apps/web/public/zavi-editor-runtime.js`],
  { encoding: "utf8" },
);

const card = (price: string) =>
  `<section class="card"><h2>Volvo XC40</h2><p class="price">${price}</p><p class="tail">per day, insured</p></section>` +
  `<h1 class="hero">Short. <span>Long line.</span></h1>`;

function publish(edits: unknown[]) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ badge_hidden: true, edits }) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("published overlay with sparse runs", () => {
  it("rewrites the runs the operator changed and leaves a DB-driven price live after publish", async () => {
    document.body.innerHTML = card("$81");
    publish([{ selector: "section.card", patch: { segments: ["Volvo XC40 Recharge", null, "per day, fully insured"] } }]);
    (0, eval)(RUNTIME_SRC);
    await vi.waitFor(() => expect(document.querySelector("section.card h2")?.textContent).toBe("Volvo XC40 Recharge"));
    expect(document.querySelector("p.price")?.textContent).toBe("$81");
    expect(document.querySelector("p.tail")?.textContent).toBe("per day, fully insured");
    expect(document.body.textContent).not.toContain("null");
  });

  it("refuses all-null, blank, or over-40 run patches without touching the page", async () => {
    document.body.innerHTML = card("$68");
    publish([
      { selector: "section.card", patch: { segments: [null, null, null] } },
      { selector: "h1.hero", patch: { segments: ["  ", null] } },
      { selector: "section.card", patch: { segments: Array(41).fill("x") } },
      { selector: "h1.hero", patch: { style: { color: "#0a2540" } } },
    ]);
    (0, eval)(RUNTIME_SRC);
    await vi.waitFor(() => expect((document.querySelector("h1.hero") as HTMLElement).style.color).toBe("rgb(10, 37, 64)"));
    expect(document.querySelector("section.card")?.textContent).toBe("Volvo XC40$68per day, insured");
    expect(document.querySelector("h1.hero")?.textContent).toBe("Short. Long line.");
  });

  it("a runtime from before sparse runs neither crashes nor writes 'null' when it reads a sparse draft, and still applies the rest", async () => {
    expect(PRE_SPARSE_RUNTIME).not.toContain("segments[j] === null");
    document.body.innerHTML = card("$68");
    publish([
      { selector: "section.card", patch: { segments: ["Volvo XC40 Recharge", null, "per day, fully insured"] } },
      { selector: "h1.hero", patch: { style: { color: "#0a2540" } } },
    ]);
    expect(() => (0, eval)(PRE_SPARSE_RUNTIME)).not.toThrow();
    await vi.waitFor(() => expect((document.querySelector("h1.hero") as HTMLElement).style.color).toBe("rgb(10, 37, 64)"));
    expect(document.querySelector("section.card")?.textContent).toBe("Volvo XC40$68per day, insured");
    expect(document.body.textContent).not.toContain("null");
  });
});
