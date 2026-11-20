
type ToolCallLike = {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  returned_ids?: unknown;
};

export type EpisodeProvenance = {
  connectors_used: string[];
  candidate_sources_checked: Array<{
    tool: string;
    returned_ids: string[];
    returned_count: number;
  }>;
  candidate_dead_ends: Array<{ tool: string; code: string }>;
};

const MAX_ENTRIES = 20;
const MAX_IDS_PER_TOOL = 5;

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{3,63}$/;

function isOpaqueId(v: unknown): v is string {
  return typeof v === "string" && !v.includes("@") && OPAQUE_ID_RE.test(v);
}

function asName(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const CONNECTOR_WRAPPER_SEGMENTS = new Set(["mcp", "server"]);

function connectorOf(name: string): string {
  const parts = name.split("__").filter(Boolean);
  if (parts.length <= 1) return name;
  let i = 0;
  while (i < parts.length - 1 && CONNECTOR_WRAPPER_SEGMENTS.has(parts[i])) i++;
  return parts[i] ?? name;
}

export function deriveEpisodeProvenance(
  toolCalls: unknown,
): EpisodeProvenance | null {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const connectors = new Set<string>();
  const checked: EpisodeProvenance["candidate_sources_checked"] = [];
  const deadEnds: EpisodeProvenance["candidate_dead_ends"] = [];

  for (const raw of toolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const tc = raw as ToolCallLike;
    const name = asName(tc.name);
    if (!name) continue;

    if (connectors.size < MAX_ENTRIES) {
      connectors.add(connectorOf(name));
    }

    if (tc.status === "tool_error" || tc.status === "throw") {
      if (deadEnds.length < MAX_ENTRIES) {
        deadEnds.push({
          tool: name,
          code: typeof tc.code === "string" && tc.code ? tc.code : String(tc.status),
        });
      }
      continue;
    }

    if (tc.status === "ok" && checked.length < MAX_ENTRIES) {
      const validIds = Array.isArray(tc.returned_ids)
        ? tc.returned_ids.filter(isOpaqueId)
        : [];
      const ids = validIds.slice(0, MAX_IDS_PER_TOOL);
      const total = validIds.length;
      if (total > 0) {
        checked.push({ tool: name, returned_ids: ids, returned_count: total });
      }
    }
  }

  if (connectors.size === 0 && checked.length === 0 && deadEnds.length === 0) {
    return null;
  }
  return {
    connectors_used: [...connectors].sort(),
    candidate_sources_checked: checked,
    candidate_dead_ends: deadEnds,
  };
}
