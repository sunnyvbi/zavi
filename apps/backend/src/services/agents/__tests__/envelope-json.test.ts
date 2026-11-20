import { describe, it, expect } from "vitest";
import { repairEnvelopeJson, tryParseEnvelopePayload } from "../envelope-json";

describe("repairEnvelopeJson — trailing commas (dtc-021 regression)", () => {
  it("strips a trailing comma before ]", () => {
    expect(JSON.parse(repairEnvelopeJson('["a","b",]'))).toEqual(["a", "b"]);
  });

  it("strips a trailing comma before } (with whitespace/newline)", () => {
    expect(JSON.parse(repairEnvelopeJson('{"a":1,\n  }'))).toEqual({ a: 1 });
  });

  it("rescues the exact dtc-021 nested-array shape", () => {
    const broken = '{"rows":[["4.6 stars on biossance.com",],["Squalane"]]}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(JSON.parse(repairEnvelopeJson(broken))).toEqual({
      rows: [["4.6 stars on biossance.com"], ["Squalane"]],
    });
  });

  it("does NOT remove a comma that is part of string content", () => {
    const payload = '{"note":"items: a, b, and c","n":2}';
    expect(JSON.parse(repairEnvelopeJson(payload))).toEqual({ note: "items: a, b, and c", n: 2 });
  });

  it("leaves valid JSON byte-identical (no false positives)", () => {
    const valid = '{"a":[1,2,3],"b":{"c":4}}';
    expect(repairEnvelopeJson(valid)).toBe(valid);
  });

  it("tryParseEnvelopePayload returns kind=repaired for a trailing comma", () => {
    const r = tryParseEnvelopePayload('{"x":[1,2,],"rendered_markdown":"hi"}', { envelope_name: "test" });
    expect(r.kind).toBe("repaired");
    if (r.kind === "repaired") expect(r.value).toEqual({ x: [1, 2], rendered_markdown: "hi" });
  });
});

describe("repairEnvelopeJson — stray quotes in values", () => {
  it("rescues an unescaped quoted phrase followed by a colon inside a value", () => {
    const broken =
      '{"rendered_markdown": "Seed "hindi tutor for kids ": 8 suggestions", "steps": [{"title": "T"}]}';
    expect(() => JSON.parse(broken)).toThrow();
    const parsed = JSON.parse(repairEnvelopeJson(broken));
    expect(parsed.rendered_markdown).toBe('Seed "hindi tutor for kids ": 8 suggestions');
    expect(parsed.steps).toEqual([{ title: "T" }]);
  });

  it("rescues a quoted phrase followed by a comma that is still prose", () => {
    const broken =
      '{"deliverable": {"kind": "post", "content": "They said "no thanks", then booked anyway."}, "n": 1}';
    const parsed = JSON.parse(repairEnvelopeJson(broken));
    expect(parsed.deliverable.content).toBe('They said "no thanks", then booked anyway.');
    expect(parsed.n).toBe(1);
  });

  it("still closes keys at the colon and values at the comma", () => {
    const broken = '{"a": "x "y" z", "b": ["p "q" r", "s"]}';
    expect(JSON.parse(repairEnvelopeJson(broken))).toEqual({ a: 'x "y" z', b: ['p "q" r', "s"] });
  });

  it("leaves valid JSON with escaped quotes and colons byte-identical", () => {
    const valid = JSON.stringify({ a: 'Seed "x": y', b: [{ c: "d, e" }], f: "g:h" });
    expect(repairEnvelopeJson(valid)).toBe(valid);
  });
});

describe("repairEnvelopeJson — missing separators", () => {
  it("inserts a missing comma between two objects in an array", () => {
    const broken = '{"steps": [{"title": "A"}\n  {"title": "B"}], "rendered_markdown": "x"}';
    expect(JSON.parse(repairEnvelopeJson(broken)).steps).toEqual([{ title: "A" }, { title: "B" }]);
  });

  it("inserts a missing comma between two strings in an array", () => {
    const broken = '{"evidence": ["one"\n "two"]}';
    expect(JSON.parse(repairEnvelopeJson(broken)).evidence).toEqual(["one", "two"]);
  });

  it("inserts a missing comma between two object members", () => {
    const broken = '{"a": "x"\n "b": ["y"]\n "c": {"d": 1}}';
    expect(JSON.parse(repairEnvelopeJson(broken))).toEqual({ a: "x", b: ["y"], c: { d: 1 } });
  });

  it("leaves valid nested JSON byte-identical", () => {
    const valid = JSON.stringify({ steps: [{ t: "a", e: ["x", "y"] }, { t: "b" }], m: "q" }, null, 2);
    expect(repairEnvelopeJson(valid)).toBe(valid);
  });
});

