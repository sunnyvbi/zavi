
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickVariant, shipSteps, SHIP_FINAL_STEP, type PickDeps } from "../pick";

const T1 = "73db45ff-457e-4541-bc8f-bdb625390204";
const WRITE_METHODS = ["insert", "upsert", "update", "delete", "rpc"];

function fakeSb(variants: Record<string, unknown>) {
  const writes: string[] = [];
  const reads: string[] = [];
  const trap = (where: string) => (name: string) => () => {
    writes.push(`${where}.${name}`);
    return Promise.resolve({ data: null, error: null });
  };
  const sb = {
    from(table: string) {
      reads.push(table);
      let slug: unknown;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          if (c === "slug") slug = v;
          return chain;
        },
        limit: () => {
          const cfg = variants[slug as string];
          return Promise.resolve({ data: cfg === undefined ? [] : [{ slug, config: cfg }], error: null });
        },
      };
      for (const m of WRITE_METHODS) chain[m] = trap(table)(m);
      return chain;
    },
    rpc: trap("client")("rpc"),
  };
  return { sb: sb as unknown as SupabaseClient, writes, reads };
}

function deps(sb: SupabaseClient): PickDeps & { lines: Array<[string, string]> } {
  const lines: Array<[string, string]> = [];
  return {
    sb,
    lines,
    appendLine: vi.fn(async (f: string, l: string) => {
      lines.push([f, l]);
    }),
    runsDir: "/home/x/.zavi/variants-runs/",
    now: () => new Date("2026-10-08T12:00:00Z"),
  };
}

const base = { tenantId: T1, agentSlug: "operator", note: "v1 read the file", record: { results: [] } };

const CONFIGS: Record<string, unknown> = {
  v1: { effort: "low", isolate_settings: true },
  lean: { prompt: { agent_file: "lean", skills: ["operator-render-video"] } },
  nomem: { memory: "off", tools: { disable: ["github__search_code"] } },
  empty: {},
};

describe("pickVariant", () => {
  it.each(["default", "v1", "lean", "nomem", "empty"])("%s: never touches a write method, only reads the variant", async (slug) => {
    const { sb, writes, reads } = fakeSb(CONFIGS);
    const d = deps(sb);
    await pickVariant({ ...base, variantSlug: slug }, d);
    expect(writes).toEqual([]);
    expect(reads.every((t) => t === "agent_engine_variants")).toBe(true);
    expect(d.lines).toHaveLength(1);
  });

  it("logs the pick, the note and the ship steps to the dated local file", async () => {
    const { sb } = fakeSb(CONFIGS);
    const d = deps(sb);
    const r = await pickVariant({ ...base, variantSlug: "v1" }, d);
    expect(r.log_file).toBe("/home/x/.zavi/variants-runs/2026-10-08.jsonl");
    const [file, line] = d.lines[0];
    expect(file).toBe(r.log_file);
    expect(JSON.parse(line)).toMatchObject({ pick: "v1", note: "v1 read the file", tenant_id: T1, ship_steps: r.ship_steps });
  });

  it("an unknown slug saves nothing", async () => {
    const { sb, writes } = fakeSb({});
    const d = deps(sb);
    await expect(pickVariant({ ...base, variantSlug: "nope" }, d)).rejects.toThrow(/unknown variation/);
    expect(writes).toEqual([]);
    expect(d.lines).toEqual([]);
  });
});

describe("shipSteps", () => {
  it("default: no change", () => {
    expect(shipSteps("operator", null)).toEqual(["No change: today's agent stays."]);
  });

  it("a variation with no overrides: no change", () => {
    expect(shipSteps("operator", {})[0]).toMatch(/No change/);
  });

  it("prompt file: make it the agent's prompt, then review and deploy", () => {
    const s = shipSteps("operator", { prompt: { agent_file: "lean" } });
    expect(s[0]).toBe("Make agent.lean.md the operator prompt (replace the agent.md body) in a PR");
    expect(s.at(-1)).toBe(SHIP_FINAL_STEP);
  });

  it("behaviours: turn each on by default in code", () => {
    expect(shipSteps("cgo", { behaviors: ["a", "b"] })).toEqual([
      "Turn on a by default in code",
      "Turn on b by default in code",
      SHIP_FINAL_STEP,
    ]);
  });

  it("settings: move each key=value into frontmatter or the fleet default", () => {
    const s = shipSteps("operator", { effort: "low", max_turns: 20, tools: { disable: ["github__grep"] }, memory: "off" });
    expect(s).toContain('Move effort="low" into operator agent.md frontmatter (or the fleet default)');
    expect(s).toContain("Move max_turns=20 into operator agent.md frontmatter (or the fleet default)");
    expect(s).toContain('Move memory="off" into operator agent.md frontmatter (or the fleet default)');
    expect(s).toContain('Move tools.disable=["github__grep"] into operator agent.md frontmatter (or the fleet default)');
    expect(s.at(-1)).toBe(SHIP_FINAL_STEP);
  });

  it("never mentions a tenant or going live", () => {
    const all = shipSteps("operator", { effort: "low", prompt: { agent_file: "x" }, behaviors: ["b"] }).join(" ");
    expect(all).not.toMatch(/tenant|live|assign/i);
  });
});
