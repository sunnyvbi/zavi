
import { describe, it, expect } from "vitest";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { CHANNELS } from "@zavi/shared";
import { resolveChannelSkillPath, MAX_CHANNEL_SKILL_BYTES } from "@/services/agents/channel-skills";

const CHANNELS_ROOT = path.join(process.cwd(), "src", "channels");
const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

type RouterStep = { id?: string; when?: string; skill?: string; tools?: string[] };

function recipeSlugs(): string[] {
  if (!existsSync(CHANNELS_ROOT)) return [];
  return readdirSync(CHANNELS_ROOT)
    .filter((d) => !d.startsWith("_"))
    .filter((d) => statSync(path.join(CHANNELS_ROOT, d)).isDirectory())
    .filter((d) => existsSync(path.join(CHANNELS_ROOT, d, "recipe.md")));
}

function routerOf(slug: string): { executor: string; steps: RouterStep[] } {
  const raw = readFileSync(path.join(CHANNELS_ROOT, slug, "recipe.md"), "utf-8");
  const fm = matter(raw).data as { executor?: string; router?: RouterStep[] };
  return { executor: fm.executor ?? "", steps: Array.isArray(fm.router) ? fm.router : [] };
}

describe("channel router <-> co-located skill parity", () => {
  const slugs = recipeSlugs();

  it("finds recipes to check (guards against a silently empty suite)", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  it("every router step's `skill` resolves to a real co-located file", () => {
    const bad: string[] = [];
    for (const slug of slugs) {
      const { executor, steps } = routerOf(slug);
      for (const step of steps) {
        if (!step?.skill) continue;
        const owner = executor || slug;
        if (resolveChannelSkillPath(owner, step.skill) === null) {
          bad.push(
            `${slug}/recipe.md step '${step.id ?? "?"}' binds skill '${step.skill}' -> no file at src/agents/${owner}/skills/${step.skill}.md`,
          );
        }
      }
    }
    expect(bad, `Unresolvable router skill bindings:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every router step declares a valid `when`", () => {
    const valid = new Set(["always", "connected", "public_only"]);
    const bad: string[] = [];
    for (const slug of slugs) {
      for (const step of routerOf(slug).steps) {
        if (!valid.has(String(step?.when))) {
          bad.push(`${slug}/recipe.md step '${step?.id ?? "?"}' has when='${step?.when}'`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("no co-located skill body exceeds the byte clamp", () => {
    const bad: string[] = [];
    if (existsSync(AGENTS_ROOT)) {
      for (const agent of readdirSync(AGENTS_ROOT)) {
        const dir = path.join(AGENTS_ROOT, agent, "skills");
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".md")) continue;
          const bytes = Buffer.byteLength(readFileSync(path.join(dir, f), "utf-8"), "utf-8");
          if (bytes > MAX_CHANNEL_SKILL_BYTES) {
            bad.push(`${agent}/skills/${f} is ${bytes} bytes (cap ${MAX_CHANNEL_SKILL_BYTES})`);
          }
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  const MAX_CHANNEL_AGENT_BYTES = 20_000;

  it("no channel-capsule agent body exceeds the channel-agent cap", () => {
    const bad: string[] = [];
    for (const slug of slugs) {
      const owner = routerOf(slug).executor || slug;
      const agentPath = path.join(AGENTS_ROOT, owner, "agent.md");
      const skillsDir = path.join(AGENTS_ROOT, owner, "skills");
      if (!existsSync(agentPath) || !existsSync(skillsDir)) continue;
      const bytes = Buffer.byteLength(readFileSync(agentPath, "utf-8"), "utf-8");
      if (bytes > MAX_CHANNEL_AGENT_BYTES) {
        bad.push(`${owner}/agent.md is ${bytes} bytes (channel cap ${MAX_CHANNEL_AGENT_BYTES})`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("a router step names only tools that actually exist in a tool source file", () => {
    const declaredToolNames = new Set<string>();
    const roots = [path.join(process.cwd(), "src", "services", "tools")];
    const walk = (dir: string): string[] => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(full);
        return full.endsWith(".ts") ? [full] : [];
      });
    };
    for (const root of roots) {
      for (const file of walk(root)) {
        for (const m of readFileSync(file, "utf-8").matchAll(/\bname:\s*"([a-z0-9_]+)"/g)) {
          declaredToolNames.add(m[1]);
        }
      }
    }
    expect(declaredToolNames.size).toBeGreaterThan(10);

    const specTools = new Set<string>();
    const INTERNAL = path.join(process.cwd(), "src", "services", "mcp", "internal");
    if (existsSync(INTERNAL)) {
      for (const entry of readdirSync(INTERNAL, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const src = readFileSync(path.join(INTERNAL, entry.name), "utf-8");
        const server =
          src.match(/server_id:\s*"([a-z0-9_]+)"/)?.[1] ??
          entry.name.replace(/\.ts$/, "").replace(/-/g, "_");
        const block = src.match(/const SPECS[^=]*=\s*\{([\s\S]*?)\n\}(?: as const)?;/);
        if (!block) continue;
        for (const m of block[1].matchAll(/^ {2}([a-z0-9_]+):\s*\{/gm)) {
          specTools.add(`${server}__${m[1]}`);
        }
      }
    }
    expect(specTools.size).toBeGreaterThan(3);

    const resolvable = (t: string): boolean => {
      if (declaredToolNames.has(t)) return true;
      if (t.includes("__")) {
        if (declaredToolNames.has(t.replace("__", "_"))) return true;
        if (specTools.has(t)) return true;
      }
      return false;
    };

    const unknown = new Set<string>();
    for (const slug of slugs) {
      for (const step of routerOf(slug).steps) {
        for (const t of step.tools ?? []) {
          if (!resolvable(t)) unknown.add(`${slug}: ${t}`);
        }
      }
    }
    expect(
      [...unknown],
      `Router steps naming tools that resolve to nothing — a typo here reaches the model as a real tool name:\n${[...unknown].join("\n")}`,
    ).toEqual([]);
  });

  it("the facade resolver actually rejects a bogus name (mutation guard)", () => {
    const declaredToolNames = new Set<string>(["report_render_pdf"]);
    const specTools = new Set<string>(["apify__scrape_tiktok"]);
    const resolvable = (t: string): boolean =>
      declaredToolNames.has(t) ||
      (t.includes("__") &&
        (declaredToolNames.has(t.replace("__", "_")) || specTools.has(t)));

    expect(resolvable("report__render_pdf")).toBe(true);
    expect(resolvable("apify__scrape_tiktok")).toBe(true);
    expect(resolvable("apify__scrape_tik_tok")).toBe(false);
    expect(resolvable("report__render_pdff")).toBe(false);
    expect(resolvable("nosuchserver__nosuchtool")).toBe(false);
  });
});
