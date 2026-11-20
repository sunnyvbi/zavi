
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export type RouterStep = {
  id: string;
  when: "always" | "connected" | "public_only";
  goal?: string;
  skill?: string;
  load?: "on_demand";
  tools?: readonly string[];
};

export const MAX_CHANNEL_SKILL_BYTES = 16_000;

export const MAX_CHANNEL_SKILL_BLOCK_BYTES = 80_000;

const SAFE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export function channelSkillsRoot(channelSlug: string): string {
  return path.join(process.cwd(), "src", "agents", channelSlug, "skills");
}

export function sharedSkillsRoot(): string {
  return path.join(process.cwd(), "src", "agents", "_core", "ads");
}

function containedSkillPath(root: string, skillName: string): string | null {
  const candidate = path.join(root, `${skillName}.md`);
  const resolvedRoot = existsSync(root) ? realpathSync(root) : path.resolve(root);
  const resolved = existsSync(candidate) ? realpathSync(candidate) : path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return existsSync(resolved) ? resolved : null;
}

export function resolveChannelSkillPath(
  channelSlug: string,
  skillName: string,
): string | null {
  if (!SAFE_NAME.test(channelSlug) || !SAFE_NAME.test(skillName)) return null;
  return (
    containedSkillPath(channelSkillsRoot(channelSlug), skillName) ??
    containedSkillPath(sharedSkillsRoot(), skillName)
  );
}

export function readChannelSkill(channelSlug: string, skillName: string): string | null {
  const p = resolveChannelSkillPath(channelSlug, skillName);
  if (!p) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  let body: string;
  try {
    body = matter(raw).content.trim();
  } catch {
    body = raw.trim();
  }
  if (!body) return null;
  return clampSkillBody(body);
}

const TRUNCATION_MARKER = "\n\n[channel skill truncated — the rest of this file was not loaded]";

function clampSkillBody(body: string): string {
  if (Buffer.byteLength(body, "utf-8") <= MAX_CHANNEL_SKILL_BYTES) return body;
  const budget = MAX_CHANNEL_SKILL_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
  const head = new TextDecoder("utf-8").decode(
    Buffer.from(body, "utf-8").subarray(0, Math.max(0, budget)),
  );
  return head + TRUNCATION_MARKER;
}

export function applicableRouterSteps(
  steps: readonly RouterStep[],
  hasConnector: boolean,
): RouterStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.filter((s) => {
    if (!s || typeof s !== "object") return false;
    if (s.when === "connected") return hasConnector;
    if (s.when === "public_only") return !hasConnector;
    return s.when === "always";
  });
}

export type ChannelSkillBlock = {
  block: string;
  skills: string[];
  missing: string[];
};

export function buildChannelSkillBlock(
  channelSlug: string,
  steps: readonly RouterStep[],
): ChannelSkillBlock {
  const seen = new Set<string>();
  const sections: string[] = [];
  const skills: string[] = [];
  const missing: string[] = [];

  for (const step of steps) {
    const name = step?.skill;
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    const body = readChannelSkill(channelSlug, name);
    if (body === null) {
      missing.push(name);
      continue;
    }
    sections.push(`## Skill playbook: ${name}\n\n${body}`);
    skills.push(name);
  }

  if (sections.length === 0) return { block: "", skills: [], missing };
  return {
    block: `---\n\nThe playbook(s) below are the craft for this channel's steps. Apply them.\n\n${sections.join(
      "\n\n",
    )}\n\n---`,
    skills,
    missing,
  };
}
