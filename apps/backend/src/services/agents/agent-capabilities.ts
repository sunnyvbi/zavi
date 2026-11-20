
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { AgentMetadataSchema, type AgentMetadata } from "./types";
import { canonicalAgentSlug } from "@/agents/content-design/constants";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

export type AgentCapabilities = AgentMetadata["capabilities"];

export const NO_CAPABILITIES: AgentCapabilities = {
  money_path: false,
  reads_operator_db: false,
  emits_artifact: false,
  structured_clarifications: false,
};

const CACHE = new Map<string, AgentCapabilities>();

export function agentCapabilities(slug: string): AgentCapabilities {
  const canonical = canonicalAgentSlug(slug);
  const cached = CACHE.get(canonical);
  if (cached) return cached;
  const caps = readCapabilities(canonical);
  CACHE.set(canonical, caps);
  return caps;
}

function readCapabilities(canonical: string): AgentCapabilities {
  const body_path = path.join(AGENTS_ROOT, canonical, "agent.md");
  if (!fs.existsSync(body_path)) return NO_CAPABILITIES;
  try {
    const raw = fs.readFileSync(body_path, "utf-8");
    const fm = matter(raw).data as Record<string, unknown>;
    const metaPraxisRaw =
      ((fm.metadata as Record<string, unknown> | undefined)?.praxis ?? {}) as
        Record<string, unknown>;
    return AgentMetadataSchema.parse(metaPraxisRaw).capabilities;
  } catch {
    return NO_CAPABILITIES;
  }
}

export function __resetAgentCapabilitiesCache(): void {
  CACHE.clear();
}
