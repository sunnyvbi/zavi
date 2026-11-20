
import { describe, it, expect } from "vitest";
import { parseAnchorBlock } from "../generate-anchors";

const wrap = (json: string) => `<anchor>${json}</anchor>`;

describe("parseAnchorBlock", () => {
  it("returns body + key_facts array when both present and valid", () => {
    const out = parseAnchorBlock(
      wrap(
        JSON.stringify({
          body_markdown: "# Company\n\nWe rent cars peer to peer.",
          key_facts: [
            { label: "Industry", value: "P2P car rental" },
            { label: "Stage", value: "Live · 600 hosts" },
          ],
        }),
      ),
    );
    expect(out).not.toBeNull();
    expect(out!.body_markdown).toContain("We rent cars peer to peer.");
    expect(out!.key_facts).toEqual([
      { label: "Industry", value: "P2P car rental" },
      { label: "Stage", value: "Live · 600 hosts" },
    ]);
  });

  it("treats missing key_facts field as undefined (retry-able), not as []", () => {
    const out = parseAnchorBlock(
      wrap(
        JSON.stringify({
          body_markdown: "# Company\n\nWe rent cars peer to peer.",
        }),
      ),
    );
    expect(out).not.toBeNull();
    expect(out!.key_facts).toBeUndefined();
  });

  it("returns key_facts: [] when explicitly empty array (final-answer sentinel)", () => {
    const out = parseAnchorBlock(
      wrap(
        JSON.stringify({
          body_markdown: "# Company\n\nWe rent cars peer to peer.",
          key_facts: [],
        }),
      ),
    );
    expect(out).not.toBeNull();
    expect(out!.key_facts).toEqual([]);
  });

  it("returns key_facts: undefined when field present but malformed", () => {
    const out = parseAnchorBlock(
      wrap(
        JSON.stringify({
          body_markdown: "# Company\n\nWe rent cars peer to peer.",
          key_facts: "P2P car rental",
        }),
      ),
    );
    expect(out).not.toBeNull();
    expect(out!.key_facts).toBeUndefined();
  });

  it("returns key_facts: undefined when array contains non-{label,value} entries", () => {
    const out = parseAnchorBlock(
      wrap(
        JSON.stringify({
          body_markdown: "# Company\n\nWe rent cars peer to peer.",
          key_facts: [
            { label: "Industry", value: "P2P car rental" },
            { somethingElse: true },
          ],
        }),
      ),
    );
    expect(out).not.toBeNull();
    expect(out!.key_facts).toBeUndefined();
  });

  it("preserves oversized label/value as-is (clamping happens at render)", () => {
    const longLabel = "This-Label-Is-Way-Too-Long-For-A-Chip";
    const longValue = "This-value-blows-the-thirty-character-cap-by-a-lot";
    const out = parseAnchorBlock(
      wrap(
        JSON.stringify({
          body_markdown: "# Company\n\nWe rent cars peer to peer.",
          key_facts: [{ label: longLabel, value: longValue }],
        }),
      ),
    );
    expect(out).not.toBeNull();
    expect(out!.key_facts).toEqual([{ label: longLabel, value: longValue }]);
  });

  it("returns null when JSON inside the anchor envelope is malformed", () => {
    const out = parseAnchorBlock("<anchor>{not valid json</anchor>");
    expect(out).toBeNull();
  });

  it("returns null when body_markdown is missing or empty", () => {
    const missing = parseAnchorBlock(wrap(JSON.stringify({ key_facts: [] })));
    const empty = parseAnchorBlock(
      wrap(JSON.stringify({ body_markdown: "  ", key_facts: [] })),
    );
    expect(missing).toBeNull();
    expect(empty).toBeNull();
  });

  it("returns null when no <anchor> envelope at all", () => {
    const out = parseAnchorBlock("{ \"body_markdown\": \"hi\" }");
    expect(out).toBeNull();
  });
});
