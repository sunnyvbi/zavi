
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  CONNECTOR_DESCRIPTORS,
  SHAPE_PRIORITY,
  classifyShape,
  buildAgentsUnlockedMap,
  type ConnectorSlug,
} from "@/services/connectors/catalog";

export type ConnectorRecommendation = {
  slug: ConnectorSlug;
  name: string;
  connected: boolean;
  rationale: string;
  agents_unlocked: string[];
  new_agents_unlocked: string[];
  recommended: boolean;
};

export async function connectorsRecommendations(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const sb = serviceClient();

    const { data: anchor, error: anchorErr } = await sb
      .from("memory_note")
      .select("body_markdown")
      .eq("tenant_id", auth.tenant_id)
      .eq("slug", "company")
      .is("superseded_by", null)
      .maybeSingle();
    if (anchorErr) {
      throw new Error(`anchor read failed: ${anchorErr.message}`);
    }
    const companyBody = (anchor as { body_markdown?: string } | null)?.body_markdown ?? "";

    const shape = classifyShape(companyBody);

    const { data: connectors } = await sb
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", auth.tenant_id);
    const connectedSlugs = new Set<string>();
    for (const { slug } of (connectors ?? []) as Array<{ slug: string }>) {
      connectedSlugs.add(slug);
      const bare = slug.replace(/^(?:pipedream|composio)\./, "");
      if (bare !== slug) connectedSlugs.add(bare);
    }

    const unlockMap = await buildAgentsUnlockedMap(auth.tenant_id);

    const alreadyUnlocked = new Set<string>();
    for (const slug of connectedSlugs) {
      const list = unlockMap[slug as ConnectorSlug];
      if (list) for (const a of list) alreadyUnlocked.add(a);
    }

    const priority = SHAPE_PRIORITY[shape];
    let recommendedAssigned = false;
    const recommendations: ConnectorRecommendation[] = priority.map((slug) => {
      const descriptor = CONNECTOR_DESCRIPTORS.find((d) => d.slug === slug)!;
      const connected = connectedSlugs.has(slug);
      const agents_unlocked = unlockMap[slug] ?? [];
      const new_agents_unlocked = agents_unlocked.filter(
        (a) => !alreadyUnlocked.has(a),
      );
      const recommended =
        !connected && !recommendedAssigned && new_agents_unlocked.length > 0;
      if (recommended) recommendedAssigned = true;
      return {
        slug,
        name: descriptor.name,
        connected,
        rationale: descriptor.rationale_by_shape[shape],
        agents_unlocked,
        new_agents_unlocked,
        recommended,
      };
    });

    if (!recommendedAssigned) {
      const firstUnconnected = recommendations.find((r) => !r.connected);
      if (firstUnconnected) firstUnconnected.recommended = true;
    }

    res.json({
      shape,
      recommendations,
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "recommendations_failed", message: (e as Error).message },
    });
  }
}
