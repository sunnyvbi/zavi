
import { describe, it, expect } from "vitest";
import { computeBuildChips } from "../build-chips";
import { parseChipJson } from "../build-chips-generate";
import { readBuiltAppSuggestionContext } from "../build-suggestion-context";

describe("computeBuildChips", () => {
  it("returns [] for an empty objective", () => {
    expect(computeBuildChips({ objective: "", priorRefines: [] })).toEqual([]);
    expect(computeBuildChips({ objective: null, priorRefines: [] })).toEqual([]);
  });

  it("classifies a marketplace idea and emits marketplace chips", () => {
    const chips = computeBuildChips({
      objective: "A peer-to-peer marketplace to rent camera gear between users.",
      priorRefines: [],
    });
    const keys = chips.map((c) => c.key);
    expect(keys).toContain("mkt-browse");
    expect(keys).toContain("mkt-auth");
    expect(chips.length).toBeLessThanOrEqual(5);
    for (const c of chips) {
      expect(c.key).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(c.prompt.length).toBeGreaterThan(0);
    }
  });

  it("drops a chip once its action shows up in a prior refine", () => {
    const withoutRefine = computeBuildChips({
      objective: "A marketplace for renting tools.",
      priorRefines: [],
    });
    const withAuthRefine = computeBuildChips({
      objective: "A marketplace for renting tools.",
      priorRefines: ["Add sign up and log in for users."],
    });
    expect(withoutRefine.map((c) => c.key)).toContain("mkt-auth");
    expect(withAuthRefine.map((c) => c.key)).not.toContain("mkt-auth");
  });

  it("drops a chip when the action is already in the original idea", () => {
    const chips = computeBuildChips({
      objective: "A marketplace with a browse page and search already planned.",
      priorRefines: [],
    });
    expect(chips.map((c) => c.key)).not.toContain("mkt-browse");
    expect(chips.map((c) => c.key)).not.toContain("mkt-search");
  });

  it("falls back to generic chips for an unclassifiable idea", () => {
    const chips = computeBuildChips({
      objective: "Something wonderful and unique.",
      priorRefines: [],
    });
    expect(chips.map((c) => c.key)).toContain("gen-auth");
  });

  it("treats a landing page as a landing page even when the business rents things", () => {
    for (const objective of [
      "Make a kayak rental landing page for tourists.",
      "A landing page for my equipment hire company.",
      "Build a coming soon page for my car rental business.",
    ]) {
      const keys = computeBuildChips({ objective, priorRefines: [] }).map((c) => c.key);
      expect(keys.some((key) => key.startsWith("land-"))).toBe(true);
      expect(keys).not.toContain("mkt-seller");
    }
  });

  it("keeps a dashboard with a marketing landing page a dashboard", () => {
    const keys = computeBuildChips({
      objective: "Build a SaaS analytics dashboard with a marketing landing page.",
      priorRefines: [],
    }).map((c) => c.key);
    expect(keys.some((key) => key.startsWith("dash-"))).toBe(true);
  });

  it("keeps a store with a coming-soon page a store, so cart and checkout chips survive", () => {
    const chips = computeBuildChips({
      objective: "An online store for candles with a coming soon page before launch.",
      priorRefines: [],
    });
    expect(chips.map((c) => c.key).some((key) => key.startsWith("shop-"))).toBe(true);
    expect(chips.map((c) => c.key).some((key) => key.startsWith("land-"))).toBe(false);
  });

  it("is deterministic — same inputs yield the same keys in the same order", () => {
    const args = { objective: "An online store selling coffee.", priorRefines: [] };
    expect(computeBuildChips(args)).toEqual(computeBuildChips(args));
  });

  it("never returns more than 5 chips", () => {
    const chips = computeBuildChips({
      objective: "A marketplace app.",
      priorRefines: [],
    });
    expect(chips.length).toBeLessThanOrEqual(5);
  });
});

describe("parseChipJson", () => {
  it("parses a clean JSON array into chips with stable keys", () => {
    const chips = parseChipJson(
      '[{"label":"Add Auth Flows","prompt":"Add sign up and log in."},{"label":"Build Cart","prompt":"Add a cart."}]',
    );
    expect(chips.length).toBe(2);
    expect(chips[0].label).toBe("Add Auth Flows");
    expect(chips[0].key).toBe("dyn-add-auth-flows");
    expect(chips[0].prompt.length).toBeGreaterThan(0);
  });

  it("tolerates code fences and surrounding prose", () => {
    const chips = parseChipJson(
      'Here you go:\n```json\n[{"label":"Add Search","prompt":"Add a search bar."}]\n```\nHope that helps!',
    );
    expect(chips.map((c) => c.label)).toEqual(["Add Search"]);
  });

  it("returns [] on non-JSON, empty, or non-array input", () => {
    expect(parseChipJson("")).toEqual([]);
    expect(parseChipJson("sorry, I can't help")).toEqual([]);
    expect(parseChipJson('{"label":"x"}')).toEqual([]);
  });

  it("drops malformed items, dedups by key, and caps at 5", () => {
    const chips = parseChipJson(
      JSON.stringify([
        { label: "Add Auth", prompt: "p1" },
        { label: "Add Auth", prompt: "dup" },
        { label: "No prompt" },
        { prompt: "no label" },
        { label: "A", prompt: "p" },
        { label: "B", prompt: "p" },
        { label: "C", prompt: "p" },
        { label: "D", prompt: "p" },
        { label: "E", prompt: "p" },
      ]),
    );
    expect(chips.length).toBeLessThanOrEqual(5);
    const keys = chips.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("readBuiltAppSuggestionContext", () => {
  it("summarizes current routes and bounded entry-page source", async () => {
    const context = await readBuiltAppSuggestionContext(
      { full_name: "zavi/bike-rental", branch: "main", token: "token" },
      {
        listTree: async () => ({
          truncated: false,
          entries: [
            { path: "src/app/page.tsx", type: "file", size: 100 },
            { path: "src/app/pricing/page.tsx", type: "file", size: 100 },
            { path: "src/lib/private.ts", type: "file", size: 100 },
          ],
        }),
        readFile: async ({ path }) => ({
          path: String(path),
          kind: "text",
          content: path === "src/app/page.tsx" ? "export default function Home(){ return <Fleet /> }" : "export default function Pricing(){ return <Plans /> }",
          size: 100,
        }),
      },
    );
    expect(context).toContain("src/app/page.tsx");
    expect(context).toContain("src/app/pricing/page.tsx");
    expect(context).toContain("<Fleet />");
    expect(context).not.toContain("src/lib/private.ts");
  });

  it("fails soft when the repo cannot be read", async () => {
    const context = await readBuiltAppSuggestionContext(
      { full_name: "zavi/app", branch: "main", token: "token" },
      { listTree: async () => { throw new Error("github down"); } },
    );
    expect(context).toBeNull();
  });
});
