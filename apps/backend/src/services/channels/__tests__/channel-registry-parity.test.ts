
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import matter from "gray-matter";
import path from "node:path";
import { loadChannelRecipe, listRecipeSlugs } from "../recipe";
import {
  ACTION_TYPES,
  ACTIONS_STORES,
  CHANNELS,
  CHANNEL_CATEGORY_ORDER,
  CONNECTOR_DESCRIPTORS,
  HUMAN_DISCIPLINES,
  type Channel,
} from "@zavi/shared";

const BACKEND_SRC = path.join(process.cwd(), "src");
const TOOL_ROOTS = [
  path.join(BACKEND_SRC, "services", "tools"),
  path.join(BACKEND_SRC, "services", "mcp", "internal"),
];
const AGENTS_ROOT = path.join(BACKEND_SRC, "agents");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(full);
    return e.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

const declaredToolNames: ReadonlySet<string> = (() => {
  const found = new Set<string>();
  for (const root of TOOL_ROOTS) {
    for (const file of walk(root)) {
      const src = fs.readFileSync(file, "utf-8");
      for (const m of src.matchAll(/\bname:\s*"([a-z0-9_]+)"/g)) found.add(m[1]);
    }
  }
  return found;
})();

const agentSlugs: ReadonlySet<string> = new Set(
  fs.existsSync(AGENTS_ROOT)
    ? fs
        .readdirSync(AGENTS_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "__tests__")
        .map((d) => d.name)
    : [],
);

const connectorSlugs: ReadonlySet<string> = new Set(
  CONNECTOR_DESCRIPTORS.map((d) => d.slug),
);

const ACTING_TOOL_RE = /(^|_)(propose|send|submit|create|write|publish)(_|$)/;

