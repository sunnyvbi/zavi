// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");

describe("published overlay on the live app", () => {
  it("applies published rewrites to a two-tone heading and a card, and skips a mismatched one", async () => {
    document.body.innerHTML =
      '<h1 class="hero">A quieter way to rent a car. <br><span class="muted">Northline opens the road soon.</span></h1>' +
      '<section class="card"><h2>Volvo XC40</h2><p>260 mi range</p><script>var x = 1;</script></section>' +
      "<footer><p>Northline</p><p>2026</p></footer>";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        badge_hidden: true,
        edits: [
          { selector: "h1.hero", patch: { segments: ["Rent a car, quietly. ", "Northline is almost here."] } },
          { selector: "section.card", patch: { segments: ["Volvo XC40 Recharge", "260-mile range"] } },
          { selector: "footer", patch: { segments: ["Only one"] } },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    (0, eval)(RUNTIME_SRC);
    await vi.waitFor(() => {
      expect(document.querySelector("h1.hero span.muted")?.textContent).toBe("Northline is almost here.");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector("h1.hero")?.textContent).toBe("Rent a car, quietly. Northline is almost here.");
    expect(document.querySelector("h1.hero br")).not.toBeNull();
    expect(document.querySelector("section.card h2")?.textContent).toBe("Volvo XC40 Recharge");
    expect(document.querySelector("section.card p")?.textContent).toBe("260-mile range");
    expect(document.querySelector("section.card script")?.textContent).toBe("var x = 1;");
    expect(document.querySelector("footer")?.textContent).toBe("Northline2026");
    vi.unstubAllGlobals();
  });
});