describe("repairEnvelopeJson — missing separator after a number or literal", () => {
  it("inserts the comma between a number and the next value", () => {
    expect(JSON.parse(repairEnvelopeJson('{"e": [30 "days"]}')).e).toEqual([30, "days"]);
    expect(JSON.parse(repairEnvelopeJson('{"a": 1 "b": 2}'))).toEqual({ a: 1, b: 2 });
  });

  it("inserts the comma after true/false/null", () => {
    expect(JSON.parse(repairEnvelopeJson('{"e": [true "x", false "y", null "z"]}')).e).toEqual([
      true, "x", false, "y", null, "z",
    ]);
  });

  it("leaves valid JSON with numbers and literals byte-identical", () => {
    const valid = JSON.stringify({ a: [1, 2.5, -3e4], b: true, c: null, d: "1 x", e: { f: 9 } });
    expect(repairEnvelopeJson(valid)).toBe(valid);
  });
});

describe("tryParseEnvelopePayload — one closing brace too many", () => {
  const env = { envelope_name: "digest" };

  it("recovers the envelope, steps and all", () => {
    const good = JSON.stringify({ rendered_markdown: "hi", steps: [{ label: "a" }] });
    const r = tryParseEnvelopePayload(good + "}", env);
    expect(r.kind).toBe("repaired");
    expect(r.kind !== "failed" && (r.value as { steps: unknown[] }).steps).toHaveLength(1);
  });

  it("recovers a stray bracket and stray closers with trailing whitespace", () => {
    const good = JSON.stringify({ rendered_markdown: "hi", steps: [] });
    expect(tryParseEnvelopePayload(good + "]", env).kind).toBe("repaired");
    expect(tryParseEnvelopePayload(good + "\n}} \n", env).kind).toBe("repaired");
  });

  it("recovers a payload followed by a stray tool-call closing tag (engineer pr_proposal, 2026-10-09)", () => {
    const good = JSON.stringify({ repo: "o/r", head_branch: "engineer/x", rendered_markdown: "hi", typecheck_ok: true });
    const r = tryParseEnvelopePayload(good + "</parameter>\n", env);
    expect(r.kind).toBe("repaired");
    expect(r.kind !== "failed" && (r.value as { head_branch: string }).head_branch).toBe("engineer/x");
    expect(tryParseEnvelopePayload(good + "}\n</parameter>\n</invoke>", env).kind).toBe("repaired");
  });

  it("does NOT drop a tail with an opening tag or text, even next to a closing tag", () => {
    const good = JSON.stringify({ rendered_markdown: "hi", steps: [] });
    expect(tryParseEnvelopePayload(good + "</parameter><parameter>x", env).kind).not.toBe("repaired");
    expect(tryParseEnvelopePayload(good + "</p> more words", env).kind).not.toBe("repaired");
  });

  it("does NOT drop a closing tag that may close markup opened inside a string value", () => {
    const opened = JSON.stringify({ rendered_markdown: "draft", evidence: { text: "<claim>proof" } });
    expect(tryParseEnvelopePayload(opened + "</claim>", env).kind).not.toBe("repaired");
    expect(tryParseEnvelopePayload(JSON.stringify({ rendered_markdown: "hi" }) + "</div>", env).kind).not.toBe("repaired");
  });

  it("does NOT silently drop a tail that carries content", () => {
    const good = JSON.stringify({ rendered_markdown: "hi", steps: [] });
    const r = tryParseEnvelopePayload(good + good, env);
    expect(r.kind).not.toBe("repaired");
  });

  it("leaves a clean payload on the strict path", () => {
    const good = JSON.stringify({ rendered_markdown: "hi", steps: [] });
    expect(tryParseEnvelopePayload(good, env).kind).toBe("strict");
  });
});

