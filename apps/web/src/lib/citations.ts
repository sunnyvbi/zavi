
import { createBrowserSupabase } from "./supabase";
import { getActiveTenantId } from "./active-tenant-client";

export type Citation = {
  kind: "memory_doc" | "agent_run";
  ref: string;
  label: string;
};

export type CitationPreview =
  | { found: true; kind: "memory_doc"; slug: string; body_markdown: string; updated_at: string }
  | {
      found: true;
      kind: "agent_run";
      run_id: string;
      agent_slug: string;
      status: string;
      output_text: string;
      finished_at: string | null;
    }
  | { found: false; kind: "memory_doc" | "agent_run"; ref: string };

export async function resolveCitation(c: Citation): Promise<CitationPreview> {
  const sb = createBrowserSupabase();
  const tid = await getActiveTenantId(sb);
  if (c.kind === "memory_doc") {
    if (!tid) return { found: false, kind: "memory_doc", ref: c.ref };
    const { data, error } = await sb
      .from("memory_note")
      .select("slug, body_markdown, updated_at")
      .eq("tenant_id", tid)
      .eq("slug", c.ref)
      .is("superseded_by", null)
      .maybeSingle();
    if (error || !data) return { found: false, kind: "memory_doc", ref: c.ref };
    return {
      found: true,
      kind: "memory_doc",
      slug: data.slug as string,
      body_markdown: (data.body_markdown as string) ?? "",
      updated_at: (data.updated_at as string) ?? "",
    };
  }
  if (!tid) return { found: false, kind: "agent_run", ref: c.ref };
  const { data, error } = await sb
    .from("agent_runs")
    .select("id, agent_slug, status, output_text, finished_at")
    .eq("tenant_id", tid)
    .eq("id", c.ref)
    .single();
  if (error || !data) return { found: false, kind: "agent_run", ref: c.ref };
  return {
    found: true,
    kind: "agent_run",
    run_id: data.id as string,
    agent_slug: data.agent_slug as string,
    status: data.status as string,
    output_text: (data.output_text as string) ?? "",
    finished_at: (data.finished_at as string | null) ?? null,
  };
}
