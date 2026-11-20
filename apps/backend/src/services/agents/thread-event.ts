
import { isDbToolName } from "@zavi/shared/db-guard";
import { serviceClient } from "@/services/supabase";
import { scrubSecretsFromText } from "@/services/mcp/egress-secret-scrub";
import {
  BODY_SCHEMAS,
  CitationSchema,
  type Citation,
  type ThreadEventBody,
  type ThreadEventKind,
} from "./thread-event-types";
import type { StepLike } from "./types";

const OUTPUT_PREVIEW_MAX = 200;
const DIFF_MAX = 4096;
const CONTENT_PREVIEW_MAX = 500;

export type EmitThreadEventInput<K extends ThreadEventKind> = {
  agent_run_id: string | null;
  agent_slug: string;
  tenant_id: string;
  thread_id: string | null;
  kind: K;
  body: unknown;
  citations?: Citation[];
};

export async function emitThreadEvent<K extends ThreadEventKind>(
  input: EmitThreadEventInput<K>,
): Promise<void> {
  const { agent_run_id, agent_slug, tenant_id, thread_id, kind, body, citations } =
    input;

  const schema = BODY_SCHEMAS[kind];
  const parsedBody = schema.parse(body) as ThreadEventBody<K>;

  if (kind === "tool_call") {
    const tc = parsedBody as ThreadEventBody<"tool_call">;
    tc.output_preview = isDbToolName(tc.tool_name)
      ? ""
      : scrubSecretsFromText(tc.output_preview.slice(0, OUTPUT_PREVIEW_MAX)).scrubbed;
    tc.target = scrubSecretsFromText(tc.target).scrubbed;
  } else if (kind === "file_edit") {
    const fe = parsedBody as ThreadEventBody<"file_edit">;
    fe.diff = scrubSecretsFromText(fe.diff.slice(0, DIFF_MAX)).scrubbed;
  } else if (kind === "file_create") {
    const fc = parsedBody as ThreadEventBody<"file_create">;
    fc.content_preview = scrubSecretsFromText(
      fc.content_preview.slice(0, CONTENT_PREVIEW_MAX),
    ).scrubbed;
  } else if (kind === "voice_agent_utterance") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { redactVoiceTranscriptFull } = require("../redactor") as {
      redactVoiceTranscriptFull: (s: string) => string;
    };
    const ua = parsedBody as ThreadEventBody<"voice_agent_utterance">;
    ua.text = redactVoiceTranscriptFull(ua.text);
  } else if (kind === "reasoning" || kind === "plan" || kind === "decision") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { redactAgentText } = require("../redactor") as {
      redactAgentText: (s: string) => string;
    };
    if (kind === "reasoning") {
      const rb = parsedBody as ThreadEventBody<"reasoning">;
      rb.text = redactAgentText(rb.text);
    } else if (kind === "plan") {
      const pb = parsedBody as ThreadEventBody<"plan">;
      pb.summary = redactAgentText(pb.summary);
      pb.steps = pb.steps.map((s) => redactAgentText(s));
    } else {
      const db = parsedBody as ThreadEventBody<"decision">;
      db.title = redactAgentText(db.title);
      if (typeof db.summary === "string") db.summary = redactAgentText(db.summary);
    }
  }

  const validatedCitations: Citation[] = (citations ?? []).map((c) =>
    CitationSchema.parse(c),
  );

  const { error } = await serviceClient().from("thread_event").insert({
    tenant_id,
    agent_run_id,
    agent_slug,
    thread_id,
    kind,
    body: parsedBody,
    citations: validatedCitations,
  });

  if (error) {
    throw new Error(
      `emitThreadEvent failed for run=${agent_run_id ?? "null"} kind=${kind}: ${error.message}`,
    );
  }
}

export async function emitThreadEventOnce<K extends ThreadEventKind>(
  step: StepLike | undefined,
  stepIdSuffix: string,
  runId: string,
  input: EmitThreadEventInput<K>,
): Promise<void> {
  if (!step) {
    await emitThreadEvent(input);
    return;
  }
  await step.run(`emit-${stepIdSuffix}-${runId}`, () => emitThreadEvent(input));
}

export function buildCitationsFromContext(input: {
  memoryHits?: { slug: string; label?: string }[];
  runRefs?: { run_id: string; label?: string }[];
}): Citation[] {
  const out: Citation[] = [];
  for (const m of input.memoryHits ?? []) {
    out.push({
      kind: "memory_doc",
      ref: m.slug,
      label: m.label ?? m.slug,
    });
  }
  for (const r of input.runRefs ?? []) {
    out.push({
      kind: "agent_run",
      ref: r.run_id,
      label: r.label ?? `run ${r.run_id.slice(0, 8)}`,
    });
  }
  return out;
}