describe("channel registry parity (@zavi/shared CHANNELS is the source of truth)", () => {
  it("has unique slugs", () => {
    const slugs = CHANNELS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("declares only categories that exist in the display order", () => {
    for (const c of CHANNELS) {
      expect(CHANNEL_CATEGORY_ORDER).toContain(c.category);
    }
  });

  it("every declared connector exists in CONNECTOR_DESCRIPTORS", () => {
    const bad: string[] = [];
    for (const c of CHANNELS) {
      for (const conn of c.connectors) {
        if (!connectorSlugs.has(conn)) bad.push(`${c.slug} -> ${conn}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every declared tool is declared in a tool source file", () => {
    const bad: string[] = [];
    for (const c of CHANNELS) {
      for (const tool of c.tools) {
        if (!declaredToolNames.has(tool)) bad.push(`${c.slug} -> ${tool}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("at most one OPEN channel claims a given human brief_kind", () => {
    const seen = new Map<string, string>();
    for (const c of CHANNELS as readonly Channel[]) {
      if (c.human?.available !== true) continue;
      const prior = seen.get(c.human.brief_kind);
      expect(
        prior,
        `brief_kind '${c.human.brief_kind}' claimed by both ${prior} and ${c.slug}`,
      ).toBeUndefined();
      seen.set(c.human.brief_kind, c.slug);
    }
  });

  it("every declared human discipline is a real human discipline", () => {
    const bad: string[] = [];
    for (const c of CHANNELS as readonly Channel[]) {
      for (const d of c.human?.disciplines ?? []) {
        if (!(HUMAN_DISCIPLINES as readonly string[]).includes(d)) bad.push(`${c.slug} -> ${d}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every channel lists at least one allowed action type, all in ACTION_TYPES, and an actions_store", () => {
    const bad: string[] = [];
    for (const c of CHANNELS as readonly Channel[]) {
      if (!c.action_types || c.action_types.length === 0) bad.push(`${c.slug}: no action_types`);
      for (const t of c.action_types ?? []) {
        if (!(ACTION_TYPES as readonly string[]).includes(t)) bad.push(`${c.slug} -> ${t}`);
      }
      if (!(ACTIONS_STORES as readonly string[]).includes(c.actions_store ?? "")) {
        bad.push(`${c.slug}: actions_store ${String(c.actions_store)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every executor is a real agent with an agent.md", () => {
    const bad: string[] = [];
    for (const c of CHANNELS) {
      if (!agentSlugs.has(c.executor)) {
        bad.push(`${c.slug} -> ${c.executor} (no directory)`);
        continue;
      }
      const md = path.join(AGENTS_ROOT, c.executor, "agent.md");
      if (!fs.existsSync(md)) bad.push(`${c.slug} -> ${c.executor} (directory, but no agent.md)`);
    }
    expect(bad).toEqual([]);
  });

  it("no two channels share an executor", () => {
    const owners = new Map<string, string[]>();
    for (const c of CHANNELS) owners.set(c.executor, [...(owners.get(c.executor) ?? []), c.slug]);
    const shared = [...owners].filter(([, slugs]) => slugs.length > 1).map(([e, s]) => `${e} -> ${s.join(", ")}`);
    expect(shared, shared.join("\n")).toEqual([]);
  });

  it("every channel's executor inherits the family core matching its category", () => {
    const CORE_FOR_CATEGORY: Record<string, string> = {
      paid: "paid-channel",
      organic: "organic-channel",
      owned: "owned-channel",
      earned: "earned-channel",
      partner: "partner-channel",
    };
    const bad: string[] = [];
    for (const c of CHANNELS) {
      if (c.executor !== c.slug) continue;
      const core = CORE_FOR_CATEGORY[c.category];
      if (!core) {
        bad.push(`${c.slug} -> category '${c.category}' has no family core mapped`);
        continue;
      }
      const agentPath = path.join(AGENTS_ROOT, c.executor, "agent.md");
      if (!fs.existsSync(agentPath)) continue;
      const fm = matter(fs.readFileSync(agentPath, "utf-8")).data as {
        metadata?: { praxis?: { inherits?: string[] } };
      };
      const inherits = fm.metadata?.praxis?.inherits ?? [];
      if (!inherits.includes(core)) {
        bad.push(`${c.slug} (${c.category}) -> ${c.executor} does not inherit ${core}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("every paid channel's executor inherits _core/paid-channel.md", () => {
    const bad: string[] = [];
    for (const c of CHANNELS) {
      if (c.category !== "paid") continue;
      const md = path.join(AGENTS_ROOT, c.executor, "agent.md");
      if (!fs.existsSync(md)) {
        bad.push(`${c.slug} -> ${c.executor} (no agent.md)`);
        continue;
      }
      const fm = matter(fs.readFileSync(md, "utf-8")).data as {
        metadata?: { praxis?: { inherits?: string[] } };
      };
      const inherits = fm.metadata?.praxis?.inherits ?? [];
      if (!inherits.includes("paid-channel")) {
        bad.push(`${c.slug} -> ${c.executor} (does not inherit paid-channel)`);
      }
    }
    expect(bad).toEqual([]);
  });

  const EXECUTOR_TOOL_EXCEPTIONS: Record<string, string> = {
    "email_marketing::email_send":
      "granting an agent a real outbound send is an owner decision; the channel drafts, the operator sends",
  };

  it("every channel's executor is granted the tools the channel declares", () => {
    const norm = (t: string) => t.replace(/__/g, "_");
    const bad: string[] = [];
    for (const c of CHANNELS) {
      if (c.tools.length === 0) continue;
      const md = path.join(AGENTS_ROOT, c.executor, "agent.md");
      if (!fs.existsSync(md)) continue;
      const fm = matter(fs.readFileSync(md, "utf-8")).data as {
        metadata?: { praxis?: { tools?: string[] } };
      };
      const granted = new Set((fm.metadata?.praxis?.tools ?? []).map(norm));
      for (const tool of c.tools) {
        if (granted.has(norm(tool))) continue;
        if (EXECUTOR_TOOL_EXCEPTIONS[`${c.slug}::${tool}`]) continue;
        bad.push(`${c.slug} declares "${tool}" but executor ${c.executor} is not granted it`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every documented executor-tool exception still describes a real gap", () => {
    const norm = (t: string) => t.replace(/__/g, "_");
    const stale: string[] = [];
    for (const key of Object.keys(EXECUTOR_TOOL_EXCEPTIONS)) {
      const [slug, tool] = key.split("::");
      const chan = CHANNELS.find((c) => c.slug === slug);
      if (!chan) {
        stale.push(`${key} — no such channel`);
        continue;
      }
      if (!(chan.tools as readonly string[]).includes(tool)) {
        stale.push(`${key} — channel no longer declares that tool`);
        continue;
      }
      const md = path.join(AGENTS_ROOT, chan.executor, "agent.md");
      if (!fs.existsSync(md)) continue;
      const fm = matter(fs.readFileSync(md, "utf-8")).data as {
        metadata?: { praxis?: { tools?: string[] } };
      };
      const granted = new Set((fm.metadata?.praxis?.tools ?? []).map(norm));
      if (granted.has(norm(tool))) stale.push(`${key} — executor now holds it; delete the exception`);
    }
    expect(stale).toEqual([]);
  });

  describe("readiness matches declared capability", () => {
    const withReadiness = (r: Channel["readiness"]) =>
      CHANNELS.filter((c) => c.readiness === r);

    it("planned channels declare no tools", () => {
      for (const c of withReadiness("planned")) {
        expect({ slug: c.slug, tools: c.tools }).toEqual({ slug: c.slug, tools: [] });
      }
    });

    it("connector_only channels have a connector and no tools", () => {
      for (const c of withReadiness("connector_only")) {
        expect(c.connectors.length).toBeGreaterThan(0);
        expect(c.tools).toEqual([]);
      }
    });

    it("read_only channels declare at least one tool", () => {
      for (const c of withReadiness("read_only")) {
        expect({ slug: c.slug, hasTools: c.tools.length > 0 }).toEqual({
          slug: c.slug,
          hasTools: true,
        });
      }
    });

    it("live channels declare at least one acting tool", () => {
      for (const c of withReadiness("live")) {
        const acting = c.tools.filter((t) => ACTING_TOOL_RE.test(t));
        expect({ slug: c.slug, acting: acting.length > 0 }).toEqual({
          slug: c.slug,
          acting: true,
        });
      }
    });

    it("records how many channels can actually act today", () => {
      expect(withReadiness("live").map((c) => c.slug).sort()).toEqual([
        "chatgpt_ads",
        "email_marketing",
        "google_ads",
        "instagram_organic",
        "linkedin_ads",
        "linkedin_organic",
        "meta_ads",
        "pinterest_organic",
        "reddit_ads",
        "tiktok_ads",
        "ugc",
        "x_ads",
        "x_organic",
        "youtube_ads",
      ]);
    });
  });

  describe("measured_on reads as honest, customer-readable copy", () => {
    const SNAKE_CASE_EXEMPT = new Set(["seo"]);

    it("no exemption outlives its reason", () => {
      const stale: string[] = [];
      for (const slug of SNAKE_CASE_EXEMPT) {
        const c = CHANNELS.find((x) => x.slug === slug);
        if (!c) {
          stale.push(`${slug} — no such channel; delete the exemption`);
          continue;
        }
        if (!c.measured_on.some((k) => k.includes("_"))) {
          stale.push(`${slug} — measured_on is clean now; delete it from SNAKE_CASE_EXEMPT`);
        }
      }
      expect(stale).toEqual([]);
    });

    it("every channel declares at least one", () => {
      const empty = CHANNELS.filter((c) => (c.measured_on as readonly string[]).length === 0);
      expect(empty.map((c) => c.slug)).toEqual([]);
    });

    it("reads like English, not like a column name", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        if (SNAKE_CASE_EXEMPT.has(c.slug)) continue;
        for (const k of c.measured_on) {
          if (k !== k.trim()) bad.push(`${c.slug}: "${k}" — leading/trailing space`);
          if (k.includes("_")) bad.push(`${c.slug}: "${k}" — snake_case, write words`);
          if (!/[a-z]/.test(k)) bad.push(`${c.slug}: "${k}" — no lowercase, looks like a key`);
          if (k.trim().length < 3) bad.push(`${c.slug}: "${k}" — too short to mean anything`);
          if (k.length > 60) bad.push(`${c.slug}: "${k}" — too long for the drawer row`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("survives the comma join the drawer does", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        for (const k of c.measured_on) {
          if (k.includes(",")) bad.push(`${c.slug}: "${k}" — comma reads as a separator`);
        }
        if (new Set(c.measured_on).size !== c.measured_on.length) bad.push(`${c.slug}: duplicate entry`);
      }
      expect(bad).toEqual([]);
    });

    it("a channel with no connector and no tool promises no number", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        if (c.connectors.length > 0 || c.tools.length > 0) continue;
        if (c.measured_on.length !== 1 || c.measured_on[0] !== "nothing yet") {
          bad.push(`${c.slug}: has no instrument, so measured_on must be ["nothing yet"], got ${JSON.stringify(c.measured_on)}`);
        }
      }
      expect(bad).toEqual([]);
    });
  });

  describe("recipe deltas", () => {
    it("every registry channel has a delta", () => {
      const have = new Set(listRecipeSlugs());
      const missing = CHANNELS.filter((c) => !have.has(c.slug)).map((c) => c.slug);
      expect(missing).toEqual([]);
    });

    it("no delta exists for a channel the registry does not know", () => {
      const known = new Set<string>(CHANNELS.map((c) => c.slug));
      expect(listRecipeSlugs().filter((s) => !known.has(s))).toEqual([]);
    });

    it("every delta is filed under the channel it declares", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        const r = loadChannelRecipe(c.slug);
        if (r.meta.channel !== c.slug) bad.push(`${c.slug} declares ${r.meta.channel}`);
      }
      expect(bad).toEqual([]);
    });

    it("every delta's executor matches the registry executor", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        const r = loadChannelRecipe(c.slug);
        if (r.meta.executor !== c.executor) {
          bad.push(`${c.slug}: delta ${r.meta.executor} vs registry ${c.executor}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("every artifact.tool is declared in a tool source file", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        const { tool } = loadChannelRecipe(c.slug).meta.artifact;
        if (!declaredToolNames.has(tool)) bad.push(`${c.slug} -> ${tool}`);
      }
      expect(bad).toEqual([]);
    });

    it("every delta has a public-evidence fallback", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        const r = loadChannelRecipe(c.slug);
        if (r.meta.inputs.public.length === 0) bad.push(c.slug);
      }
      expect(bad).toEqual([]);
    });

    it("every connected input is a tool the registry grants that channel", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        const granted = new Set<string>(c.tools);
        for (const input of loadChannelRecipe(c.slug).meta.inputs.connected) {
          if (!granted.has(input)) bad.push(`${c.slug} -> ${input}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("a channel with no tools declares no connected inputs", () => {
      const bad: string[] = [];
      for (const c of CHANNELS.filter((x) => x.tools.length === 0)) {
        const connected = loadChannelRecipe(c.slug).meta.inputs.connected;
        if (connected.length > 0) bad.push(`${c.slug} -> ${connected.join(",")}`);
      }
      expect(bad).toEqual([]);
    });

    it("only live channels run daily", () => {
      const bad: string[] = [];
      for (const c of CHANNELS) {
        const { cadence } = loadChannelRecipe(c.slug).meta;
        if (cadence === "daily" && c.readiness !== "live") {
          bad.push(`${c.slug} is ${c.readiness} but runs daily`);
        }
      }
      expect(bad).toEqual([]);
    });
  });
});
