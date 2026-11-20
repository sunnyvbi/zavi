
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getAgentRunById } from "@/services/agents/runner";
import { canUserAccessAgentRun } from "@/services/auth/members";
import { serviceClient } from "@/services/supabase";

const MAX_CAPTURES_PER_RUN = 50;
const TOP_N_ANCHORS = 3;

type BrainAnchor = {
  note_id: string;
  title: string;
  source: string | null;
  hit_count: number;
};

type BrainAnchorsResponse = {
  anchors: BrainAnchor[];
  capture_count: number;
  capture_enabled: boolean;
};

export async function agentRunBrainAnchors(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const run_id = req.params.run_id;
  if (!run_id) {
    res.status(400).json({ error: { code: "missing_run_id", message: "run_id path param required" } });
    return;
  }

  try {
    const run = await getAgentRunById(auth.tenant_id, run_id);
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: `run ${run_id} not found` } });
      return;
    }

    const allowed = await canUserAccessAgentRun(serviceClient(), auth.user_id, run_id, { read: true });
    if (!allowed) {
      res.status(404).json({ error: { code: "not_found", message: `run ${run_id} not found` } });
      return;
    }

    const sb = serviceClient();
    const { data: caps, error: capsErr } = await sb
      .from("eval_candidates")
      .select("retrieved_note_ids, created_at")
      .eq("tenant_id", run.tenant_id)
      .eq("run_id", run_id)
      .order("created_at", { ascending: true })
      .limit(MAX_CAPTURES_PER_RUN);

    if (capsErr) {
      res.status(500).json({ error: { code: "captures_read_failed", message: capsErr.message } });
      return;
    }

    if (!caps || caps.length === 0) {
      const payload: BrainAnchorsResponse = {
        anchors: [],
        capture_count: 0,
        capture_enabled: false,
      };
      res.json(payload);
      return;
    }

    const freq = new Map<string, number>();
    for (const c of caps as Array<{ retrieved_note_ids: string[] | null }>) {
      for (const nid of c.retrieved_note_ids ?? []) {
        if (typeof nid === "string" && nid.length > 0) {
          freq.set(nid, (freq.get(nid) ?? 0) + 1);
        }
      }
    }

    if (freq.size === 0) {
      const payload: BrainAnchorsResponse = {
        anchors: [],
        capture_count: caps.length,
        capture_enabled: true,
      };
      res.json(payload);
      return;
    }

    const topIds = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N_ANCHORS)
      .map(([id]) => id);

    const { data: notes, error: notesErr } = await sb
      .from("memory_note")
      .select("id, title, source")
      .eq("tenant_id", run.tenant_id)
      .in("id", topIds);

    if (notesErr) {
      res.status(500).json({ error: { code: "notes_read_failed", message: notesErr.message } });
      return;
    }

    const noteById = new Map<string, { title: string | null; source: string | null }>();
    for (const n of (notes ?? []) as Array<{ id: string; title: string | null; source: string | null }>) {
      noteById.set(n.id, { title: n.title, source: n.source });
    }

    const anchors: BrainAnchor[] = topIds.map((id) => {
      const n = noteById.get(id);
      return {
        note_id: id,
        title: n?.title && n.title.length > 0 ? n.title : "(untitled)",
        source: n?.source ?? null,
        hit_count: freq.get(id) ?? 0,
      };
    });

    const payload: BrainAnchorsResponse = {
      anchors,
      capture_count: caps.length,
      capture_enabled: true,
    };
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}
