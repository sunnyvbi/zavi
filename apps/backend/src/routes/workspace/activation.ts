
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { readMemoryStatus, type MemoryStatus } from "@/services/onboarding/background-memory";
import {
  BRAIN_SLOT_SLUGS,
  scoreSlot,
  type BrainSlotSlug,
  type SlotStatus,
} from "@/services/memory/brain-slots";

export type NextBestAction = { key: string; label: string; href: string };

export type BrainSlotState = { slug: BrainSlotSlug; status: SlotStatus };

export type BrainState = {
  filled: number;
  total: 10;
  slots: BrainSlotState[];
};

export type ActivationState = {
  brain_seeded: boolean;
  connectors_count: number;
  agents_run_count: number;
  first_approval_acted: boolean;
  activated: boolean;
  next_best_action: NextBestAction;
  brain?: BrainState;
  memory_status?: MemoryStatus | null;
};

export type ActivationSignals = {
  brain_seeded: boolean;
  connectors_count: number;
  agents_run_count: number;
  first_approval_acted: boolean;
};

export function deriveActivationState(sig: ActivationSignals): ActivationState {
  const activated = sig.agents_run_count > 0 && sig.first_approval_acted;

  let next_best_action: NextBestAction;
  if (!sig.brain_seeded) {
    next_best_action = {
      key: "seed_brain",
      label: "Finish setting up your workspace",
      href: "/workspace?tab=brain",
    };
  } else if (sig.connectors_count === 0) {
    next_best_action = {
      key: "connect",
      label: "Connect a data source so your team can act on real data",
      href: "/workspace?tab=settings",
    };
  } else if (sig.agents_run_count === 0) {
    next_best_action = {
      key: "run_agent",
      label: "Run your first agent — ask the CTO Engineer anything",
      href: "/workspace?agent=engineer",
    };
  } else if (!sig.first_approval_acted) {
    next_best_action = {
      key: "review_approval",
      label: "Review Zavi's first proposal",
      href: "/workspace?tab=channels",
    };
  } else {
    next_best_action = {
      key: "explore",
      label: "Explore your workspace",
      href: "/workspace",
    };
  }

  return {
    brain_seeded: sig.brain_seeded,
    connectors_count: sig.connectors_count,
    agents_run_count: sig.agents_run_count,
    first_approval_acted: sig.first_approval_acted,
    activated,
    next_best_action,
  };
}

export async function workspaceActivation(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);

  const [brainRes, connectorsRes, runsRes, actedDecisionsRes] = await Promise.all([
    supabase
      .from("memory_note")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id),
    supabase
      .from("connector_metadata")
      .select("slug", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id),
    supabase
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id)
      .not("enqueued_at", "is", null),
    supabase
      .from("decisions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", auth.tenant_id)
      .neq("status", "proposed"),
  ]);

  if (brainRes.error) {
    res.status(500).json({
      error: { code: "brain_query_failed", message: brainRes.error.message },
    });
    return;
  }
  if (connectorsRes.error) {
    res.status(500).json({
      error: { code: "connectors_query_failed", message: connectorsRes.error.message },
    });
    return;
  }
  if (runsRes.error) {
    res.status(500).json({
      error: { code: "runs_query_failed", message: runsRes.error.message },
    });
    return;
  }
  if (actedDecisionsRes.error) {
    res.status(500).json({
      error: { code: "decisions_query_failed", message: actedDecisionsRes.error.message },
    });
    return;
  }

  const state = deriveActivationState({
    brain_seeded: (brainRes.count ?? 0) > 0,
    connectors_count: connectorsRes.count ?? 0,
    agents_run_count: runsRes.count ?? 0,
    first_approval_acted: (actedDecisionsRes.count ?? 0) > 0,
  });

  const brain = await computeBrainState(supabase, auth.tenant_id);
  if (brain) state.brain = brain;

  try {
    state.memory_status = await readMemoryStatus(auth.tenant_id);
  } catch {
    state.memory_status = null;
  }

  res.json(state);
}

async function computeBrainState(
  supabase: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
): Promise<BrainState | null> {
  try {
    const { data, error } = await supabase
      .from("memory_note")
      .select("slug, body_markdown, metadata")
      .eq("tenant_id", tenant_id)
      .in("slug", BRAIN_SLOT_SLUGS as unknown as string[])
      .eq("note_type", "anchor")
      .is("superseded_by", null);
    if (error) return null;

    const byslug = new Map<
      string,
      { body_markdown: string | null; metadata: Record<string, unknown> | null }
    >();
    for (const row of (data ?? []) as Array<{
      slug: string | null;
      body_markdown: string | null;
      metadata: Record<string, unknown> | null;
    }>) {
      if (row.slug) byslug.set(row.slug, row);
    }

    const slots: BrainSlotState[] = BRAIN_SLOT_SLUGS.map((slug) => {
      const row = byslug.get(slug);
      const status = scoreSlot(row?.body_markdown, row?.metadata ?? {});
      return { slug, status };
    });
    const filled = slots.filter((s) => s.status === "filled").length;
    return { filled, total: 10, slots };
  } catch {
    return null;
  }
}
