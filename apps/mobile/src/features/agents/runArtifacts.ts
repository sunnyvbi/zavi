import { useQuery } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import type { ChatMessage } from "./types";

export type RunArtifact = { id: string; run_id: string; filename: string; mime: string; bytes: number };

export function useRunArtifacts(messages: ChatMessage[]) {
  const tenant = useActiveTenant();
  const runIds = Array.from(
    new Set(
      messages
        .filter((m) => m.sender_role !== "user" && m.sender_role !== "system" && m.agent_run_id)
        .map((m) => m.agent_run_id as string),
    ),
  ).sort();

  return useQuery({
    queryKey: ["run-artifacts", tenant, runIds],
    enabled: tenant !== "none" && runIds.length > 0,
    queryFn: async (): Promise<Map<string, RunArtifact[]>> => {
      const { data, error } = await supabase
        .from("run_artifacts")
        .select("id, run_id, filename, mime, bytes")
        .in("run_id", runIds);
      if (error || !data) return new Map();
      const byRun = new Map<string, RunArtifact[]>();
      for (const a of data as RunArtifact[]) {
        const list = byRun.get(a.run_id) ?? [];
        list.push(a);
        byRun.set(a.run_id, list);
      }
      return byRun;
    },
  });
}

export async function signArtifactUrl(id: string): Promise<string | null> {
  try {
    const res = await apiJson<{ signed_url?: string }>(
      `/api/run-artifacts/${encodeURIComponent(id)}/url`,
    );
    return res.signed_url ?? null;
  } catch {
    return null;
  }
}
