
import { unzipSync } from "fflate";
import {
  parseSkillFile,
  SKILL_MAX_BODY_CHARS,
  type ParsedSkill,
} from "./skillFile";

export const SKILL_ZIP_MAX_BYTES = 50 * 1024 * 1024;
export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_ZIP_ACCEPT =
  ".zip,application/zip,application/x-zip-compressed";

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_MD = "skill.md";

export type SkillZipParse =
  | {
      ok: true;
      skill: ParsedSkill;
      name: string;
      description: string;
      ignored: string[];
    }
  | { ok: false; error: string };

export function checkSkillZip(file: {
  name: string;
  size: number;
}): string | null {
  if (!file.name.toLowerCase().endsWith(".zip")) return "Upload a .zip file.";
  if (file.size === 0) return "That zip is empty.";
  if (file.size > SKILL_ZIP_MAX_BYTES) {
    return `That zip is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is 50 MB.`;
  }
  return null;
}

function isNoise(path: string): boolean {
  if (path.endsWith("/")) return true;
  if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === ".DS_Store" || base === "" || base.startsWith("._");
}

function topLevelDir(path: string): string | null {
  const slash = path.indexOf("/");
  return slash === -1 ? null : path.slice(0, slash);
}

export function parseSkillZip(bytes: Uint8Array): SkillZipParse {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    return {
      ok: false,
      error: `That file isn't a readable zip: ${(e as Error).message}`,
    };
  }

  const paths = Object.keys(entries).filter((p) => !isNoise(p));
  if (paths.length === 0)
    return { ok: false, error: "That zip has no files in it." };

  const rootSkillPath = paths.find(
    (p) => !p.includes("/") && p.toLowerCase() === SKILL_MD,
  );
  let skillPath = rootSkillPath;
  if (!skillPath) {
    const roots = new Set(paths.map((p) => topLevelDir(p) ?? ""));
    if (roots.size > 1 || roots.has("")) {
      return {
        ok: false,
        error:
          "That zip has more than one thing at its top level. Put SKILL.md at the root, or inside a single folder.",
      };
    }
    skillPath = paths.find((p) => {
      const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
      return base === SKILL_MD && p.split("/").length === 2;
    });
  }
  if (!skillPath) {
    return {
      ok: false,
      error:
        "No SKILL.md found at the zip root or inside its top-level folder.",
    };
  }

  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(entries[skillPath]);
  } catch {
    return { ok: false, error: "SKILL.md isn't valid UTF-8 text." };
  }

  const frontmatter = readFrontmatter(raw);
  if (!frontmatter) {
    return {
      ok: false,
      error: "SKILL.md needs YAML frontmatter with `name` and `description`.",
    };
  }
  if (!frontmatter.name) {
    return { ok: false, error: "SKILL.md frontmatter is missing `name`." };
  }
  if (!frontmatter.description) {
    return {
      ok: false,
      error: "SKILL.md frontmatter is missing `description`.",
    };
  }
  if (frontmatter.name.length > SKILL_NAME_MAX_CHARS) {
    return {
      ok: false,
      error: `\`name\` is ${frontmatter.name.length} characters. The limit is ${SKILL_NAME_MAX_CHARS}.`,
    };
  }
  if (!SKILL_NAME_RE.test(frontmatter.name)) {
    return {
      ok: false,
      error: "`name` must be lowercase letters, numbers and hyphens only.",
    };
  }

  const parsed = parseSkillFile("SKILL.md", raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.skill.body_markdown.length > SKILL_MAX_BODY_CHARS) {
    return {
      ok: false,
      error: "That SKILL.md is too long to store as one skill.",
    };
  }

  return {
    ok: true,
    skill: parsed.skill,
    name: frontmatter.name,
    description: frontmatter.description,
    ignored: paths.filter((p) => p !== skillPath),
  };
}

function readFrontmatter(
  raw: string,
): { name: string; description: string } | null {
  const text = raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t\n]*/, "");
  const fm = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!fm) return null;
  const out = { name: "", description: "" };
  for (const line of fm[1].split("\n")) {
    const kv = line.match(/^(name|description)\s*:\s*(.*)$/i);
    if (!kv) continue;
    const value = kv[2]
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .trim();
    if (kv[1].toLowerCase() === "name") out.name = value;
    else out.description = value;
  }
  return out;
}
