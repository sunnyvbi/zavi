import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadFileVariants } from "../file-variants";
import { loadLabVariants } from "../run-variants";
import { pickVariant } from "../pick";

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "variants-files-"));
  const dir = path.join(root, "operator", "variants");
  fs.mkdirSync(dir, { recursive: true });
  const w = (f: string, body: string) => fs.writeFileSync(path.join(dir, f), body);
  w("code-first.json", JSON.stringify({ label: "Code first", config: { prompt: { agent_file: "code-first" } } }));
  w("v1.json", JSON.stringify({ label: "V1 from file", config: { effort: "medium" } }));
  w("broken.json", "{ not json");
  w("badcfg.json", JSON.stringify({ label: "Bad", config: { max_turn: 3 } }));
  w("default.json", JSON.stringify({ label: "x", config: {} }));
  w("README.md", "ignored");
  w("isnull.json", "null");
  w("isarray.json", "[]");
  w("isscalar.json", "5");
  w("nocfg.json", JSON.stringify({ label: "No config" }));
  w("typo.json", JSON.stringify({ label: "Typo", configs: { effort: "low" } }));
  w("nolabel.json", JSON.stringify({ config: { effort: "low" } }));
  w("extra.json", JSON.stringify({ label: "Extra", config: {}, note: "x" }));
  w("emptylabel.json", JSON.stringify({ label: "  ", config: {} }));
});

function fakeSb(rows: Array<{ slug: string; label: string; config: unknown }>) {
  const asked: string[][] = [];
  const sb = {
    from: () => {
      let want: string[] = [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        in: (_c: string, vs: string[]) => {
          want = vs;
          asked.push(vs);
          return chain;
        },
        limit: () => Promise.resolve({ data: rows.filter((r) => want.includes(r.slug)), error: null }),
      };
      return chain;
    },
  };
  return { sb: sb as unknown as SupabaseClient, asked };
}

describe("loadFileVariants", () => {
  it("lists .json files, validates each, never throws on a bad one", () => {
    const files = loadFileVariants("operator", root);
    const by = Object.fromEntries(files.map((f) => [f.slug, f]));
    expect(Object.keys(by).sort()).toEqual([
      "badcfg", "broken", "code-first", "default", "emptylabel", "extra", "isarray", "isnull",
      "isscalar", "nocfg", "nolabel", "typo", "v1",
    ]);
    expect(by["code-first"]).toMatchObject({ label: "Code first", source: "local", config: { prompt: { agent_file: "code-first" } } });
    expect(by.broken.error).toMatch(/unreadable/);
    expect(by.badcfg.error).toMatch(/invalid file: config/);
    expect(by.default.error).toMatch(/bad file name/);
  });

  it.each(["isnull", "isarray", "isscalar", "nocfg", "typo", "nolabel", "extra", "emptylabel"])(
    "%s: the whole file is checked strictly -> an error entry, no config",
    (slug) => {
      const f = loadFileVariants("operator", root).find((x) => x.slug === slug)!;
      expect(f.config).toBeUndefined();
      expect(f.error).toMatch(/^invalid file:/);
    },
  );

  it("a channel agent's slug may hold an underscore (meta_ads)", () => {
    const dir = path.join(root, "meta_ads", "variants");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "lean.json"), JSON.stringify({ label: "Lean", config: { prompt: { recipe_file: "lean" } } }));
    expect(loadFileVariants("meta_ads", root)).toMatchObject([{ slug: "lean", label: "Lean", config: { prompt: { recipe_file: "lean" } } }]);
  });

  it("an agent with no variants dir, or a bad slug, has none", () => {
    expect(loadFileVariants("cgo", root)).toEqual([]);
    expect(loadFileVariants("../etc", root)).toEqual([]);
  });
});

describe("loadLabVariants with files", () => {
  it("a file wins over a prod row of the same name, and is not read from prod", async () => {
    const { sb, asked } = fakeSb([
      { slug: "v1", label: "V1 prod", config: { effort: "low" } },
      { slug: "v2", label: "V2 prod", config: { effort: "high" } },
    ]);
    const files = loadFileVariants("operator", root);
    const vs = await loadLabVariants(sb, ["default", "v1", "v2", "code-first"], files);
    const by = Object.fromEntries(vs.map((v) => [v.slug, v]));
    expect(by.v1).toMatchObject({ source: "local", label: "V1 from file", variant: { config: { effort: "medium" } } });
    expect(by.v2).toMatchObject({ source: "prod", variant: { config: { effort: "high" } } });
    expect(by["code-first"].source).toBe("local");
    expect(by.default.source).toBe("default");
    expect(asked).toEqual([["v2"]]);
  });

  it("a bad file shows as an error column, not a crash", async () => {
    const { sb } = fakeSb([]);
    const vs = await loadLabVariants(sb, ["broken"], loadFileVariants("operator", root));
    expect(vs[0]).toMatchObject({ slug: "broken", variant: null, source: "local" });
    expect(vs[0].error).toMatch(/unreadable/);
  });

  it("unknown in both sources is rejected", async () => {
    const { sb } = fakeSb([]);
    await expect(loadLabVariants(sb, ["nope"], loadFileVariants("operator", root))).rejects.toThrow(/unknown variation: nope/);
  });
});

describe("pick with a file variation", () => {
  it("uses the file's config, reads nothing from prod", async () => {
    let touched = false;
    const sb = { from: () => { touched = true; throw new Error("no prod"); } } as unknown as SupabaseClient;
    const lines: string[] = [];
    const r = await pickVariant(
      { tenantId: "t", agentSlug: "operator", variantSlug: "code-first", note: "", record: null },
      { sb, runsDir: "/x", appendLine: async (_f, l) => void lines.push(l), fileVariants: loadFileVariants("operator", root) },
    );
    expect(touched).toBe(false);
    expect(r.ship_steps[0]).toBe("Make agent.code-first.md the operator prompt (replace the agent.md body) in a PR");
  });
});
