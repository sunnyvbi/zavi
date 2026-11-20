
import fs from "node:fs";
import path from "node:path";

export type SeededFile = {
  content: string;
  mimeType: string;
  created_at: string;
  modified_at: string;
};

export const SKILLS_ROOT = path.join(process.cwd(), "skills");
export const SKILLS_MOUNT = "/skills/";

const TEXT_EXT = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv"]);

function mimeFor(file: string): string {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".csv")) return "text/csv";
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return "text/yaml";
  return "text/markdown";
}

let cache: Record<string, SeededFile> | null = null;

export function loadSkillFiles(root: string = SKILLS_ROOT): Record<string, SeededFile> {
  if (cache && root === SKILLS_ROOT) return cache;
  const out: Record<string, SeededFile> = {};
  if (!fs.existsSync(root)) return out;

  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const next = `${rel}${entry.name}`;
      if (entry.isDirectory()) {
        walk(abs, `${next}/`);
        continue;
      }
      if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = fs.statSync(abs);
      if (stat.size > 256 * 1024) {
        console.warn(`[deepagent/skills] skipping ${next} — ${stat.size} bytes exceeds the 256KB cap`);
        continue;
      }
      const iso = stat.mtime.toISOString();
      out[`${SKILLS_MOUNT}${next}`] = {
        content: fs.readFileSync(abs, "utf-8"),
        mimeType: mimeFor(entry.name),
        created_at: iso,
        modified_at: iso,
      };
    }
  };
  walk(root, "");

  if (root === SKILLS_ROOT) cache = out;
  return out;
}

export function listSkillNames(root: string = SKILLS_ROOT): string[] {
  const files = loadSkillFiles(root);
  const names = new Set<string>();
  for (const p of Object.keys(files)) {
    const m = p.slice(SKILLS_MOUNT.length).split("/")[0];
    if (m) names.add(m);
  }
  return [...names].sort();
}

export function _resetSkillCache(): void {
  cache = null;
}

export function assertSkillsPresent(): void {
  const names = listSkillNames();
  if (names.length > 0) {
    console.log(`[deepagent/skills] ${names.length} skills loaded: ${names.join(", ")}`);
    return;
  }
  console.error(
    `[deepagent/skills] ZERO SKILLS LOADED from ${SKILLS_ROOT} — the deep agent ` +
      `will run with no playbooks and will NOT report an error. Likely causes: the ` +
      `directory is missing from the container image (check the runtime-stage COPY ` +
      `lines in apps/backend/docker/main/Dockerfile), or cwd is not apps/backend.`,
  );
}
