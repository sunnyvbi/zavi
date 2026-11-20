import { describe, expect, it } from "vitest";
import { fieldLabel, readCallFields } from "./callFields";

describe("readCallFields", () => {
  it("reads a handoff whose input was cut off mid-sentence, with real line breaks", () => {
    const raw =
      '{"target_agent_slug":"engineer","intent":"Use this uploaded photo on the landing page.\\n\\nImage URL (workspace-hosted, will';
    expect(readCallFields(raw)).toEqual([
      { key: "target_agent_slug", value: "engineer" },
      {
        key: "intent",
        value: "Use this uploaded photo on the landing page.\n\nImage URL (workspace-hosted, will",
        truncated: true,
      },
    ]);
  });

  it("reads a complete result, drops the ok flag, and keeps numbers and objects", () => {
    const raw = JSON.stringify({ ok: true, routed_to: "refine_product", message: "I've started \"that\" change", n: 3, meta: { a: 1 } });
    expect(readCallFields(raw)).toEqual([
      { key: "routed_to", value: "refine_product" },
      { key: "message", value: "I've started \"that\" change" },
      { key: "n", value: "3" },
      { key: "meta", value: '{"a":1}' },
    ]);
  });

  it("reads a truncated result that ends on an escape or a bare value", () => {
    expect(readCallFields('{"ok": true,"count": 12,"message":"half a \\')).toEqual([
      { key: "count", value: "12" },
      { key: "message", value: "half a ", truncated: true },
    ]);
  });

  it("reads only top-level keys from a truncated result with nested arrays", () => {
    const raw =
      '{"ok":true,"audiences":[{"id":"a","name":"N","member_count":6},{"id":"b","name":"M","member_count":3}],"next":"x';
    const fields = readCallFields(raw)!;
    expect(fields.map((f) => f.key)).toEqual(["next"]);
    expect(fields[0]).toEqual({ key: "next", value: "x", truncated: true });
  });

  it("never emits a nested key or a duplicate key", () => {
    const raw =
      '{"ok":true,"a":[{"id":"1","name":"N"},{"id":"2","name":"M"}],"b":{"id":"3","name":"Q"},"id":"top","name":"T","tail":"cut';
    const keys = readCallFields(raw)!.map((f) => f.key);
    expect(keys).toEqual(["id", "name", "tail"]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(readCallFields(raw)![0]).toEqual({ key: "id", value: "top" });
  });

  it("treats braces and brackets inside string values as text", () => {
    const raw = '{"note":"a } b ] c { d [","list":[{"id":"z"}],"after":"ok"}';
    expect(JSON.parse(raw)).toBeTruthy();
    const broken = raw.slice(0, -1);
    expect(readCallFields(broken)).toEqual([
      { key: "note", value: "a } b ] c { d [" },
      { key: "after", value: "ok" },
    ]);
  });

  it("handles escaped quotes and backslashes inside nested and top-level strings", () => {
    const raw = '{"list":[{"id":"he said \\"}\\" ok","name":"\\\\"}],"msg":"say \\"hi\\" now","last":"cu';
    expect(readCallFields(raw)).toEqual([
      { key: "msg", value: 'say "hi" now' },
      { key: "last", value: "cu", truncated: true },
    ]);
  });

  it("drops everything when truncation lands inside a nested object", () => {
    expect(readCallFields('{"count":2,"items":[{"id":"a","name":"N')).toEqual([{ key: "count", value: "2" }]);
    expect(readCallFields('{"items":{"id":"a","deep":{"x":1')).toBeNull();
  });

  it("gives up on anything that is not an object, so the caller shows it as-is", () => {
    for (const raw of ["plain text", "[1,2]", "{}", '{"ok":true}', ""]) expect(readCallFields(raw)).toBeNull();
  });

  it("labels keys in plain words", () => {
    expect(fieldLabel("target_agent_slug")).toBe("Target agent");
    expect(fieldLabel("routed_to")).toBe("Routed to");
  });
});
