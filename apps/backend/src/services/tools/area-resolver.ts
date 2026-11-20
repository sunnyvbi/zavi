
import type { ToolArea } from "./areas";

export type CompressResult = {
  areas: ToolArea[];
  unmatched: string[];
};

export function compressToolsToAreas(
  granted: string[],
  allAreas: ToolArea[],
): CompressResult {
  const grantedSet = new Set(granted);
  const matched = new Set<string>();

  const areas: ToolArea[] = [];
  for (const area of allAreas) {
    const intersect = area.tool_slugs
      .filter((s) => grantedSet.has(s))
      .slice()
      .sort();
    if (intersect.length === 0) continue;
    for (const s of intersect) matched.add(s);
    areas.push({
      id: area.id,
      name: area.name,
      description: area.description,
      tool_slugs: intersect,
    });
  }

  const unmatched = granted.filter((s) => !matched.has(s)).slice().sort();
  return { areas, unmatched };
}

export function renderToolAreasForPrompt(
  areas: ToolArea[],
  unmatched: string[],
  perToolFallback: (slug: string) => string,
): string {
  const lines: string[] = [];

  for (const area of areas) {
    const dispatcherList = area.tool_slugs.join(", ");
    lines.push(
      `- **${area.name}** (dispatcher for: ${dispatcherList}) — ${area.description}`,
    );
  }

  if (unmatched.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Other tools:");
    for (const slug of unmatched) {
      lines.push(perToolFallback(slug));
    }
  }

  return lines.join("\n");
}