describe("tryParseEnvelopePayload — one broken spot costs that spot, not every item (2026-09-17)", () => {
  const env = { envelope_name: "digest" };
  const step = (n: number) =>
    JSON.stringify({ title: `Step ${n}`, body: `Do thing ${n}.`, evidence: [`https://example.com/${n}`] });

  it("a full-width comma and extra braces between items keeps every well-formed item", () => {
    const payload =
      `{"rendered_markdown":"report","steps":[${step(1)},${step(2)}}}，${step(3)},${step(4)}]}`;
    const r = tryParseEnvelopePayload(payload, env);
    expect(r.kind).toBe("items_salvaged");
    const v = (r as { value: { rendered_markdown: string; steps: Array<{ title: string }> } }).value;
    expect(v.rendered_markdown).toBe("report");
    expect(v.steps.map((s) => s.title)).toEqual(["Step 1", "Step 2", "Step 3", "Step 4"]);
  });

  it("an item's own nested objects are not lifted out as sibling items", () => {
    const nested = JSON.stringify({
      title: "Step N",
      body: "b",
      evidence: ["e"],
      deliverable: { kind: "comment", label: "l", content: "c" },
      rows: [{ cells: ["a"] }],
    });
    const payload = `{"rendered_markdown":"r","steps":[${nested}，${step(2)}]}`;
    const r = tryParseEnvelopePayload(payload, env);
    const v = (r as { value: { steps: Array<{ title: string }> } }).value;
    expect(v.steps.map((s) => s.title)).toEqual(["Step N", "Step 2"]);
  });

  it("an item that is itself unparseable is dropped and the rest survive", () => {
    const payload = `{"rendered_markdown":"r","steps":[${step(1)},{"title": },${step(3)}]}`;
    const r = tryParseEnvelopePayload(payload, env);
    expect(r.kind).toBe("items_salvaged");
    const v = (r as { value: { steps: Array<{ title: string }> } }).value;
    expect(v.steps.map((s) => s.title)).toEqual(["Step 1", "Step 3"]);
  });

  it("no salvageable item still degrades to the plain markdown fallback", () => {
    const r = tryParseEnvelopePayload(`{"rendered_markdown":"only prose","steps":[{"title": oops}`, env);
    expect(r.kind).toBe("markdown_fallback");
  });
});

describe("tryParseEnvelopePayload — a string closed with an escaped quote does not swallow the next item", () => {
  const env = { envelope_name: "digest" };
  const item = (n: number, content: string) =>
    `{"title":"Step ${n}","body":"b","evidence":["e"],"deliverable":{"kind":"comment","label":"l","content":"${content}"}}`;

  it("the next step stays its own step, not text inside the previous one", () => {
    const broken = `{"title":"Step 2","body":"b","evidence":["e"],"deliverable":{"kind":"comment","label":"l","content":"reply ends \\"}}`;
    const payload = `{"rendered_markdown":"r","steps":[${item(1, "one")},${broken},${item(3, "three")}]}`;
    const r = tryParseEnvelopePayload(payload, env);
    expect(r.kind).not.toBe("failed");
    const steps = (r as { value: { steps: Array<{ title: string; deliverable: { content: string } }> } }).value.steps;
    expect(steps.map((s) => s.title)).toEqual(["Step 1", "Step 2", "Step 3"]);
    expect(steps[1].deliverable.content).not.toContain('"title"');
  });

  it("items from a later array do not bleed into an earlier one", () => {
    const payload = `{"rendered_markdown":"r","notes":[{"what":"a","why":"b"}],"steps":[${item(1, "x")}，${item(2, "y")}]}`;
    const r = tryParseEnvelopePayload(payload, env);
    const v = (r as { value: { notes: unknown[]; steps: unknown[] } }).value;
    expect(v.notes).toHaveLength(1);
    expect(v.steps).toHaveLength(2);
  });

  it("a valid string that legitimately ends in an escaped quote is untouched", () => {
    const ok = `{"rendered_markdown":"r","steps":[${item(1, 'he said \\"hi\\"')}]}`;
    const r = tryParseEnvelopePayload(ok, env);
    expect(r.kind).toBe("strict");
  });
});
