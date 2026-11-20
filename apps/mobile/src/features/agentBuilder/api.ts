import { useQuery } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import {
  TERMINAL_RUN_STATUSES,
  type BuilderAgent,
  type BuilderNote,
  type BuilderReceipt,
  type BuilderRefusal,
  type BuilderRun,
  type CustomAgentDeliver,
  type CustomAgentTrigger,
  type ServerCustomAgent,
} from "./logic";

const base = (id: string) => `/api/custom-agents/${encodeURIComponent(id)}`;
const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const agentBuilderKeys = {
  list: (tenant: string) => ["custom-agents", tenant] as const,
  archived: (tenant: string) => ["custom-agents-archived", tenant] as const,
  runs: (tenant: string, id: string) => ["custom-agent-runs", tenant, id] as const,
  notes: (tenant: string, id: string) => ["custom-agent-notes", tenant, id] as const,
  receipts: (tenant: string, id: string, runId: string) => ["custom-agent-receipts", tenant, id, runId] as const,
  run: (tenant: string, runId: string) => ["custom-agent-run", tenant, runId] as const,
};

export type AgentList = { agents: BuilderAgent[]; refusal: BuilderRefusal | null };

export async function fetchAgents(): Promise<AgentList> {
  const body = await apiJson<{ agents?: BuilderAgent[]; refusal?: BuilderRefusal | null }>("/api/custom-agents");
  const agents = (body.agents ?? []).filter((a) => a.status === "active" || a.status === "paused");
  return { agents, refusal: body.refusal ?? null };
}

export async function fetchArchived(): Promise<BuilderAgent[]> {
  const body = await apiJson<{ agents?: BuilderAgent[] }>("/api/custom-agents?status=archived");
  return (body.agents ?? []).filter((a) => a.status === "archived");
}

export async function fetchAgentForRun(originRunId: string): Promise<ServerCustomAgent | null> {
  const body = await apiJson<{ agents?: ServerCustomAgent[] }>(
    `/api/custom-agents?origin_run_id=${encodeURIComponent(originRunId)}`,
  );
  return body.agents?.[0] ?? null;
}

export async function setAgentStatus(id: string, status: "active" | "paused" | "archived"): Promise<BuilderAgent> {
  const { agent } = await apiJson<{ agent: BuilderAgent }>(`${base(id)}/status`, { method: "POST", ...json({ status }) });
  return agent;
}

export async function unarchiveAgent(id: string): Promise<void> {
  await apiJson(`${base(id)}/unarchive`, { method: "POST" });
}

export async function updateAgent(
  id: string,
  fields: { name?: string; role?: string; instructions?: string; schedule_cron?: string },
): Promise<BuilderAgent> {
  const { agent } = await apiJson<{ agent: BuilderAgent }>(base(id), { method: "PATCH", ...json(fields) });
  return agent;
}

export async function createAgent(body: {
  name: string;
  role: string;
  instructions: string;
  tools: string[];
  triggers: CustomAgentTrigger[];
  deliver: CustomAgentDeliver | null;
  status: "draft" | "active";
  origin_run_id?: string;
}): Promise<{ id: string; status: string }> {
  const { agent } = await apiJson<{ agent: { id: string; status: string } }>("/api/custom-agents", {
    method: "POST",
    ...json(body),
  });
  return agent;
}

export async function startTestRun(id: string): Promise<string | null> {
  const { run_id } = await apiJson<{ run_id: string }>(`${base(id)}/test`, {
    method: "POST",
    retryOnNetworkError: false,
  });
  return run_id || null;
}

export async function deleteNote(id: string, noteId: string): Promise<void> {
  await apiJson(`${base(id)}/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
}

export type SchedulePreviewBody =
  | { ok: true; cron: string; tz: string; label: string; next: string[] }
  | { ok: false; message: string };

export function previewSchedule(text: string): Promise<SchedulePreviewBody> {
  return apiJson<SchedulePreviewBody>("/api/custom-agents/schedule-preview", { method: "POST", ...json({ text }) });
}

export type RunRead = { status: string; output: string; done: boolean; agentSlug: string | null };

export async function fetchRun(runId: string): Promise<RunRead | null> {
  try {
    const body = await apiJson<{ run?: { status?: string; output_text?: string | null; agent_slug?: string } }>(
      `/api/agents/runs/${encodeURIComponent(runId)}`,
    );
    if (!body.run) return null;
    const status = body.run.status ?? "";
    return {
      status,
      output: body.run.output_text ?? "",
      done: TERMINAL_RUN_STATUSES.has(status),
      agentSlug: body.run.agent_slug ?? null,
    };
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 404) return null;
    throw e;
  }
}

async function fetchReceipts(id: string, runId: string): Promise<BuilderReceipt[]> {
  const out: BuilderReceipt[] = [];
  let before: string | null = null;
  for (let page = 0; page < 50; page++) {
    const qs = `run_id=${encodeURIComponent(runId)}&limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    const body: { receipts?: BuilderReceipt[]; next_cursor?: string | null } = await apiJson(
      `${base(id)}/receipts?${qs}`,
    );
    out.push(...(body.receipts ?? []));
    before = body.next_cursor ?? null;
    if (!before) break;
  }
  return out;
}

export function useAgentList() {
  const tenant = useActiveTenant();
  return useQuery({ queryKey: agentBuilderKeys.list(tenant), enabled: tenant !== "none", queryFn: fetchAgents });
}

export function useArchivedAgents() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: agentBuilderKeys.archived(tenant),
    enabled: tenant !== "none",
    queryFn: fetchArchived,
  });
}

export function useAgentRuns(id: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: agentBuilderKeys.runs(tenant, id),
    enabled: tenant !== "none" && !!id,
    queryFn: async () => (await apiJson<{ runs?: BuilderRun[] }>(`${base(id)}/runs`)).runs ?? [],
  });
}

export function useAgentNotes(id: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: agentBuilderKeys.notes(tenant, id),
    enabled: tenant !== "none" && !!id,
    queryFn: async () => (await apiJson<{ notes?: BuilderNote[] }>(`${base(id)}/notes`)).notes ?? [],
  });
}

export function useRunReceipts(id: string, runId: string) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: agentBuilderKeys.receipts(tenant, id, runId),
    enabled: tenant !== "none",
    queryFn: () => fetchReceipts(id, runId),
  });
}

export function useRun(runId: string | null) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: agentBuilderKeys.run(tenant, runId ?? ""),
    enabled: tenant !== "none" && !!runId,
    queryFn: () => fetchRun(runId as string),
    refetchInterval: (q) => (q.state.data && !q.state.data.done ? 3000 : false),
  });
}
