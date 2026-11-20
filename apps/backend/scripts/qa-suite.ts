
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "qa", "scenarios");

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const themeIdx = args.indexOf("--theme");
const THEME = themeIdx >= 0 ? args[themeIdx + 1] : null;
const RUN_FLAG = args.includes("--run");

if (RUN_FLAG) {
  console.error(
    "--run is intentionally not implemented in v0. The replay path needs " +
      "JWT minting + the live agent dispatcher; add it when a regression " +
      "motivates it. v0 is catalog + format-validator only.",
  );
  process.exit(2);
}

type Frontmatter = {
  id: string;
  agent_slug: string;
  title: string;
  dimensions: string[];
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  priority: string;
  owner: string;
  last_verified: string;
};

type ParsedScenario = {
  file: string;
  frontmatter: Frontmatter;
};

type ParseError = { file: string; reason: string };

const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

function walkScenarios(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkScenarios(p));
    } else if (entry.endsWith(".md") && entry !== "index.md" && entry !== "README.md") {
      out.push(p);
    }
  }
  return out;
}

function parseFrontmatter(raw: string): Frontmatter {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("missing --- frontmatter block at top of file");
  const body = m[1];
  const obj: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj, indent: -1 },
  ];
  const lines = body.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  let lastKey: string | null = null;
  let lastIndent = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      const current = stack[stack.length - 1].obj;
      const target = current[lastKey ?? ""];
      if (Array.isArray(target)) {
        target.push(stripQuotes(trimmed.slice(2).trim()));
      }
      continue;
    }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    const current = stack[stack.length - 1].obj;
    if (value === "") {
      const next: Record<string, unknown> | unknown[] = {};
      current[key] = next;
      const idx = lines.indexOf(line);
      const peek = lines[idx + 1] ?? "";
      if (peek.trim().startsWith("- ")) {
        current[key] = [];
      }
      lastKey = key;
      stack.push({ obj: next as Record<string, unknown>, indent });
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      current[key] = inner === ""
        ? []
        : inner.split(",").map((s) => stripQuotes(s.trim()));
    } else {
      current[key] = stripQuotes(value);
    }
    lastIndent = indent;
  }
  return obj as unknown as Frontmatter;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function validate(file: string, fm: Frontmatter): string | null {
  const REQUIRED = ["id", "agent_slug", "title", "dimensions", "input", "expected", "priority", "owner", "last_verified"] as const;
  for (const k of REQUIRED) {
    if (fm[k] === undefined) return `missing required field: ${k}`;
  }
  if (typeof fm.id !== "string" || !/^[a-z0-9-]+$/.test(fm.id)) {
    return `id must be lowercase kebab-case (got: ${String(fm.id)})`;
  }
  if (typeof fm.priority !== "string" || !VALID_PRIORITIES.has(fm.priority)) {
    return `priority must be one of P0/P1/P2/P3 (got: ${String(fm.priority)})`;
  }
  if (!Array.isArray(fm.dimensions)) {
    return `dimensions must be a list`;
  }
  if (typeof fm.input !== "object" || fm.input === null) {
    return `input must be an object`;
  }
  if (typeof fm.expected !== "object" || fm.expected === null) {
    return `expected must be an object`;
  }
  return null;
}

function main(): void {
  const files = walkScenarios(ROOT);
  const parsed: ParsedScenario[] = [];
  const errors: ParseError[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    const rel = relative(join(__dirname, "..", ".."), f);
    if (THEME) {
      const theme = relative(ROOT, f).split("/")[0];
      if (theme !== THEME) continue;
    }
    let fm: Frontmatter;
    try {
      const raw = readFileSync(f, "utf8");
      fm = parseFrontmatter(raw);
    } catch (e) {
      errors.push({ file: rel, reason: (e as Error).message });
      continue;
    }
    const err = validate(rel, fm);
    if (err) {
      errors.push({ file: rel, reason: err });
      continue;
    }
    if (seen.has(fm.id)) {
      errors.push({ file: rel, reason: `duplicate id: ${fm.id}` });
      continue;
    }
    seen.add(fm.id);
    parsed.push({ file: rel, frontmatter: fm });
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ parsed, errors, count: parsed.length, error_count: errors.length }, null, 2));
    process.exit(errors.length > 0 ? 1 : 0);
  }

  const byAgent = new Map<string, ParsedScenario[]>();
  for (const s of parsed) {
    const list = byAgent.get(s.frontmatter.agent_slug) ?? [];
    list.push(s);
    byAgent.set(s.frontmatter.agent_slug, list);
  }
  const agents = [...byAgent.keys()].sort();
  console.log(`Praxis QA scenarios — ${parsed.length} parsed, ${errors.length} errors\n`);
  for (const agent of agents) {
    const list = byAgent.get(agent)!;
    console.log(`  ${agent}  (${list.length})`);
    for (const s of list) {
      const dims = s.frontmatter.dimensions.join(",");
      console.log(`    [${s.frontmatter.priority}] ${s.frontmatter.id.padEnd(34)} ${dims}`);
    }
  }
  if (errors.length > 0) {
    console.log("\nERRORS:");
    for (const e of errors) {
      console.log(`  ${e.file}:`);
      console.log(`    → ${e.reason}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
