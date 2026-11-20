import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildContext, type ClaimedAgentRun } from "../src/services/agents/runner";
import { runChat } from "../src/services/agents/chat-dispatcher";
import { makeDraftCtx } from "../src/services/agents/generic-dispatcher";
import { loadAgentDefinition } from "../src/services/agents/registry";
import { serviceClient } from "../src/services/supabase";
import { SKILL_REGISTRY } from "../src/services/agents/skill-runtime";
import type { ReplayCase } from "./skill-runtime-replay-cases";

export const EVAL_USER_ID = "0335f3eb-8f08-4f72-91e1-6cd085503f13";
const KNOWN_SLUGS = SKILL_REGISTRY.map((s) => s.slug);

export interface RunObservation {
  run_id: string | null;
  status: string;
  loaded_slugs: string[];
  output_text: string;
  index_present: boolean;
}

export function extractLoadedSlugs(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: string[] = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const rec = tc as Record<string, unknown>;
    if (rec.name !== "skill__load") continue;
    const preview = typeof rec.input_preview === "string" ? rec.input_preview : "";
    const slug = KNOWN_SLUGS.find((s) => preview.includes(s));
    out.push(slug ?? "(unknown-slug)");
  }
  return out;
}

export async function runArm(
  c: ReplayCase,
  tenant_id: string,
  suppress: boolean,
): Promise<RunObservation> {
  const runId = randomUUID();
  const sb = serviceClient();
  const empty: RunObservation = { run_id: runId, status: "", loaded_slugs: [], output_text: "", index_present: false };

  const def = await loadAgentDefinition(c.agent_slug, tenant_id);
  if (!def) return { ...empty, status: "no_agent_def" };

  const { data: thread, error: thErr } = await sb
    .from("agent_threads")
    .insert({ tenant_id, agent_slug: c.agent_slug, user_id: EVAL_USER_ID, title: "SKILL-EVAL (auto, deletes itself)" })
    .select("id")
    .single();
  if (thErr || !thread) return { ...empty, status: `thread_insert_error:${thErr?.message ?? "none"}` };
  const threadId = (thread as { id: string }).id;

  try {
    const { data: msg, error: msgErr } = await sb
      .from("agent_thread_messages")
      .insert({ thread_id: threadId, tenant_id, sender_role: "user", body: c.prompt, agent_run_id: null })
      .select("id")
      .single();
    if (msgErr || !msg) return { ...empty, status: `msg_insert_error:${msgErr?.message ?? "none"}` };
    const userMessageId = (msg as { id: string }).id;

    const payload: Record<string, unknown> = { thread_id: threadId, user_message_id: userMessageId };
    if (suppress) payload.suppress_skill_runtime = true;
    const { error: runErr } = await sb.from("agent_runs").insert({
      id: runId, tenant_id, agent_slug: c.agent_slug, agent_definition_hash: def.content_hash,
      trigger: "chat", status: "running", started_at: new Date().toISOString(), payload,
    });
    if (runErr) return { ...empty, status: `run_insert_error:${runErr.message}` };

    const claim: ClaimedAgentRun = { id: runId, tenant_id, agent_slug: c.agent_slug, trigger: "chat", payload };
    const ctx = await buildContext(claim, runId);
    const draftCtx = makeDraftCtx(ctx);
    const result = await runChat(draftCtx, payload);
    const snapshot = (result as { prompt_snapshot?: string }).prompt_snapshot ?? "";
    return {
      run_id: runId,
      status: result.parse_ok ? "success" : "parse_failed",
      loaded_slugs: extractLoadedSlugs(result.tool_calls),
      output_text: result.output_text ?? "",
      index_present: snapshot.includes("Skill playbooks"),
    };
  } catch (e) {
    return { ...empty, status: `dispatch_error:${(e as Error).message}` };
  } finally {
    await sb.from("agent_runs").update({ status: "success", finished_at: new Date().toISOString() }).eq("id", runId).eq("status", "running");
    await sb.from("agent_threads").delete().eq("id", threadId).eq("tenant_id", tenant_id);
  }
}

export function codexGrade(task: string, aText: string, bText: string): string {
  const prompt = [
    "You are a blind quality judge. Two AI responses to the same task are below.",
    "Judge ONLY on quality: is the answer specific, well-structured, grounded, and genuinely useful for the task? Penalize generic filler and unsupported claims.",
    "Do NOT assume either is better by position. Output EXACTLY one token on the last line: RESPONSE_A, RESPONSE_B, or TIE.",
    `\nTASK:\n${task}`,
    `\n=== RESPONSE_A ===\n${aText.slice(0, 6000)}`,
    `\n=== RESPONSE_B ===\n${bText.slice(0, 6000)}`,
  ].join("\n");
  try {
    const out = execFileSync(
      "codex",
      ["exec", "-s", "read-only", "-c", 'model_reasoning_effort="medium"', prompt],
      { encoding: "utf-8", timeout: 180000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const m = out.match(/RESPONSE_A|RESPONSE_B|TIE/g);
    const last = m ? m[m.length - 1] : "";
    return last === "RESPONSE_A" ? "A" : last === "RESPONSE_B" ? "B" : last === "TIE" ? "tie" : "error";
  } catch {
    return "error";
  }
}
