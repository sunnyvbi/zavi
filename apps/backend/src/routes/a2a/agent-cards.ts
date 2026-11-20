
import type { Request, Response } from "express";
import { listGlobalAgentSlugs, loadGlobalAgentDefinition } from "@/services/agents/registry";
import { filterGlobalVisibleAgents } from "@/services/agents/visibility";

export async function a2aAgentCards(_req: Request, res: Response): Promise<void> {
  const baseUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`;
  const defs = listGlobalAgentSlugs()
    .map((slug) => loadGlobalAgentDefinition(slug))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const visible = await filterGlobalVisibleAgents(defs);
  const cards: Array<Record<string, unknown>> = [];

  for (const def of visible) {
    const slug = def.slug;
    cards.push({
      schema_version: "0.1",
      id: slug,
      name: def.name,
      description: def.description,
      version: def.content_hash,
      capabilities: {
        tools: def.metadata_praxis.tools ?? [],
        decision_class: def.metadata_praxis.decision_class ?? null,
        impact_classes: def.metadata_praxis.impact_classes ?? [],
        manual_only: def.metadata_praxis.manual_only ?? false,
        side_effects: def.metadata_praxis.side_effects ?? false,
      },
      endpoints: {
        dispatch: `${baseUrl}/api/a2a/dispatch`,
      },
    });
  }

  res.json({ schema_version: "0.1", count: cards.length, cards });
}
