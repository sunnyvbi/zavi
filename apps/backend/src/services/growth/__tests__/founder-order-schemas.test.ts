
import { describe, expect, it } from "vitest";
import * as google from "@/services/tools/google-ads/write/_decision-bodies";
import * as meta from "@/services/tools/meta-ads/write/_decision-bodies";

type Def = { type: string; shape?: Record<string, unknown>; catchall?: { _zod: { def: Def } }; options?: unknown[]; in?: unknown; innerType?: unknown };
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;

function topObjects(s: unknown): Array<{ shape: Record<string, unknown>; strict: boolean }> {
  const d = defOf(s);
  if (d.type === "object") return [{ shape: d.shape ?? {}, strict: d.catchall ? defOf(d.catchall).type === "never" : false }];
  if (d.type === "union") return (d.options ?? []).flatMap(topObjects);
  if (d.type === "pipe") return topObjects(d.in);
  if (d.type === "optional" || d.type === "default" || d.type === "nullable") return topObjects(d.innerType);
  throw new Error(`unhandled top-level zod type ${d.type}`);
}

const schemas = [
  ...Object.entries(google).map(([k, v]) => [`google.${k}`, v] as const),
  ...Object.entries(meta).map(([k, v]) => [`meta.${k}`, v] as const),
].filter(([k]) => k.endsWith("BodySchema"));

describe("founder-order stamps fit every Meta and Google card body", () => {
  it("found the body schemas to check", () => {
    expect(schemas.length).toBeGreaterThanOrEqual(25);
  });

  for (const [name, schema] of schemas) {
    it(`${name} accepts origin user_initiated_chat and the cut guard note`, () => {
      const objects = topObjects(schema);
      expect(objects.length).toBeGreaterThan(0);
      for (const o of objects) {
        const origin = o.shape.origin as { safeParse: (v: unknown) => { success: boolean } } | undefined;
        if (origin) expect(origin.safeParse("user_initiated_chat").success).toBe(true);
        if (o.strict) {
          expect(origin, "strict body schema without origin").toBeDefined();
          const note = o.shape.cut_guard_note as { safeParse: (v: unknown) => { success: boolean } } | undefined;
          expect(note, "strict body schema without cut_guard_note").toBeDefined();
          expect(note!.safeParse("x").success).toBe(true);
        }
      }
    });
  }
});
