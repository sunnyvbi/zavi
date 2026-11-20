
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { writeNote } from "@/services/memory";
import { callModel } from "@/services/llm/call-model";
import { withProviderRetry } from "@/services/llm/retry";
import { DEFAULT_PROVIDER } from "@/services/llm/models";
import {
  distillSkillCandidates,
  deterministicSkillProse,
  SKILL_DISTILL_SETTING_KEY,
  type DistillSkillDeps,
  type DistillRunRow,
  type SkillCluster,
  type SkillNoteWrite,
} from "@/services/memory/distill-skill-candidate";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const MAX_DISTILL_TENANTS_PER_SWEEP = 200;

async function synthesizeProseWithHaiku(
  cluster: SkillCluster,
): Promise<{ title: string; body_markdown: string }> {
  const fallback = deterministicSkillProse(cluster);
  const system =
    "You write a SHORT, reusable 'how we do X here' team skill note from a recurring tool-call procedure. " +
    "You are given ONLY tool names + how often the team ran them — never user data. " +
    "Output 2-4 sentences of plain procedural guidance an agent could reuse. No preamble, no markdown headers.";
  const user =
    `Tool sequence (in order): ${cluster.sequence.join(" -> ")}\n` +
    `Run by agents: ${cluster.agent_slugs.join(", ")}\n` +
    `Times the team did this: ${cluster.occurrences}\n\n` +
    `Write the skill body. Then on a final line write: TITLE: <a <=80-char title>.`;

  const res = await withProviderRetry(
    () =>
      callModel({
        provider: DEFAULT_PROVIDER,
        model: HAIKU_MODEL,
        system,
        messages: [{ role: "user", content: user }],
        max_tokens: 400,
        tags: { tenantId: cluster.tenant_id },
      }),
    { label: "distill-skill-prose", attempts: 2 },
  );

  const text = (res.text ?? "").trim();
  if (!text) return fallback;
  const titleMatch = text.match(/TITLE:\s*(.+)\s*$/i);
  const title = (titleMatch?.[1] ?? fallback.title).trim().slice(0, 240);
  const body_markdown = (titleMatch ? text.slice(0, titleMatch.index).trim() : text).trim();
  if (!body_markdown) return fallback;
  return { title, body_markdown };
}

function defaultDistillSkillDeps(
  logger?: { warn: (m: string) => void; info?: (m: string) => void },
): DistillSkillDeps {
  const sb = serviceClient();
  return {
    enabledTenantIds: async () => {
      const { data, error } = await sb
        .from("tenants")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(MAX_DISTILL_TENANTS_PER_SWEEP);
      if (error) throw new Error(error.message);
      const tenantIds = (data ?? []).map((r) => (r as { id: string }).id);
      const enabled: string[] = [];
      for (const t of tenantIds) {
        if (await getBoolSetting(SKILL_DISTILL_SETTING_KEY, t)) enabled.push(t);
      }
      return enabled;
    },
    readSuccessfulRuns: async (sinceIso, limit, tenantIds) => {
      if (tenantIds.length === 0) return [];
      const { data, error } = await sb
        .from("agent_runs")
        .select("id, tenant_id, agent_slug, status, grounding_flags, tool_calls")
        .in("tenant_id", tenantIds)
        .eq("status", "success")
        .gte("finished_at", sinceIso)
        .order("finished_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => {
        const row = r as DistillRunRow & { tool_calls?: Array<Record<string, unknown>> | null };
        return {
          id: row.id,
          tenant_id: row.tenant_id,
          agent_slug: row.agent_slug,
          status: row.status,
          grounding_flags: row.grounding_flags,
          tool_calls: Array.isArray(row.tool_calls)
            ? row.tool_calls.map((tc) => ({ name: tc?.name, status: tc?.status }))
            : null,
        } as DistillRunRow;
      });
    },
    skillSourceRefExists: async (tenant_id, source_ref) => {
      const { data, error } = await sb
        .from("memory_note")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("note_type", "skill")
        .eq("source_ref", source_ref)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    },
    synthesizeProse: synthesizeProseWithHaiku,
    writeSkillNote: async (note: SkillNoteWrite) => {
      await writeNote(note.tenant_id, {
        title: note.title,
        body_markdown: note.body_markdown,
        note_type: "skill",
        agent_slug: null,
        trust_tier: 2,
        source: "auto_distill_agent_run",
        source_ref: note.source_ref,
        tags: ["skill", "auto_distill"],
        metadata: note.metadata,
      });
    },
    logger,
  };
}

export const distillSkillCandidateFn = inngest.createFunction(
  { id: "distill-skill-candidate", concurrency: 1 },
  { cron: "41 4 * * *" },
  async ({ logger }) => {
    const res = await distillSkillCandidates(defaultDistillSkillDeps(logger));
    logger.info(
      `distill-skill-candidate: enabled_tenants=${res.enabled_tenants} ` +
        `runs_scanned=${res.runs_scanned} clusters=${res.clusters_considered} ` +
        `attempts=${res.synth_write_attempts} skills_written=${res.skills_written} ` +
        `skipped_existing=${res.skipped_existing} write_failures=${res.write_failures}`,
    );
    return res;
  },
);
