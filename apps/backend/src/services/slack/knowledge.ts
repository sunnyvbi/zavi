
import { readFile } from "node:fs/promises";
import path from "node:path";

export type KnowledgeSource = { path: string; content: string };
export type KnowledgePack = { sources: KnowledgeSource[] };

const OVERVIEW_PATH = path.join(
  process.cwd(),
  "src",
  "services",
  "slack",
  "knowledge",
  "zavi-overview.md",
);

let cached: KnowledgePack | null = null;
let loading: Promise<KnowledgePack> | null = null;
let missingWarned = false;

export async function loadKnowledgePack(): Promise<KnowledgePack> {
  if (cached) return cached;
  if (loading) return loading;
  loading = doLoad();
  cached = await loading;
  loading = null;
  return cached;
}

async function doLoad(): Promise<KnowledgePack> {
  const start = Date.now();
  const sources: KnowledgeSource[] = [];

  try {
    const content = await readFile(OVERVIEW_PATH, "utf-8");
    sources.push({ path: "zavi-overview.md", content });
  } catch (e) {
    if (!missingWarned) {
      console.warn(
        `[slack/knowledge] overview file missing at ${OVERVIEW_PATH}: ${(e as Error).message}. Triage will run with only active_agents.`,
      );
      missingWarned = true;
    }
  }

  const ms = Date.now() - start;
  console.log(
    `[slack/knowledge] loaded ${sources.length} source(s) in ${ms}ms`,
  );
  return { sources };
}

export function _resetKnowledgeCache(): void {
  cached = null;
  loading = null;
  missingWarned = false;
}
